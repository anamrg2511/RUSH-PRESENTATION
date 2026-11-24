import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { invitationsApi } from '../../api/endpoints';
import { Button, ButtonLink, Card, FormError, LoadingState } from '../../components/ui';
import { useI18n } from '../../i18n/I18nProvider';

export function InvitePage() {
  const token = useParams().token ?? '';
  const { t } = useI18n();
  const nav = useNavigate();
  const qc = useQueryClient();
  const preview = useQuery({ queryKey: ['invitation', token], queryFn: () => invitationsApi.preview(token), retry: false });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (preview.isLoading) return <LoadingState />;
  if (preview.error) {
    const expired = preview.error instanceof ApiError && preview.error.code === 'invitation_expired';
    return (
      <Card className="mx-auto max-w-md p-8 text-center">
        <div className="text-4xl">{expired ? '⌛' : '🔒'}</div>
        <h1 className="mt-3 text-xl font-bold">{expired ? t('inv.expiredTitle') : t('inv.invalidTitle')}</h1>
        <p className="mt-2 text-muted">{t('inv.askNew')}</p>
        <ButtonLink to="/dashboard" variant="secondary" className="mt-6">
          {t('common.goHome')}
        </ButtonLink>
      </Card>
    );
  }
  const p = preview.data!;

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await invitationsApi.accept(token);
      await qc.invalidateQueries({ queryKey: ['rooms'] });
      nav(`/rooms/${res.roomId}`, { replace: true });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mx-auto max-w-md overflow-hidden">
      <img src={p.coverImageUrl} alt="" className="h-36 w-full object-cover" referrerPolicy="no-referrer" />
      <div className="p-6 text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-pink">{t('inv.joinTitle')}</p>
        <h1 className="mt-1 text-2xl font-extrabold">{p.roomName}</h1>
        {p.roomDescription && <p className="mt-2 text-fg-soft">{p.roomDescription}</p>}
        <p className="mt-3 text-sm text-muted">{t('rooms.memberCount', { n: p.memberCount, max: 40 })}</p>
        <div className="mt-6">
          <FormError error={error} />
          {p.alreadyMember ? (
            <>
              <p className="mb-3 text-sm text-fg-soft">{t('inv.alreadyMember')}</p>
              <ButtonLink to={`/rooms/${p.roomId}`}>{t('inv.openRoom')}</ButtonLink>
            </>
          ) : (
            <Button size="lg" onClick={join} loading={busy} className="mt-2 w-full">
              {t('inv.joinRoom')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Página /invite/:token que muestra la sala a la que se invita y permite unirse.

Responsabilidades principales:
- Consultar invitationsApi.preview.
- Mostrar mensajes específicos si el enlace caducó o no es válido.
- Unirse con invitationsApi.accept y navegar a la sala.

Elementos importantes:
- InvitePage()

Dependencias:
- @tanstack/react-query
- react-router-dom
- api/endpoints.ts
- components/ui.tsx

Flujo de datos:
Lee GET /api/invitations/:token y envía POST /api/invitations/:token/accept.

Aspectos técnicos importantes:
- Si el visitante no ha iniciado sesión, App.tsx lo lleva a /login y después vuelve aquí.

Lugar en la arquitectura:
Capa de presentación (página). Entrada de nuevos miembros a las salas.
*/
