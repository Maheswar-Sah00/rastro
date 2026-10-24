// Data loading with transparent fallback:
//   data/<file>  (real pipeline / contracts output)  ->  data/mock/<file>  ->  missing
// A build-time manifest (data/_files.json, emitted by vite.config.ts) lists which files
// exist so the app never requests a file that is not there. Without a manifest the
// loader simply probes. `?data=mock` forces mocks, `?data=real` disables them.

import { useEffect, useState, useSyncExternalStore } from 'react';
import type {
  Destination, FeatureCollection, Meta, Metrics, Movement, OnChain, Ranch, RanchProps, Shipment,
  DeforProps, ProtectedProps, AreaGeom, RiskFlag,
} from './types';
import { bboxOfGeom, centroidOfGeom } from './geo';
import { fixName } from './content';

export type Origin = 'real' | 'mock' | 'missing';
export interface Loaded<T> { data: T | null; origin: Origin; status: 'loading' | 'ready' }

const BASE = import.meta.env.BASE_URL;
const forced = (() => {
  try {
    const v = new URLSearchParams(window.location.search).get('data');
    return v === 'mock' || v === 'real' ? v : null;
  } catch {
    return null;
  }
})();

export const dataUrl = (rel: string) => `${BASE}${rel.replace(/^\.?\//, '')}`;

async function fetchText(url: string): Promise<string | undefined> {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return undefined;
    const text = await r.text();
    const t = text.trimStart();
    if (!t || t.startsWith('<')) return undefined; // SPA fallback page, not data
    return text;
  } catch {
    return undefined;
  }
}
async function fetchJson(url: string): Promise<unknown | undefined> {
  const text = await fetchText(url);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- manifest
interface Manifest { real: Set<string>; mock: Set<string>; evidence: { real: boolean; mock: boolean } }
let manifestP: Promise<Manifest | null> | null = null;
function manifest(): Promise<Manifest | null> {
  if (!manifestP) {
    manifestP = fetchJson(dataUrl('data/_files.json')).then((m) => {
      const mm = m as { real?: string[]; mock?: string[]; evidence?: { real?: boolean; mock?: boolean } } | undefined;
      if (!mm || !Array.isArray(mm.real) || !Array.isArray(mm.mock)) return null;
      return { real: new Set(mm.real), mock: new Set(mm.mock), evidence: { real: !!mm.evidence?.real, mock: !!mm.evidence?.mock } };
    });
  }
  return manifestP;
}

async function resolve(file: string): Promise<{ url: string; origin: Origin } | null> {
  const m = await manifest();
  const tryReal = forced !== 'mock';
  const tryMock = forced !== 'real';
  if (m) {
    if (tryReal && m.real.has(file)) return { url: dataUrl('data/' + file), origin: 'real' };
    if (tryMock && m.mock.has(file)) return { url: dataUrl('data/mock/' + file), origin: 'mock' };
    return null;
  }
  return { url: '', origin: 'missing' }; // probe mode
}

async function loadRaw(file: string): Promise<{ raw: unknown; origin: Origin; text?: string }> {
  const r = await resolve(file);
  if (r && r.origin !== 'missing') {
    const raw = await fetchJson(r.url);
    if (raw !== undefined) return { raw, origin: r.origin };
    return { raw: null, origin: 'missing' };
  }
  if (r === null) return { raw: null, origin: 'missing' };
  // Probe mode (no manifest).
  if (forced !== 'mock') {
    const raw = await fetchJson(dataUrl('data/' + file));
    if (raw !== undefined) return { raw, origin: 'real' };
  }
  if (forced !== 'real') {
    const raw = await fetchJson(dataUrl('data/mock/' + file));
    if (raw !== undefined) return { raw, origin: 'mock' };
  }
  return { raw: null, origin: 'missing' };
}

// ---------------------------------------------------------------- parsers (tolerant)
const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : d;
};
const maybeJson = <T,>(v: unknown, d: T): T => {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return d;
    }
  }
  return (v as T) ?? d;
};

function parseRanches(raw: unknown): Ranch[] {
  const fc = raw as FeatureCollection<AreaGeom, RanchProps>;
  if (!fc || !Array.isArray(fc.features)) return [];
  const out: Ranch[] = [];
  for (const f of fc.features) {
    if (!f || !f.geometry || !f.properties) continue;
    const p = { ...f.properties } as RanchProps;
    const risk = maybeJson<RanchProps['risk']>(p.risk, { class: 'clean', score: 0, flags: [] });
    risk.flags = maybeJson<RiskFlag[]>(risk.flags, []).map((fl) => ({ ...fl, evidence: maybeJson<Record<string, unknown>>(fl.evidence, {}) }));
    if (!['clean', 'watch', 'high'].includes(risk.class)) risk.class = 'clean';
    p.risk = risk;
    p.defor_by_year = maybeJson(p.defor_by_year, null);
    p.id = String(p.id);
    p.median_holding_days = p.median_holding_days == null || Number.isNaN(Number(p.median_holding_days)) ? null : num(p.median_holding_days);
    for (const k of ['area_ha', 'pasture_ha', 'capacity_head', 'head_now', 'breeding_cows', 'defor_post2008_ha', 'defor_post2020_ha', 'inflow_head', 'outflow_head', 'upstream_taint_pct'] as const) {
      (p as Record<string, unknown>)[k] = num(p[k]);
    }
    out.push({ ...p, geometry: f.geometry, centroid: centroidOfGeom(f.geometry), bbox: bboxOfGeom(f.geometry) });
  }
  return out;
}

function parseMovements(raw: unknown): Movement[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Movement[])
    .filter((m) => m && m.from != null && m.to != null)
    .map((m) => ({ ...m, from: String(m.from), to: String(m.to), head: num(m.head), rejected: m.rejected || null }));
}

function parseDefor(raw: unknown): FeatureCollection<AreaGeom, DeforProps> | null {
  const fc = raw as FeatureCollection<AreaGeom, Record<string, unknown>>;
  if (!fc || !Array.isArray(fc.features)) return null;
  return {
    type: 'FeatureCollection',
    features: fc.features
      .filter((f) => f && f.geometry)
      .map((f) => {
        const p = f.properties ?? {};
        const year = Math.round(num(p.year ?? p.ano ?? p.YEAR, 0));
        const area_ha = p.area_ha != null ? num(p.area_ha) : num(p.area_km ?? p.areakm, 0) * 100;
        return { type: 'Feature', geometry: f.geometry, properties: { year, area_ha } };
      }),
  };
}

function parseProtected(raw: unknown): FeatureCollection<AreaGeom, ProtectedProps> | null {
  const fc = raw as FeatureCollection<AreaGeom, Record<string, unknown>>;
  if (!fc || !Array.isArray(fc.features)) return null;
  return {
    type: 'FeatureCollection',
    features: fc.features
      .filter((f) => f && f.geometry)
      .map((f) => {
        const p = f.properties ?? {};
        const kind = String(p.kind ?? 'conservation').toLowerCase().startsWith('ind') ? 'indigenous' : 'conservation';
        return { type: 'Feature', geometry: f.geometry, properties: { name: fixName(String(p.name ?? 'Protected area')), kind } };
      }),
  };
}

const identity = <T,>(raw: unknown) => (raw ?? null) as T | null;
function parseGeneric(raw: unknown): FeatureCollection | null {
  const fc = raw as FeatureCollection;
  if (!fc || !Array.isArray(fc.features)) return null;
  return { type: 'FeatureCollection', features: fc.features.filter((f) => f && f.geometry).map((f) => ({ type: 'Feature', geometry: f.geometry, properties: f.properties ?? {} })) };
}

export const DATASETS = {
  meta: { file: 'meta.json', parse: identity<Meta> },
  metrics: { file: 'metrics.json', parse: identity<Metrics> },
  ranches: { file: 'ranches.geojson', parse: parseRanches },
  movements: { file: 'movements.json', parse: parseMovements },
  destinations: { file: 'destinations.json', parse: (r: unknown) => (Array.isArray(r) ? (r as Destination[]) : []) },
  shipments: { file: 'shipments.json', parse: (r: unknown) => (Array.isArray(r) ? (r as Shipment[]) : []) },
  onchain: { file: 'onchain.json', parse: (r: unknown) => (r && typeof r === 'object' && Array.isArray((r as OnChain).records) ? (r as OnChain) : null) },
  deforestation: { file: 'layers/deforestation.geojson', parse: parseDefor },
  protected: { file: 'layers/protected.geojson', parse: parseProtected },
  aoi: { file: 'layers/aoi.geojson', parse: parseGeneric },
  cleared: { file: 'layers/cleared_before_2008.geojson', parse: parseGeneric },
} as const;

export type DatasetKey = keyof typeof DATASETS;
type DataOf<K extends DatasetKey> = NonNullable<ReturnType<(typeof DATASETS)[K]['parse']>>;

// ---------------------------------------------------------------- store
const promises = new Map<DatasetKey, Promise<void>>();
const results = new Map<DatasetKey, Loaded<unknown>>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function ensure(key: DatasetKey): Promise<void> {
  let p = promises.get(key);
  if (!p) {
    results.set(key, { data: null, origin: 'missing', status: 'loading' });
    const ds = DATASETS[key];
    p = loadRaw(ds.file).then(({ raw, origin }) => {
      let data: unknown = null;
      try {
        data = raw == null ? null : ds.parse(raw);
      } catch {
        data = null;
      }
      results.set(key, { data, origin: data == null ? 'missing' : origin, status: 'ready' });
      emit();
    });
    promises.set(key, p);
  }
  return p;
}

export function useData<K extends DatasetKey>(key: K, enabled = true): Loaded<DataOf<K>> {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (enabled) void ensure(key);
  }, [key, enabled]);
  const r = results.get(key);
  if (!r) return { data: null, origin: 'missing', status: 'loading' };
  return r as Loaded<DataOf<K>>;
}

/** Origins of every dataset requested so far (for the header badge). */
export function useOrigins(): Partial<Record<DatasetKey, Loaded<unknown>>> {
  useSyncExternalStore(subscribe, () => version);
  return Object.fromEntries(results.entries()) as Partial<Record<DatasetKey, Loaded<unknown>>>;
}

// ---------------------------------------------------------------- derived indexes (memoised per data object)
const memo = new WeakMap<object, Map<string, unknown>>();
export function derive<T extends object, R>(src: T | null, name: string, fn: (s: T) => R): R | null {
  if (!src) return null;
  let m = memo.get(src);
  if (!m) memo.set(src, (m = new Map()));
  if (!m.has(name)) m.set(name, fn(src));
  return m.get(name) as R;
}

export function useRanchIndex() {
  const r = useData('ranches');
  return derive(r.data, 'byId', (list) => new Map(list.map((x) => [x.id, x])));
}

export interface MoveIndex { byFrom: Map<string, Movement[]>; byTo: Map<string, Movement[]>; byGta: Map<string, Movement> }
export function indexMovements(list: Movement[]): MoveIndex {
  const byFrom = new Map<string, Movement[]>(), byTo = new Map<string, Movement[]>(), byGta = new Map<string, Movement>();
  for (const m of list) {
    byGta.set(m.gta, m);
    if (m.rejected) continue;
    (byFrom.get(m.from) ?? byFrom.set(m.from, []).get(m.from)!).push(m);
    (byTo.get(m.to) ?? byTo.set(m.to, []).get(m.to)!).push(m);
  }
  return { byFrom, byTo, byGta };
}
export function useMoveIndex(enabled = true) {
  const r = useData('movements', enabled);
  return derive(r.data, 'index', indexMovements);
}

// ---------------------------------------------------------------- ABI + evidence
export async function loadAbi(abiPath?: string): Promise<unknown[] | null> {
  const tries: string[] = [];
  if (abiPath) tries.push(dataUrl(abiPath));
  tries.push(dataUrl('data/HerdLedger.abi.json'));
  if (forced !== 'real') tries.push(dataUrl('data/mock/HerdLedger.abi.json'));
  const m = await manifest();
  for (const url of tries) {
    if (m) {
      const rel = url.slice(BASE.length).replace(/^data\//, '');
      const isMock = rel.startsWith('mock/');
      const key = isMock ? rel.slice(5) : rel;
      if (!(isMock ? m.mock : m.real).has(key)) continue;
    }
    const raw = await fetchJson(url);
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object' && Array.isArray((raw as { abi?: unknown[] }).abi)) return (raw as { abi: unknown[] }).abi;
  }
  return null;
}

/** Fetch an evidence bundle as exact bytes. */
export async function fetchEvidence(hash: string): Promise<{ bytes: ArrayBuffer; origin: Origin; url: string } | null> {
  const hex = hash.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{16,}$/.test(hex)) return null;
  const file = `evidence/${hex}.json`;
  const m = await manifest();
  const cands: { url: string; origin: Origin }[] = [];
  if (forced !== 'mock' && (!m || m.evidence.real)) cands.push({ url: dataUrl('data/' + file), origin: 'real' });
  if (forced !== 'real' && (!m || m.evidence.mock)) cands.push({ url: dataUrl('data/mock/' + file), origin: 'mock' });
  for (const c of cands) {
    try {
      const r = await fetch(c.url, { cache: 'no-cache' });
      if (!r.ok) continue;
      const bytes = await r.arrayBuffer();
      const head = new TextDecoder().decode(bytes.slice(0, 64)).trimStart();
      if (head.startsWith('<')) continue;
      return { bytes, origin: c.origin, url: c.url };
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Small helper hook: run once when `when` becomes true. */
export function useOnce(when: boolean) {
  const [v, setV] = useState(false);
  useEffect(() => {
    if (when && !v) setV(true);
  }, [when, v]);
  return v;
}

/** Current parsed value of a dataset (after ensure()). */
export function peek<K extends DatasetKey>(key: K): DataOf<K> | null {
  return (results.get(key)?.data as DataOf<K> | undefined) ?? null;
}
