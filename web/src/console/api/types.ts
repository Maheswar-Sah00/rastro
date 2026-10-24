// Types for the Rastro API (/api/v1). They mirror backend/app/schemas/api.py and the pipeline's
// versioned schemas (rastro.schemas.canonical / geo / lineage / risk). Keep them in this one module.

export type DataStatus = 'real' | 'synthetic' | 'derived' | 'unavailable';
export type Outcome = 'PASS' | 'REVIEW' | 'FLAGGED';
export type RiskClass = 'high' | 'watch' | 'clean' | 'insufficient_data';
export type Severity = 'info' | 'watch' | 'high';

export interface Provenance {
  dataset_id: string | null;
  dataset_version: string | null;
  logical_digest: string | null;
  generated_at: string | null;
  schema_version: string | null;
  data_status: Record<string, DataStatus>;
  freshness: Record<string, number | null>;
}
export interface PageInfo { limit: number; offset: number; total: number }
export interface Item<T> { meta: Provenance; data: T }
export interface Items<T> { meta: Provenance; page: PageInfo; data: T[] }

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; request_id?: string };
}

// ---- system -------------------------------------------------------------------------------
export interface Health {
  status: 'ok' | 'degraded';
  version: string;
  api_version: string;
  schema_version: string;
  data_dir_found: boolean;
  datasets: Record<string, 'real' | 'mock' | null>;
}
export interface Ready { ready: boolean; checks: Record<string, boolean>; missing: string[] }

// ---- canonical records ----------------------------------------------------------------------
export interface Ranch {
  ranch_id: string;
  entity_type: 'ranch' | 'external_supplier';
  display_name: string;
  municipality: string;
  municipality_ibge: string | null;
  geometry_ref: string | null;
  total_area_hectares: number | null;
  pasture_area_hectares: number | null;
  estimated_cattle_capacity: number | null;
  breeding_cows_declared: number;
  opening_head: number;
  role: string;
  owner_group_id: string;
  registered_on: string;
  data_source: string;
  data_quality: { geometry: string; attributes: string; notes: string | null };
}
export interface GtaMovement {
  gta_id: string;
  lot_id: string;
  origin_id: string;
  origin_type: 'ranch' | 'external_supplier';
  destination_id: string;
  destination_type: 'ranch' | 'slaughterhouse' | 'export_port';
  issue_date: string;
  movement_date: string;
  head_count: number;
  purpose: string;
  source_lot_ids: string[] | null;
  permit_status: 'issued' | 'attempted_while_embargoed';
  provenance: string;
}
export interface Shipment {
  shipment_id: string;
  kind: 'delivery' | 'voyage';
  destination_id: string;
  shipment_date: string;
  gta_ids: string[];
  lot_allocations: { lot_id: string; head: number }[];
  declared_head_count: number;
  lineage_coverage: number | null;
  certification_status: string;
}

// ---- geo evidence ------------------------------------------------------------------------------
export interface AreaOverlap {
  feature_id: string;
  name: string;
  legal_context: string;
  overlap_ha: number;
  overlap_share: number;
  phase?: string | null;
  recognised?: boolean | null;
  category?: string | null;
  strict_protection?: boolean | null;
}
export interface Overlap { overlap_ha: number; overlap_share: number; areas: AreaOverlap[] }
export interface GeoEvidence {
  schema_version: string;
  ranch_id: string;
  cutoff_date: string;
  as_of: string;
  geometry: { status: string; area_ha: number | null; source_crs: string | null; data_status: string };
  post_cutoff_deforestation_area_hectares: number | null;
  intersecting_deforestation_polygon_ids: string[] | null;
  deforestation: {
    coverage: 'full' | 'partial' | 'none' | 'undeclared';
    post_cutoff_ha: number | null;
    straddles_cutoff_ha: number | null;
    pre_cutoff_ha: number | null;
    unknown_date_ha: number | null;
    pre_cutoff_undated_ha: number | null;
    nearest_post_cutoff_km: number | null;
    post_cutoff_nearby_not_intersecting: number | null;
    proximity_km: number;
  };
  indigenous_territory: Overlap | null;
  protected_area: Overlap | null;
  embargo: { status: 'none' | 'active' | 'historical' | 'unverified'; embargo_ids: string[]; sources: string[]; simulated: boolean; since: string | null };
  nearest_slaughterhouse_km: number | null;
  legal: {
    eudr_cutoff_indicator: string;
    recognised_indigenous_land_overlap: boolean | null;
    strict_protection_overlap: boolean | null;
    embargo_status: string;
    embargo_simulated: boolean;
    note: string;
  };
  scientific_risk: { class: 'low' | 'watch' | 'high' | 'unknown'; reasons: string[] };
  dataset_versions: Record<string, string>;
  data_status: Record<string, string>;
  warnings: string[];
}

// ---- lineage --------------------------------------------------------------------------------------
export interface LineageSource {
  origin_key: string;
  ranch_id: string | null;
  origin_kind: 'birth' | 'opening' | 'external' | 'unresolved' | 'missing';
  head_equiv: number;
  share_pct: number;
  min_hops: number;
  categories: string[];
}
export interface PathStep { gta_id: string; lot_id: string; date: string; from: string; to: string; permit_head: number; attributed_head: number }
export interface LineageTrace {
  schema_version: string;
  target_kind: 'shipment' | 'gta' | 'lot';
  shipment_id: string | null;
  lot_ids: string[];
  gta_ids: string[];
  declared_head: number;
  traced_head: number;
  policy: 'fifo' | 'pro_rata';
  coverage_pct: number;
  sources: LineageSource[];
  intermediaries: string[];
  direct_suppliers: string[];
  max_hops: number;
  exposure_pct: Record<string, number>;
  attribution: {
    record_inconsistency_pct: number;
    environmental_overlap_pct: number;
    suspected_laundering_pct: number;
    unknown_provenance_pct: number;
    review_required: boolean;
    review_reasons: string[];
  };
  policy_sensitivity: { fifo_any_risk_pct: number; pro_rata_any_risk_pct: number; spread_pct: number };
  trace_path: PathStep[];
  unresolved: { gta_id: string; head: number; reason: string }[];
  evidence_refs: string[];
  uncertainty_notes: string[];
}

// ---- risk -------------------------------------------------------------------------------------------
export interface Finding {
  schema_version: string;
  finding_id: string;
  entity_type: 'ranch' | 'gta' | 'shipment';
  entity_id: string;
  dataset_refs: string[];
  detector: string;
  detector_version: string;
  code: string;
  category: string;
  severity: Severity;
  confidence: number;
  blocking: boolean;
  features: Record<string, unknown>;
  observed: Record<string, unknown>;
  thresholds: { name: string; value: number | string; comparison: string }[];
  evidence_ids: string[];
  explanation: string;
  limitations: string[];
  observed_at: string;
  evidence_hash: string | null;
}
export interface Decision {
  schema_version: string;
  shipment_id: string;
  outcome: Outcome;
  risk_categories: string[];
  reasons: string[];
  blocking_finding_ids: string[];
  review_finding_ids: string[];
  exposure_pct: Record<string, number>;
  coverage_pct: number;
  direct_suppliers: string[];
  thresholds: Record<string, number>;
  evidence_hash: string;
  decided_at: string;
}

// ---- API views ----------------------------------------------------------------------------------------
export type EnvStatus = 'available' | 'missing' | 'not_applicable';
export interface RanchSummary {
  ranch_id: string;
  display_name: string;
  entity_type: string;
  role: string;
  total_area_hectares: number | null;
  pasture_area_hectares: number | null;
  estimated_cattle_capacity: number | null;
  data_source: string;
  environmental_evidence: EnvStatus;
  post_cutoff_deforestation_ha: number | null;
  eudr_indicator: string | null;
  risk_status: 'assessed' | 'not_assessed';
  risk_class: RiskClass | null;
}
export interface RanchRiskView {
  ranch_id: string;
  risk_status: 'assessed' | 'not_assessed';
  risk_class: RiskClass | null;
  anomaly_score: number | null;
  anomaly_note: string;
  findings: Finding[];
}
export interface RanchDetail {
  ranch: Ranch;
  environmental: { status: EnvStatus; evidence: GeoEvidence | null };
  risk: RanchRiskView;
  movements: Record<string, number>;
}
export interface MovementView {
  movement: GtaMovement;
  ledger_status: 'accepted' | 'refused' | 'not_moved';
  refusal_reason: string | null;
  shipment_id: string | null;
}
export interface GtaDetail extends MovementView { lineage?: LineageTrace | null }

export interface ShipmentSummary {
  shipment_id: string;
  kind: string;
  destination_id: string;
  shipment_date: string;
  declared_head_count: number;
  gta_count: number;
  assessment_status: 'assessed' | 'not_assessed';
  outcome: Outcome | null;
  coverage_pct: number | null;
  any_risk_pct: number | null;
}
export interface ShipmentDetail {
  shipment: Shipment;
  assessment_status: 'assessed' | 'not_assessed';
  decision: Decision | null;
  lineage: LineageTrace | null;
}
export interface ShipmentRisk {
  shipment_id: string;
  assessment_status: 'assessed' | 'not_assessed';
  decision: Decision | null;
  findings_by_category: Record<string, Finding[]>;
}
export interface EvidenceItem { kind: 'decision' | 'finding'; id: string; evidence_hash: string; file: string; file_present: boolean; hash_verified: boolean | null }
export interface ShipmentEvidence { shipment_id: string; items: EvidenceItem[]; lineage_evidence_refs: string[]; note: string }
export interface Assessment {
  shipment_id: string;
  source: 'precomputed' | 'recomputed';
  outcome: Outcome;
  risk_categories: string[];
  reasons: string[];
  findings_by_category: Record<string, Finding[]>;
  evidence_refs: string[];
  decision_evidence_hash: string;
  coverage_pct: number;
  exposure_pct: Record<string, number>;
  policy_sensitivity: Record<string, number>;
  uncertainty_notes: string[];
  detector_versions: string[];
  engine_version: string | null;
}

export interface ChainInfo {
  mode: 'rpc' | 'local_records';
  network: string | null;
  chain_id: number | null;
  address: string | null;
  label: string;
  verified_public: boolean;
  available: boolean;
  detail: string | null;
}
export interface CertificateView {
  certificate_id: string;
  shipment_ref: string | null;
  verdict: string | null;
  evidence_hash: string | null;
  status: string;
  status_source: string;
  chain: ChainInfo;
  records: Record<string, unknown>[];
}
export interface VerifyResult {
  certificate_id: string;
  evidence_file_present: boolean;
  evidence_hash_matches: boolean | null;
  onchain_hash_matches: boolean | null;
  status: string;
  usable: boolean;
  chain: ChainInfo;
  notes: string[];
  outcome?: 'valid' | 'consumed' | 'revoked' | 'expired' | 'not_clean' | 'invalid' | 'unverifiable' | 'not_on_ledger' | null;
  reason?: string | null;
  checks?: { check: string; ok: boolean | null; detail: string }[];
  signer?: string | null;
  certificate?: Record<string, unknown> | null;
  verified_at?: string | null;
}
/** One line of the issuance registry; chain fields come only from mined receipts or simulated reverts. */
export interface CertificateEvent {
  event: string;
  logged_at: string;
  shipment_id?: string | null;
  lot_id?: string | null;
  decision?: string | null;
  reason?: string | null;
  evidence_hash?: string | null;
  tx_hash?: string | null;
  block_number?: number | null;
  receipt_status?: number | null;
  status_after?: string | null;
  error?: { name?: string } | string | null;
}
export interface RedTeamHeadline {
  scenario: string; role: string; seed: number;
  rastro_cattle_caught_flagged_pct: number | null; rastro_cattle_caught_flag_or_review_pct: number | null; baseline_cattle_caught_pct: number | null;
  rastro_clean_lots_flagged_pct: number | null; rastro_clean_lots_reviewed_pct: number | null; baseline_clean_lots_flagged_pct: number | null;
  laundering_found_high: string; laundering_found_baseline: string; shipment_review_rate_pct: number;
  coverage_head_weighted_pct: number; unknown_origin_head_weighted_pct: number; processing_s: number;
}
export interface RedTeamSummary {
  run_command: string; held_out_seed: number; development_seed: number; versions: Record<string, string>; baseline_rule: string;
  headline: RedTeamHeadline[]; brief_comparison: Record<string, unknown>; leakage_controls: string[]; circularity: string[]; artifacts: string[];
}
export interface EvaluationSummary { status: 'available' | 'unavailable'; report: EvaluationReport | null; redteam?: RedTeamSummary | null; note: string }

export interface BinaryMetrics {
  tp: number; fp: number; fn: number; tn: number;
  precision: number | null; recall: number | null; f1: number | null; false_positive_rate: number | null;
  predicted: number; actual: number;
}
export interface LotEval {
  confusion: Record<string, Record<Outcome, number>>;
  flagged_vs_major_taint: BinaryMetrics;
  not_pass_vs_any_taint: BinaryMetrics;
  tainted_head_caught_pct_flag_or_review: number | null;
  tainted_head_caught_pct_flagged_only: number | null;
  clean_lots_flagged_pct: number | null;
  clean_lots_reviewed_pct: number | null;
  lots: number;
}
export interface EvaluationReport {
  engine_version: string;
  role: string;
  dataset: string;
  seed: number;
  tuning_note: string;
  ranch_level: { per_detector: Record<string, BinaryMetrics>; overall: Record<string, BinaryMetrics>; honest_hard_cases_risk_class: Record<string, Record<string, number>> };
  lot_level: Record<string, LotEval>;
  ablation: Record<string, Record<string, number | null>>;
  caveats: string[];
}

// /api/v1/summary is loosely typed on purpose: the console reads known keys defensively.
export type Summary = Record<string, unknown>;

// Published web bundle (/api/v1/datasets/{name}), schema v1.
export interface Envelope<T> { schema: string; source: 'real' | 'mock'; data: T }
export interface BundleMovement {
  gta: string; hash: string; from: string; to: string; head: number; date: string; purpose: string;
  suspicious: boolean; rejected: string | null;
}
export interface BundleDestination { id: string; kind: 'slaughterhouse' | 'port'; name: string; lat: number; lon: number; real: boolean }

export interface ChainStatus {
  chain: ChainInfo;
  roles: Record<string, string> | null;
  oracle_check: { is_oracle: boolean | null; source?: string; label?: string; detail?: string } | null;
  totals: Record<string, number> | null;
  conserved: boolean | null;
}
export interface PreparedTx { to: string | null; data: string; value: string; signed: boolean; note: string }

// ---- investigation workspace (Task 08) ------------------------------------------------------------
export type ReviewStatus = 'under_review' | 'confirmed' | 'dismissed';
export interface ReviewEntry {
  review_id: string;
  finding_id: string;
  status: ReviewStatus;
  reason: string | null;
  reviewer: string;
  at: string;
  request_id: string;
  finding_evidence_hash: string | null;
  finding_code: string;
  finding_blocking: boolean;
}
export interface FindingView {
  finding: Finding;
  review_status: ReviewStatus | 'unreviewed' | string;
  reviews: ReviewEntry[];
  decision_impact: { shipment_id: string; outcome: Outcome; role: string; note: string }[];
}
export interface GraphNode {
  id: string;
  kind: 'ranch' | 'sink' | 'unknown_origin' | 'folded';
  ranch_id: string | null;
  roles: string[];
  origin_kinds: string[];
  head_fifo: number;
  head_pro_rata: number;
  share_pct: number;
  categories: string[];
  finding_ids: string[];
  data_status: string;
}
export interface GraphEdge {
  gta_id: string | null;
  kind: 'gta' | 'unattributed_inflow' | 'folded';
  from: string;
  to: string;
  date: string | null;
  permit_head: number;
  attributed_head: number;
  gta_count?: number | null;
}
export interface LineageGraph {
  shipment_id: string;
  declared_head: number;
  destination: string;
  policy: string;
  view: { mode: 'full' | 'overview' | 'branch'; max_nodes?: number; root?: string; folded: { node: string; members: string[] }[] };
  nodes: GraphNode[];
  edges: GraphEdge[];
  totals: { source_head_fifo?: number; source_head_pro_rata?: number; pro_rata_only_head?: number; [k: string]: number | undefined };
  uncertainty: {
    policy_sensitivity?: { fifo_any_risk_pct: number; pro_rata_any_risk_pct: number; spread_pct: number };
    notes?: string[];
    model?: string;
    pro_rata_only_origins?: { count: number; head: number; top: { id: string; head: number }[] };
  };
}
export interface CategoryShare {
  head: number;
  pct: number;
  sources: string[];
  via_intermediaries?: { ranch_id: string; codes: string[]; attributed_head: number }[] | null;
  note?: string | null;
}
export interface Breakdown {
  shipment_id: string;
  declared_head: number;
  categories: Record<string, CategoryShare>;
  unique_affected_head: number;
  unique_affected_pct: number;
  sum_of_category_pct: number;
  note: string;
}
export interface ClearingStep { action: string; why: string; finding_id: string | null }
export interface ShipmentRiskDetail extends ShipmentRisk {
  breakdown: Breakdown;
  clearing_steps: ClearingStep[];
  review_status: Record<string, string>;
}
export interface LineageReport {
  shipment_id: string;
  declared_head: number;
  coverage_pct: number;
  max_hops: number;
  outcome: Outcome | null;
  exposure_pct: Record<string, number>;
  attribution: Record<string, unknown>;
  breakdown: Breakdown;
  sources: Record<string, unknown>[];
  path: Record<string, unknown>[];
  uncertainty_notes: string[];
  provenance: Provenance;
}
