import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import type { AnswerSubmission, GameEndDto, LiveQuestionDto, StandingDto } from '@rush/shared';
import { ApiError } from '../../api/client';
import { sessionsApi } from '../../api/endpoints';
import { useMe } from '../../auth/AuthProvider';
import { NeonFloor } from '../../components/brand';
import { IconPlay } from '../../components/icons';
import { useConfirm } from '../../components/overlays';
import { Avatar, Button, ButtonLink, Card, cx, ErrorState, LoadingState, NotFoundState, Spinner } from '../../components/ui';
import { useI18n } from '../../i18n/I18nProvider';
import { MediaPreview } from '../quizzes/QuestionEditorModal';
import { QUESTION_TYPE_STYLE } from '../quizzes/questionTypes';
import { formatClock, formatDuration } from './time';
import { useGameSocket, type GlobalTimer } from './useGameSocket';

/*
 * Presentation of the live game. All state comes from useGameSocket: the server owns the ONE
 * global timer, grading, scores and the winner; this file only renders them.
 */

export function PlayPage() {
  const sessionId = Number(useParams().sessionId);
  const info = useQuery({ queryKey: ['session', sessionId], queryFn: () => sessionsApi.info(sessionId), retry: false, staleTime: 0 });
  if (info.isLoading) return <LoadingState />;
  if (info.error instanceof ApiError && info.error.status === 404) return <NotFoundState />;
  if (info.error) return <ErrorState error={info.error} onRetry={() => info.refetch()} />;
  const s = info.data!;
  if (s.status === 'COMPLETED' || s.status === 'CANCELLED') return <Navigate to={`/sessions/${sessionId}/results`} replace />;
  return <Game sessionId={sessionId} roomId={s.roomId} quizTitle={s.quizTitle} />;
}

function useCountdown(endsAt: number, clockOffset: number) {
  const [now, setNow] = useState(() => Date.now() + clockOffset);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + clockOffset), 200);
    return () => clearInterval(id);
  }, [clockOffset]);
  return Math.max(0, endsAt - now);
}

/** Neon stage used by every game screen. */
function Stage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="relative isolate mx-auto max-w-3xl">
      <div className="pointer-events-none absolute -inset-x-20 -top-10 -z-10 h-72 bg-[radial-gradient(closest-side,rgb(160_32_240/0.35),transparent)]" aria-hidden="true" />
      <p className="mb-4 text-center font-display text-xs font-bold uppercase tracking-[0.25em] text-cyan">{title}</p>
      {children}
    </div>
  );
}

function Game({ sessionId, roomId, quizTitle }: { sessionId: number; roomId: number; quizTitle: string }) {
  const { t } = useI18n();
  const me = useMe();
  const nav = useNavigate();
  const confirm = useConfirm();
  const game = useGameSocket(sessionId);
  const [actionError, setActionError] = useState<string | null>(null);
  const { phase, lobby } = game;

  const cancel = async () => {
    if (!(await confirm({ title: t('play.cancel'), message: t('play.cancelConfirm'), danger: true }))) return;
    const r = await game.cancel();
    if (!r.ok) setActionError(r.error.message);
  };

  if (phase.kind === 'connecting') {
    return (
      <Stage title={quizTitle}>
        <div className="flex items-center justify-center gap-3 py-24 font-display font-bold text-fg-soft">
          <Spinner className="h-6 w-6 text-cyan" /> {phase.reconnecting ? t('play.reconnecting') : t('play.connecting')}
        </div>
      </Stage>
    );
  }

  if (phase.kind === 'error' || phase.kind === 'cancelled' || phase.kind === 'removed' || phase.kind === 'disconnected') {
    const text =
      phase.kind === 'cancelled' ? t('play.cancelled') : phase.kind === 'removed' ? t('play.removed') : phase.kind === 'disconnected' ? t('play.disconnected') : phase.message;
    return (
      <Stage title={quizTitle}>
        <Card className="p-10 text-center">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl bg-danger/15 text-4xl ring-1 ring-danger/40">{phase.kind === 'cancelled' ? '🛑' : '🔌'}</div>
          {phase.kind === 'error' && <h1 className="mt-5 font-display text-2xl font-black">{t('play.cannotJoin')}</h1>}
          <p className="mt-3 text-fg-soft">{text}</p>
          <ButtonLink to={`/rooms/${roomId}`} variant="secondary" className="mt-8">
            {t('play.backToRoom')}
          </ButtonLink>
        </Card>
      </Stage>
    );
  }

  if (phase.kind === 'lobby') {
    const players = lobby?.participants ?? [];
    return (
      <Stage title={quizTitle}>
        <Card className="relative isolate overflow-hidden p-6 pb-24 sm:p-10 sm:pb-32">
          <NeonFloor className="-z-10 h-28 sm:h-36" cols={12} rows={4} dim />
          <div className="text-center">
            <h1 className="font-display text-4xl font-black tracking-tight sm:text-5xl">{t('play.waitingRoom')}</h1>
            <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-night/60 px-4 py-1.5 text-sm font-semibold text-fg-soft ring-1 ring-line">
              <span className="h-2 w-2 animate-glow rounded-full bg-lime shadow-[0_0_10px_var(--color-lime)]" />
              {game.canControl ? t('play.waitingFor') : t('play.hostWillStart')}
            </p>
            {lobby && (
              <p className="mx-auto mt-3 max-w-md font-display text-sm font-bold text-cyan">
                ⏱ {t('play.rules', { t: formatDuration(lobby.totalTimeLimitSeconds) })}
              </p>
            )}
            <p className="mt-2 text-xs text-muted">{t('play.noLeaderboard')}</p>
          </div>
          <div className="mt-8 flex items-center justify-between">
            <h2 className="font-display text-sm font-bold uppercase tracking-[0.18em] text-muted">{t('play.players', { n: players.length })}</h2>
          </div>
          <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {players.map((p) => (
              <li
                key={p.userId}
                className={cx(
                  'animate-pop flex items-center gap-3 rounded-2xl border px-3 py-2.5 backdrop-blur',
                  p.userId === me.userId ? 'border-magenta/60 bg-magenta/15 shadow-glow-magenta' : 'border-line bg-night/60',
                )}
              >
                <Avatar name={p.fullName} url={p.profilePictureUrl} size={34} />
                <span className="truncate font-display text-sm font-bold">{p.username}</span>
              </li>
            ))}
          </ul>
          {actionError && <p className="mt-5 text-center text-sm font-semibold text-danger-soft">{actionError}</p>}
          <div className="mt-10 flex flex-col-reverse justify-center gap-3 sm:flex-row">
            <Button variant="secondary" onClick={() => nav(`/rooms/${roomId}`)}>
              {t('play.leave')}
            </Button>
            {game.canControl && (
              <>
                <Button variant="ghost" className="text-danger-soft hover:bg-danger/10" onClick={cancel}>
                  {t('play.cancel')}
                </Button>
                <Button
                  size="lg"
                  className="text-lg"
                  onClick={async () => {
                    setActionError(null);
                    const r = await game.start();
                    if (!r.ok) setActionError(r.error.message);
                  }}
                >
                  <IconPlay size={18} /> {t('play.start')}
                </Button>
              </>
            )}
          </div>
        </Card>
      </Stage>
    );
  }

  if (phase.kind === 'question') {
    return (
      <Stage title={quizTitle}>
        <QuestionView
          key={phase.question.questionId}
          question={phase.question}
          timer={game.timer ?? { endsAt: phase.question.endsAt, clockOffset: phase.question.serverNow - Date.now(), totalTimeLimitSeconds: phase.question.totalTimeLimitSeconds }}
          submitted={phase.submitted}
          onAnswer={(a) => game.answer(phase.question.questionId, a)}
          canControl={game.canControl}
          onCancel={cancel}
        />
      </Stage>
    );
  }

  if (phase.kind === 'reveal') {
    const r = phase.result;
    const tone = r.isCorrect ? 'lime' : r.answered ? 'danger' : 'tangerine';
    return (
      <Stage title={quizTitle}>
        <Card
          className={cx(
            'animate-pop relative overflow-hidden p-10 text-center',
            tone === 'lime' && 'border-lime/50 shadow-glow-lime',
            tone === 'danger' && 'border-danger/50',
            tone === 'tangerine' && 'border-tangerine/50',
          )}
        >
          <div
            className={cx(
              'pointer-events-none absolute inset-0 -z-0 opacity-40',
              tone === 'lime' ? 'bg-[radial-gradient(closest-side,rgb(57_245_0/0.35),transparent)]' : tone === 'danger' ? 'bg-[radial-gradient(closest-side,rgb(255_48_48/0.3),transparent)]' : 'bg-[radial-gradient(closest-side,rgb(255_149_0/0.3),transparent)]',
            )}
            aria-hidden="true"
          />
          <div className="relative">
            <div className="text-6xl">{r.isCorrect ? '🎉' : r.answered ? '😅' : '⏰'}</div>
            <h1 className={cx('mt-4 font-display text-5xl font-black tracking-tight', tone === 'lime' ? 'text-lime' : tone === 'danger' ? 'text-danger-soft' : 'text-tangerine')}>
              {r.isCorrect ? t('play.correct') : r.answered ? t('play.wrong') : t('play.noAnswer')}
            </h1>
            {r.isCorrect && <p className="mt-2 font-display text-2xl font-black text-sun drop-shadow-[0_0_14px_rgb(255_230_0/0.6)]">{t('play.earned', { n: r.pointsEarned })}</p>}
            {!r.isCorrect && (
              <p className="mx-auto mt-4 max-w-md rounded-2xl bg-night/60 px-4 py-3 text-fg-soft ring-1 ring-line">
                {t('play.correctAnswerWas', { a: phase.question.questionType === 'TRUE_FALSE' ? (r.correctAnswer === 'TRUE' ? t('common.true') : t('common.false')) : r.correctAnswer })}
              </p>
            )}
            {phase.question.index + 1 >= phase.question.total ? (
              <p className="mt-8 flex items-center justify-center gap-2 font-display text-sm font-bold text-cyan">
                <Spinner className="h-4 w-4" /> {t('play.finishing')}
              </p>
            ) : (
              <p className="mt-8 font-display text-sm font-bold text-muted">{t('play.question', { i: phase.question.index + 1, n: phase.question.total })}</p>
            )}
            {game.timer && <ClockLine timer={game.timer} />}
          </div>
        </Card>
      </Stage>
    );
  }

  // completed
  return (
    <Stage title={quizTitle}>
      <FinalStandings end={phase.end} meId={me.userId} sessionId={sessionId} roomId={roomId} />
    </Stage>
  );
}

function QuestionText({ q }: { q: LiveQuestionDto }) {
  if (q.questionType !== 'FILL_IN_THE_BLANK') return <>{q.questionText}</>;
  const parts = q.questionText.split(/_{3,}/);
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && <span className="mx-1 inline-block w-24 border-b-4 border-sun align-baseline shadow-[0_4px_12px_-4px_var(--color-sun)]" aria-label="blank" />}
        </span>
      ))}
    </>
  );
}

/** Answer colours: each option gets its own neon so they are easy to tell apart. */
const OPTION_STYLES = [
  { idle: 'border-magenta/40 hover:border-magenta hover:bg-magenta/10', on: 'border-magenta bg-magenta/20 shadow-glow-magenta', letter: 'bg-magenta' },
  { idle: 'border-cyan/40 hover:border-cyan hover:bg-cyan/10', on: 'border-cyan bg-cyan/15 shadow-glow-cyan', letter: 'bg-cyan text-night' },
  { idle: 'border-lime/40 hover:border-lime hover:bg-lime/10', on: 'border-lime bg-lime/15 shadow-glow-lime', letter: 'bg-lime text-night' },
  { idle: 'border-sun/40 hover:border-sun hover:bg-sun/10', on: 'border-sun bg-sun/15 shadow-[0_0_0_1px_rgb(255_230_0/0.4),0_8px_28px_-6px_rgb(255_230_0/0.45)]', letter: 'bg-sun text-night' },
  { idle: 'border-tangerine/40 hover:border-tangerine hover:bg-tangerine/10', on: 'border-tangerine bg-tangerine/15', letter: 'bg-tangerine text-night' },
  { idle: 'border-violet/50 hover:border-violet hover:bg-violet/10', on: 'border-violet bg-violet/20', letter: 'bg-violet' },
];
const TF_STYLES = [
  { idle: 'border-lime/40 hover:border-lime hover:bg-lime/10', on: 'border-lime bg-lime/15 shadow-glow-lime', letter: 'bg-lime text-night' },
  { idle: 'border-danger/40 hover:border-danger hover:bg-danger/10', on: 'border-danger bg-danger/15', letter: 'bg-danger' },
];

/** Under this much remaining global time the clock turns red. */
const URGENT_MS = 30_000;

/** Circular countdown ring driven by the server's global deadline (it never resets between questions). */
function TimerRing({ remaining, total }: { remaining: number; total: number }) {
  const { t } = useI18n();
  const r = 26;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, remaining / total));
  const urgent = remaining < URGENT_MS;
  return (
    <div className="relative h-16 w-16 shrink-0" role="timer" aria-label={t('play.timeLeft')}>
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90" aria-hidden="true">
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgb(255 255 255 / 0.1)" strokeWidth="6" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke={urgent ? 'var(--color-danger)' : 'var(--color-cyan)'}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          style={{ transition: 'stroke-dashoffset 200ms linear', filter: `drop-shadow(0 0 6px ${urgent ? 'var(--color-danger)' : 'var(--color-cyan)'})` }}
        />
      </svg>
      <span className={cx('absolute inset-0 flex items-center justify-center font-display text-sm font-black tabular-nums', urgent ? 'animate-pulse text-danger-soft' : 'text-fg')} aria-live="off">
        {formatClock(remaining)}
      </span>
    </div>
  );
}

/** Compact line with the remaining global time (shown between questions). */
function ClockLine({ timer }: { timer: GlobalTimer }) {
  const { t } = useI18n();
  const remaining = useCountdown(timer.endsAt, timer.clockOffset);
  return (
    <p className={cx('mt-2 font-display text-sm font-black tabular-nums', remaining < URGENT_MS ? 'text-danger-soft' : 'text-cyan')} role="timer" aria-label={t('play.timeLeft')}>
      ⏱ {t('play.timeLeftShort', { t: formatClock(remaining) })} <span className="font-bold text-muted">{t('play.totalOf', { t: formatDuration(timer.totalTimeLimitSeconds) })}</span>
    </p>
  );
}

function QuestionView({
  question: q,
  timer,
  submitted,
  onAnswer,
  canControl,
  onCancel,
}: {
  question: LiveQuestionDto;
  timer: GlobalTimer;
  submitted: boolean;
  onAnswer: (a: AnswerSubmission) => Promise<{ ok: boolean; error?: { message: string } }>;
  canControl: boolean;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const remaining = useCountdown(timer.endsAt, timer.clockOffset);
  const total = timer.totalTimeLimitSeconds * 1000;
  const [optionId, setOptionId] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [matches, setMatches] = useState<Record<number, number>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timeUp = remaining <= 0;
  const locked = submitted || timeUp || sending;

  const ready =
    q.questionType === 'MULTIPLE_CHOICE' || q.questionType === 'TRUE_FALSE'
      ? optionId !== null
      : q.questionType === 'MATCHING'
        ? q.matchingLeft.every((l) => matches[l.pairId] !== undefined)
        : text.trim().length > 0;

  const submit = async () => {
    if (!ready || locked) return;
    const answer: AnswerSubmission =
      q.questionType === 'MULTIPLE_CHOICE' || q.questionType === 'TRUE_FALSE'
        ? { kind: 'option', optionId: optionId! }
        : q.questionType === 'MATCHING'
          ? { kind: 'matching', matches: q.matchingLeft.map((l) => ({ leftPairId: l.pairId, rightPairId: matches[l.pairId]! })) }
          : { kind: 'text', text };
    setSending(true);
    setError(null);
    const r = await onAnswer(answer);
    setSending(false);
    if (!r.ok) setError(r.error?.message ?? 'Error');
  };

  const usedRights = new Set(Object.values(matches));
  const isTF = q.questionType === 'TRUE_FALSE';
  const optionLabel = (txt: string) => (isTF ? (txt === 'TRUE' ? t('common.true') : t('common.false')) : txt);
  const typeStyle = QUESTION_TYPE_STYLE[q.questionType];
  const textInput = 'block w-full rounded-2xl border-2 border-line-strong bg-night/60 px-5 py-4 font-display text-xl font-bold text-fg placeholder:text-faint focus:border-cyan focus:shadow-glow-cyan focus:outline-none disabled:opacity-60';

  return (
    <Card className="overflow-hidden">
      {/* question progress */}
      <div className="flex gap-1 px-5 pt-5 sm:px-8" aria-hidden="true">
        {Array.from({ length: q.total }, (_, i) => (
          <span key={i} className={cx('h-1.5 flex-1 rounded-full', i < q.index ? 'bg-gradient-to-r from-magenta to-violet' : i === q.index ? 'bg-cyan shadow-[0_0_10px_var(--color-cyan)]' : 'bg-white/10')} />
        ))}
      </div>
      <div className="p-5 sm:p-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-display text-sm font-bold text-muted">{t('play.question', { i: q.index + 1, n: q.total })}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className={cx('rounded-full bg-gradient-to-r px-2.5 py-0.5 font-display text-[11px] font-black', typeStyle.chip, typeStyle.fg)}>{t(`qe.type.${q.questionType}`)}</span>
              <span className="font-display text-sm font-black text-sun">{t('common.points', { n: q.pointValue })}</span>
            </div>
          </div>
          <div className="flex flex-col items-center gap-0.5">
            <TimerRing remaining={remaining} total={total} />
            <span className="text-[11px] font-bold text-muted">{t('play.totalOf', { t: formatDuration(timer.totalTimeLimitSeconds) })}</span>
          </div>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
          <div className={cx('h-full rounded-full transition-[width] duration-200 ease-linear', remaining < URGENT_MS ? 'bg-danger' : 'bg-gradient-to-r from-cyan to-magenta')} style={{ width: `${Math.min(100, (remaining / total) * 100)}%` }} />
        </div>

        <h1 className="mt-7 whitespace-pre-line text-center font-display text-2xl font-black leading-snug tracking-tight sm:text-4xl">
          <QuestionText q={q} />
        </h1>
        {q.media && <MediaPreview media={q.media} className="mx-auto mt-6" />}

        <div className="mt-8">
          {(q.questionType === 'MULTIPLE_CHOICE' || isTF) && (
            <div className={cx('grid gap-3', q.options.length > 2 ? 'sm:grid-cols-2' : 'grid-cols-2')} role="radiogroup" aria-label={t('play.answerOptions')}>
              {q.options.map((o, i) => {
                const st = (isTF ? TF_STYLES : OPTION_STYLES)[i % (isTF ? 2 : OPTION_STYLES.length)]!;
                const on = optionId === o.optionId;
                return (
                  <button
                    key={o.optionId}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={locked}
                    onClick={() => setOptionId(o.optionId)}
                    className={cx(
                      'flex min-h-[4.5rem] items-center gap-4 rounded-2xl border-2 bg-night/50 px-4 py-4 text-left font-display text-lg font-bold transition duration-150 disabled:cursor-not-allowed',
                      on ? st.on : st.idle,
                      !locked && !on && 'hover:-translate-y-0.5',
                      locked && !on && 'opacity-40',
                    )}
                  >
                    <span className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl font-display text-base font-black text-white', st.letter)}>
                      {isTF ? (o.text === 'TRUE' ? '✓' : '✕') : String.fromCharCode(65 + i)}
                    </span>
                    {optionLabel(o.text)}
                  </button>
                );
              })}
            </div>
          )}

          {(q.questionType === 'OPEN_ANSWER' || q.questionType === 'FILL_IN_THE_BLANK') && (
            <input
              aria-label={t('play.yourAnswer')}
              placeholder={t('play.typeAnswer')}
              value={text}
              maxLength={255}
              disabled={locked}
              autoFocus
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              className={textInput}
            />
          )}

          {q.questionType === 'MATCHING' && (
            <div className="space-y-3">
              {q.matchingLeft.map((l, i) => (
                <div key={l.pairId} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
                  <span className={cx('rounded-2xl border-2 bg-night/50 px-4 py-3.5 font-display font-bold', OPTION_STYLES[i % OPTION_STYLES.length]!.idle)}>{l.text}</span>
                  <span className="text-xl font-black text-muted" aria-hidden="true">
                    ⇄
                  </span>
                  <select
                    aria-label={l.text}
                    disabled={locked}
                    value={matches[l.pairId] ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      setMatches((m) => {
                        const next = { ...m };
                        if (v === '') delete next[l.pairId];
                        else next[l.pairId] = Number(v);
                        return next;
                      });
                    }}
                    className="block w-full rounded-2xl border-2 border-line-strong bg-panel-2 px-4 py-3.5 font-display font-bold text-fg focus:border-cyan focus:outline-none disabled:opacity-60"
                  >
                    <option value="">{t('play.matchPick')}</option>
                    {q.matchingRight.map((r) => (
                      <option key={r.pairId} value={r.pairId} disabled={usedRights.has(r.pairId) && matches[l.pairId] !== r.pairId}>
                        {r.text}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <p className="mt-5 text-center text-sm font-semibold text-danger-soft">{error}</p>}
        <div className="mt-8 flex flex-col items-center gap-4">
          {submitted ? (
            <p className="flex items-center gap-2 rounded-full bg-lime/10 px-5 py-2.5 font-display font-bold text-lime ring-1 ring-lime/40">
              <Spinner className="h-4 w-4" /> {t('play.submitted')}
            </p>
          ) : timeUp ? (
            <p className="font-display text-xl font-black text-danger-soft">{t('play.timeUp')}</p>
          ) : (
            <Button size="lg" className="w-full text-lg sm:w-auto sm:min-w-[16rem]" onClick={submit} disabled={!ready} loading={sending}>
              {t('play.submit')}
            </Button>
          )}
          {canControl && (
            <button type="button" onClick={onCancel} className="text-xs font-bold text-faint transition hover:text-danger-soft">
              {t('play.cancel')}
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

function FinalStandings({ end, meId, sessionId, roomId }: { end: GameEndDto; meId: number; sessionId: number; roomId: number }) {
  const { t } = useI18n();
  const iWon = end.winner?.userId === meId;
  return (
    <Card className="animate-pop relative isolate overflow-hidden p-6 pb-24 sm:p-10 sm:pb-32">
      <NeonFloor className="-z-10 h-28 sm:h-36" cols={12} rows={4} dim />
      <div className="text-center">
        <div className="text-6xl">{iWon ? '🏆' : '🏁'}</div>
        <h1 className="mt-3 font-display text-5xl font-black tracking-tight">
          <span className="text-neon animate-shimmer">{t('play.finished')}</span>
        </h1>
        <WinnerBanner end={end} meId={meId} className="mt-5" />
        <p className="mt-4 font-display font-bold text-fg-soft">{t('play.finalStandings')}</p>
      </div>
      <Leaderboard standings={end.standings} meId={meId} className="mt-6" />
      <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
        <ButtonLink to={`/sessions/${sessionId}/results`} size="lg">
          {t('play.seeResults')}
        </ButtonLink>
        <ButtonLink to={`/rooms/${roomId}`} variant="secondary" size="lg">
          {t('play.backToRoom')}
        </ButtonLink>
      </div>
    </Card>
  );
}

/** Announces the winner (the highest final score); notes when the game ended because time ran out. */
export function WinnerBanner({ end, meId, className }: { end: Pick<GameEndDto, 'reason' | 'winner'>; meId: number; className?: string }) {
  const { t } = useI18n();
  if (end.winner) {
    return (
      <div className={cx('mx-auto max-w-lg rounded-2xl border-2 border-sun bg-sun/15 px-5 py-3 shadow-[0_0_0_1px_rgb(255_230_0/0.4),0_10px_30px_-8px_rgb(255_230_0/0.5)]', className)} role="status">
        <p className="font-display text-lg font-black text-sun">🏆 {end.winner.userId === meId ? t('play.youWin') : t('play.winnerIs', { name: end.winner.fullName })}</p>
        {end.reason === 'time_up' && <p className="mt-1 text-sm font-semibold text-fg-soft">{t('play.timeUpNote')}</p>}
      </div>
    );
  }
  return (
    <p className={cx('mx-auto max-w-lg rounded-2xl border-2 border-tangerine/60 bg-tangerine/10 px-5 py-3 font-display font-bold text-tangerine', className)} role="status">
      ⏰ {t('play.noWinner')}
    </p>
  );
}

const PODIUM = [
  { medal: '🥇', ring: 'border-sun bg-sun/15 shadow-[0_0_0_1px_rgb(255_230_0/0.4),0_10px_30px_-8px_rgb(255_230_0/0.5)]', score: 'text-sun' },
  { medal: '🥈', ring: 'border-cyan/70 bg-cyan/10', score: 'text-cyan' },
  { medal: '🥉', ring: 'border-tangerine/70 bg-tangerine/10', score: 'text-tangerine' },
];

/** Ranked list with highlighted top three; used at the end of a game and on the results page. */
export function Leaderboard({ standings, meId, className }: { standings: StandingDto[]; meId: number; className?: string }) {
  const { t } = useI18n();
  return (
    <ol className={cx('space-y-2.5', className)}>
      {standings.map((s, i) => {
        const podium = PODIUM[i];
        const mine = s.userId === meId;
        return (
          <li
            key={s.userId}
            className={cx(
              'flex items-center justify-between gap-3 rounded-2xl border-2 px-4 py-3 transition',
              podium ? podium.ring : 'border-line bg-night/50',
              mine && 'ring-2 ring-magenta ring-offset-2 ring-offset-panel',
            )}
          >
            <span className="flex min-w-0 items-center gap-3">
              <span className="w-8 shrink-0 text-center font-display text-xl font-black text-muted">{podium ? podium.medal : i + 1}</span>
              <span className="min-w-0">
                <span className="block truncate font-display font-bold">{s.fullName}</span>
                <span className="block truncate text-xs text-muted">
                  @{s.username}
                  {s.isWinner && ` · 🏆 ${t('play.winner')}`}
                  {s.disconnected && ` · ${t('res.left')}`}
                </span>
              </span>
            </span>
            <span className={cx('shrink-0 font-display text-xl font-black tabular-nums', podium ? podium.score : 'text-fg')}>{t('common.points', { n: s.totalScore })}</span>
          </li>
        );
      })}
    </ol>
  );
}

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Pantalla /play/:sessionId de la partida en vivo: sala de espera, preguntas con el
temporizador global del cuestionario, resultado de cada respuesta, ganador y clasificación final.

Responsabilidades principales:
- Consultar sessionsApi.info; si la sesión terminó, redirigir a los resultados.
- Sala de espera con jugadores, tiempo total del cuestionario y reglas (gana quien termine primero),
  y botones Start game / Cancel (solo quien puede controlar).
- QuestionView: opciones de colores, campo de texto o selectores de emparejamiento; anillo de cuenta
  atrás global (TimerRing, m:ss) basado en el endsAt único del servidor, que no se reinicia al
  cambiar de pregunta.
- Pantalla de resultado de la respuesta (con el tiempo global restante, ClockLine).
- FinalStandings: WinnerBanner (ganador por mayor puntuación final, o fin por tiempo sin ganador) y
  Leaderboard.

Elementos importantes:
- PlayPage()
- Game
- Stage
- QuestionView
- QuestionText
- TimerRing
- ClockLine
- useCountdown
- FinalStandings
- WinnerBanner (exportado)
- Leaderboard (exportado)
- OPTION_STYLES, TF_STYLES, PODIUM

Dependencias:
- @tanstack/react-query
- api/endpoints.ts (sessionsApi)
- auth/AuthProvider.tsx
- features/play/useGameSocket.ts
- components/brand.tsx
- components/overlays.tsx
- components/ui.tsx
- features/quizzes/QuestionEditorModal.tsx (MediaPreview)
- features/quizzes/questionTypes.ts

Flujo de datos:
Muestra lo que envía el servidor y envía la respuesta elegida con game.answer.

Aspectos técnicos importantes:
- La pantalla nunca recibe la respuesta correcta antes de que el jugador responda.
- El ganador lo decide el servidor; la pantalla solo lo muestra.
- La traducción de palabras está desactivada en esta ruta.

Lugar en la arquitectura:
Capa de presentación (página). Experiencia multijugador en tiempo real.
*/
