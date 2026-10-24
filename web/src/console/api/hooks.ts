import { api, unwrap } from './client';
import type { Item, Items, RanchSummary } from './types';
import { useApi } from './useApi';

let ranchesOnce: Promise<Items<RanchSummary>> | null = null;

/** All ranch summaries (414 rows) fetched once per page load; the API caps pages at 500. */
export function useAllRanches() {
  return useApi(() => {
    if (!ranchesOnce) ranchesOnce = api.ranches({ limit: 500, offset: 0 }).catch((e) => {
      ranchesOnce = null;
      throw e;
    });
    return ranchesOnce;
  }, []);
}

export function riskMap(rows: RanchSummary[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows || []) out[r.ranch_id] = r.risk_status === 'assessed' && r.risk_class ? r.risk_class : 'unassessed';
  return out;
}

export function useSummary() {
  return useApi((s) => api.summary(s).then((x) => unwrap(x as Item<Record<string, unknown>>)), []);
}
