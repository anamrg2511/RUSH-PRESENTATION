import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { sessionsApi } from '../../api/endpoints';
import { useMe } from '../../auth/AuthProvider';
import { Badge, Card, cx, ErrorState, LoadingState, NotFoundState, SectionLabel } from '../../components/ui';
import { useI18n } from '../../i18n/I18nProvider';
import { Leaderboard, WinnerBanner } from './PlayPage';

export function ResultsPage() {
  const sessionId = Number(useParams().sessionId);
  const { t, formatDate } = useI18n();
  const me = useMe();
  const q = useQuery({ queryKey: ['session', sessionId, 'results'], queryFn: () => sessionsApi.results(sessionId) });
  if (q.isLoading) return <LoadingState />;
  if (q.error instanceof ApiError && q.error.status === 404) return <NotFoundState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data!;
  const tf = (s: string, type: string) => (type === 'TRUE_FALSE' ? (s === 'TRUE' ? t('common.true') : s === 'FALSE' ? t('common.false') : s) : s);
  const pct = r.myTotalScore !== null && r.maxScore > 0 ? Math.round((r.myTotalScore / r.maxScore) * 100) : 0;
  const correct = r.myAnswers?.filter((a) => a.isCorrect).length ?? 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link to={`/rooms/${r.roomId}`} className="text-sm font-semibold text-muted transition hover:text-fg">
          ← {r.roomName}
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-black tracking-tight sm:text-4xl">{r.quizTitle}</h1>
          <Badge tone={r.status === 'COMPLETED' ? 'green' : 'red'}>{t(`res.status.${r.status}`)}</Badge>
        </div>
        {r.startedAt && <p className="mt-1 text-sm text-muted">{formatDate(r.startedAt, true)}</p>}
      </div>

      {r.endReason && <WinnerBanner end={{ reason: r.endReason, winner: r.winner }} meId={me.userId} className="mx-0 text-center" />}

      {r.myTotalScore !== null && (
        <Card className="relative overflow-hidden border-magenta/40 bg-gradient-to-br from-magenta/30 via-violet/25 to-panel p-6 shadow-glow-magenta sm:p-8">
          <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-cyan/20 blur-3xl" aria-hidden="true" />
          <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-display text-xs font-bold uppercase tracking-[0.2em] text-fg-soft">{t('res.yourScore')}</p>
              <p className="mt-2 font-display text-6xl font-black tabular-nums leading-none text-white">
                {r.myTotalScore} <span className="text-xl font-bold text-fg-soft">{t('res.of', { n: r.maxScore })}</span>
              </p>
            </div>
            <div className="flex gap-3">
              <div className="rounded-2xl bg-night/50 px-5 py-3 text-center ring-1 ring-line">
                <p className="font-display text-3xl font-black tabular-nums text-lime">{correct}</p>
                <p className="text-xs font-semibold text-muted">/ {r.myAnswers?.length ?? 0}</p>
              </div>
              <div className="rounded-2xl bg-night/50 px-5 py-3 text-center ring-1 ring-line">
                <p className="font-display text-3xl font-black tabular-nums text-sun">{pct}%</p>
                <p className="text-xs font-semibold text-muted" aria-hidden="true">
                  &nbsp;
                </p>
              </div>
            </div>
          </div>
        </Card>
      )}

      <Card className="p-5 sm:p-6">
        <SectionLabel className="mb-4">{t('res.standings')}</SectionLabel>
        <Leaderboard standings={r.standings} meId={me.userId} />
      </Card>

      <Card className="p-5 sm:p-6">
        <SectionLabel className="mb-4">{t('res.yourAnswers')}</SectionLabel>
        {r.myAnswers === null ? (
          <p className="text-sm text-muted">{t('res.notParticipant')}</p>
        ) : (
          <ol className="space-y-3">
            {r.myAnswers.map((a) => (
              <li key={a.questionId} className={cx('rounded-2xl border-l-4 bg-night/50 p-4 ring-1 ring-inset ring-line', a.isCorrect ? 'border-lime' : 'border-danger')}>
                <div className="flex items-start justify-between gap-3">
                  <p className="font-display font-bold">
                    <span className="text-muted">{a.displayOrder}.</span> {a.questionText}
                  </p>
                  <span className={cx('shrink-0 font-display font-black tabular-nums', a.isCorrect ? 'text-lime' : 'text-faint')}>
                    {a.pointsEarned}/{a.pointValue}
                  </span>
                </div>
                <p className="mt-2 text-sm">
                  <span className="text-muted">{t('play.yourAnswer')}: </span>
                  <span className={cx('font-semibold', a.isCorrect ? 'text-lime' : 'text-danger-soft')}>{a.yourAnswer ? tf(a.yourAnswer, a.questionType) : t('res.notReached')}</span>
                </p>
                {!a.isCorrect && <p className="mt-0.5 text-sm text-fg-soft">{t('play.correctAnswerWas', { a: tf(a.correctAnswer, a.questionType) })}</p>}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Página /sessions/:sessionId/results con la puntuación propia, la clasificación y la
revisión de cada respuesta.

Responsabilidades principales:
- Consultar sessionsApi.results.
- Mostrar puntuación sobre el máximo, aciertos y porcentaje.
- Mostrar el ganador por mayor puntuación final o el aviso de fin por tiempo (WinnerBanner).
- Mostrar la clasificación (Leaderboard) y cada respuesta con la correcta cuando se falló; las
  preguntas a las que no se llegó porque la partida terminó aparecen como no respondidas.

Elementos importantes:
- ResultsPage()

Dependencias:
- @tanstack/react-query
- api/endpoints.ts
- auth/AuthProvider.tsx
- components/ui.tsx
- features/play/PlayPage.tsx (Leaderboard)

Flujo de datos:
Lee GET /api/sessions/:sessionId/results.

Aspectos técnicos importantes:
- Los datos vienen del historial guardado en MySQL, por lo que siguen disponibles después de la
  partida.

Lugar en la arquitectura:
Capa de presentación (página). Muestra el resultado de las partidas.
*/
