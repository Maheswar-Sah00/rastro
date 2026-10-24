export const nf = new Intl.NumberFormat('en-US');

/** Formats a number, keeping null distinct from zero ("—" means not measured, never "none"). */
export function num(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
export function pct(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? '—' : `${num(v, digits)}%`;
}
export function ha(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? '—' : `${num(v, digits)} ha`;
}
export function short(hash: string | null | undefined, n = 10): string {
  if (!hash) return '—';
  return hash.length > n + 4 ? `${hash.slice(0, n)}…${hash.slice(-4)}` : hash;
}
// Plain-English names for codes the API returns (risk categories, finding codes, dataset counts).
const PLAIN: Record<string, string> = {
  post_cutoff_deforestation: 'Forest cleared after 2020',
  embargo: 'Embargoed ranch',
  indigenous_territory: 'Indigenous land',
  protected_area: 'Protected area',
  inventory_birth_anomalies: 'Impossible births or herd size',
  suspicious_movement_behaviour: 'Suspicious resales',
  unknown_origin: 'Origin unknown',
  environmental: 'Environmental',
  behavioural: 'Suspicious trading',
  record_inconsistency: 'Paperwork does not add up',
  PHANTOM_BIRTHS: 'More calves than the herd could have',
  INSUFFICIENT_HERD: 'Sold more cattle than it had',
  OVER_CAPACITY: 'More cattle than the land can hold',
  PASS_THROUGH: 'Resells cattle almost immediately',
  TAINTED_SUPPLY: 'Cattle from a risky ranch',
  ANOMALY: 'Unusual trading pattern',
  EMBARGOED: 'Embargoed ranch',
  POST2020_DEFORESTATION: 'Forest cleared after 2020',
  PROTECTED_AREA: 'Inside a protected area',
  gta_movements: 'Cattle-transport permits',
  birth_declarations: 'Births recorded',
  death_declarations: 'Deaths recorded',
  herd_inventory: 'Herd counts',
  prodes_deforestation: 'Forest-clearing areas (satellite)',
  ranch_boundaries: 'Ranch boundaries',
  ledger_refusals: 'Refused by the ledger',
  indigenous_territories: 'Indigenous territories',
  conservation_units: 'Protected areas',
  destinations: 'Slaughterhouses and ports',
};

export function label(code: string): string {
  if (PLAIN[code]) return PLAIN[code];
  return code.replace(/_/g, ' ').replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bPct\b/, '%');
}
export function plural(n: number, one: string, many = `${one}s`) {
  return `${nf.format(n)} ${n === 1 ? one : many}`;
}
