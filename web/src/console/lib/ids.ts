// Identifier patterns (docs/data-dictionary.md) and global-search routing.
export const ID_PATTERNS = {
  ranch: /^R\d{4}$/,
  external: /^X\d{2,}$/,
  gta: /^GTA-[A-Z]{2}-(\d{4}-\d{6}|ATTEMPT-\d{4})$/,
  lot: /^LOT-.+/,
  shipment: /^SHP-[DV]-\d+$/,
  certificate: /^0x[0-9a-fA-F]{64}$/,
};

export interface SearchTarget { page: string; id: string; label: string }

/** Map free text to a route. Accepts lower case and a bare number for ranches (e.g. "120" -> R0120). */
export function resolveSearch(text: string): SearchTarget | null {
  const t = text.trim();
  if (!t) return null;
  const up = t.toUpperCase();
  if (ID_PATTERNS.certificate.test(t)) return { page: 'certificates', id: t.toLowerCase(), label: 'Certificate' };
  if (ID_PATTERNS.lot.test(up)) return { page: 'lots', id: up, label: 'Lot lineage' };
  if (ID_PATTERNS.gta.test(up)) return { page: 'gtas', id: up, label: 'GTA' };
  if (ID_PATTERNS.shipment.test(up)) return { page: 'shipments', id: up, label: 'Shipment' };
  if (ID_PATTERNS.ranch.test(up) || ID_PATTERNS.external.test(up)) return { page: 'ranches', id: up, label: 'Ranch' };
  if (/^\d{1,4}$/.test(t)) return { page: 'ranches', id: `R${t.padStart(4, '0')}`, label: 'Ranch' };
  return null;
}

export function entityPage(id: string): string | null {
  const r = resolveSearch(id);
  return r ? r.page : null;
}
