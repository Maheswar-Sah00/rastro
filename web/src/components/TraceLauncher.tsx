import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useData } from '../lib/data';
import { fmt, fmtDate, marketLabel } from '../lib/format';
import type { Shipment } from '../lib/types';
import { pickDefaults } from './TraceSection';

const MAX_RESULTS = 8;

/** Header shortcut into the trace: pick a shipment (featured or searched) and land on its lineage. Opens with T. */
export function TraceLauncher({ onPick }: { onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [warm, setWarm] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const ships = useData('shipments', warm || open);

  const rows = useMemo(() => {
    const list = ships.data ?? [];
    const term = q.trim().toLowerCase();
    if (!term) {
      const d = pickDefaults(list);
      const featured: [Shipment | undefined, string][] = [
        [d.tr, 'Passes today, Rastro fails'],
        [d.big, 'Biggest flagged voyage'],
        [d.eu, 'EU lot that clears'],
        [d.euFail, 'EU lot Rastro stops'],
      ];
      return featured.filter((f): f is [Shipment, string] => !!f[0]).map(([s, why]) => ({ s, why }));
    }
    return list
      .filter((s) => `${s.id} ${s.market} ${marketLabel(s.market)} ${s.destination}`.toLowerCase().includes(term))
      .slice(0, MAX_RESULTS)
      .map((s) => ({ s, why: '' }));
  }, [ships.data, q]);

  useEffect(() => setHi(0), [q, open]);

  // T opens it from anywhere (unless typing); a click outside closes it.
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key.toLowerCase() !== 't' || e.metaKey || e.ctrlKey || e.altKey || t.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [open]);

  const choose = (id: string) => {
    setOpen(false);
    setQ('');
    onPick(id);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'ArrowDown') setHi((h) => Math.min(h + 1, rows.length - 1));
    else if (e.key === 'ArrowUp') setHi((h) => Math.max(h - 1, 0));
    else if (e.key === 'Enter' && rows[hi]) choose(rows[hi].s.id);
    else return;
    e.preventDefault();
  };

  return (
    <div className={`tl${open ? ' open' : ''}`} ref={root} onKeyDown={onKey}>
      <button
        type="button"
        className="tl-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onPointerEnter={() => setWarm(true)}
        onFocus={() => setWarm(true)}
      >
        <IconShip />
        <span>Trace</span>
        <kbd aria-hidden>T</kbd>
      </button>
      {open && (
        <div className="tl-panel" role="dialog" aria-label="Trace a shipment">
          <div className="tl-search">
            <IconSearch />
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Shipment id, market or port"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={rows[hi] ? `${listId}-${hi}` : undefined}
              autoComplete="off"
            />
            <kbd aria-hidden>esc</kbd>
          </div>
          <p className="tl-head">{q.trim() ? 'Matches' : 'Start with one of these'}</p>
          <ul className="tl-list" id={listId} role="listbox">
            {ships.status === 'loading' && !ships.data && <li className="tl-empty">Loading shipments…</li>}
            {ships.data && !rows.length && <li className="tl-empty">No shipment matches “{q.trim()}”.</li>}
            {rows.map(({ s, why }, i) => (
              <li
                key={s.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === hi}
                className="tl-row"
                onPointerMove={() => setHi(i)}
                onClick={() => choose(s.id)}
              >
                <span className="tl-main">
                  <span className="tl-id">{s.id}</span>
                  <span className="tl-meta">
                    {marketLabel(s.market)} · {fmt(s.head)} head · {fmtDate(s.date)}
                  </span>
                  {why && <span className="tl-why">{why}</span>}
                </span>
                <span className="tl-verdicts" aria-label={`Today ${s.status_quo_verdict}, Rastro ${s.rastro_verdict}`}>
                  <Verdict who="Today" v={s.status_quo_verdict} />
                  <span className="tl-arrow" aria-hidden>→</span>
                  <Verdict who="Rastro" v={s.rastro_verdict} />
                </span>
              </li>
            ))}
          </ul>
          <p className="tl-foot" aria-hidden>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move · <kbd>↵</kbd> trace
          </p>
        </div>
      )}
    </div>
  );
}

function Verdict({ who, v }: { who: string; v: string }) {
  const k = v === 'pass' ? 'pass' : v === 'fail' ? 'fail' : 'review';
  return (
    <span className={`tl-v tl-v-${k}`}>
      <span className="tl-v-who">{who}</span>
      {k === 'pass' ? '✓' : k === 'fail' ? '✕' : '!'}
    </span>
  );
}

const ico = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
function IconShip() {
  return (
    <svg {...ico}>
      <path d="M2 10h12l-1.6 3H3.6L2 10z" />
      <path d="M4 10V6.5h8V10M7 6.5V4h2.5" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg {...ico}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 13.5 13.5" />
    </svg>
  );
}
