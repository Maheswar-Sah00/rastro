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
export function label(code: string): string {
  return code.replace(/_/g, ' ').replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bPct\b/, '%');
}
export function plural(n: number, one: string, many = `${one}s`) {
  return `${nf.format(n)} ${n === 1 ? one : many}`;
}
