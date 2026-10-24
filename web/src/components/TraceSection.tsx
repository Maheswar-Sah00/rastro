import { useEffect, useMemo, useRef, useState } from 'react';
import { useData, useMoveIndex, useRanchIndex } from '../lib/data';
import { buildSankey } from '../lib/trace';
import { explorerTx, fmt, fmtDate, marketLabel, pct, shortHash } from '../lib/format';
import { RISK_COLOR } from '../lib/colors';
import { fixName } from '../lib/content';
import { useEvalMode } from '../lib/ui';
import type { Destination, Shipment } from '../lib/types';
import { Sankey } from './Sankey';
import { EvidenceVerify } from './EvidenceVerify';
import { useNear } from './MapSection';
import { DataTag, RiskChip, SourceTag, Stamp } from './Tags';
import { Explain } from '../lib/explain';

const DEFAULT_FEATURED = 'SHP-0008'; // Türkiye-bound voyage
const DEFAULT_BIG = 'SHP-0018'; // the biggest flagged voyage
const DEFAULT_EU = 'SHP-0327';

const isVoyage = (s: Shipment) => s.kind === 'voyage' || (!s.kind && s.destination.startsWith('P:'));
const disagree = (s: Shipment) => s.status_quo_verdict === 'pass' && s.rastro_verdict === 'fail';

export function pickDefaults(list: Shipment[]) {
  const byId = new Map(list.map((s) => [s.id, s]));
  const voyages = list.filter(isVoyage);
  const tr =
    byId.get(DEFAULT_FEATURED) ??
    voyages.find((s) => s.market === 'TR' && disagree(s)) ??
    voyages.find((s) => disagree(s)) ??
    voyages[0] ??
    list[0];
  const big =
    (byId.get(DEFAULT_BIG) && byId.get(DEFAULT_BIG)!.id !== tr?.id ? byId.get(DEFAULT_BIG) : undefined) ??
    [...voyages].filter((s) => s.id !== tr?.id && disagree(s)).sort((a, b) => b.head - a.head)[0];
  const eu = byId.get(DEFAULT_EU) ?? list.find((s) => s.market === 'EU' && s.rastro_verdict === 'pass') ?? list.find((s) => s.market === 'EU');
  const euFail = list.find((s) => s.market === 'EU' && disagree(s) && s.id !== eu?.id);
  return { tr, big, eu, euFail };
}

export function TraceSection({ shipmentId, onShipment, onRanch, forceLoad }: { shipmentId: string | null; onShipment: (id: string) => void; onRanch: (id: string) => void; forceLoad: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const near = useNear(ref, '700px') || forceLoad;
  const ships = useData('shipments', near);
  const ranches = useData('ranches', near);
  const dests = useData('destinations', near);
  const metrics = useData('metrics');
  const onchain = useData('onchain', near);
  const idx = useMoveIndex(near);
  const byId = useRanchIndex();
  const [evalMode] = useEvalMode();

  const list = ships.data ?? [];
  const defaults = useMemo(() => pickDefaults(list), [list]);
  const shipById = useMemo(() => new Map(list.map((s) => [s.id, s])), [list]);
  const current = (shipmentId && shipById.get(shipmentId)) || defaults.tr || null;
  const destById = useMemo(() => new Map((dests.data ?? []).map((d) => [d.id, d])), [dests.data]);

  const trace = useMemo(() => (current && byId ? buildSankey(current, idx, byId) : null), [current, idx, byId]);
  const voyages = useMemo(() => list.filter(isVoyage).sort((a, b) => a.date.localeCompare(b.date)), [list]);

  return (
    <section id="trace" className="section" ref={ref} aria-labelledby="trace-title" style={{ minHeight: list.length || ships.status === 'ready' ? undefined : 2300 }}>
      <div className="wrap">
        <div className="section-head center">
          <p className="kicker">05 · Trace a shipment</p>
          <h2 className="title" id="trace-title">
            Can this buyer know?
          </h2>
          <p className="deck">Pick a ship. See where its cattle were born.</p>
          <Explain>
            Pick any shipment to see where its cattle came from. The flow diagram runs from birth ranches on the left to the ship or slaughterhouse on the right; red bands are cattle from flagged ranches. "Today" is the current one-hop check's verdict, "Rastro" is ours (✓ pass, ✕ fail, ! review).
          </Explain>
        </div>

        {ships.status === 'loading' && near && <div className="card empty">Loading shipments…</div>}
        {ships.status === 'ready' && !list.length && <div className="card empty">No shipments in the dataset yet.</div>}

        {list.length > 0 && (
          <>
            {voyages.length > 0 && <VoyageStrip voyages={voyages} current={current} onPick={onShipment} origin={ships.origin} />}
            <Picker list={list} current={current} defaults={defaults} onPick={onShipment} destById={destById} />
          </>
        )}

        {current && (
          <div className="card trace-detail" id="trace-detail" style={{ marginTop: 22 }}>
            <ShipmentHeader s={current} dest={destById.get(current.destination)} origin={ships.origin} />
            <Composition s={current} />
            <div className="sankey-wrap">
              {trace && trace.links.length ? (
                <Sankey trace={trace} onNode={onRanch} />
              ) : (
                <div className="empty">{ranches.status === 'loading' || !idx ? 'Loading the movement graph…' : 'No upstream flow to draw.'}</div>
              )}
              {trace && (
                <p className="small muted" style={{ margin: '6px 0 0' }}>
                  {!trace.nodes.some((n) => n.kind === 'origin' || n.kind === 'other' || n.kind === 'hop') && <b>No upstream suppliers: the direct supplier raised these animals itself. </b>}
                  Band width = head-equivalent. Origins and their shares come from the pipeline's trace
                  {trace.exact ? ' (exact edges).' : '; which direct supplier each origin fed is read from the movement permits.'} Click a ranch to open it.
                </p>
              )}
            </div>
            <Verdicts s={current} byId={byId} onRanch={onRanch} thresholds={metrics.data?.thresholds} evalMode={evalMode} />
            <Certificate s={current} onchain={onchain.data} chainOrigin={onchain.origin} />
          </div>
        )}
      </div>
    </section>
  );
}

function VoyageStrip({ voyages: all, current, onPick, origin }: { voyages: Shipment[]; current: Shipment | null; onPick: (id: string) => void; origin: 'real' | 'mock' | 'missing' }) {
  const [dest, setDest] = useState<string>('all');
  const markets = useMemo(() => {
    const m = new Map<string, number>();
    all.forEach((v) => m.set(v.market, (m.get(v.market) ?? 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);
  const voyages = dest === 'all' ? all : all.filter((v) => v.market === dest);
  const max = Math.max(...all.map((v) => v.head), 1);
  const passedSq = voyages.filter((v) => v.status_quo_verdict === 'pass').length;
  const flagged = voyages.filter((v) => v.trace.flagged_pct > 0).length;
  const notClear = voyages.filter((v) => v.trace.flagged_pct + (v.trace.watch_pct ?? 0) + v.trace.unknown_pct > 0).length;
  const failed = voyages.filter((v) => v.rastro_verdict === 'fail').length;
  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div>
          <h3 style={{ fontSize: 20 }}>
            {voyages.length} live-export voyage{voyages.length === 1 ? '' : 's'} from Barcarena{dest !== 'all' ? ` to ${marketLabel(dest)}` : ''}
          </h3>
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            {passedSq === voyages.length ? 'Every one' : `${passedSq} of ${voyages.length}`} passed today's direct-supplier check.{' '}
            <b style={{ color: 'var(--high)' }}>{notClear}</b> carried cattle Rastro could not clear ({flagged} with cattle from flagged ranches); Rastro fails <b style={{ color: 'var(--high)' }}>{failed}</b>.
          </p>
        </div>
        <DataTag origin={origin} real={false} />
      </div>
      {markets.length > 1 && (
        <div className="seg" role="group" aria-label="Destination" style={{ marginTop: 12 }}>
          <button aria-pressed={dest === 'all'} onClick={() => setDest('all')}>
            All {all.length}
          </button>
          {markets.map(([m, n]) => (
            <button key={m} aria-pressed={dest === m} onClick={() => setDest(m)} title={marketLabel(m)}>
              {marketLabel(m)} {n}
            </button>
          ))}
        </div>
      )}
      <div className="voyage-strip" role="group" aria-label="Voyages by date, bar height = head, colour = composition">
        {voyages.map((v) => {
          const h = (v.head / max) * 100;
          const parts: [string, number][] = [
            [RISK_COLOR.clean, v.trace.clean_pct],
            [RISK_COLOR.watch, v.trace.watch_pct ?? 0],
            [RISK_COLOR.unknown, v.trace.unknown_pct],
            [RISK_COLOR.high, v.trace.flagged_pct],
          ];
          return (
            <button
              key={v.id}
              className="voyage"
              aria-pressed={current?.id === v.id}
              title={`${v.id} · to ${marketLabel(v.market)} · ${fmtDate(v.date)} · ${fmt(v.head)} head · ${pct(v.trace.flagged_pct)} flagged`}
              onClick={() => onPick(v.id)}
              style={{ height: `${Math.max(12, h)}%` }}
            >
              {parts.map(([c, p], i) => (
                <span key={i} className="seg-c" style={{ height: `${p}%`, background: c }} />
              ))}
              <span className="voyage-code">{v.market}</span>
            </button>
          );
        })}
      </div>
      <div className="voyage-axis">
        <span>{voyages.length ? fmtDate(voyages[0].date) : ''}</span>
        <span className="mid">bar height = head on board · red = traced to flagged ranches · letters = destination (synthetic, following Pará's real export mix)</span>
        <span>{voyages.length ? fmtDate(voyages[voyages.length - 1].date) : ''}</span>
      </div>
    </div>
  );
}

type VerdictFilter = 'disagree' | 'all' | 'fail' | 'review' | 'sqfail';
function Picker({ list, current, defaults, onPick, destById }: { list: Shipment[]; current: Shipment | null; defaults: ReturnType<typeof pickDefaults>; onPick: (id: string) => void; destById: Map<string, Destination> }) {
  const [market, setMarket] = useState<string>('EU');
  const [verdict, setVerdict] = useState<VerdictFilter>('all');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(60);
  const markets = useMemo(() => [...new Set(list.filter((s) => !isVoyage(s)).map((s) => s.market))].sort(), [list]);
  useEffect(() => setLimit(60), [market, verdict, q]);
  const filtered = useMemo(() => {
    const qq = q.trim().toUpperCase();
    return list.filter((s) => {
      // The list shows only what Rastro catches: lots it fails or sends to review.
      if (isVoyage(s) || s.rastro_verdict === 'pass') return false;
      if (market !== 'all' && s.market !== market) return false;
      if (verdict === 'disagree' && !disagree(s)) return false;
      if (verdict === 'fail' && s.rastro_verdict !== 'fail') return false;
      if (verdict === 'review' && s.rastro_verdict !== 'review') return false;
      if (verdict === 'sqfail' && s.status_quo_verdict !== 'fail') return false;
      if (qq && !s.id.includes(qq) && !(s.direct_suppliers ?? []).some((d) => d.includes(qq)) && !s.destination.toUpperCase().includes(qq)) return false;
      return true;
    });
  }, [list, market, verdict, q]);
  const quick = [
    defaults.tr && { s: defaults.tr, label: `Live-export voyage → ${marketLabel(defaults.tr.market)} · ${defaults.tr.id}` },
    defaults.big && { s: defaults.big, label: `Biggest flagged voyage → ${marketLabel(defaults.big.market)} · ${defaults.big.id}` },
    defaults.eu && { s: defaults.eu, label: `EU delivery · ${defaults.eu.id}` },
    defaults.euFail && { s: defaults.euFail, label: `EU lot Rastro blocks · ${defaults.euFail.id}` },
  ].filter(Boolean) as { s: Shipment; label: string }[];

  return (
    <div className="picker">
      <div className="card card-pad">
        <p className="eyebrow" style={{ marginTop: 0 }}>Demo shipments</p>
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          {quick.map(({ s, label }) => (
            <button key={s.id} className={`btn ${current?.id === s.id ? 'btn-primary' : ''}`} style={{ justifyContent: 'space-between' }} onClick={() => onPick(s.id)}>
              <span>{label}</span>
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <VerdictMini v={s.status_quo_verdict} who="today" />
                <VerdictMini v={s.rastro_verdict} who="Rastro" />
              </span>
            </button>
          ))}
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Live-export voyages from Barcarena carry only lots that passed today's check. Deliveries are single permits into a slaughterhouse.
        </p>
      </div>
      <div className="card card-pad">
        <div className="filters">
          <span className="eyebrow">Deliveries</span>
          <select aria-label="Market" value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="all">All markets</option>
            {markets.map((m) => (
              <option key={m} value={m}>
                {marketLabel(m)}
              </option>
            ))}
          </select>
          <select aria-label="Verdict" value={verdict} onChange={(e) => setVerdict(e.target.value as VerdictFilter)}>
            <option value="all">Fail or review</option>
            <option value="disagree">Passes today, Rastro fails</option>
            <option value="fail">Rastro: fail</option>
            <option value="review">Rastro: review</option>
            <option value="sqfail">Fails today's check</option>
          </select>
          <input type="search" placeholder="SHP-… or R0…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search shipments" style={{ flex: 1, minWidth: 110 }} />
        </div>
        <div className="small muted" style={{ marginBottom: 6 }}>
          {fmt(filtered.length)} deliveries Rastro fails or sends to review
        </div>
        <div className="ship-list" role="listbox" aria-label="Deliveries">
          {filtered.slice(0, limit).map((s) => (
            <button key={s.id} className="ship-row" role="option" aria-selected={current?.id === s.id} aria-pressed={current?.id === s.id} onClick={() => onPick(s.id)}>
              <span className="mono" style={{ fontWeight: 600 }}>
                {s.id}
              </span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {marketLabel(s.market)} · {fmt(s.head)} head · {fmtDate(s.date)}
                <span className="muted"> · {fixName(destById.get(s.destination)?.name ?? s.destination).replace(/\s*\(.*\)$/, '')}</span>
              </span>
              <span style={{ display: 'inline-flex', gap: 4 }}>
                <VerdictMini v={s.status_quo_verdict} who="today" />
                <VerdictMini v={s.rastro_verdict} who="Rastro" />
              </span>
            </button>
          ))}
          {filtered.length === 0 && <div className="empty small">No deliveries match.</div>}
        </div>
        {filtered.length > limit && (
          <button className="linkish small" style={{ marginTop: 8 }} onClick={() => setLimit((l) => l + 120)}>
            Show more ({fmt(filtered.length - limit)} left)
          </button>
        )}
      </div>
    </div>
  );
}

function VerdictMini({ v, who }: { v: string; who: string }) {
  const c = v === 'pass' ? 'clean' : v === 'fail' ? 'high' : 'watch';
  return (
    <span className={`chip chip-${c}`} style={{ fontSize: 11, padding: '1px 7px' }} title={`${who}: ${v}`}>
      {who === 'today' ? 'Today' : 'Rastro'} {v === 'pass' ? '✓' : v === 'fail' ? '✕' : '!'}
    </span>
  );
}

function ShipmentHeader({ s, dest, origin }: { s: Shipment; dest?: Destination; origin: 'real' | 'mock' | 'missing' }) {
  const nDirect = s.direct_suppliers?.length ?? new Set(s.gtas).size;
  return (
    <div className="ship-summary">
      <div>
        <span className="eyebrow">{isVoyage(s) ? 'Live-export voyage' : 'Delivery'}</span>
        <div className="big mono" style={{ fontFamily: 'var(--mono)' }}>
          {s.id}
        </div>
      </div>
      <div className="meta">
        {isVoyage(s) ? (
          <>
            <span>
              Bound for <b>{marketLabel(s.market)}</b> <span className="chip chip-neutral" style={{ fontSize: 11, padding: '0 6px' }}>{s.market}</span>
            </span>
            <span>
              From <b>{fixName(dest?.name ?? s.destination)}</b>
            </span>
          </>
        ) : (
          <>
            <span>
              To <b>{fixName(dest?.name ?? s.destination)}</b>
            </span>
            <span>
              Market <b>{marketLabel(s.market)}</b>
            </span>
          </>
        )}
        <span>
          <b>{fmt(s.head)}</b> head
        </span>
        <span>
          <b>{fmt(s.gtas.length)}</b> permit{s.gtas.length === 1 ? '' : 's'} from <b>{fmt(nDirect)}</b> direct supplier{nDirect === 1 ? '' : 's'}
        </span>
        <span>{fmtDate(s.date)}</span>
        <DataTag origin={origin} real={false} />
      </div>
    </div>
  );
}

function Composition({ s }: { s: Shipment }) {
  const t = s.trace;
  const parts = [
    { k: 'clean', label: 'Clean', v: t.clean_pct, c: RISK_COLOR.clean },
    { k: 'watch', label: 'Watch: smaller post-2020 clearing', v: t.watch_pct ?? 0, c: RISK_COLOR.watch },
    { k: 'high', label: 'Flagged', v: t.flagged_pct, c: RISK_COLOR.high },
    { k: 'unknown', label: 'Unknown origin', v: t.unknown_pct, c: RISK_COLOR.unknown },
  ].filter((p) => p.v > 0);
  return (
    <div className="composition">
      <div className="small" style={{ marginBottom: 8, color: 'var(--ink-2)' }}>
        Where the <b>{fmt(s.head)}</b> head on this lot were raised, traced through <b>{t.n_origins != null ? fmt(t.n_origins) : fmt(t.by_ranch.length)}</b> origin ranch{(t.n_origins ?? t.by_ranch.length) === 1 ? '' : 'es'}, up to <b>{t.max_hops}</b> hop{t.max_hops === 1 ? '' : 's'} upstream
      </div>
      <div className="comp-bar" role="img" aria-label={parts.map((p) => `${p.label} ${pct(p.v, 1)}`).join(', ')}>
        {parts.map((p) => (
          <div key={p.k} style={{ flexBasis: `${p.v}%`, background: p.c }} title={`${p.label}: ${pct(p.v, 1)}`}>
            {p.v >= 7 ? pct(p.v, p.v % 1 ? 1 : 0) : ''}
          </div>
        ))}
      </div>
      <div className="comp-legend">
        {parts.map((p) => (
          <span key={p.k}>
            <i style={{ background: p.c }} /> {p.label} <b className="num">{pct(p.v, 1)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function Verdicts({ s, byId, onRanch, thresholds, evalMode }: { s: Shipment; byId: Map<string, import('../lib/types').Ranch> | null; onRanch: (id: string) => void; thresholds?: { fail_flagged_pct?: number; review_flagged_pct?: number }; evalMode: boolean }) {
  const direct = s.direct_suppliers ?? [];
  const sqFlagged = direct.filter((d) => byId?.get(d)?.status_quo_flagged);
  const t = s.trace;
  const eu = s.market === 'EU';
  const bad = t.flagged_pct + (eu ? (t.watch_pct ?? 0) : 0);
  const fail = thresholds?.fail_flagged_pct ?? 25;
  const review = thresholds?.review_flagged_pct ?? 5;
  const topFlagged = t.by_ranch.filter((b) => b.risk_class === 'high').slice(0, 4);
  const directHigh = direct.filter((d) => byId?.get(d)?.risk.class === 'high');
  const taintedHead = Math.round((s.head * t.flagged_pct) / 100);
  return (
    <>
      {s.status_quo_verdict === 'pass' && s.rastro_verdict !== 'pass' && (
        <div style={{ margin: '0 22px 16px' }} className="notice">
          <span aria-hidden style={{ fontSize: 18 }}>⚠</span>
          <span>
            Today's check accepts this lot. Rastro traces <b>{fmt(taintedHead)} head</b> ({pct(t.flagged_pct, 1)}) to flagged ranches
            {eu && (t.watch_pct ?? 0) > 0 ? <> and another {pct(t.watch_pct, 1)} to post-2020 clearings that the EU regulation does not allow</> : null}.
          </span>
        </div>
      )}
      <div className="verdicts">
        <div className="verdict">
          <h4>Today's check</h4>
          <p className="how">Direct suppliers only, against embargo lists, deforestation alerts and protected areas</p>
          <Stamp verdict={s.status_quo_verdict} />
          <p className="why">
            {direct.length ? (
              s.status_quo_verdict === 'pass' ? (
                <>
                  {direct.length === 1 ? 'The only direct supplier looks' : `All ${fmt(direct.length)} direct suppliers look`} clean on paper. The buyer accepts the lot.
                  {directHigh.length > 0 && <> It cannot see that {directHigh.length} of them break physics rules.</>}
                </>
              ) : (
                <>
                  {fmt(sqFlagged.length || 1)} direct supplier{sqFlagged.length === 1 ? ' is' : 's are'} on an embargo list, inside a protected area or has visible
                  post-2020 clearing.
                </>
              )
            ) : s.status_quo_verdict === 'pass' ? (
              'The direct supplier looks clean on paper.'
            ) : (
              'The direct supplier is flagged.'
            )}
          </p>
          {sqFlagged.length > 0 && (
            <ul>
              {sqFlagged.slice(0, 4).map((d) => (
                <li key={d}>
                  <button className="ranch-link" onClick={() => onRanch(d)}>
                    {d}
                  </button>{' '}
                  {byId?.get(d)?.risk.flags[0]?.title}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="verdict">
          <h4>Rastro</h4>
          <p className="how">Full upstream trace + conservation-of-cattle physics</p>
          <Stamp verdict={s.rastro_verdict} />
          <p className="why">
            {t.flagged_pct === 0 && !(t.watch_pct ?? 0) && !t.unknown_pct ? <>Every animal on this lot traces to ranches that pass all checks. </> : null}
            {pct(t.flagged_pct, 1)} of head traces to flagged ranches
            {eu ? <>, plus {pct(t.watch_pct ?? 0, 1)} from post-2020 clearings (counted as failing for the EU)</> : (t.watch_pct ?? 0) > 0 ? <>; {pct(t.watch_pct, 1)} on watch</> : null}
            {t.unknown_pct > 0 ? <>; {pct(t.unknown_pct, 1)} of unknown origin</> : null}.{' '}
            <span className="muted">
              Rule: fail at ≥ {fail}%, review at ≥ {review}%{eu ? ' (flagged + watch for EU-bound lots)' : ''}. Here: {pct(bad, 1)}.
            </span>
          </p>
          {topFlagged.length > 0 && (
            <ul>
              {topFlagged.map((b) => (
                <li key={b.ranch}>
                  <button className="ranch-link" onClick={() => onRanch(b.ranch)}>
                    {b.ranch}
                  </button>{' '}
                  {fmt(b.head_equiv)} head, {b.hops <= 1 ? 'raised by a direct supplier' : `${b.hops} hops up`}
                  {byId?.get(b.ranch)?.risk.flags[0] ? <span className="muted"> · {byId.get(b.ranch)!.risk.flags[0].title}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {evalMode && s.truth_tainted_pct != null && (
            <p className="small" style={{ marginTop: 10 }}>
              <span className="chip chip-neutral">Ground truth: {pct(s.truth_tainted_pct, 1)} of head truly tainted</span>
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function Certificate({ s, onchain, chainOrigin }: { s: Shipment; onchain: import('../lib/types').OnChain | null; chainOrigin: 'real' | 'mock' | 'missing' }) {
  const c = s.certificate;
  if (!c) return null;
  const recs = (onchain?.records ?? []).filter((r) => r.ref === s.id);
  const issued = recs.find((r) => r.kind === 'issueCertificate');
  const consumed = recs.find((r) => r.kind === 'consumeCertificate' && r.status === 'success');
  const explorer = onchain?.explorer ?? null;
  const status =
    c.verdict === 'clean'
      ? consumed
        ? 'Clean, and already consumed once. Any second use reverts.'
        : 'Clean: can be redeemed exactly once, for one shipment or one EU due-diligence statement.'
      : c.verdict === 'flagged'
        ? 'Flagged: the ledger refuses to let any buyer redeem it as clean.'
        : 'Under review: cannot be redeemed until resolved.';
  const seal = c.verdict === 'clean' ? RISK_COLOR.clean : c.verdict === 'flagged' ? RISK_COLOR.high : RISK_COLOR.watch;
  const link = (tx?: string | null) => {
    const u = explorerTx(explorer, tx);
    return u ? (
      <a href={u} target="_blank" rel="noreferrer">
        {shortHash(tx)}
      </a>
    ) : (
      shortHash(tx)
    );
  };
  return (
    <div className="cert">
      <svg className="cert-seal" viewBox="0 0 52 52" aria-hidden>
        <circle cx="26" cy="26" r="23" fill="none" stroke={seal} strokeWidth="3" strokeDasharray="4 3" />
        <circle cx="26" cy="26" r="16" fill={seal} />
        <text x="26" y="31" textAnchor="middle" fontSize="15" fill="#fff" fontWeight="800">
          {c.verdict === 'clean' ? '✓' : c.verdict === 'flagged' ? '✕' : '!'}
        </text>
      </svg>
      <div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
          <b>Lot certificate</b>
          <RiskChip cls={c.verdict === 'clean' ? 'clean' : c.verdict === 'flagged' ? 'high' : 'watch'}>{c.verdict}</RiskChip>
          <SourceTag kind={chainOrigin === 'mock' ? 'mock' : 'chain'} />
        </div>
        <p style={{ margin: '0 0 8px', fontSize: 14 }}>{status}</p>
        <dl>
          <dt>Lot id</dt>
          <dd>{c.lot_id}</dd>
          <dt>Evidence</dt>
          <dd>{c.evidence_hash ?? '–'}</dd>
          {issued && (
            <>
              <dt>Issued</dt>
              <dd>
                {link(issued.tx)} · block {issued.block ?? '–'}
              </dd>
            </>
          )}
          {consumed && (
            <>
              <dt>Consumed</dt>
              <dd>
                {link(consumed.tx)} · block {consumed.block ?? '–'}
              </dd>
            </>
          )}
          {!issued && (
            <>
              <dt>On-chain</dt>
              <dd style={{ fontFamily: 'var(--sans)' }}>{onchain ? 'not in the replayed subset' : 'ledger not yet deployed'}</dd>
            </>
          )}
        </dl>
        <EvidenceVerify hash={c.evidence_hash} anchored={issued?.evidence_hash ?? c.evidence_hash} anchoredLabel={issued?.evidence_hash ? 'On-chain' : 'Published'} />
      </div>
    </div>
  );
}
