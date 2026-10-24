import { useEffect, useMemo, useRef, useState } from 'react';
import { useData, useMoveIndex, useRanchIndex } from '../lib/data';
import { explorerTx, fmt, fmtDate, pct, roleLabel, shortHash } from '../lib/format';
import { RISK_COLOR, deforColor } from '../lib/colors';
import { useTheme } from '../lib/theme';
import { fixName } from '../lib/content';
import { useEvalMode } from '../lib/ui';
import type { Destination, Movement, Ranch, RiskFlag } from '../lib/types';
import { EvidenceVerify } from './EvidenceVerify';
import { RiskChip, SourceTag } from './Tags';

export function RanchPanel({ id, onClose, onSelect, onShowMap }: { id: string; onClose: () => void; onSelect: (id: string) => void; onShowMap: () => void }) {
  const ranches = useData('ranches');
  const byId = useRanchIndex();
  const idx = useMoveIndex(true);
  const moves = useData('movements');
  const dests = useData('destinations');
  const onchain = useData('onchain');
  const [evalMode, setEvalMode] = useEvalMode();
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const r = byId?.get(id) ?? null;

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [id]);

  const destById = useMemo(() => new Map((dests.data ?? []).map((d) => [d.id, d])), [dests.data]);
  const rejected = useMemo(() => (moves.data ?? []).filter((m) => m.rejected && m.from === id), [moves.data, id]);
  const up = useMemo(() => aggregate(idx?.byTo.get(id) ?? [], 'from'), [idx, id]);
  const down = useMemo(() => aggregate(idx?.byFrom.get(id) ?? [], 'to'), [idx, id]);
  const records = (onchain.data?.records ?? []).filter((x) => x.ref === id);
  const attest = records.find((x) => x.kind === 'attestRisk');

  if (!r) {
    return (
      <Shell onClose={onClose} closeRef={closeRef}>
        <div className="drawer-head">
          <h3>{id}</h3>
          <p className="muted">{ranches.status === 'loading' ? 'Loading ranch data…' : 'This ranch is not in the current dataset (it may sit outside the study window).'}</p>
        </div>
      </Shell>
    );
  }

  const flags = r.risk.flags ?? [];
  const highs = flags.filter((f) => f.severity === 'high').length;
  const births = birthsOf(r);
  const capRatio = r.capacity_head > 0 ? r.head_now / r.capacity_head : 0;
  const peak = typeof r.capacity_peak_pct === 'number' ? r.capacity_peak_pct : null;
  const hold = r.median_holding_days;
  const defYears = r.defor_by_year && Object.keys(r.defor_by_year).length ? r.defor_by_year : null;
  const ti = num(r.ti_overlap_ha), uc = num(r.uc_overlap_ha);
  const ucName = typeof r.uc_name === 'string' ? r.uc_name : null;
  const explorer = onchain.data?.explorer ?? null;
  const isMock = ranches.origin === 'mock';

  return (
    <Shell onClose={onClose} closeRef={closeRef}>
      <div className="drawer-head">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <span className="eyebrow">Ranch</span>
          <SourceTag kind={isMock ? 'mock' : 'synthetic'} title="Synthetic ranch: boundary, herd and permits are simulated" />
        </div>
        <h3>
          <span className="mono" style={{ fontFamily: 'var(--mono)', fontSize: 26, fontWeight: 700 }}>
            {r.id}
          </span>
          <RiskChip cls={r.risk.class}>
            {r.risk.class === 'high' ? 'High risk' : r.risk.class === 'watch' ? 'Watch' : 'Clean'} · {fmt(r.risk.score * 100)}
          </RiskChip>
        </h3>
        <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>
          {roleLabel(String(r.role))} · {fmt(r.area_ha)} ha · {fmt(r.head_now)} head on hand
        </div>
        <div className={`verdict-line ${r.risk.class}`}>
          <span aria-hidden>{r.risk.class === 'high' ? '⚠' : r.risk.class === 'watch' ? '◐' : '✓'}</span>
          <span>
            {r.risk.class === 'high'
              ? `${highs} hard-evidence flag${highs === 1 ? '' : 's'}. Cattle from here should not reach a buyer as clean.`
              : r.risk.class === 'watch'
                ? 'No hard rule broken, but something deserves a second look.'
                : 'Passes every physical check and traces to clean suppliers.'}{' '}
            {r.status_quo_flagged
              ? 'Today’s direct-supplier check also flags it when it sells straight to a meatpacker.'
              : r.risk.class === 'clean'
                ? ''
                : r.sells_direct === false
                  ? 'It never sells straight to a meatpacker, so today’s direct-supplier check never looks at it.'
                  : 'Today’s direct-supplier check lets it through.'}
          </span>
        </div>
        <button ref={closeRef} className="btn btn-sm btn-ghost close" onClick={onClose} aria-label="Close ranch panel">
          ✕
        </button>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={onShowMap}>
            Show on map
          </button>
          {evalMode && r.truth && (
            <span className="chip chip-neutral" title="Simulator ground truth: not something the product would know">
              Ground truth: <b>{r.truth}</b>
            </span>
          )}
        </div>
      </div>

      <div className="drawer-body" ref={bodyRef}>
        <div className="panel-sec">
          <h4>Physics checks</h4>
          <Gauge
            label="Herd vs pasture capacity"
            value={r.head_now}
            max={Math.max(r.capacity_head * 1.25, r.head_now * 1.05, 1)}
            marks={[
              { at: r.capacity_head, label: 'capacity' },
              { at: r.capacity_head * 1.1, label: '' },
            ]}
            color={capRatio > 1.1 ? RISK_COLOR.high : capRatio > 0.95 ? RISK_COLOR.watch : RISK_COLOR.clean}
            right={`${fmt(r.head_now)} / ${fmt(r.capacity_head)} head`}
            note={`${fmt(r.pasture_ha)} ha of pasture × 1.5 head/ha${peak != null ? ` · peak during the period: ${fmt(peak)}% of capacity` : ''}`}
          />
          {births ? (
            <Gauge
              label="Declared births vs biological maximum"
              value={births.declared}
              max={Math.max(births.max * 1.3, births.declared * 1.05, 1)}
              marks={[{ at: births.max, label: 'max' }]}
              color={births.declared > births.max ? RISK_COLOR.high : RISK_COLOR.clean}
              right={`${fmt(births.declared)} / ${fmt(births.max)}`}
              note={`${fmt(r.breeding_cows)} breeding cows × 0.85 calves per cow per year`}
            />
          ) : (
            <div className="gauge">
              <div className="gauge-top">
                <span>Births vs biological maximum</span>
                <b>{r.breeding_cows ? `max ${fmt(Math.floor(r.breeding_cows * 0.85))} / yr` : 'no breeding herd'}</b>
              </div>
            </div>
          )}
          <Gauge
            label="Median days an animal stays before resale"
            value={hold ?? 0}
            max={Math.max(240, (hold ?? 0) * 1.1)}
            marks={[{ at: 45, label: '45 d' }]}
            color={hold != null && hold < 45 ? RISK_COLOR.high : RISK_COLOR.clean}
            right={hold == null ? 'no resales' : `${fmt(hold)} days`}
            note={hold == null ? 'Raises its own animals; nothing bought and resold.' : 'Under 45 days with no weight gain is the pass-through signature.'}
            empty={hold == null}
          />
          <dl className="kv" style={{ marginTop: 6 }}>
            <dt>Bought (3 years)</dt>
            <dd>{fmt(r.inflow_head)} head</dd>
            <dt>Sold (3 years)</dt>
            <dd>{fmt(r.outflow_head)} head</dd>
            <dt>Upstream taint</dt>
            <dd style={{ color: r.upstream_taint_pct >= 25 ? 'var(--high)' : undefined }}>{pct(r.upstream_taint_pct)} of purchases</dd>
            {(r.rejected_gtas ?? rejected.length) > 0 && (
              <>
                <dt>Permits refused by the ledger</dt>
                <dd style={{ color: 'var(--high)' }}>{fmt(Number(r.rejected_gtas ?? rejected.length))}</dd>
              </>
            )}
          </dl>
        </div>

        <div className="panel-sec">
          <h4>
            Land <SourceTag kind={isMock ? 'mock' : 'real'} title="Deforestation and protected areas are real; the ranch boundary is synthetic" />
          </h4>
          <p className="small muted" style={{ margin: '-6px 0 10px' }}>Real clearing and protected boundaries, measured inside a synthetic ranch boundary.</p>
          <dl className="kv">
            <dt>Cleared since 2008</dt>
            <dd>{fmt(r.defor_post2008_ha, 1)} ha</dd>
            <dt>Cleared after 2020 (EUDR cut-off)</dt>
            <dd style={{ color: r.defor_post2020_ha > 0 ? 'var(--defor)' : undefined }}>{fmt(r.defor_post2020_ha, 1)} ha</dd>
            <dt>Indigenous-land overlap</dt>
            <dd style={{ color: r.in_protected || ti > 0 ? 'var(--high)' : undefined }}>
              {r.in_protected || ti > 0 ? `${fixName(r.protected_name) || 'yes'}${ti > 0 ? ` · ${fmt(ti, 1)} ha` : ''}` : 'none'}
            </dd>
            {(ucName || uc > 0) && (
              <>
                <dt>Conservation unit</dt>
                <dd>
                  {fixName(ucName) || 'yes'}
                  {uc > 0 ? ` · ${fmt(uc, 1)} ha` : ''}
                </dd>
                {!flags.some((f) => f.code === 'PROTECTED_AREA' && !r.in_protected) && (
                  <dd className="small muted" style={{ gridColumn: '1 / -1', textAlign: 'left', fontWeight: 400, marginTop: -4 }}>
                    Sustainable-use unit where ranching is legal: context, not a flag.
                  </dd>
                )}
              </>
            )}
            <dt>
              Environmental embargo <SourceTag kind={isMock ? 'mock' : 'synthetic'} title="Embargoes are simulated in this demo (Ibama lists in production)" />
            </dt>
            <dd style={{ color: r.embargoed ? 'var(--high)' : undefined }}>{r.embargoed ? 'Embargoed' : 'none'}</dd>
          </dl>
          {defYears && <YearBars data={defYears} />}
        </div>

        <div className="panel-sec">
          <h4>Why this rating · {flags.length} flag{flags.length === 1 ? '' : 's'}</h4>
          {flags.length === 0 && <p className="small muted" style={{ margin: 0 }}>No flags. Herd, births, pasture and resale timing are all within physical limits.</p>}
          {flags.map((f, i) => (
            <FlagCard key={f.code + i} f={f} />
          ))}
        </div>

        <div className="panel-sec">
          <h4>Upstream suppliers</h4>
          <Counterparties list={up} byId={byId} destById={destById} onSelect={onSelect} empty={idx ? 'Buys no animals: raises its own.' : 'Loading movements…'} />
        </div>
        <div className="panel-sec">
          <h4>Downstream buyers</h4>
          <Counterparties list={down} byId={byId} destById={destById} onSelect={onSelect} empty={idx ? 'No recorded sales.' : 'Loading movements…'} />
          {rejected.length > 0 && (
            <p className="small" style={{ color: 'var(--high)', margin: '10px 0 0' }}>
              + {fmt(rejected.length)} attempted permit{rejected.length === 1 ? '' : 's'} ({fmt(rejected.reduce((s, m) => s + m.head, 0))} head) refused by the ledger:{' '}
              {[...new Set(rejected.map((m) => m.rejected))].join(', ')}
            </p>
          )}
        </div>

        <div className="panel-sec">
          <h4>
            On-chain attestation <SourceTag kind={onchain.origin === 'mock' ? 'mock' : 'chain'} />
          </h4>
          {!onchain.data && <p className="small muted" style={{ margin: '0 0 8px' }}>Ledger not yet deployed: the risk attestation will appear here once the replay has run.</p>}
          {records.length > 0 ? (
            <table className="mini-table">
              <tbody>
                {records.map((x, i) => {
                  const link = explorerTx(explorer, x.tx);
                  return (
                    <tr key={i}>
                      <td>
                        <span className="mono">{x.kind}</span>
                        <div className="small muted">{x.note}</div>
                      </td>
                      <td className="r">
                        {link ? (
                          <a className="mono" href={link} target="_blank" rel="noreferrer">
                            {shortHash(x.tx)}
                          </a>
                        ) : (
                          <span className="mono">{shortHash(x.tx)}</span>
                        )}
                        <div className="small muted">block {x.block ?? '–'}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            onchain.data && <p className="small muted" style={{ margin: 0 }}>No ledger record for this ranch in the replayed subset.</p>
          )}
          <dl className="kv" style={{ marginTop: 10, fontSize: 12.5 }}>
            <dt>Ranch id on-chain</dt>
            <dd className="mono" title={r.onchain_id}>{shortHash(r.onchain_id, 8, 6)}</dd>
            <dt>Evidence hash</dt>
            <dd className="mono" title={r.risk.evidence_hash ?? ''}>{shortHash(r.risk.evidence_hash, 8, 6)}</dd>
          </dl>
          <EvidenceVerify hash={r.risk.evidence_hash} anchored={attest?.evidence_hash ?? r.risk.evidence_hash} anchoredLabel={attest?.evidence_hash ? 'On-chain' : 'Published'} />
        </div>

        <div className="panel-sec">
          <label className="switch small">
            <input type="checkbox" checked={evalMode} onChange={(e) => setEvalMode(e.target.checked)} />
            Evaluation mode: show the simulator's ground truth
          </label>
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            The product would never know this label; it is how we score the detector.
          </p>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children, onClose, closeRef }: { children: React.ReactNode; onClose: () => void; closeRef: React.RefObject<HTMLButtonElement | null> }) {
  void closeRef;
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Ranch details">
        {children}
      </aside>
    </>
  );
}

function Gauge({ label, value, max, marks, color, right, note, empty }: { label: string; value: number; max: number; marks: { at: number; label: string }[]; color: string; right: string; note?: string; empty?: boolean }) {
  const w = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  return (
    <div className="gauge">
      <div className="gauge-top">
        <span>{label}</span>
        <b>{right}</b>
      </div>
      <div className="gauge-track" style={{ marginTop: 18 }}>
        {!empty && <div className="gauge-fill" style={{ width: w(value), background: color }} />}
        {marks.map((m) => (
          <div key={m.at} className="gauge-mark" style={{ left: w(m.at), opacity: m.label ? 1 : 0.45 }}>
            {m.label && <span>{m.label}</span>}
          </div>
        ))}
      </div>
      {note && <div className="gauge-note">{note}</div>}
    </div>
  );
}

function FlagCard({ f }: { f: RiskFlag }) {
  const ev = f.evidence && typeof f.evidence === 'object' ? Object.entries(f.evidence) : [];
  return (
    <div className={`flag ${f.severity}`}>
      <div className="flag-top">
        <span className="flag-code">{f.code}</span>
        <RiskChip cls={f.severity === 'high' ? 'high' : f.severity === 'watch' || f.severity === 'medium' ? 'watch' : 'unknown'}>{f.severity}</RiskChip>
      </div>
      <h5>{f.title}</h5>
      <p>{f.text}</p>
      {ev.length > 0 && (
        <details className="evidence">
          <summary>EVIDENCE ({ev.length})</summary>
          <table>
            <tbody>
              {ev.map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{fmtEvidence(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function fmtEvidence(v: unknown): string {
  if (v == null) return '–';
  if (typeof v === 'number') return Number.isInteger(v) ? fmt(v) : String(Math.round(v * 1000) / 1000);
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function YearBars({ data }: { data: Record<string, number> }) {
  const [theme] = useTheme();
  const years = Array.from({ length: 18 }, (_, i) => 2008 + i);
  const max = Math.max(1, ...Object.values(data).map(Number));
  return (
    <div style={{ marginTop: 14 }}>
      <div className="small muted">Clearing inside the ranch by PRODES year</div>
      <div className="year-bars" role="img" aria-label="Hectares cleared per year">
        {years.map((y) => {
          const v = Number(data[String(y)] ?? 0);
          return <div key={y} className="yb" title={`${y}: ${fmt(v, 1)} ha`} style={{ height: `${(v / max) * 100}%`, background: v ? deforColor(y, theme) : 'transparent' }} />;
        })}
      </div>
      <div className="year-axis">
        <span>2008</span>
        <span style={{ color: 'var(--defor)' }}>2021 ▸ EUDR</span>
        <span>2025</span>
      </div>
    </div>
  );
}

interface CP { id: string; head: number; n: number; susp: number; last: string }
function aggregate(list: Movement[], key: 'from' | 'to'): CP[] {
  const m = new Map<string, CP>();
  for (const mv of list) {
    const id = mv[key];
    const e = m.get(id) ?? { id, head: 0, n: 0, susp: 0, last: '' };
    e.head += mv.head;
    e.n += 1;
    if (mv.suspicious) e.susp += mv.head;
    if (mv.date > e.last) e.last = mv.date;
    m.set(id, e);
  }
  return [...m.values()].sort((a, b) => b.head - a.head);
}

function Counterparties({ list, byId, destById, onSelect, empty }: { list: CP[]; byId: Map<string, Ranch> | null; destById: Map<string, Destination>; onSelect: (id: string) => void; empty: string }) {
  const [all, setAll] = useState(false);
  if (!list.length) return <p className="small muted" style={{ margin: 0 }}>{empty}</p>;
  const shown = all ? list : list.slice(0, 8);
  return (
    <>
      <table className="mini-table">
        <thead>
          <tr>
            <th>Counterparty</th>
            <th className="r">Head</th>
            <th className="r">Permits</th>
            <th className="r">Last</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => {
            const r = byId?.get(c.id);
            const d = destById.get(c.id);
            return (
              <tr key={c.id}>
                <td>
                  {r ? (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: RISK_COLOR[r.risk.class] }} aria-hidden />
                      <button className="ranch-link" onClick={() => onSelect(c.id)} title={`Open ${c.id}`}>
                        {c.id}
                      </button>
                      <span className="small muted">{r.role}</span>
                    </span>
                  ) : d ? (
                    <span>
                      <b style={{ fontWeight: 600 }}>{fixName(d.name)}</b>
                    </span>
                  ) : (
                    <span className="mono">
                      {c.id} <span className="small muted">outside window</span>
                    </span>
                  )}
                  {c.susp > 0 && <div className="small" style={{ color: 'var(--high)' }}>{fmt((c.susp / c.head) * 100)}% flagged as suspicious</div>}
                </td>
                <td className="r">{fmt(c.head)}</td>
                <td className="r">{fmt(c.n)}</td>
                <td className="r small muted nowrap">{fmtDate(c.last).replace(/^\d+ /, '')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {list.length > 8 && (
        <button className="linkish small" style={{ marginTop: 8 }} onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${list.length}`}
        </button>
      )}
    </>
  );
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function birthsOf(r: Ranch): { declared: number; max: number } | null {
  const fl = r.risk.flags.find((f) => f.code === 'PHANTOM_BIRTHS');
  const ev = (fl?.evidence ?? {}) as Record<string, unknown>;
  const declared = r.births_declared ?? (ev.births_declared as number | undefined) ?? (ev.births as number | undefined) ?? (ev.births_claimed as number | undefined);
  const max = r.births_biological_max ?? (ev.births_biological_max as number | undefined) ?? (ev.max_births as number | undefined);
  if (declared == null || max == null) return null;
  if (!declared && !max) return null;
  return { declared: Number(declared), max: Number(max) };
}
