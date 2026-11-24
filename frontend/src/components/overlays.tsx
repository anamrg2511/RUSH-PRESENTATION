import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n/I18nProvider';
import { Button, cx } from './ui';

/** Accessible modal: role=dialog, Escape closes, focus moves inside and returns afterwards. */
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  // Read onClose through a ref so the focus/Escape effect below depends only on `open`.
  // Callers pass an inline onClose, so depending on it would re-run this effect on every
  // parent render (i.e. every keystroke) and steal focus back to the first field.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = panel.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])');
    (focusable ?? panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-night/75 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        className={cx('animate-pop relative max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border border-line-strong bg-panel p-5 shadow-[0_30px_80px_-20px_rgb(0_0_0/0.9),0_0_0_1px_rgb(160_32_240/0.25)] sm:rounded-3xl sm:p-7', wide ? 'sm:max-w-2xl' : 'sm:max-w-md')}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-1 rounded-t-3xl bg-gradient-to-r from-magenta via-violet to-cyan" aria-hidden="true" />
        <div className="mb-5 flex items-start justify-between gap-4">
          <h2 className="font-display text-xl font-extrabold text-fg">{title}</h2>
          <button data-close type="button" onClick={onClose} className="-m-1 rounded-full p-1.5 text-muted transition hover:bg-white/10 hover:text-fg" aria-label="Close">
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor" aria-hidden="true">
              <path d="M6.3 5 5 6.3 8.7 10 5 13.7 6.3 15 10 11.3 13.7 15 15 13.7 11.3 10 15 6.3 13.7 5 10 8.7z" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- confirm dialog
interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}
type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback<ConfirmFn>((o) => new Promise((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal open={!!state} onClose={() => close(false)} title={state?.title ?? ''}>
        {state?.message && <p className="text-sm leading-relaxed text-fg-soft">{state.message}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => close(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
            {state?.confirmLabel ?? t('common.confirm')}
          </Button>
        </div>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm outside provider');
  return ctx;
}

// ---------------------------------------------------------------- toasts
interface Toast {
  id: number;
  text: string;
  tone: 'success' | 'error';
}
const ToastContext = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('animate-pop pointer-events-auto flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-semibold text-white shadow-[0_12px_32px_-8px_rgb(0_0_0/0.8)] backdrop-blur', t.tone === 'success' ? 'border-lime/40 bg-panel-2/95' : 'border-danger/50 bg-danger/90')}>
            <span aria-hidden="true" className={t.tone === 'success' ? 'text-lime' : ''}>
              {t.tone === 'success' ? '✓' : '!'}
            </span>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Implementa la ventana modal, el diálogo de confirmación y las notificaciones temporales
(toasts).

Responsabilidades principales:
- Modal: role="dialog", cierre con Escape o clic fuera, foco dentro de la ventana y devolución del
  foco al cerrar.
- ConfirmProvider/useConfirm: pregunta de confirmación que devuelve una promesa true/false.
- ToastProvider/useToast: mensajes de éxito o error que desaparecen a los 4 segundos.

Elementos importantes:
- Modal
- ConfirmProvider
- useConfirm
- ToastProvider
- useToast

Dependencias:
- react
- react-dom (createPortal)
- components/ui.tsx
- i18n/I18nProvider.tsx

Flujo de datos:
Lo usan las páginas para pedir confirmación antes de acciones destructivas y para avisar del
resultado.

Aspectos técnicos importantes:
- Se dibujan en document.body mediante portales para quedar por encima del resto.

Lugar en la arquitectura:
Capa de presentación. Evita borrados accidentales y da retroalimentación al usuario.
*/
