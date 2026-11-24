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

    // the member races through both questions wrong and finishes FIRST (0 points). Finishing first
    // must NOT win and must NOT end the game: the owner still has a question left.
    const q2mP = next<LiveQuestionDto>(sm, 'session:question');
    expect((await answerOpt(sm, sessionId, q1b, 'gamsa')).data?.finished).toBe(false);
    const q2m = await q2mP;
    expect(q2m.endsAt).toBe(st.endsAt);
    const memberDone = await answerOpt(sm, sessionId, q2m, 'gamsa');
    expect(memberDone.data?.finished).toBe(true);
    // the game keeps running and there is no winner yet, because the owner has not finished
    await socketModule.engine.drain(sessionId);
    expect(socketModule.engine.isLive(sessionId)).toBe(true);
    expect(await db.selectFrom('quiz_session').select(['winner_user_id', 'session_status']).where('session_id', '=', sessionId).executeTakeFirstOrThrow())
      .toEqual({ winner_user_id: null, session_status: 'IN_PROGRESS' });

    // the owner answers Q2 correctly and finishes LAST with the higher score (150) → the owner wins
    const doneO = next<GameEndDto>(so, 'session:completed');
    const doneM = next<GameEndDto>(sm, 'session:completed');
    const last = await answerOpt(so, sessionId, q2, 'annyeong');
    expect(last.ok).toBe(true);
    expect(last.data?.finished).toBe(true);
    const [endO, endM] = await Promise.all([doneO, doneM]);
    expect(endO).toEqual(endM); // everybody receives the same final results
    expect(endO.reason).toBe('completed');
    expect(endO.winner).toMatchObject({ userId: owner.userId, username: owner.username });
    // highest final score wins even though the member finished first; the winner is listed first
    expect(endO.standings.map((s) => [s.userId, s.totalScore, s.isWinner, s.finished])).toEqual([
      [owner.userId, 150, true, true],
      [member.userId, 0, false, true],
    ]);

    // nobody can answer after the game ended
    expect((await answerOpt(sm, sessionId, q2m, 'gamsa')).error?.code).toBe('session_ended');

    // durable record
    const session = await db.selectFrom('quiz_session').selectAll().where('session_id', '=', sessionId).executeTakeFirstOrThrow();
    expect(session).toMatchObject({ session_status: 'COMPLETED', winner_user_id: owner.userId });
    expect(session.started_at).not.toBeNull();
    expect(session.ended_at).not.toBeNull();
    const attempts = await db.selectFrom('quiz_attempt').select(['user_id', 'finished_at']).where('session_id', '=', sessionId).execute();
    // both players finished, so both have a completion time (the member's is earlier)
    expect(attempts.find((a) => a.user_id === member.userId)!.finished_at).not.toBeNull();
    expect(attempts.find((a) => a.user_id === owner.userId)!.finished_at).not.toBeNull();
    const answers = await db.selectFrom('user_answer as ua').innerJoin('quiz_attempt as a', 'a.attempt_id', 'ua.attempt_id')
      .select(['a.user_id', 'ua.selected_option_id']).where('a.session_id', '=', sessionId).execute();
    expect(answers).toHaveLength(4); // every question answered by both players, no filler needed
    expect(answers.filter((a) => a.selected_option_id === null)).toHaveLength(0);
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

  it('breaks a score tie by the earliest completion and flags exactly one winner', async () => {
    const { so, sm, sessionId, q1o, q1m } = await startedGame([mcQuestion('Only', 100)]);
    const doneO = next<GameEndDto>(so, 'session:completed');
    const doneM = next<GameEndDto>(sm, 'session:completed');
    // both answer the only question correctly (100 each); the game ends once both have finished
    const [ro, rm] = await Promise.all([answerOpt(so, sessionId, q1o, 'annyeong'), answerOpt(sm, sessionId, q1m, 'annyeong')]);
    expect(ro.ok && rm.ok).toBe(true);
    expect(ro.data?.finished && rm.data?.finished).toBe(true);
    const [eo, em] = await Promise.all([doneO, doneM]);
    expect(eo).toEqual(em);
    expect(eo.reason).toBe('completed');
    expect(eo.standings.filter((s) => s.isWinner)).toHaveLength(1);
    expect(eo.standings.every((s) => s.totalScore === 100)).toBe(true);
    // the tie is broken deterministically by the earliest completion time, then the lowest user id
    const attempts = await db.selectFrom('quiz_attempt').select(['user_id', 'finished_at']).where('session_id', '=', sessionId).execute();
    const expected = attempts.slice().sort((a, b) => a.finished_at!.getTime() - b.finished_at!.getTime() || a.user_id - b.user_id)[0]!.user_id;
    expect(eo.winner?.userId).toBe(expected);
    const row = await db.selectFrom('quiz_session').select(['winner_user_id', 'session_status']).where('session_id', '=', sessionId).executeTakeFirstOrThrow();
    expect(row).toEqual({ winner_user_id: expected, session_status: 'COMPLETED' });
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

    // the reconnected member finishes all three questions (300 points) FIRST, but that alone does
    // not end the game or win it — the owner still has questions left.
    const q3mP = next<LiveQuestionDto>(again, 'session:question');
    await answerOpt(again, sessionId, rejoin.data!.current, 'annyeong');
    const memberFinish = await answerOpt(again, sessionId, await q3mP, 'annyeong');
    expect(memberFinish.data?.finished).toBe(true);
    await socketModule.engine.drain(sessionId);
    expect(socketModule.engine.isLive(sessionId)).toBe(true);

    // the owner finishes last with the lower score; the member's higher score still wins
    const q3oP = next<LiveQuestionDto>(so, 'session:question');
    await answerOpt(so, sessionId, ownerQ2, 'gamsa'); // Q2 wrong
    const done = next<GameEndDto>(so, 'session:completed');
    await answerOpt(so, sessionId, await q3oP, 'gamsa'); // Q3 wrong → owner finishes last
    const end = await done;
    expect(end.winner?.userId).toBe(member.userId);
    expect(end.standings[0]).toMatchObject({ userId: member.userId, totalScore: 300, isWinner: true });
    expect(end.standings[1]).toMatchObject({ userId: owner.userId, totalScore: 100 });
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

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Pruebas del ciclo de vida de las partidas en tiempo real usando conexiones Socket.IO
reales.

Responsabilidades principales:
- Partida completa: sala de espera, temporizador global, avance independiente de cada jugador,
  ganador por mayor puntuación final (aunque otro termine antes) y clasificación final.
- El temporizador global se inicia una sola vez, no se reinicia al cambiar de pregunta y se
  sincroniza con todos los jugadores (session:timer).
- Empate de puntuación resuelto por finalización más temprana, con un único ganador.
- Fin por tiempo agotado: gana la mayor puntuación; desconexión y reconexión sin declarar ganador.
- Migraciones idempotentes.
- Una sola sesión activa por sala; solo OWNER/ADMIN crea, inicia o cancela.
- Desconexiones en la sala de espera y durante la partida.
- Corrección de emparejamiento y texto; sesiones simultáneas en salas distintas; sockets sin sesión
  rechazados.
- Bloqueo de preguntas jugadas para conservar el historial.

Elementos importantes:
- 13 casos de prueba
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
