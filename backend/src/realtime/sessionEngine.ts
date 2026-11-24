import type { AnswerSubmission, GameEndDto, GameEndReason, LiveQuestionDto, LobbyStateDto, QuestionDto, QuestionEndDto, TimerSyncDto } from '@rush/shared';
import { gradeAnswer, LIMITS } from '@rush/shared';
import { db, mysqlErrorCode, transaction } from '../db';
import { emails } from '../integrations/mailer';
import { getMembershipRole, isManager } from '../services/permissions';
import { loadQuestions } from '../services/questions';
import { describeCorrectAnswer, getSessionRow, loadStandings, winnerOf } from '../services/sessions';

/**
 * Authoritative in-memory game engine. The server owns the state machine, the ONE global timer of
 * each session, grading, scores and the winner; clients only send answers. Every state change for
 * one session runs through a per-session queue, so the timer, answers, disconnects and reconnects
 * never race. MySQL is the durable record.
 *
 * Rules:
 * - One global deadline per session (quiz.total_time_limit_seconds), set once when the game starts
 *   and never reset. Each player advances through the questions at their own pace.
 * - The session ends as soon as the FIRST player answers every question, or when the deadline
 *   passes, whichever comes first. The first player to finish decides WHEN the session ends, not
 *   WHO wins.
 * - The winner is the participant with the highest final score at that moment. Ties are broken by
 *   the earliest completion time, then by the lowest user id, so the result is deterministic and
 *   server-authoritative. Finishing first never overrides a higher score: a player who has more
 *   points but has not finished still wins.
 */

export interface Emitter {
  /** emit to every socket of one participant */
  toUser(sessionId: number, userId: number, event: string, payload: unknown): void;
  /** emit to every socket that joined the session */
  toSession(sessionId: number, event: string, payload: unknown): void;
  /** remove a user's sockets from the session channel */
  detachUser(sessionId: number, userId: number): void;
}

interface Participant {
  userId: number;
  attemptId: number;
  username: string;
  fullName: string;
  profilePictureUrl: string | null;
  sockets: Set<string>;
  connected: boolean;
  /** index of this player's current question */
  index: number;
  answered: Set<number>; // question ids
  finishedAt: Date | null;
}

interface LiveSession {
  sessionId: number;
  roomId: number;
  roomName: string;
  quizId: number;
  quizTitle: string;
  hostUserId: number | null;
  status: 'WAITING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  questions: QuestionDto[];
  questionCount: number;
  totalTimeLimitSeconds: number;
  participants: Map<number, Participant>;
  /** global deadline (epoch ms); 0 until the game starts */
  endsAt: number;
  /** fires once at the global deadline */
  timer: NodeJS.Timeout | null;
  /** periodic re-broadcast of the deadline */
  syncTimer: NodeJS.Timeout | null;
  queue: Promise<unknown>;
}

export class SessionError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const ANSWER_GRACE_MS = 750; // network latency allowance after the deadline

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const ended = () => new SessionError('session_ended', 'This session has ended');

export class SessionEngine {
  private sessions = new Map<number, LiveSession>();
  /** speeds up tests: multiplier applied to the global time limit */
  timeScale = 1;
  /** how often the deadline is re-broadcast (tests shorten it) */
  syncIntervalMs: number = LIMITS.timerSyncMs;

  constructor(private emitter: Emitter) {}

  setEmitter(emitter: Emitter) {
    this.emitter = emitter;
  }

  private run<T>(s: LiveSession, fn: () => Promise<T>): Promise<T> {
    const next = s.queue.then(fn, fn);
    s.queue = next.catch(() => undefined);
    return next;
  }

  /** Loads a WAITING session from the DB into memory (lazily, on first join). */
  private async ensureLoaded(sessionId: number): Promise<LiveSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const row = await getSessionRow(sessionId);
    if (!row) throw new SessionError('not_found', 'Session not found');
    if (row.session_status !== 'WAITING') {
      throw row.session_status === 'IN_PROGRESS' ? new SessionError('already_started', 'This session has already started') : ended();
    }
    const { n } = await db.selectFrom('question').select((eb) => eb.fn.countAll<number>().as('n')).where('quiz_id', '=', row.quiz_id).executeTakeFirstOrThrow();
    const again = this.sessions.get(sessionId);
    if (again) return again;
    const s: LiveSession = {
      sessionId,
      roomId: row.room_id,
      roomName: row.room_name,
      quizId: row.quiz_id,
      quizTitle: row.title,
      hostUserId: row.host_user_id,
      status: 'WAITING',
      questions: [],
      questionCount: Number(n),
      totalTimeLimitSeconds: row.total_time_limit_seconds,
      participants: new Map(),
      endsAt: 0,
      timer: null,
      syncTimer: null,
      queue: Promise.resolve(),
    };
    this.sessions.set(sessionId, s);
    return s;
  }

  private lobbyState(s: LiveSession, forUserCanControl: boolean): LobbyStateDto {
    return {
      sessionId: s.sessionId,
      roomId: s.roomId,
      quizTitle: s.quizTitle,
      questionCount: s.questionCount,
      totalTimeLimitSeconds: s.totalTimeLimitSeconds,
      status: s.status,
      hostUserId: s.hostUserId,
      participants: [...s.participants.values()]
        .filter((p) => p.connected)
        .map((p) => ({ userId: p.userId, username: p.username, fullName: p.fullName, profilePictureUrl: p.profilePictureUrl })),
      canControl: forUserCanControl,
    };
  }

  private broadcastLobby(s: LiveSession) {
    // canControl differs per user, so it is resolved by the client from its own role; send false here
    this.emitter.toSession(s.sessionId, 'session:lobby', this.lobbyState(s, false));
  }

  private timerState(s: LiveSession): TimerSyncDto {
    return { endsAt: s.endsAt, serverNow: Date.now(), totalTimeLimitSeconds: s.totalTimeLimitSeconds };
  }

  /** The player's current question (never with correct answers), stamped with the global deadline. */
  private liveQuestion(s: LiveSession, p: Participant): LiveQuestionDto | null {
    const q = s.questions[p.index];
    if (!q || p.finishedAt) return null;
    return {
      questionId: q.questionId,
      index: p.index,
      total: s.questions.length,
      questionText: q.questionText,
      questionType: q.questionType,
      pointValue: q.pointValue,
      media: q.media ? { mediaType: q.media.mediaType, mediaUrl: q.media.mediaUrl } : null,
      options: q.options.map((o) => ({ optionId: o.optionId, text: o.text })),
      matchingLeft: q.pairs.map((x) => ({ pairId: x.pairId, text: x.left })),
      matchingRight: shuffle(q.pairs.map((x) => ({ pairId: x.pairId, text: x.right }))),
      ...this.timerState(s),
    };
  }

  private sendCurrentQuestion(s: LiveSession, p: Participant) {
    const live = this.liveQuestion(s, p);
    if (live) this.emitter.toUser(s.sessionId, p.userId, 'session:question', live);
  }

  /**
   * A room member joins the waiting room. After the start, only an existing participant can come
   * back (reconnect); they receive their current question and the remaining global time.
   */
  async join(sessionId: number, userId: number, socketId: string): Promise<{ lobby: LobbyStateDto; current: LiveQuestionDto | null }> {
    const s = this.sessions.get(sessionId) ?? (await this.ensureLoaded(sessionId));
    return this.run(s, async () => {
      if (s.status === 'COMPLETED' || s.status === 'CANCELLED') throw ended();
      const role = await getMembershipRole(s.roomId, userId);
      if (!role) throw new SessionError('not_member', 'Only room members can join this session');

      if (s.status === 'IN_PROGRESS') {
        const p = s.participants.get(userId);
        if (!p) throw new SessionError('already_started', 'This session has already started');
        p.sockets.add(socketId);
        if (!p.connected) {
          p.connected = true;
          await db.updateTable('quiz_attempt').set({ disconnected_at: null }).where('attempt_id', '=', p.attemptId).execute();
        }
        return { lobby: this.lobbyState(s, isManager(role)), current: this.liveQuestion(s, p) };
      }

      let p = s.participants.get(userId);
      if (!p) {
        const user = await db.selectFrom('user').select(['username', 'full_name', 'profile_picture_url']).where('user_id', '=', userId).executeTakeFirstOrThrow();
        let attemptId: number;
        try {
          const res = await db.insertInto('quiz_attempt').values({ session_id: sessionId, user_id: userId }).executeTakeFirstOrThrow();
          attemptId = Number(res.insertId);
        } catch (err) {
          if (mysqlErrorCode(err) !== 'ER_DUP_ENTRY') throw err;
          const a = await db.selectFrom('quiz_attempt').select('attempt_id').where('session_id', '=', sessionId).where('user_id', '=', userId).executeTakeFirstOrThrow();
          attemptId = a.attempt_id;
        }
        p = {
          userId,
          attemptId,
          username: user.username,
          fullName: user.full_name,
          profilePictureUrl: user.profile_picture_url,
          sockets: new Set(),
          connected: true,
          index: 0,
          answered: new Set(),
          finishedAt: null,
        };
        s.participants.set(userId, p);
      }
      p.sockets.add(socketId);
      p.connected = true;
      this.broadcastLobby(s);
      return { lobby: this.lobbyState(s, isManager(role)), current: null };
    });
  }

  /** Starts the game and the ONE global timer of the session (only once: the status guard below). */
  async start(sessionId: number, userId: number): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new SessionError('not_found', 'Join the session first');
    await this.run(s, async () => {
      if (!isManager(await getMembershipRole(s.roomId, userId))) {
        throw new SessionError('forbidden', 'Only the room owner or an administrator can start the session');
      }
      if (s.status !== 'WAITING') throw new SessionError('already_started', 'The session has already started');
      // Participants must still be room members at start time.
      for (const p of [...s.participants.values()]) {
        if (!(await getMembershipRole(s.roomId, p.userId))) {
          await db.deleteFrom('quiz_attempt').where('attempt_id', '=', p.attemptId).execute();
          s.participants.delete(p.userId);
          this.emitter.detachUser(s.sessionId, p.userId);
        }
      }
      if (s.participants.size === 0) throw new SessionError('no_participants', 'At least one participant is needed');
      s.questions = await loadQuestions(s.quizId);
      if (s.questions.length === 0) throw new SessionError('no_questions', 'This quiz has no questions');
      s.questionCount = s.questions.length;
      // read the time limit again: the quiz may have been edited while players were waiting
      const quiz = await db.selectFrom('quiz').select('total_time_limit_seconds').where('quiz_id', '=', s.quizId).executeTakeFirstOrThrow();
      s.totalTimeLimitSeconds = quiz.total_time_limit_seconds;
      const res = await db
        .updateTable('quiz_session')
        .set({ session_status: 'IN_PROGRESS', started_at: new Date() })
        .where('session_id', '=', sessionId)
        .where('session_status', '=', 'WAITING')
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw new SessionError('session_ended', 'This session is no longer waiting');
      s.status = 'IN_PROGRESS';

      const durationMs = s.totalTimeLimitSeconds * 1000 * this.timeScale;
      s.endsAt = Date.now() + durationMs;
      s.timer = setTimeout(() => {
        void this.run(s, () => this.finish(s, 'time_up')).catch((e) => console.error('[session] time up', e));
      }, durationMs + ANSWER_GRACE_MS);
      s.syncTimer = setInterval(() => {
        if (s.status === 'IN_PROGRESS') this.emitter.toSession(s.sessionId, 'session:timer', this.timerState(s));
      }, this.syncIntervalMs);

      // A-22: email every participant that the session is starting.
      const users = await db.selectFrom('user').select('email').where('user_id', 'in', [...s.participants.keys()]).execute();
      for (const u of users) emails.sessionStarting(u.email, s.roomName, s.quizTitle, s.sessionId);
      this.emitter.toSession(s.sessionId, 'session:started', { sessionId, questionCount: s.questionCount, ...this.timerState(s) });
      for (const p of s.participants.values()) {
        p.index = 0;
        if (p.connected) this.sendCurrentQuestion(s, p);
      }
    });
  }

  /**
   * A player answers their current question. Each player sees only their own result and then gets
   * their next question; answering the last question marks them finished and ends the session for
   * everyone. The winner is still decided by final score, not by who finished first.
   */
  async answer(sessionId: number, userId: number, questionId: number, submission: AnswerSubmission): Promise<{ accepted: true; result: QuestionEndDto; finished: boolean }> {
    const s = this.sessions.get(sessionId);
    if (!s) throw ended();
    return this.run(s, async () => {
      if (s.status !== 'IN_PROGRESS') throw s.status === 'WAITING' ? new SessionError('not_accepting', 'The session has not started yet') : ended();
      const p = s.participants.get(userId);
      if (!p || !p.connected) throw new SessionError('not_participant', 'You are not playing in this session');
      if (Date.now() > s.endsAt + ANSWER_GRACE_MS) throw new SessionError('time_up', 'Time is up');
      const q = s.questions[p.index];
      if (!q || p.finishedAt) throw new SessionError('already_finished', 'You have answered every question');
      if (q.questionId !== questionId) throw new SessionError('wrong_question', 'This is not your current question');

      const grade = gradeAnswer(
        {
          questionType: q.questionType,
          pointValue: q.pointValue,
          correctTextAnswer: q.correctTextAnswer,
          options: q.options.map((o) => ({ optionId: o.optionId, isCorrect: o.isCorrect })),
          pairs: q.pairs.map((x) => ({ pairId: x.pairId })),
        },
        submission,
      );
      if (!grade.valid) throw new SessionError('invalid_answer', 'This answer does not match the question');

      try {
        await transaction(async (tx) => {
          const res = await tx
            .insertInto('user_answer')
            .values({
              attempt_id: p.attemptId,
              question_id: questionId,
              selected_option_id: submission.kind === 'option' ? submission.optionId : null,
              text_answer: submission.kind === 'text' ? submission.text.trim().slice(0, 255) : null,
              is_correct: grade.isCorrect,
              points_earned: grade.pointsEarned,
            })
            .executeTakeFirstOrThrow();
          if (submission.kind === 'matching' && submission.matches.length > 0) {
            await tx
              .insertInto('user_answer_match')
              .values(submission.matches.map((m) => ({ user_answer_id: Number(res.insertId), left_pair_id: m.leftPairId, selected_right_pair_id: m.rightPairId })))
              .execute();
          }
        });
      } catch (err) {
        if (mysqlErrorCode(err) === 'ER_DUP_ENTRY') throw new SessionError('already_answered', 'You already answered this question');
        throw err;
      }
      p.answered.add(questionId);
      const result: QuestionEndDto = {
        questionId,
        answered: true,
        isCorrect: grade.isCorrect,
        pointsEarned: grade.pointsEarned,
        correctAnswer: describeCorrectAnswer(q),
      };
      this.emitter.toUser(s.sessionId, userId, 'session:question-end', result);

      if (p.index === s.questions.length - 1) {
        // This player answered the last question, so they are the first to finish, which ends the
        // session for everyone right now. Their completion time is recorded because it breaks score
        // ties, but it does NOT decide the winner: finish() ranks every player by their final score,
        // so a player with more points who has not finished still wins.
        p.finishedAt = new Date();
        for (const q of s.questions) p.answered.add(q.questionId);
        await this.finish(s, 'completed');
        return { accepted: true as const, result, finished: true };
      }
      p.index += 1;
      this.sendCurrentQuestion(s, p);
      return { accepted: true as const, result, finished: false };
    });
  }

  private async writeTotals(s: LiveSession): Promise<void> {
    for (const p of s.participants.values()) {
      const { total } = await db
        .selectFrom('user_answer')
        .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('points_earned'), eb.lit(0)).as('total'))
        .where('attempt_id', '=', p.attemptId)
        .executeTakeFirstOrThrow();
      await db.updateTable('quiz_attempt').set({ total_score: Number(total) }).where('attempt_id', '=', p.attemptId).execute();
    }
  }

  /**
   * The winner is the attempt with the highest total score. Ties are broken by the earliest
   * completion time (players who never finished rank last), then by the lowest user id, so the
   * result is deterministic. Runs after writeTotals, so total_score is already persisted.
   */
  private async determineWinner(sessionId: number): Promise<number | null> {
    const rows = await db
      .selectFrom('quiz_attempt')
      .select(['user_id', 'total_score', 'finished_at'])
      .where('session_id', '=', sessionId)
      .execute();
    if (rows.length === 0) return null;
    const completion = (at: Date | null) => (at ? at.getTime() : Number.POSITIVE_INFINITY);
    rows.sort((a, b) => b.total_score - a.total_score || completion(a.finished_at) - completion(b.finished_at) || a.user_id - b.user_id);
    return rows[0]!.user_id;
  }

  /**
   * Ends the game for everybody, exactly once. Called when the first player finishes all questions
   * or when the deadline passes. The conditional UPDATE (… WHERE session_status = 'IN_PROGRESS') is
   * the atomic guard: only one caller can move the session to COMPLETED, even if a final answer and
   * the deadline arrive at the same moment. Players who had not finished keep the points they
   * earned; their unanswered questions count as 0. The winner is then decided from the persisted
   * scores, so it never depends on who finished first.
   */
  private async finish(s: LiveSession, reason: GameEndReason): Promise<void> {
    if (s.status !== 'IN_PROGRESS') return;
    s.status = 'COMPLETED';
    this.stopTimers(s);
    const res = await db
      .updateTable('quiz_session')
      .set({ session_status: 'COMPLETED', ended_at: new Date() })
      .where('session_id', '=', s.sessionId)
      .where('session_status', '=', 'IN_PROGRESS')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) {
      this.sessions.delete(s.sessionId);
      return;
    }
    // Persist each finisher's completion time; it breaks score ties when the winner is chosen.
    for (const p of s.participants.values()) {
      if (p.finishedAt) await db.updateTable('quiz_attempt').set({ finished_at: p.finishedAt }).where('attempt_id', '=', p.attemptId).execute();
    }
    // A-10: questions a player did not answer are stored as empty 0-point answers (complete history).
    const missing = [...s.participants.values()].flatMap((p) =>
      s.questions.filter((q) => !p.answered.has(q.questionId)).map((q) => ({ attempt_id: p.attemptId, question_id: q.questionId, is_correct: false, points_earned: 0 })),
    );
    if (missing.length > 0) await db.insertInto('user_answer').values(missing).execute();
    for (const p of s.participants.values()) for (const q of s.questions) p.answered.add(q.questionId);
    await this.writeTotals(s);
    const winnerUserId = await this.determineWinner(s.sessionId);
    if (winnerUserId !== null) {
      await db.updateTable('quiz_session').set({ winner_user_id: winnerUserId }).where('session_id', '=', s.sessionId).execute();
    }
    const standings = await loadStandings(s.sessionId, winnerUserId);
    const payload: GameEndDto = { sessionId: s.sessionId, reason, winner: winnerOf(standings), standings };
    this.emitter.toSession(s.sessionId, 'session:completed', payload);
    this.sessions.delete(s.sessionId);
  }

  private stopTimers(s: LiveSession) {
    if (s.timer) clearTimeout(s.timer);
    if (s.syncTimer) clearInterval(s.syncTimer);
    s.timer = null;
    s.syncTimer = null;
  }

  async cancel(sessionId: number, userId: number | null): Promise<void> {
    let s = this.sessions.get(sessionId);
    if (!s) {
      // not loaded yet (nobody joined) — load it so the DB row is cancelled consistently
      const row = await getSessionRow(sessionId);
      if (!row) throw new SessionError('not_found', 'Session not found');
      if (row.session_status !== 'WAITING' && row.session_status !== 'IN_PROGRESS') throw ended();
      s = await this.ensureLoaded(sessionId);
    }
    const live = s;
    await this.run(live, async () => {
      if (userId !== null && !isManager(await getMembershipRole(live.roomId, userId))) {
        throw new SessionError('forbidden', 'Only the room owner or an administrator can cancel the session');
      }
      if (live.status !== 'WAITING' && live.status !== 'IN_PROGRESS') return;
      await this.cancelInternal(live, true);
    });
  }

  private async cancelInternal(s: LiveSession, persist: boolean) {
    this.stopTimers(s);
    s.status = 'CANCELLED';
    if (persist) {
      await this.writeTotals(s);
      await db.updateTable('quiz_session').set({ session_status: 'CANCELLED', ended_at: new Date() }).where('session_id', '=', s.sessionId).execute();
    }
    this.emitter.toSession(s.sessionId, 'session:cancelled', { sessionId: s.sessionId });
    this.sessions.delete(s.sessionId);
  }

  /**
   * Socket closed. In the waiting room the player is removed (A-19). During the game the player is
   * only marked as disconnected: their progress is kept, they can reconnect, and a disconnect never
   * ends the game or makes anybody the winner. The global timer keeps running.
   */
  async disconnect(sessionId: number, userId: number, socketId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    await this.run(s, async () => {
      const p = s.participants.get(userId);
      if (!p) return;
      p.sockets.delete(socketId);
      if (p.sockets.size > 0) return;
      await this.dropParticipant(s, p);
    });
  }

  private async dropParticipant(s: LiveSession, p: Participant) {
    if (s.status === 'WAITING') {
      await db.deleteFrom('quiz_attempt').where('attempt_id', '=', p.attemptId).execute();
      s.participants.delete(p.userId);
      this.broadcastLobby(s);
    } else if (s.status === 'IN_PROGRESS' && p.connected) {
      p.connected = false;
      await db.updateTable('quiz_attempt').set({ disconnected_at: new Date() }).where('attempt_id', '=', p.attemptId).execute();
      this.emitter.detachUser(s.sessionId, p.userId);
    }
  }

  /** The user left or was removed from the room: drop them from that room's live session for good. */
  async memberLeftRoom(roomId: number, userId: number): Promise<void> {
    for (const s of this.sessions.values()) {
      if (s.roomId !== roomId) continue;
      const p = s.participants.get(userId);
      if (!p) continue;
      await this.run(s, async () => {
        this.emitter.toUser(s.sessionId, userId, 'session:removed', { sessionId: s.sessionId });
        p.sockets.clear();
        // (join() re-checks membership, so a removed member cannot come back)
        await this.dropParticipant(s, p);
        this.emitter.detachUser(s.sessionId, userId);
      });
    }
  }

  /** Rooms/quizzes are about to be deleted (rows cascade): stop their live sessions without writing. */
  abortFor(roomIds: number[], quizIds: number[]): void {
    for (const s of [...this.sessions.values()]) {
      if (roomIds.includes(s.roomId) || quizIds.includes(s.quizId)) {
        void this.run(s, () => this.cancelInternal(s, false)).catch(() => undefined);
      }
    }
  }

  /** test helper */
  async drain(sessionId: number): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) await s.queue;
  }

  isLive(sessionId: number): boolean {
    return this.sessions.has(sessionId);
  }

  /** test helper: the global deadline of a live session (0 before the start) */
  deadlineOf(sessionId: number): number | null {
    return this.sessions.get(sessionId)?.endsAt ?? null;
  }

  /** Stops all timers; queued callbacks become no-ops because the sessions are no longer active. */
  async shutdown(): Promise<void> {
    const all = [...this.sessions.values()];
    for (const s of all) {
      this.stopTimers(s);
      s.status = 'CANCELLED';
    }
    this.sessions.clear();
    await Promise.all(all.map((s) => s.queue));
  }
}

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Implementa el motor autoritativo de las partidas multijugador: sala de espera, inicio,
temporizador global del cuestionario, avance de cada jugador a su ritmo, corrección, ganador por
mayor puntuación final, puntuación y resultados.

Responsabilidades principales:
- join: un miembro de la sala entra en la sala de espera (se crea su quiz_attempt). Durante la
  partida solo puede volver un participante existente (reconexión): recibe su pregunta actual y el
  tiempo global restante.
- start: solo OWNER/ADMIN y solo una vez (estado WAITING). Carga las preguntas, lee
  quiz.total_time_limit_seconds, fija UNA fecha límite global (endsAt) y programa un único
  setTimeout para el fin del tiempo y un setInterval que reenvía la fecha límite (session:timer).
- answer: valida que la pregunta sea la actual de ese jugador y que no haya pasado el tiempo
  global; corrige con gradeAnswer, guarda user_answer, envía al jugador su resultado
  (session:question-end) y su siguiente pregunta (session:question). Si era la última pregunta,
  marca a ese jugador como terminado (finishedAt) y termina la sesión para todos de inmediato: el
  primero en terminar decide CUÁNDO acaba la partida, no QUIÉN gana.
- finish: termina la partida una sola vez, cuando el primer jugador termina o cuando vence el
  tiempo global. El UPDATE condicional (WHERE session_status = 'IN_PROGRESS') garantiza que una sola
  llamada cierra la sesión aunque una respuesta final y el vencimiento del tiempo coincidan. Guarda
  finished_at, registra con 0 puntos las preguntas no contestadas, calcula total_score y determina
  el ganador por mayor puntuación final (desempate por menor finished_at y luego menor user_id).
  Emite session:completed con el motivo, el ganador y la clasificación.
- determineWinner: ganador autoritativo a partir de las puntuaciones ya persistidas.
- cancel: cierra la sesión como CANCELLED.
- disconnect: en la sala de espera elimina al jugador; durante la partida solo marca
  disconnected_at (puede reconectarse; una desconexión nunca da la victoria a nadie).

Elementos importantes:
- class SessionEngine
- interface Emitter (toUser, toSession, detachUser)
- class SessionError
- interfaces internas Participant y LiveSession
- métodos join, start, answer, finish, cancel, disconnect, memberLeftRoom, abortFor, shutdown

Dependencias:
- db/index.ts
- @rush/shared (gradeAnswer, LIMITS, tipos)
- services/permissions.ts
- services/questions.ts (loadQuestions)
- services/sessions.ts (describeCorrectAnswer, getSessionRow, loadStandings, winnerOf)
- integrations/mailer.ts

Flujo de datos:
Recibe acciones de los jugadores desde socket.ts, lee las preguntas de MySQL, escribe respuestas,
puntuaciones y el ganador en MySQL y emite eventos a los navegadores a través del Emitter.

Aspectos técnicos importantes:
- Cada sesión tiene una cola de promesas (run) que serializa el temporizador, las respuestas, las
  desconexiones y las reconexiones para evitar condiciones de carrera.
- El temporizador global nunca se reinicia al cambiar de pregunta; el servidor (Date.now) decide
  con un margen de 750 ms y el cliente solo muestra la cuenta atrás.
- Los puntos dependen solo de si la respuesta es correcta. La sesión termina en cuanto el primer
  jugador contesta todas las preguntas (o al vencer el tiempo), pero el ganador es siempre el de
  mayor puntuación final, no el que terminó primero.
- timeScale y syncIntervalMs permiten acelerar los tiempos en las pruebas.

Lugar en la arquitectura:
Capa de tiempo real / lógica de juego; la crea socket.ts y la usan las rutas de cancelación. Es el
núcleo de la funcionalidad multijugador: garantiza que nadie pueda manipular tiempos, puntuaciones
ni el ganador desde el navegador.
*/
