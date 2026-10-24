import type { ReactNode } from 'react';
import { API_BASE, type ApiError } from '../api/client';
import { Icon } from './Icon';

export function Loading({ what = 'Loading' }: { what?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden /> {what}…
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state empty">
      <Icon name="info" />
      <div>
        <strong>{title}</strong>
        {children && <div className="muted">{children}</div>}
      </div>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const title =
    error.status === 0 ? 'API unreachable' : error.status === 404 ? 'Not found' : error.status === 422 || error.status === 400 ? 'Invalid request' : 'Request failed';
  return (
    <div className="state error" role="alert">
      <Icon name="alert" />
      <div>
        <strong>{title}</strong>
        <div>{error.message}</div>
        <div className="muted small">
          {error.status === 0 ? `Start the API (backend/) or set VITE_API_URL. Expected at ${API_BASE}.` : `HTTP ${error.status} · ${error.code}`}
          {error.requestId ? ` · request ${error.requestId}` : ''}
        </div>
        {onRetry && (
          <button type="button" className="btn btn-small" onClick={onRetry}>
            <Icon name="refresh" size={14} /> Retry
          </button>
        )}
      </div>
    </div>
  );
}

/** Renders loading / error / content for one API state. */
export function Async<T>({ state, children, what }: { state: { data: T | null; error: ApiError | null; loading: boolean; reload: () => void }; children: (d: T) => ReactNode; what?: string }) {
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (state.loading && !state.data) return <Loading what={what} />;
  if (!state.data) return <Empty title="No data" />;
  return <>{children(state.data)}</>;
}
