import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import type { CreatedInvitationDto } from '@rush/shared';
import { roomsApi } from '../../api/endpoints';
import { useConfirm, useToast } from '../../components/overlays';
import { Badge, Button, Card, ErrorState, FormError, LoadingState, TextField } from '../../components/ui';
import { useI18n } from '../../i18n/I18nProvider';

/**
 * Copies text to the clipboard. The Async Clipboard API is only available in secure contexts
 * (HTTPS or localhost); on a LAN HTTP origin it is missing, so fall back to selecting a field and
 * the legacy execCommand('copy'). Returns whether the copy succeeded.
 */
export async function copyToClipboard(text: string, field: HTMLInputElement | null): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the legacy path */
    }
  }
  const el = field ?? Object.assign(document.createElement('textarea'), { value: text });
  if (!field) {
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
  }
  try {
    el.focus();
    el.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (!field) el.remove();
  }
}

export function InvitationsPanel({ roomId }: { roomId: number }) {
  const { t, errorText } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const list = useQuery({ queryKey: ['room', roomId, 'invitations'], queryFn: () => roomsApi.invitations(roomId) });
  const [invitee, setInvitee] = useState('');
  const [created, setCreated] = useState<CreatedInvitationDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const inv = await roomsApi.createInvitation(roomId, { invitee: invitee.trim() || undefined });
      setCreated(inv);
      setCopied(false);
      setInvitee('');
      void qc.invalidateQueries({ queryKey: ['room', roomId, 'invitations'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    if (await copyToClipboard(created.url, linkRef.current)) {
      setCopied(true);
      toast(t('inv.copied'));
    } else {
      setCopied(false);
      linkRef.current?.select();
      toast(t('inv.copyFailed'), 'error');
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <Card className="p-5 lg:col-span-2">
        <h3 className="mb-4 font-bold">{t('inv.create')}</h3>
        <form className="space-y-4" onSubmit={create}>
          <TextField label={t('inv.invitee')} value={invitee} onChange={(e) => setInvitee(e.target.value)} hint={t('inv.inviteeHint')} optional />
          <FormError error={error} />
          <Button type="submit" className="w-full" loading={busy}>
            {t('inv.create')}
          </Button>
        </form>
        {created && (
          <div className="mt-5 rounded-xl border border-lime/40 bg-lime/10 p-3" data-no-translate>
            <p className="text-sm font-semibold text-lime">{t('inv.created')}</p>
            <input ref={linkRef} readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} className="mt-2 w-full rounded-lg border border-lime/40 bg-panel-2 px-2 py-1.5 font-mono text-xs" aria-label="Invitation link" />
            <Button size="sm" variant="secondary" className="mt-2" onClick={copy}>
              {copied ? t('common.copied') : t('common.copy')}
            </Button>
          </div>
        )}
      </Card>
      <Card className="p-5 lg:col-span-3">
        <h3 className="mb-3 font-bold">{t('inv.list')}</h3>
        {list.isLoading ? (
          <LoadingState />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : list.data!.length === 0 ? (
          <p className="text-sm text-muted">{t('inv.none')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {list.data!.map((i) => (
              <li key={i.invitationId} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{i.invitedUsername ? t('inv.for', { name: `@${i.invitedUsername}` }) : t('inv.open')}</p>
                  <p className="text-muted">
                    {i.expired && <Badge tone="red">{t('inv.expired')}</Badge>} @{i.createdByUsername}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (!(await confirm({ title: t('inv.revoke'), message: t('inv.revokeConfirm'), danger: true, confirmLabel: t('inv.revoke') }))) return;
                    try {
                      await roomsApi.revokeInvitation(roomId, i.invitationId);
                      void qc.invalidateQueries({ queryKey: ['room', roomId, 'invitations'] });
                    } catch (e) {
                      toast(errorText(e), 'error');
                    }
                  }}
                >
                  {t('inv.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Panel para crear, listar y revocar enlaces de invitación de una sala.

Responsabilidades principales:
- Opcionalmente dirigir el enlace a un destinatario registrado (la caducidad es fija y la fija el
  servidor; no se muestra en la interfaz).
- Mostrar una sola vez el enlace creado y permitir copiarlo (con copia de respaldo para orígenes
  HTTP de red local, donde la API de portapapeles no está disponible).
- Listar invitaciones (activas o caducadas) y revocarlas.

Elementos importantes:
- InvitationsPanel({ roomId })
- copyToClipboard(text, field)

Dependencias:
- @tanstack/react-query
- api/endpoints.ts (roomsApi)
- components/overlays.tsx
- components/ui.tsx

Flujo de datos:
Envía POST/GET/DELETE a /api/rooms/:roomId/invitations.

Aspectos técnicos importantes:
- El enlace solo se puede ver al crearlo porque el servidor guarda únicamente el hash del token.

Lugar en la arquitectura:
Capa de presentación. Permite incorporar miembros a una sala privada.
*/
