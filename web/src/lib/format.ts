const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export const fmt = (n: number | null | undefined, digits = 0) =>
  n == null || !Number.isFinite(n) ? '–' : digits ? new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n) : nf0.format(n);
export const fmt1 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '–' : nf1.format(n));
export const pct = (n: number | null | undefined, digits = 0) => (n == null || !Number.isFinite(n) ? '–' : `${fmt(n, digits)}%`);
export const compact = (n: number) => (Math.abs(n) >= 1e6 ? `${fmt1(n / 1e6)}M` : Math.abs(n) >= 1e4 ? `${fmt1(n / 1e3)}k` : fmt(n));

export const shortHash = (h?: string | null, head = 6, tail = 4) => {
  if (!h) return '–';
  return h.length <= head + tail + 3 ? h : `${h.slice(0, head + 2)}…${h.slice(-tail)}`;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDate = (iso?: string | null) => {
  if (!iso) return '–';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m) return iso;
  return `${d ? d + ' ' : ''}${MONTHS[m - 1]} ${y}`;
};

export const MARKET_LABEL: Record<string, string> = {
  TR: 'Türkiye', EG: 'Egypt', IQ: 'Iraq', LB: 'Lebanon', MA: 'Morocco', SA: 'Saudi Arabia', JO: 'Jordan',
  EU: 'European Union', BR: 'Brazil (domestic)', CN: 'China',
};
export const marketLabel = (m: string) => MARKET_LABEL[m] ?? m;

export const ROLE_LABEL: Record<string, string> = { breeder: 'Breeder (cow-calf)', rearer: 'Rearer', fattener: 'Fattener', intermediary: 'Intermediary / trader' };
export const roleLabel = (r: string) => ROLE_LABEL[r] ?? r;

export const PURPOSE_LABEL: Record<string, string> = { breeding: 'breeding', rearing: 'rearing', fattening: 'fattening', slaughter: 'slaughter', export: 'live export' };

export const explorerTx = (explorer: string | null | undefined, tx: string | null | undefined) =>
  explorer && tx ? `${explorer.replace(/\/$/, '')}/tx/${tx}` : null;
export const explorerAddr = (explorer: string | null | undefined, a: string | null | undefined) =>
  explorer && a ? `${explorer.replace(/\/$/, '')}/address/${a}` : null;
