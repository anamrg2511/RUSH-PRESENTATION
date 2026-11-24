import type { GameEndReason, QuestionDto, SessionHistoryItemDto, SessionResultDto, StandingDto, WinnerDto } from '@rush/shared';
import { sql } from 'kysely';
import { db, mysqlErrorCode } from '../db';
import { badRequest, conflict, notFound } from '../http/errors';
import { getMembershipRole, requireRoomManager, requireRoomMember } from './permissions';

/** Human-readable correct answer (used in the end-of-question reveal and in results). */
export function describeCorrectAnswer(q: QuestionDto): string {
  switch (q.questionType) {
    case 'MULTIPLE_CHOICE':
    case 'TRUE_FALSE':
      return q.options.find((o) => o.isCorrect)?.text ?? '';
    case 'OPEN_ANSWER':
    case 'FILL_IN_THE_BLANK':
      return q.correctTextAnswer ?? '';
    case 'MATCHING':
      return q.pairs.map((p) => `${p.left} → ${p.right}`).join('; ');
  }
}

/**
 * Creates a WAITING session (OWNER/ADMIN only). The quiz must be in the room and PUBLISHED.
 * UNIQUE(room_id, active_flag) guarantees one active session per room even under concurrency.
 */
export async function createSession(roomId: number, userId: number, quizId: number): Promise<number> {
  await requireRoomManager(roomId, userId);
  const quiz = await db
    .selectFrom('room_quiz as rq')
    .innerJoin('quiz as q', 'q.quiz_id', 'rq.quiz_id')
    .select((eb) => [
      'q.quiz_status',
      eb.selectFrom('question as qu').select(eb.fn.countAll<number>().as('n')).whereRef('qu.quiz_id', '=', 'q.quiz_id').as('question_count'),
    ])
    .where('rq.room_id', '=', roomId)
    .where('rq.quiz_id', '=', quizId)
    .executeTakeFirst();
  if (!quiz) throw notFound('Quiz in this room');
  if (quiz.quiz_status !== 'PUBLISHED') throw badRequest('quiz_not_published', 'Only published quizzes can be played');
  if (Number(quiz.question_count ?? 0) === 0) throw badRequest('no_questions', 'This quiz has no questions');
  try {
    const res = await db
      .insertInto('quiz_session')
      .values({ room_id: roomId, quiz_id: quizId, host_user_id: userId, session_status: 'WAITING' })
      .executeTakeFirstOrThrow();
    return Number(res.insertId);
  } catch (err) {
    if (mysqlErrorCode(err) === 'ER_DUP_ENTRY') throw conflict('session_active', 'This room already has an active session');
    throw err;
  }
}

export async function getSessionRow(sessionId: number) {
  return db
    .selectFrom('quiz_session as s')
    .innerJoin('quiz as q', 'q.quiz_id', 's.quiz_id')
    .innerJoin('room as r', 'r.room_id', 's.room_id')
    .select(['s.session_id', 's.room_id', 's.quiz_id', 's.host_user_id', 's.session_status', 's.created_at', 's.started_at', 's.ended_at', 's.winner_user_id', 'q.title', 'q.total_time_limit_seconds', 'r.name as room_name'])
    .where('s.session_id', '=', sessionId)
    .executeTakeFirst();
}

/**
 * Final standings of a session, ranked by score (highest first). The winner — the highest final
 * score, ties broken by earliest completion — is flagged and listed first so every client shows the
 * same order.
 */
export async function loadStandings(sessionId: number, winnerUserId: number | null): Promise<StandingDto[]> {
  const rows = await db
    .selectFrom('quiz_attempt as a')
    .innerJoin('user as u', 'u.user_id', 'a.user_id')
    .select(['a.user_id', 'u.username', 'u.full_name', 'a.total_score', 'a.disconnected_at', 'a.finished_at'])
    .where('a.session_id', '=', sessionId)
    .orderBy('a.total_score', 'desc')
    .orderBy('u.username')
    .execute();
  const standings = rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    fullName: r.full_name,
    totalScore: r.total_score,
    disconnected: r.disconnected_at !== null,
    finished: r.finished_at !== null,
    isWinner: winnerUserId !== null && r.user_id === winnerUserId,
  }));
  return [...standings.filter((x) => x.isWinner), ...standings.filter((x) => !x.isWinner)];
}

export function winnerOf(standings: StandingDto[]): WinnerDto | null {
  const w = standings.find((x) => x.isWinner);
  return w ? { userId: w.userId, username: w.username, fullName: w.fullName } : null;
}

/** Room members and the session's participants (even after leaving the room) can see results. */
export async function getSessionResult(sessionId: number, userId: number): Promise<SessionResultDto> {
  const s = await getSessionRow(sessionId);
  if (!s) throw notFound('Session');
  const myAttempt = await db.selectFrom('quiz_attempt').select(['attempt_id', 'total_score'])
    .where('session_id', '=', sessionId).where('user_id', '=', userId).executeTakeFirst();
  if (!myAttempt && !(await getMembershipRole(s.room_id, userId))) throw notFound('Session');

  const standings = await loadStandings(sessionId, s.winner_user_id);
  // 'completed' when every participant answered all questions; otherwise the deadline ended it.
  const endReason: GameEndReason | null =
    s.session_status !== 'COMPLETED' ? null : standings.every((x) => x.finished) ? 'completed' : 'time_up';

  // Max score = points of the questions actually played in this session (locked, so stable).
  const played = await sql<{ total: number | null }>`
    SELECT SUM(q.point_value) AS total FROM question q
    WHERE q.question_id IN (SELECT DISTINCT ua.question_id FROM user_answer ua JOIN quiz_attempt a ON a.attempt_id = ua.attempt_id WHERE a.session_id = ${sessionId})
  `.execute(db);

  let myAnswers: SessionResultDto['myAnswers'] = null;
  if (myAttempt) {
    const answers = await db
      .selectFrom('user_answer as ua')
      .innerJoin('question as q', 'q.question_id', 'ua.question_id')
      .leftJoin('answer_option as o', 'o.option_id', 'ua.selected_option_id')
      .select(['ua.user_answer_id', 'ua.question_id', 'ua.text_answer', 'ua.is_correct', 'ua.points_earned', 'q.display_order', 'q.question_text', 'q.question_type', 'q.point_value', 'q.correct_text_answer', 'o.option_text', 'ua.selected_option_id'])
      .where('ua.attempt_id', '=', myAttempt.attempt_id)
      .orderBy('q.display_order')
      .execute();
    const qIds = answers.map((a) => a.question_id);
    const [correctOptions, pairs, matches] = qIds.length
      ? await Promise.all([
          db.selectFrom('answer_option').select(['question_id', 'option_text']).where('question_id', 'in', qIds).where('is_correct', '=', true).execute(),
          db.selectFrom('matching_pair').select(['pair_id', 'question_id', 'left_item', 'right_item', 'display_order']).where('question_id', 'in', qIds).orderBy('display_order').execute(),
          db.selectFrom('user_answer_match').select(['user_answer_id', 'left_pair_id', 'selected_right_pair_id']).where('user_answer_id', 'in', answers.map((a) => a.user_answer_id)).execute(),
        ])
      : [[], [], []];
    myAnswers = answers.map((a) => {
      const qPairs = pairs.filter((p) => p.question_id === a.question_id);
      let yourAnswer = '';
      let correctAnswer = '';
      switch (a.question_type) {
        case 'MULTIPLE_CHOICE':
        case 'TRUE_FALSE':
          yourAnswer = a.option_text ?? '';
          correctAnswer = correctOptions.find((o) => o.question_id === a.question_id)?.option_text ?? '';
          break;
        case 'OPEN_ANSWER':
        case 'FILL_IN_THE_BLANK':
          yourAnswer = a.text_answer ?? '';
          correctAnswer = a.correct_text_answer ?? '';
          break;
        case 'MATCHING': {
          const mine = matches.filter((m) => m.user_answer_id === a.user_answer_id);
          yourAnswer = mine
            .map((m) => `${qPairs.find((p) => p.pair_id === m.left_pair_id)?.left_item} → ${qPairs.find((p) => p.pair_id === m.selected_right_pair_id)?.right_item}`)
            .join('; ');
          correctAnswer = qPairs.map((p) => `${p.left_item} → ${p.right_item}`).join('; ');
          break;
        }
      }
      return {
        questionId: a.question_id,
        displayOrder: a.display_order,
        questionText: a.question_text,
        questionType: a.question_type,
        pointValue: a.point_value,
        yourAnswer,
        correctAnswer,
        isCorrect: a.is_correct,
        pointsEarned: a.points_earned,
      };
    });
  }

  return {
    sessionId: s.session_id,
    roomId: s.room_id,
    roomName: s.room_name,
    quizId: s.quiz_id,
    quizTitle: s.title,
    status: s.session_status,
    startedAt: s.started_at?.toISOString() ?? null,
    endedAt: s.ended_at?.toISOString() ?? null,
    endReason,
    winner: winnerOf(standings),
    standings,
    myAnswers,
    myTotalScore: myAttempt?.total_score ?? null,
    maxScore: Number(played.rows[0]?.total ?? 0),
  };
}

function historyQuery(userId: number) {
  return db
    .selectFrom('quiz_session as s')
    .innerJoin('quiz as q', 'q.quiz_id', 's.quiz_id')
    .innerJoin('room as r', 'r.room_id', 's.room_id')
    .leftJoin('quiz_attempt as mine', (j) => j.onRef('mine.session_id', '=', 's.session_id').on('mine.user_id', '=', userId))
    .select((eb) => [
      's.session_id', 's.room_id', 'r.name as room_name', 'q.title', 's.session_status', 's.created_at', 's.started_at', 's.ended_at', 'mine.total_score',
      eb.selectFrom('quiz_attempt as a').select(eb.fn.countAll<number>().as('n')).whereRef('a.session_id', '=', 's.session_id').as('participant_count'),
    ])
    .orderBy('s.created_at', 'desc')
    .orderBy('s.session_id', 'desc')
    .limit(200);
}
type HistoryRow = Awaited<ReturnType<ReturnType<typeof historyQuery>['executeTakeFirstOrThrow']>>;
const toHistory = (r: HistoryRow): SessionHistoryItemDto => ({
  sessionId: r.session_id,
  roomId: r.room_id,
  roomName: r.room_name,
  quizTitle: r.title,
  status: r.session_status,
  createdAt: r.created_at.toISOString(),
  startedAt: r.started_at?.toISOString() ?? null,
  endedAt: r.ended_at?.toISOString() ?? null,
  participantCount: Number(r.participant_count ?? 0),
  myScore: r.total_score ?? null,
});

export async function listRoomSessions(roomId: number, userId: number): Promise<SessionHistoryItemDto[]> {
  await requireRoomMember(roomId, userId);
  return (await historyQuery(userId).where('s.room_id', '=', roomId).execute()).map(toHistory);
}

export async function listMySessions(userId: number): Promise<SessionHistoryItemDto[]> {
  return (await historyQuery(userId).where('mine.user_id', '=', userId).execute()).map(toHistory);
}

/** Startup recovery (A-21): timers do not survive a restart. */
export async function cancelOrphanedSessions(): Promise<number> {
  const res = await db
    .updateTable('quiz_session')
    .set({ session_status: 'CANCELLED', ended_at: new Date() })
    .where('active_flag', '=', 1)
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Contiene la parte REST de las partidas: creación de sesiones, resultados, historial y
recuperación tras un reinicio.

Responsabilidades principales:
- createSession: solo OWNER/ADMIN; el cuestionario debe estar en la sala, publicado y con preguntas.
- loadStandings: clasificación final ordenada por puntuación; el ganador (mayor puntuación, desempate
  por finalización más temprana) se marca y va en primer lugar.
- getSessionResult: ganador, motivo de fin, clasificación, puntuación máxima jugada y las respuestas propias del usuario.
- listRoomSessions y listMySessions: historial.
- cancelOrphanedSessions: marca como CANCELLED las sesiones activas al arrancar.
- describeCorrectAnswer: texto legible de la respuesta correcta.

Elementos importantes:
- describeCorrectAnswer
- createSession
- getSessionRow
- getSessionResult
- listRoomSessions
- listMySessions
- cancelOrphanedSessions

Dependencias:
- kysely (sql)
- db/index.ts
- http/errors.ts
- services/permissions.ts
- @rush/shared

Flujo de datos:
Lee y escribe quiz_session; lee quiz_attempt, user_answer, user_answer_match y question para los
resultados.

Aspectos técnicos importantes:
- La restricción UNIQUE(room_id, active_flag) de MySQL garantiza una sola sesión activa por sala; un
  duplicado se traduce en 409.

Lugar en la arquitectura:
Capa de servicios. Proporciona los resultados y el historial que muestra el frontend.
*/
