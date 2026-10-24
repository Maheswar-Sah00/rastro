import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

/** Side drawer for detail views. Escape closes it; focus moves into it on open. */
export function Drawer({ title, subtitle, onClose, children }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <aside className="drawer" role="dialog" aria-modal="false" aria-label={typeof title === 'string' ? title : 'Details'} tabIndex={-1} ref={ref}>
      <header className="drawer-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <div className="muted small">{subtitle}</div>}
        </div>
        <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Close details">
          <Icon name="close" />
        </button>
      </header>
      <div className="drawer-body">{children}</div>
    </aside>
  );
}

/** Confirmation dialog for actions that call a POST endpoint. */
export function ConfirmDialog({ title, body, confirmLabel, busy, onConfirm, onCancel }: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const on = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [busy, onCancel]);
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{title}</h2>
        <div className="modal-body">{body}</div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy} ref={ref}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
