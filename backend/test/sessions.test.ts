import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { GameEndDto, LiveQuestionDto, QuestionEndDto, TimerSyncDto } from '@rush/shared';
import { db } from '../src/db';
import { runMigrations } from '../src/db/migrations';
import { outbox } from '../src/integrations/mailer';
import * as socketModule from '../src/realtime/socket';
import { addMember, as, connect, createQuiz, createRoom, emit, mcQuestion, next, questionsOf, registerUser, startServer, type TestUser } from './helpers';

let server: Awaited<ReturnType<typeof startServer>>;
const sockets: Socket[] = [];

beforeAll(async () => {
  server = await startServer();
});
afterEach(async () => {
  // the DB is truncated between tests, so in-memory sessions must not outlive a test
  for (const s of sockets.splice(0)) s.disconnect();
  await socketModule.engine.shutdown();
  socketModule.engine.timeScale = 1;
  socketModule.engine.syncIntervalMs = 5000;
});
afterAll(async () => {
  await server.close();
});

async function sock(u: TestUser) {
  const s = await connect(server.url, u);
  sockets.push(s);
  return s;
}

async function setup(questions = [mcQuestion('Q1', 100), mcQuestion('Q2', 50)], totalTimeLimitSeconds?: number) {
  const owner = await registerUser();
  const member = await registerUser();
  const outsider = await registerUser();
  const roomId = await createRoom(owner);
  await addMember(roomId, owner, member);
  const quizId = await createQuiz(owner, questions, true, totalTimeLimitSeconds);
  await as(owner).post(`/api/rooms/${roomId}/quizzes`, { quizId });
  const created = await as(owner).post(`/api/rooms/${roomId}/sessions`, { quizId });
  expect(created.status).toBe(201);
  return { owner, member, outsider, roomId, quizId, sessionId: created.body.sessionId as number };
}

/** owner + member joined and the game started; returns both sockets and their first questions */
async function startedGame(questions?: Parameters<typeof setup>[0], totalTimeLimitSeconds?: number) {
  const ctx = await setup(questions, totalTimeLimitSeconds);
  const so = await sock(ctx.owner);
  const sm = await sock(ctx.member);
  await emit(so, 'session:join', { sessionId: ctx.sessionId });
  await emit(sm, 'session:join', { sessionId: ctx.sessionId });
  const started = next<TimerSyncDto>(so, 'session:started');
  const q1o = next<LiveQuestionDto>(so, 'session:question');
  const q1m = next<LiveQuestionDto>(sm, 'session:question');
  expect((await emit(so, 'session:start', { sessionId: ctx.sessionId })).ok).toBe(true);
  return { ...ctx, so, sm, started: await started, q1o: await q1o, q1m: await q1m };
}

const optionId = (q: LiveQuestionDto, text: string) => q.options.find((o) => o.text === text)!.optionId;
const answerOpt = (s: Socket, sessionId: number, q: LiveQuestionDto, text: string) =>
  emit<{ accepted: true; result: QuestionEndDto; finished: boolean }>(s, 'session:answer', { sessionId, questionId: q.questionId, answer: { kind: 'option', optionId: optionId(q, text) } });

describe('session lifecycle', () => {
  it('runs a full game: lobby → global timer → players advance independently → highest score wins', async () => {
    const { owner, member, outsider, roomId, quizId, sessionId } = await setup();
    const so = await sock(owner);
    const sm = await sock(member);
    const sx = await sock(outsider);

    // only room members can join
    expect((await emit(sx, 'session:join', { sessionId })).error?.code).toBe('not_member');
    const joinOwner = await emit<{ lobby: { canControl: boolean; totalTimeLimitSeconds: number } }>(so, 'session:join', { sessionId });
    expect(joinOwner.ok).toBe(true);
    expect(joinOwner.data!.lobby).toMatchObject({ canControl: true, totalTimeLimitSeconds: 300 });
    const lobbyUpdate = next(so, 'session:lobby');
    const joinMember = await emit<{ lobby: { canControl: boolean } }>(sm, 'session:join', { sessionId });
    expect(joinMember.data!.lobby.canControl).toBe(false);
    expect((await lobbyUpdate).participants).toHaveLength(2);

    // only OWNER/ADMIN can start
    expect((await emit(sm, 'session:start', { sessionId })).error?.code).toBe('forbidden');

    const startedO = next<TimerSyncDto>(so, 'session:started');
    const startedM = next<TimerSyncDto>(sm, 'session:started');
    const q1o = next<LiveQuestionDto>(so, 'session:question');
    const q1m = next<LiveQuestionDto>(sm, 'session:question');
    const before = Date.now();
    expect((await emit(so, 'session:start', { sessionId })).ok).toBe(true);
    const [st, stm, q1, q1b] = await Promise.all([startedO, startedM, q1o, q1m]);
    // ONE global deadline = start + the quiz's total time (300 s), the same for every player
    expect(st.totalTimeLimitSeconds).toBe(300);
    expect(st.endsAt).toBe(stm.endsAt);
    expect(st.endsAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(st.endsAt).toBeLessThan(before + 302_000);
    expect(q1.endsAt).toBe(st.endsAt);
    expect(q1b.endsAt).toBe(st.endsAt);
    expect(q1.questionId).toBe(q1b.questionId);
    expect(JSON.stringify(q1)).not.toMatch(/isCorrect|correct/i); // no answers sent to clients
    expect(q1).toMatchObject({ index: 0, total: 2, questionText: 'Q1', totalTimeLimitSeconds: 300 });

    // nobody new can join after the start
    const late = await registerUser();
    await addMember(roomId, owner, late);
    expect((await emit(await sock(late), 'session:join', { sessionId })).error?.code).toBe('already_started');

    // owner answers Q1 correctly. Each player only sees their own result.
    const endO1 = next<QuestionEndDto>(so, 'session:question-end');
    const q2o = next<LiveQuestionDto>(so, 'session:question');
    const a1 = await answerOpt(so, sessionId, q1, 'annyeong');
    expect(a1.ok).toBe(true);
    expect(a1.data).toMatchObject({ finished: false, result: { isCorrect: true, pointsEarned: 100 } });
    expect(await endO1).toMatchObject({ answered: true, isCorrect: true, pointsEarned: 100, correctAnswer: 'annyeong' });
    expect((await answerOpt(so, sessionId, q1, 'annyeong')).error?.code).toBe('wrong_question'); // already moved on
    expect((await emit(sm, 'session:answer', { sessionId, questionId: q1b.questionId, answer: { kind: 'option', optionId: 999999 } })).error?.code).toBe('invalid_answer');

    // the owner advanced alone; moving to the next question does NOT reset the global timer
    const q2 = await q2o;
    expect(q2).toMatchObject({ index: 1, questionText: 'Q2' });
    expect(q2.endsAt).toBe(st.endsAt);
    expect(socketModule.engine.deadlineOf(sessionId)).toBe(st.endsAt);

    // the member answers Q1 wrong (0 points) and is still on Q2 — mid-game, not finished
    const q2mP = next<LiveQuestionDto>(sm, 'session:question');
    expect((await answerOpt(sm, sessionId, q1b, 'gamsa')).data?.finished).toBe(false);
    const q2m = await q2mP;
    expect(q2m.endsAt).toBe(st.endsAt);
    // the game is still running and there is no winner yet: nobody has finished
    await socketModule.engine.drain(sessionId);
    expect(socketModule.engine.isLive(sessionId)).toBe(true);
    expect(await db.selectFrom('quiz_session').select(['winner_user_id', 'session_status']).where('session_id', '=', sessionId).executeTakeFirstOrThrow())
      .toEqual({ winner_user_id: null, session_status: 'IN_PROGRESS' });

    // Scenario A: the owner answers Q2 correctly and FINISHES FIRST (150). Finishing first ends the
    // session for everyone immediately — the member never gets to finish — and here the owner also
    // has the highest score, so the owner wins.
    const doneO = next<GameEndDto>(so, 'session:completed');
    const doneM = next<GameEndDto>(sm, 'session:completed');
    const last = await answerOpt(so, sessionId, q2, 'annyeong');
    expect(last.ok).toBe(true);
    expect(last.data?.finished).toBe(true);
    const [endO, endM] = await Promise.all([doneO, doneM]);
    expect(endO).toEqual(endM); // everybody receives the same final results
    expect(endO.reason).toBe('completed');
    expect(endO.winner).toMatchObject({ userId: owner.userId, username: owner.username });
    // the member is cut off mid-game with the points earned so far (0) and is not marked finished
    expect(endO.standings.map((s) => [s.userId, s.totalScore, s.isWinner, s.finished])).toEqual([
      [owner.userId, 150, true, true],
      [member.userId, 0, false, false],
    ]);

    // nobody can answer after the game ended
    expect((await answerOpt(sm, sessionId, q2m, 'gamsa')).error?.code).toBe('session_ended');

    // durable record
    const session = await db.selectFrom('quiz_session').selectAll().where('session_id', '=', sessionId).executeTakeFirstOrThrow();
    expect(session).toMatchObject({ session_status: 'COMPLETED', winner_user_id: owner.userId });
    expect(session.started_at).not.toBeNull();
    expect(session.ended_at).not.toBeNull();
    const attempts = await db.selectFrom('quiz_attempt').select(['user_id', 'finished_at']).where('session_id', '=', sessionId).execute();
    // only the owner finished (which ended the session); the member was still playing — no completion time
    expect(attempts.find((a) => a.user_id === owner.userId)!.finished_at).not.toBeNull();
    expect(attempts.find((a) => a.user_id === member.userId)!.finished_at).toBeNull();
    const answers = await db.selectFrom('user_answer as ua').innerJoin('quiz_attempt as a', 'a.attempt_id', 'ua.attempt_id')
      .select(['a.user_id', 'ua.selected_option_id']).where('a.session_id', '=', sessionId).execute();
    // owner answered both; the member answered only Q1, so their unanswered Q2 is stored as a 0-point filler
    expect(answers).toHaveLength(4);
    expect(answers.filter((a) => a.selected_option_id === null)).toHaveLength(1);
    expect(outbox.filter((m) => /is starting/.test(m.subject))).toHaveLength(2);

    // results API: winner, reason, own answers and standings
    const res = await as(owner).get(`/api/sessions/${sessionId}/results`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'COMPLETED', endReason: 'completed', winner: { userId: owner.userId }, myTotalScore: 150, maxScore: 150 });
    expect(res.body.standings[0]).toMatchObject({ userId: owner.userId, isWinner: true });
    expect(res.body.myAnswers.map((a: { isCorrect: boolean }) => a.isCorrect)).toEqual([true, true]);
    expect((await as(outsider).get(`/api/sessions/${sessionId}/results`)).status).toBe(404);
    const history = await as(member).get(`/api/rooms/${roomId}/sessions`);
    expect(history.body[0]).toMatchObject({ sessionId, myScore: 0, participantCount: 2 });
    expect((await as(member).get('/api/sessions/mine')).body).toHaveLength(1);

    // historical results stay consistent: played questions are locked (A-7)
    const [played] = await questionsOf(quizId);
    const edit = await as(owner).put(`/api/questions/${played!.question_id}`, mcQuestion('Changed'));
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('question_locked');
    expect((await as(owner).delete(`/api/questions/${played!.question_id}`)).status).toBe(409);
    const after = await as(owner).get(`/api/sessions/${sessionId}/results`);
    expect(after.body.myAnswers).toEqual(res.body.myAnswers);
    // but new questions can still be added
    expect((await as(owner).post(`/api/quizzes/${quizId}/questions`, mcQuestion('Q3'))).status).toBe(201);
  });

  it('starts the global timer only once per session', async () => {
    const { so, sessionId, started } = await startedGame();
    const deadline = socketModule.engine.deadlineOf(sessionId);
    expect(deadline).toBe(started.endsAt);
    await new Promise((r) => setTimeout(r, 50));
    expect((await emit(so, 'session:start', { sessionId })).error?.code).toBe('already_started');
    expect(socketModule.engine.deadlineOf(sessionId)).toBe(deadline);
  });

  it('broadcasts the same global deadline to every player periodically', async () => {
    socketModule.engine.syncIntervalMs = 150;
    const { so, sm, started } = await startedGame();
    const [to, tm] = await Promise.all([next<TimerSyncDto>(so, 'session:timer'), next<TimerSyncDto>(sm, 'session:timer')]);
    expect(to.endsAt).toBe(started.endsAt);
    expect(tm.endsAt).toBe(started.endsAt);
    expect(to.totalTimeLimitSeconds).toBe(300);
    expect(Math.abs(to.serverNow - Date.now())).toBeLessThan(2000);
    // a later tick still carries the unchanged deadline
    expect((await next<TimerSyncDto>(so, 'session:timer')).endsAt).toBe(started.endsAt);
  });

  // Scenario C — equal scores: the player who finished first wins the tie by earliest completion.
  it('breaks a score tie in favour of the player who completed earliest and flags exactly one winner', async () => {
    const { owner, member, so, sm, sessionId, q1o, q1m } = await startedGame([mcQuestion('Q1', 100), mcQuestion('Q2', 100)]);
    // the member answers Q1 correctly (100) and is left waiting on Q2
    const q2mP = next<LiveQuestionDto>(sm, 'session:question');
    expect((await answerOpt(sm, sessionId, q1m, 'annyeong')).data?.finished).toBe(false);
    await q2mP;
    // the owner answers Q1 correctly (100) then Q2 wrong (0) → finishes FIRST with 100, ending the session
    const q2oP = next<LiveQuestionDto>(so, 'session:question');
    await answerOpt(so, sessionId, q1o, 'annyeong');
    const doneO = next<GameEndDto>(so, 'session:completed');
    const doneM = next<GameEndDto>(sm, 'session:completed');
    expect((await answerOpt(so, sessionId, await q2oP, 'gamsa')).data?.finished).toBe(true);
    const [eo, em] = await Promise.all([doneO, doneM]);
    // both ended on 100 points; every client sees the same result and exactly one winner
    expect(eo).toEqual(em);
    expect(eo.reason).toBe('completed');
    expect(eo.standings.every((s) => s.totalScore === 100)).toBe(true);
    expect(eo.standings.filter((s) => s.isWinner)).toHaveLength(1);
    // the owner wins the tie: they completed (earliest completion) while the member never finished
    expect(eo.winner?.userId).toBe(owner.userId);
    expect(eo.standings.find((s) => s.userId === owner.userId)).toMatchObject({ finished: true, isWinner: true });
    expect(eo.standings.find((s) => s.userId === member.userId)).toMatchObject({ finished: false, isWinner: false });
    const row = await db.selectFrom('quiz_session').select(['winner_user_id', 'session_status']).where('session_id', '=', sessionId).executeTakeFirstOrThrow();
    expect(row).toEqual({ winner_user_id: owner.userId, session_status: 'COMPLETED' });
  });

  it('when the global time runs out first, the game ends and the highest score still wins', async () => {
    socketModule.engine.timeScale = 0.02; // 60 s → 1.2 s
    const { owner, member, so, sm, sessionId, q1o, q1m, started } = await startedGame(undefined, 60);
    expect(started.totalTimeLimitSeconds).toBe(60);
    await answerOpt(so, sessionId, q1o, 'annyeong'); // owner: 100 points, then stops (never finishes)
    const doneO = next<GameEndDto>(so, 'session:completed', 5000);
    const doneM = next<GameEndDto>(sm, 'session:completed', 5000);
    const [eo, em] = await Promise.all([doneO, doneM]);
    expect(Date.now()).toBeGreaterThanOrEqual(started.endsAt);
    expect(eo).toEqual(em);
    expect(eo.reason).toBe('time_up');
    // nobody answered every question, but the owner has the highest score and still wins
    expect(eo.winner).toMatchObject({ userId: owner.userId });
    expect(eo.standings.map((s) => [s.userId, s.totalScore, s.isWinner])).toEqual([[owner.userId, 100, true], [member.userId, 0, false]]);
    expect((await answerOpt(sm, sessionId, q1m, 'annyeong')).error?.code).toBe('session_ended');
    const row = await db.selectFrom('quiz_session').select(['winner_user_id', 'session_status']).where('session_id', '=', sessionId).executeTakeFirstOrThrow();
    expect(row).toEqual({ winner_user_id: owner.userId, session_status: 'COMPLETED' });
    // every unanswered question is recorded with 0 points (A-10): 2 players × 2 questions in total
    const n = await db.selectFrom('user_answer as ua').innerJoin('quiz_attempt as a', 'a.attempt_id', 'ua.attempt_id').select('ua.user_answer_id').where('a.session_id', '=', sessionId).execute();
    expect(n).toHaveLength(4);
    const res = await as(member).get(`/api/sessions/${sessionId}/results`);
    expect(res.body).toMatchObject({ endReason: 'time_up', winner: { userId: owner.userId } });
  });

  it('a disconnect never declares a winner; the player can reconnect and resume with the remaining time', async () => {
    const { owner, member, so, sm, sessionId, q1o, q1m, started } = await startedGame([mcQuestion('Q1'), mcQuestion('Q2'), mcQuestion('Q3')]);
    // member answers Q1, then drops
    const q2mP = next<LiveQuestionDto>(sm, 'session:question');
    await answerOpt(sm, sessionId, q1m, 'annyeong');
    const memberQ2 = await q2mP;
    sm.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    await socketModule.engine.drain(sessionId);
    const attempt = await db.selectFrom('quiz_attempt').selectAll().where('session_id', '=', sessionId).where('user_id', '=', member.userId).executeTakeFirstOrThrow();
    expect(attempt.disconnected_at).not.toBeNull();
    // the game goes on and nobody won
    expect(socketModule.engine.isLive(sessionId)).toBe(true);
    const row = await db.selectFrom('quiz_session').select(['winner_user_id', 'session_status']).where('session_id', '=', sessionId).executeTakeFirstOrThrow();
    expect(row).toEqual({ winner_user_id: null, session_status: 'IN_PROGRESS' });
    // the owner keeps playing
    const q2oP = next<LiveQuestionDto>(so, 'session:question');
    await answerOpt(so, sessionId, q1o, 'annyeong');
    const ownerQ2 = await q2oP;
    expect(ownerQ2.index).toBe(1);

    // reconnect: same progress (Q2), same global deadline, disconnected_at cleared
    const again = await sock(member);
    const rejoin = await emit<{ lobby: { status: string }; current: LiveQuestionDto }>(again, 'session:join', { sessionId });
    expect(rejoin.ok).toBe(true);
    expect(rejoin.data!.lobby.status).toBe('IN_PROGRESS');
    expect(rejoin.data!.current).toMatchObject({ index: 1, questionId: memberQ2.questionId, endsAt: started.endsAt });
    expect(rejoin.data!.current.serverNow).toBeLessThan(started.endsAt);
    const back = await db.selectFrom('quiz_attempt').select('disconnected_at').where('attempt_id', '=', attempt.attempt_id).executeTakeFirstOrThrow();
    expect(back.disconnected_at).toBeNull();

    // the reconnected member now finishes all three questions (300 points) FIRST. Finishing first
    // ends the session immediately — the owner is still on Q2 with only 100 points — yet the winner
    // is decided by score, so the member's higher score wins.
    const q3mP = next<LiveQuestionDto>(again, 'session:question');
    await answerOpt(again, sessionId, rejoin.data!.current, 'annyeong'); // Q2
    const done = next<GameEndDto>(so, 'session:completed');
    const memberFinish = await answerOpt(again, sessionId, await q3mP, 'annyeong'); // Q3 → finishes first
    expect(memberFinish.data?.finished).toBe(true);
    const end = await done;
    expect(end.reason).toBe('completed');
    expect(end.winner?.userId).toBe(member.userId);
    expect(end.standings[0]).toMatchObject({ userId: member.userId, totalScore: 300, isWinner: true, finished: true });
    expect(end.standings[1]).toMatchObject({ userId: owner.userId, totalScore: 100, isWinner: false, finished: false });
    // the owner can no longer answer the questions they had left
    expect((await answerOpt(so, sessionId, ownerQ2, 'annyeong')).error?.code).toBe('session_ended');
  });

  it('schema migrations are idempotent on an up-to-date database', async () => {
    expect(await runMigrations(db)).toEqual([]);
  });

  it('allows only one active session per room and requires a published quiz', async () => {
    const { owner, roomId, quizId } = await setup();
    const second = await as(owner).post(`/api/rooms/${roomId}/sessions`, { quizId });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('session_active');
    const draft = await createQuiz(owner, [mcQuestion()], false);
    await as(owner).post(`/api/rooms/${roomId}/quizzes`, { quizId: draft });
    const room2 = await createRoom(owner, 'R2');
    await as(owner).post(`/api/rooms/${room2}/quizzes`, { quizId: draft });
    expect((await as(owner).post(`/api/rooms/${room2}/sessions`, { quizId: draft })).body.error.code).toBe('quiz_not_published');
  });

  it('only OWNER/ADMIN can create sessions', async () => {
    const { member, roomId, quizId, owner, sessionId } = await setup();
    await as(owner).post(`/api/sessions/${sessionId}/cancel`);
    expect((await as(member).post(`/api/rooms/${roomId}/sessions`, { quizId })).status).toBe(403);
  });

  it('cancels a session (OWNER/ADMIN only) and notifies players', async () => {
    const { owner, member, sessionId } = await setup();
    const sm = await sock(member);
    await emit(sm, 'session:join', { sessionId });
    expect((await as(member).post(`/api/sessions/${sessionId}/cancel`)).status).toBe(403);
    const cancelled = next(sm, 'session:cancelled');
    expect((await as(owner).post(`/api/sessions/${sessionId}/cancel`)).status).toBe(204);
    await cancelled;
    const row = await db.selectFrom('quiz_session').select('session_status').where('session_id', '=', sessionId).executeTakeFirstOrThrow();
    expect(row.session_status).toBe('CANCELLED');
  });

  it('leaving the lobby removes the player; a player who drops during the game can rejoin', async () => {
    const { owner, member, sessionId } = await setup();
    const so = await sock(owner);
    let sm = await sock(member);
    await emit(so, 'session:join', { sessionId });
    await emit(sm, 'session:join', { sessionId });
    const lobby = next<{ participants: unknown[] }>(so, 'session:lobby');
    sm.disconnect();
    expect((await lobby).participants).toHaveLength(1);
    expect(await db.selectFrom('quiz_attempt').select('attempt_id').where('session_id', '=', sessionId).where('user_id', '=', member.userId).executeTakeFirst()).toBeUndefined();

    sm = await sock(member);
    expect((await emit(sm, 'session:join', { sessionId })).ok).toBe(true); // may rejoin while WAITING
    const q = next<LiveQuestionDto>(sm, 'session:question');
    await emit(so, 'session:start', { sessionId });
    await q;
    sm.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    await socketModule.engine.drain(sessionId);
    const attempt = await db.selectFrom('quiz_attempt').selectAll().where('session_id', '=', sessionId).where('user_id', '=', member.userId).executeTakeFirstOrThrow();
    expect(attempt.disconnected_at).not.toBeNull();
    const again = await sock(member);
    const rejoin = await emit<{ current: LiveQuestionDto }>(again, 'session:join', { sessionId });
    expect(rejoin.ok).toBe(true);
    expect(rejoin.data!.current.index).toBe(0);
  });

  it('grades matching and text answers on the server', async () => {
    const { owner, sessionId } = await setup([
      { questionType: 'MATCHING', questionText: 'Match', pairs: [{ left: 'cat', right: 'goyangi' }, { left: 'dog', right: 'gae' }] },
      { questionType: 'FILL_IN_THE_BLANK', questionText: 'I ___ a student', correctTextAnswer: 'am', pointValue: 30 },
    ]);
    const so = await sock(owner);
    await emit(so, 'session:join', { sessionId });
    const qm = next<LiveQuestionDto>(so, 'session:question');
    await emit(so, 'session:start', { sessionId });
    const m = await qm;
    expect(m.matchingLeft).toHaveLength(2);
    expect(m.matchingRight.map((r) => r.text).sort()).toEqual(['gae', 'goyangi']);
    const matches = m.matchingLeft.map((l) => ({ leftPairId: l.pairId, rightPairId: l.pairId }));
    const end1 = next<QuestionEndDto>(so, 'session:question-end');
    const nextQ = next<LiveQuestionDto>(so, 'session:question');
    expect((await emit(so, 'session:answer', { sessionId, questionId: m.questionId, answer: { kind: 'matching', matches } })).ok).toBe(true);
    expect((await end1).isCorrect).toBe(true);
    const t = await nextQ;
    const end2 = next<QuestionEndDto>(so, 'session:question-end');
    const doneP = next<GameEndDto>(so, 'session:completed');
    await emit(so, 'session:answer', { sessionId, questionId: t.questionId, answer: { kind: 'text', text: '  AM ' } });
    expect(await end2).toMatchObject({ isCorrect: true, pointsEarned: 30 });
    const done = await doneP;
    expect(done.standings[0]!.totalScore).toBe(130);
    expect(done.winner?.userId).toBe(owner.userId);
    const stored = await db.selectFrom('user_answer_match').selectAll().execute();
    expect(stored).toHaveLength(2);
  });

  it('a user can play simultaneous sessions in different rooms', async () => {
    const a = await setup();
    const owner2 = await registerUser();
    const room2 = await createRoom(owner2, 'Other');
    await addMember(room2, owner2, a.member);
    const quiz2 = await createQuiz(owner2);
    await as(owner2).post(`/api/rooms/${room2}/quizzes`, { quizId: quiz2 });
    const s2 = await as(owner2).post(`/api/rooms/${room2}/sessions`, { quizId: quiz2 });
    const sm = await sock(a.member);
    expect((await emit(sm, 'session:join', { sessionId: a.sessionId })).ok).toBe(true);
    expect((await emit(sm, 'session:join', { sessionId: s2.body.sessionId })).ok).toBe(true);
  });

  it('rejects unauthenticated sockets', async () => {
    await expect(connect(server.url, { cookie: 'rush.sid=bogus' } as TestUser)).rejects.toThrow();
  });
});

/**
 * The first player to finish decides WHEN the session ends; the highest final score decides WHO
 * wins. These two rules are independent, and these tests pin that down (scenarios A–E).
 */
describe('session termination (first finisher) vs winner determination (highest score)', () => {
  // Scenario A — the first player to finish also holds the highest score, so they win.
  it('A: the first player to finish wins when they also have the highest score', async () => {
    const { owner, member, so, sm, sessionId, q1o, q1m } = await startedGame(); // Q1=100, Q2=50
    // the member answers Q1 correctly (100) and is left on Q2 — they never finish
    const q2mP = next<LiveQuestionDto>(sm, 'session:question');
    await answerOpt(sm, sessionId, q1m, 'annyeong');
    await q2mP;
    // the owner answers Q1 (100) then Q2 (50) → finishes FIRST with 150, which ends the session
    const q2oP = next<LiveQuestionDto>(so, 'session:question');
    await answerOpt(so, sessionId, q1o, 'annyeong');
    const doneO = next<GameEndDto>(so, 'session:completed');
    const doneM = next<GameEndDto>(sm, 'session:completed');
    expect((await answerOpt(so, sessionId, await q2oP, 'annyeong')).data?.finished).toBe(true);
    const [eo, em] = await Promise.all([doneO, doneM]);
    expect(eo).toEqual(em);
    expect(eo.reason).toBe('completed');
    expect(eo.winner?.userId).toBe(owner.userId);
    expect(eo.standings.find((s) => s.userId === owner.userId)).toMatchObject({ totalScore: 150, isWinner: true, finished: true });
    expect(eo.standings.find((s) => s.userId === member.userId)).toMatchObject({ totalScore: 100, isWinner: false, finished: false });
  });

  // Scenario B — the first player to finish does NOT win: a player with more points who has not
  // finished still wins.
  it('B: a higher score held by a player who has not finished beats the first finisher', async () => {
    const { owner, member, so, sm, sessionId, q1o, q1m } = await startedGame(); // Q1=100, Q2=50
    // the member answers Q1 correctly (100) and stays on Q2 — they never finish
    const q2mP = next<LiveQuestionDto>(sm, 'session:question');
    await answerOpt(sm, sessionId, q1m, 'annyeong');
    await q2mP;
    // the owner answers Q1 wrong (0) then Q2 correct (50) → finishes FIRST with only 50
    const q2oP = next<LiveQuestionDto>(so, 'session:question');
    await answerOpt(so, sessionId, q1o, 'gamsa');
    const doneO = next<GameEndDto>(so, 'session:completed');
    const doneM = next<GameEndDto>(sm, 'session:completed');
    expect((await answerOpt(so, sessionId, await q2oP, 'annyeong')).data?.finished).toBe(true);
    const [eo, em] = await Promise.all([doneO, doneM]);
    expect(eo).toEqual(em);
    expect(eo.reason).toBe('completed');
    // the member wins with 100 even though the owner finished first (with 50)
    expect(eo.winner?.userId).toBe(member.userId);
    expect(eo.standings[0]).toMatchObject({ userId: member.userId, totalScore: 100, isWinner: true, finished: false });
    expect(eo.standings.find((s) => s.userId === owner.userId)).toMatchObject({ totalScore: 50, isWinner: false, finished: true });
    const row = await db.selectFrom('quiz_session').select(['winner_user_id', 'session_status']).where('session_id', '=', sessionId).executeTakeFirstOrThrow();
    expect(row).toEqual({ winner_user_id: member.userId, session_status: 'COMPLETED' });
  });

  // Scenario D — once the first player finishes, the session is closed and further answers are rejected.
  it('D: the server rejects any answer submitted after the session closes', async () => {
    const { so, sm, sessionId, q1o, q1m } = await startedGame([mcQuestion('Only', 100)]); // single question
    // the owner answers the only question → finishes FIRST → the session closes at once
    const doneM = next<GameEndDto>(sm, 'session:completed');
    expect((await answerOpt(so, sessionId, q1o, 'annyeong')).data?.finished).toBe(true);
    await doneM;
    await socketModule.engine.drain(sessionId);
    expect(socketModule.engine.isLive(sessionId)).toBe(false);
    // the member (who never answered) is rejected, and so is a repeated answer from the owner
    expect((await answerOpt(sm, sessionId, q1m, 'annyeong')).error?.code).toBe('session_ended');
    expect((await answerOpt(so, sessionId, q1o, 'annyeong')).error?.code).toBe('session_ended');
    const row = await db.selectFrom('quiz_session').select('session_status').where('session_id', '=', sessionId).executeTakeFirstOrThrow();
    expect(row.session_status).toBe('COMPLETED');
  });

  // Scenario E — every connected client receives the same final scores, ranking, status and winner.
  it('E: all clients receive identical final scores, ranking, status and winner', async () => {
    const { owner, member, so, sm, sessionId, q1o } = await startedGame(); // Q1=100, Q2=50
    const doneO = next<GameEndDto>(so, 'session:completed');
    const doneM = next<GameEndDto>(sm, 'session:completed');
    // the owner races through both questions and finishes first, ending the session
    const q2oP = next<LiveQuestionDto>(so, 'session:question');
    await answerOpt(so, sessionId, q1o, 'annyeong');
    await answerOpt(so, sessionId, await q2oP, 'annyeong');
    const [eo, em] = await Promise.all([doneO, doneM]);
    // both sockets get byte-for-byte the same end payload: same winner, ranking, scores and reason
    expect(eo).toEqual(em);
    expect(eo.winner?.userId).toBe(owner.userId);
    expect(eo.standings.map((s) => [s.userId, s.totalScore, s.isWinner])).toEqual([
      [owner.userId, 150, true],
      [member.userId, 0, false],
    ]);
    // the authoritative results endpoint agrees for both players
    const ro = await as(owner).get(`/api/sessions/${sessionId}/results`);
    const rm = await as(member).get(`/api/sessions/${sessionId}/results`);
    expect(ro.body).toMatchObject({ status: 'COMPLETED', endReason: 'completed', winner: { userId: owner.userId } });
    expect(rm.body).toMatchObject({ status: 'COMPLETED', endReason: 'completed', winner: { userId: owner.userId } });
    expect(ro.body.standings).toEqual(rm.body.standings);
  });
});

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Pruebas del ciclo de vida de las partidas en tiempo real usando conexiones Socket.IO
reales.

Responsabilidades principales:
- Partida completa: sala de espera, temporizador global, avance independiente de cada jugador. La
  sesión termina en cuanto el PRIMER jugador contesta todas las preguntas; el ganador es el de
  mayor puntuación final (que puede no ser quien terminó primero) y la clasificación final.
- El temporizador global se inicia una sola vez, no se reinicia al cambiar de pregunta y se
  sincroniza con todos los jugadores (session:timer).
- Empate de puntuación resuelto por finalización más temprana, con un único ganador.
- Fin por tiempo agotado (nadie terminó): gana la mayor puntuación; desconexión y reconexión sin
  declarar ganador.
- Separación entre fin de sesión (primer jugador en terminar) y elección del ganador (mayor
  puntuación): escenarios A–E.
- Migraciones idempotentes.
- Una sola sesión activa por sala; solo OWNER/ADMIN crea, inicia o cancela.
- Desconexiones en la sala de espera y durante la partida.
- Corrección de emparejamiento y texto; sesiones simultáneas en salas distintas; sockets sin sesión
  rechazados.
- Bloqueo de preguntas jugadas para conservar el historial.

Elementos importantes:
- 17 casos de prueba
- setup() (sala, miembro y cuestionario)

Dependencias:
- vitest
- socket.io-client
- test/helpers.ts
- src/realtime/socket.ts
- src/db/index.ts

Flujo de datos:
Usa timeScale y syncIntervalMs para acelerar el temporizador global en las pruebas que lo necesitan.

Aspectos técnicos importantes:
- Comprueba que las preguntas enviadas al cliente no contienen respuestas correctas.

Lugar en la arquitectura:
Pruebas automatizadas. Demuestra que el multijugador, los tiempos y la puntuación funcionan.
*/
