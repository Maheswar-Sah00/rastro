import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './client';

export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** Runs `fn` when `deps` change; aborts stale requests. Errors are surfaced, never replaced by fixtures. */
export function useApi<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[], enabled = true): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    fnRef.current(ctl.signal)
      .then((d) => {
        if (!ctl.signal.aborted) setData(d);
      })
      .catch((e) => {
        if (ctl.signal.aborted || (e as Error).name === 'AbortError') return;
        setData(null);
        setError(e instanceof ApiError ? e : new ApiError(-1, 'client_error', String((e as Error).message || e)));
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false);
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
