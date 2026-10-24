import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, unwrap } from '../api/client';
import type { CertificateView, Health, Ready } from '../api/types';
import { useApi } from '../api/useApi';
import { resolveSearch } from '../lib/ids';
import { href, navigate } from '../lib/router';
import { Icon } from './Icon';

export const NAV: { page: string; label: string; icon: string; group: string }[] = [
  { page: 'overview', label: 'Overview', icon: 'overview', group: 'Monitor' },
  { page: 'map', label: 'Live Map', icon: 'map', group: 'Monitor' },
  { page: 'investigations', label: 'Investigations', icon: 'investigation', group: 'Investigate' },
  { page: 'shipments', label: 'Shipments', icon: 'shipment', group: 'Investigate' },
  { page: 'ranches', label: 'Ranches', icon: 'ranch', group: 'Investigate' },
  { page: 'movements', label: 'Movements', icon: 'movement', group: 'Investigate' },
  { page: 'certificates', label: 'Certificates', icon: 'certificate', group: 'Verify' },
  { page: 'ledger', label: 'HerdLedger', icon: 'ledger', group: 'Verify' },
  { page: 'evaluation', label: 'Evaluation', icon: 'evaluation', group: 'About' },
  { page: 'sources', label: 'Data Sources', icon: 'sources', group: 'About' },
];
const GROUPS = [...new Set(NAV.map((n) => n.group))];
const ALIAS: Record<string, string> = { gtas: 'movements', lots: 'shipments' };

export interface EnvInfo { kind: 'simulation' | 'local_chain' | 'public_testnet' | 'unknown'; label: string; detail: string }

/** Derive the environment from the API: data is synthetic unless the chain adapter says a public chain answered. */
export function envFrom(health: Health | null, ready: Ready | null, chain: CertificateView['chain'] | null): EnvInfo {
  if (!health) return { kind: 'unknown', label: 'API offline', detail: 'No connection to the Rastro API; nothing on screen is live.' };
  if (chain?.verified_public && chain.available)
    return { kind: 'public_testnet', label: `Public testnet · ${chain.network || chain.chain_id}`, detail: 'Chain reads are eth_calls to a public testnet. Ranch data is still synthetic.' };
  if (chain && chain.mode === 'rpc' && chain.available)
    return { kind: 'local_chain', label: 'Local chain (anvil)', detail: 'Chain reads go to a local anvil node. Not a public network. Ranch data is synthetic.' };
  if (chain && chain.mode === 'local_records')
    return { kind: 'local_chain', label: 'Local chain (anvil replay)', detail: `${chain.label}. Ranch data is synthetic.` };
  return {
    kind: 'simulation',
    label: 'Local simulation',
    detail: `Synthetic dataset${ready && !ready.ready ? ' (not ready: ' + ready.missing.join(', ') + ')' : ''}. No chain connection established.`,
  };
}

export function Layout({ page, routeKey, env, children, demo }: { page: string; routeKey: string; env: EnvInfo; children: ReactNode; demo: boolean }) {
  const active = ALIAS[page] || page;
  const [navOpen, setNavOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  // Only the content pane scrolls; every new page starts at its top.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    setNavOpen(false);
  }, [routeKey]);
  return (
    <div className="console">
      <header className="topbar">
        <button type="button" className="btn btn-icon nav-toggle" onClick={() => setNavOpen(!navOpen)} aria-label="Toggle navigation" aria-expanded={navOpen}>
          <Icon name="layers" />
        </button>
        <a className="brand" href={href('overview')}>
          <span className="brand-mark" aria-hidden>
            R
          </span>
          Rastro <span className="muted">console</span>
        </a>
        <GlobalSearch />
        <div className={`env env-${env.kind}`} title={env.detail}>
          <span className="dot" aria-hidden />
          {env.label}
        </div>
        {demo && (
          <div className="demo-badge" title="Showing captured API responses, not a live API">
            DEMO MODE
          </div>
        )}
        <a className="small topbar-link" href="./index.html">
          Public site
        </a>
      </header>
      <div className="shell">
        <nav className={`sidenav ${navOpen ? 'open' : ''}`} aria-label="Main">
          {GROUPS.map((g) => (
            <div key={g} className="nav-group">
              <div className="nav-group-label">{g}</div>
              {NAV.filter((n) => n.group === g).map((n) => (
                <a key={n.page} href={href(n.page)} className={active === n.page ? 'active' : undefined} aria-current={active === n.page ? 'page' : undefined} onClick={() => setNavOpen(false)}>
                  <Icon name={n.icon} /> {n.label}
                </a>
              ))}
            </div>
          ))}
          <div className="sidenav-foot small muted">All ranch, herd and permit data is synthetic.</div>
        </nav>
        {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden />}
        <main className="main" id="main" ref={mainRef}>
          {children}
        </main>
      </div>
    </div>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = resolveSearch(q);
    if (!t) {
      setMsg('Use a ranch (R0120), GTA (GTA-PA-2024-004211), lot (LOT-…), shipment (SHP-V-202308) or certificate (0x…) id.');
      return;
    }
    setMsg(null);
    setQ('');
    navigate(t.page, t.id);
  };
  return (
    <form className="search" onSubmit={submit} role="search">
      <Icon name="search" />
      <label htmlFor="global-search" className="sr-only">
        Search by id
      </label>
      <input
        id="global-search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setMsg(null);
        }}
        placeholder="Ranch, GTA, lot, shipment or certificate id"
        autoComplete="off"
      />
      {msg && (
        <div className="search-msg" role="alert">
          {msg}
        </div>
      )}
    </form>
  );
}

/** Hook for the environment banner: health + readiness + chain adapter (via a certificate-independent read). */
export function useEnv(): { env: EnvInfo; health: Health | null } {
  const health = useApi((s) => api.health(s), []);
  const ready = useApi((s) => api.ready(s), [], !!health.data);
  const chain = useApi((s) => api.chainStatus(s).then((r) => unwrap(r).chain), [], !!health.data);
  return { env: envFrom(health.data, ready.data, chain.data || null), health: health.data };
}
