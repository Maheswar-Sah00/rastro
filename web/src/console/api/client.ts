// Typed client for the Rastro API. All network access in the console goes through here.
import type { CertificateEvent,
  Assessment, BundleDestination, ChainStatus, FindingView, LineageGraph, LineageReport, PreparedTx, ReviewStatus, ShipmentRiskDetail, BundleMovement, CertificateView, Envelope, EvaluationSummary, GtaDetail, Health, Item, Items,
  LineageTrace, MovementView, RanchDetail, RanchRiskView, RanchSummary, Ready, ShipmentDetail, ShipmentEvidence,
  ShipmentSummary, Summary, VerifyResult,
} from './types';

export const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) || 'http://127.0.0.1:8000').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public details?: unknown,
    public body?: unknown,
  ) {
    super(message);
  }
  get unreachable() {
    return this.status === 0;
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

/** DEMO MODE: serve responses captured from a running API (web/src/console/fixtures). Opt-in only. */
export const DEMO_MODE =
  (import.meta.env.VITE_CONSOLE_DEMO as string | undefined) === '1' ||
  (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo'));
const FIXTURES = import.meta.glob('../fixtures/*.json');
export function fixtureKey(method: string, path: string) {
  return `${method}_${path}`.replace(/[^A-Za-z0-9]+/g, '_').replace(/_+$/, '');
}

async function fromFixture<T>(method: string, url: string): Promise<T> {
  const key = fixtureKey(method, url);
  const loader = FIXTURES[`../fixtures/${key}.json`];
  if (!loader) throw new ApiError(404, 'not_in_demo_fixtures', `DEMO MODE: no captured response for ${method} ${url}. Run the console against the live API for this view.`);
  const mod = (await loader()) as { default: T };
  return mod.default;
}

function qs(q?: Query) {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: 'GET' | 'POST', path: string, opts: { query?: Query; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  if (DEMO_MODE) return fromFixture<T>(method, `${path}${qs(opts.query)}`);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}${qs(opts.query)}`, {
      method,
      signal: opts.signal,
      headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'unreachable', `The Rastro API at ${API_BASE} is not reachable.`);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; request_id?: string; details?: unknown }; detail?: unknown })?.error;
    const detail = (body as { detail?: unknown })?.detail;
    throw new ApiError(
      res.status,
      err?.code || `http_${res.status}`,
      err?.message || (typeof detail === 'string' ? detail : `Request failed with HTTP ${res.status}`),
      err?.request_id || res.headers.get('x-request-id') || undefined,
      err?.details ?? detail,
      body,
    );
  }
  return body as T;
}

const enc = encodeURIComponent;
export interface ListQuery extends Query { limit?: number; offset?: number }

export const api = {
  health: (s?: AbortSignal) => request<Health>('GET', '/api/v1/health', { signal: s }),
  // /ready answers 503 with the same body when something is missing; that is a result, not a failure.
  ready: (s?: AbortSignal) =>
    request<Ready>('GET', '/api/v1/ready', { signal: s }).catch((e) => {
      if (e instanceof ApiError && e.status === 503 && e.body && typeof e.body === 'object' && 'ready' in (e.body as object)) return e.body as Ready;
      throw e;
    }),
  summary: (s?: AbortSignal) => request<Item<Summary> | Summary>('GET', '/api/v1/summary', { signal: s }),

  ranches: (q: ListQuery, s?: AbortSignal) => request<Items<RanchSummary>>('GET', '/api/v1/ranches', { query: q, signal: s }),
  ranch: (id: string, s?: AbortSignal) => request<Item<RanchDetail>>('GET', `/api/v1/ranches/${enc(id)}`, { signal: s }),
  ranchMovements: (id: string, q: ListQuery, s?: AbortSignal) =>
    request<Items<MovementView>>('GET', `/api/v1/ranches/${enc(id)}/movements`, { query: q, signal: s }),
  ranchRisk: (id: string, s?: AbortSignal) => request<Item<RanchRiskView>>('GET', `/api/v1/ranches/${enc(id)}/risk`, { signal: s }),

  gtas: (q: ListQuery, s?: AbortSignal) => request<Items<MovementView>>('GET', '/api/v1/gtas', { query: q, signal: s }),
  gta: (id: string, s?: AbortSignal) => request<Item<GtaDetail>>('GET', `/api/v1/gtas/${enc(id)}`, { signal: s }),
  lotLineage: (id: string, policy: 'fifo' | 'pro_rata', s?: AbortSignal) =>
    request<Item<LineageTrace>>('GET', `/api/v1/lots/${enc(id)}/lineage`, { query: { policy }, signal: s }),

  shipments: (q: ListQuery, s?: AbortSignal) => request<Items<ShipmentSummary>>('GET', '/api/v1/shipments', { query: q, signal: s }),
  shipment: (id: string, s?: AbortSignal) => request<Item<ShipmentDetail>>('GET', `/api/v1/shipments/${enc(id)}`, { signal: s }),
  shipmentRisk: (id: string, s?: AbortSignal) => request<Item<ShipmentRiskDetail>>('GET', `/api/v1/shipments/${enc(id)}/risk`, { signal: s }),
  shipmentEvidence: (id: string, s?: AbortSignal) => request<Item<ShipmentEvidence>>('GET', `/api/v1/shipments/${enc(id)}/evidence`, { signal: s }),
  // The request body can only choose precomputed vs recomputed; the backend rejects any verdict field.
  assess: (id: string, recompute: boolean) => request<Item<Assessment> | Assessment>('POST', `/api/v1/shipments/${enc(id)}/assess`, { body: { recompute } }),

  certificate: (id: string, s?: AbortSignal) => request<Item<CertificateView> | CertificateView>('GET', `/api/v1/certificates/${enc(id)}`, { signal: s }),
  verifyCertificate: (id: string) => request<Item<VerifyResult> | VerifyResult>('POST', `/api/v1/certificates/${enc(id)}/verify`, { body: {} }),

  chainStatus: (s?: AbortSignal) => request<Item<ChainStatus>>('GET', '/api/v1/chain/status', { signal: s }),
  ranchBalance: (id: string, s?: AbortSignal) => request<Item<Record<string, unknown>>>('GET', `/api/v1/ranches/${enc(id)}/balance`, { signal: s }),
  consumeRequest: (id: string, use: number, refHash: string) =>
    request<Item<PreparedTx>>('POST', `/api/v1/certificates/${enc(id)}/consume-request`, { body: { use, ref_hash: refHash } }),

  // ---- investigation workspace (Task 08) ----
  lineageGraph: (id: string, q: { max_nodes?: number; expand?: string }, s?: AbortSignal) =>
    request<Item<LineageGraph>>('GET', `/api/v1/shipments/${enc(id)}/lineage/graph`, { query: q, signal: s }),
  finding: (id: string, s?: AbortSignal) => request<Item<FindingView>>('GET', `/api/v1/findings/${enc(id)}`, { signal: s }),
  // Append-only investigator review. It annotates the finding; the API never lets it change a decision.
  reviewFinding: (id: string, status: ReviewStatus, reason: string, reviewer: string) =>
    request<Item<FindingView>>('POST', `/api/v1/findings/${enc(id)}/reviews`, { body: { status, reason, reviewer } }),
  lineageReport: (id: string, s?: AbortSignal) => request<LineageReport>('GET', `/api/v1/shipments/${enc(id)}/lineage/report`, { query: { format: 'json' }, signal: s }),
  certificateEvents: (s?: AbortSignal) => request<Items<CertificateEvent>>('GET', '/api/v1/certificates', { signal: s, query: { limit: 500 } }),
  certificateReportUrl: (id: string, format: 'json' | 'html') => `${API_BASE}/api/v1/certificates/${enc(id)}/report?format=${format}`,
  evidenceDownloadUrl: (id: string) => `${API_BASE}/api/v1/shipments/${enc(id)}/evidence/download`,
  lineageReportUrl: (id: string, format: 'json' | 'md' | 'csv') => `${API_BASE}/api/v1/shipments/${enc(id)}/lineage/report?format=${format}`,

  evaluation: (s?: AbortSignal) => request<Item<EvaluationSummary> | EvaluationSummary>('GET', '/api/v1/evaluation/summary', { signal: s }),

  // Published web bundle (schema v1), used for the global movement list and map destinations.
  bundle: <T,>(name: string, s?: AbortSignal) => request<Envelope<T>>('GET', `/api/v1/datasets/${enc(name)}`, { signal: s }),
  bundleMovements: (s?: AbortSignal) => api.bundle<BundleMovement[]>('movements', s),
  bundleDestinations: (s?: AbortSignal) => api.bundle<BundleDestination[]>('destinations', s),
};

/** Some endpoints wrap their payload as {meta, data}; others return it bare. */
export function unwrap<T>(x: Item<T> | T): T {
  return x && typeof x === 'object' && 'data' in (x as object) && 'meta' in (x as object) ? (x as Item<T>).data : (x as T);
}
export function metaOf<T>(x: Item<T> | T) {
  return x && typeof x === 'object' && 'meta' in (x as object) ? (x as Item<T>).meta : null;
}
