// Data contracts: docs/SPEC.md section 6 (+ the documented optional extensions).

export type RiskClass = 'clean' | 'watch' | 'high';
export type TraceClass = RiskClass | 'unknown';
export type Role = 'breeder' | 'rearer' | 'fattener' | 'intermediary';

export type Position = [number, number];
export interface PolygonGeom { type: 'Polygon'; coordinates: Position[][] }
export interface MultiPolygonGeom { type: 'MultiPolygon'; coordinates: Position[][][] }
export type AreaGeom = PolygonGeom | MultiPolygonGeom;

export interface Feature<G = AreaGeom, P = Record<string, unknown>> {
  type: 'Feature';
  id?: number | string;
  properties: P;
  geometry: G;
}
export interface FeatureCollection<G = AreaGeom, P = Record<string, unknown>> {
  type: 'FeatureCollection';
  features: Feature<G, P>[];
}

export interface DataSourceInfo { name: string; url?: string; license?: string; real?: boolean }

export interface Meta {
  project: string;
  aoi: { name: string; bbox: [number, number, number, number] };
  generated_at?: string;
  years?: number[];
  eudr_cutoff?: string;
  synthetic_notice?: string;
  sources?: DataSourceInfo[];
}

export interface RiskFlag {
  code: string;
  severity: 'high' | 'medium' | 'low' | string;
  title: string;
  text: string;
  evidence?: Record<string, unknown> | null;
}

export interface RanchProps {
  id: string;
  onchain_id?: string;
  role: Role | string;
  area_ha: number;
  pasture_ha: number;
  capacity_head: number;
  head_now: number;
  breeding_cows: number;
  defor_post2008_ha: number;
  defor_post2020_ha: number;
  in_protected: boolean;
  protected_name: string | null;
  embargoed: boolean;
  inflow_head: number;
  outflow_head: number;
  median_holding_days: number | null;
  risk: { class: RiskClass; score: number; flags: RiskFlag[]; evidence_hash?: string | null };
  upstream_taint_pct: number;
  status_quo_flagged: boolean;
  truth?: string;
  // Optional extensions (pipeline may add them)
  ti_overlap_ha?: number | null;
  uc_overlap_ha?: number | null;
  defor_by_year?: Record<string, number> | null;
  births_declared?: number | null;
  births_biological_max?: number | null;
  capacity_peak_pct?: number | null;
  rejected_gtas?: number | null;
  uc_name?: string | null;
  [k: string]: unknown;
}

export interface Ranch extends RanchProps {
  geometry: AreaGeom;
  centroid: Position;
  bbox: [number, number, number, number];
}

export interface Movement {
  gta: string;
  hash?: string;
  from: string;
  to: string;
  head: number;
  date: string;
  purpose: 'breeding' | 'rearing' | 'fattening' | 'slaughter' | 'export' | string;
  suspicious?: boolean;
  rejected?: string | null;
}

export interface Destination {
  id: string;
  kind: 'slaughterhouse' | 'port' | string;
  name: string;
  company?: string | null;
  inspection?: string | null;
  lat: number;
  lon: number;
  municipality?: string;
  real?: boolean;
}

export interface TraceRanch { ranch: string; head_equiv: number; risk_class: TraceClass | string; hops: number }
export interface TraceLink { origin: string; via: string; head: number; class: string }

export interface Shipment {
  id: string;
  kind?: 'voyage' | 'delivery' | string;
  destination: string;
  market: 'TR' | 'EU' | 'BR' | 'CN' | string;
  head: number;
  date: string;
  gtas: string[];
  trace: {
    clean_pct: number;
    watch_pct?: number;
    flagged_pct: number;
    unknown_pct: number;
    max_hops: number;
    by_ranch: TraceRanch[];
    n_origins?: number;
    links?: TraceLink[]; // exact origin -> direct supplier edges ("other:<class>" aggregates the tail)
  };
  direct_suppliers?: string[];
  truth_tainted_pct?: number; // simulator ground truth (evaluation mode only)
  status_quo_verdict: 'pass' | 'fail' | string;
  rastro_verdict: 'pass' | 'review' | 'fail' | string;
  certificate?: { lot_id: string; verdict: 'clean' | 'flagged' | 'unknown' | string; evidence_hash?: string };
}

export interface EvalBlock {
  precision: number;
  recall: number;
  tainted_head_caught_pct: number;
  network_recall?: number;
  clean_lots_failed_pct?: number;
  clean_lots_reviewed_pct?: number;
  dirty_sources_found?: number;
  dirty_sources_total?: number;
  [k: string]: unknown;
}
export interface Metrics {
  counts: { ranches: number; movements: number; head_moved: number; shipments: number; [k: string]: number };
  eval: { status_quo: EvalBlock; rastro: EvalBlock; lots?: number; tainted_head_at_sinks?: number; head_at_sinks?: number };
  headline: {
    tainted_head_pct_passing_status_quo: number;
    tainted_head_pct_caught_rastro?: number;
    laundering_ranches_found: number;
    laundering_ranches_total?: number;
    shipments_with_tainted_cattle_passing_status_quo?: number;
    tr_shipments?: number;
    tr_shipments_flagged?: number;
  };
  ledger?: { refused?: Record<string, { gtas_or_events: number; head: number }>; smuggled_head_without_gta?: number };
  real_data?: {
    prodes_polygons?: number; prodes_polygons_in_window?: number; defor_post2020_ha?: number; defor_2008_2025_ha?: number;
    ibge_herd_municipality?: number; ibge_year?: number; ibge_herd_para?: number; window_herd_share_of_municipality_pct?: number;
  };
  stress_test?: { status_quo: EvalBlock; rastro: EvalBlock; lots?: number; tainted_head_at_sinks?: number; head_at_sinks?: number };
  thresholds?: { fail_flagged_pct?: number; review_flagged_pct?: number };
  notes?: string;
}

export interface ChainRecord {
  kind: string;
  ref: string;
  tx: string | null;
  block?: number | null;
  status: 'success' | 'reverted' | string;
  revert_reason?: string | null;
  note?: string | null;
  demo?: string;
  expected?: string;
  evidence_hash?: string | null;
  // Optional: raw call for live replay of revert demos.
  call?: { from?: string; to?: string; data: string } | null;
}

export interface OnChain {
  network: string;
  chainId?: number;
  address?: string;
  explorer?: string | null;
  rpc?: string | null;
  deploy_tx?: string | null;
  records: ChainRecord[];
  abi_path?: string;
  roles?: Partial<Record<'registrar' | 'regulator' | 'buyer' | 'relayer' | 'oracle' | 'issuer', string>>;
  demo?: { labels?: Record<string, string> } & Record<string, unknown>;
  totals?: Record<string, number>;
  calls?: Record<string, number>;
  conserved?: boolean;
  generated_at?: string;
}

export interface DeforProps { year: number; area_ha: number }
export interface ProtectedProps { name: string; kind: 'indigenous' | 'conservation' | string }
