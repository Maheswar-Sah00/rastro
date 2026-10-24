import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { derive, useData, useRanchIndex } from '../lib/data';
import { aggregateMovements, buildFlowLines, type FlowType } from '../lib/flows';
import { fmt, compact } from '../lib/format';
import { MAP_PAL, RISK_COLOR, deforColor } from '../lib/colors';
import { useTheme } from '../lib/theme';
import { useEvalMode } from '../lib/ui';
import type { Ranch } from '../lib/types';
import type { LayerToggles } from './MapView';
import { DataTag, SourceTag } from './Tags';

const MapView = lazy(() => import('./MapView'));

const FEATURED = ['R0120', 'R0291'];

type Emphasis = 'none' | 'risk' | 'quiet';
type Step = 'forest' | 'ranches' | 'flows' | 'refused' | 'explore';
const STEPS: { id: Step; n: string; label: string }[] = [
  { id: 'forest', n: '1', label: 'Forest lost' },
  { id: 'ranches', n: '2', label: 'Ranches rated' },
  { id: 'flows', n: '3', label: 'Where cattle go' },
  { id: 'refused', n: '4', label: 'Refused by the ledger' },
  { id: 'explore', n: '', label: 'Explore' },
];
const STEP_VIEW: Record<Exclude<Step, 'explore'>, { layers: LayerToggles; flowType: FlowType; postOnly: boolean; emphasis: Emphasis; limit: number }> = {
  forest: { layers: { defor: true, cleared: false, protected: true, ranches: false, flows: false, dest: false }, flowType: 'all', postOnly: false, emphasis: 'none', limit: 220 },
  ranches: { layers: { defor: false, cleared: false, protected: true, ranches: true, flows: false, dest: false }, flowType: 'all', postOnly: false, emphasis: 'risk', limit: 220 },
  flows: { layers: { defor: false, cleared: false, protected: false, ranches: true, flows: true, dest: true }, flowType: 'suspicious', postOnly: false, emphasis: 'quiet', limit: 60 },
  refused: { layers: { defor: false, cleared: false, protected: false, ranches: true, flows: true, dest: true }, flowType: 'rejected', postOnly: false, emphasis: 'quiet', limit: 220 },
};

export function useNear(ref: React.RefObject<HTMLElement | null>, margin = '900px') {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || !ref.current) return;
    if (!('IntersectionObserver' in window)) {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: margin });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near, ref, margin]);
  return near;
}

export function MapSection({ selected, onSelect, forceLoad }: { selected: string | null; onSelect: (id: string) => void; forceLoad: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const near = useNear(ref) || forceLoad;
  const meta = useData('meta');
  const ranches = useData('ranches', near);
  const defor = useData('deforestation', near);
  const cleared = useData('cleared', near);
  const prot = useData('protected', near);
  const aoi = useData('aoi', near);
  const dests = useData('destinations', near);
  const moves = useData('movements', near);
  const ranchById = useRanchIndex();
  const [evalMode] = useEvalMode();
  const [theme] = useTheme();
  const pal = MAP_PAL[theme];
  const [step, setStep] = useState<Step>('forest');
  const [emphasis, setEmphasis] = useState<Emphasis>('none');

  const [layers, setLayers] = useState<LayerToggles>(STEP_VIEW.forest.layers);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [minYear, setMinYear] = useState(2008);
  const [postOnly, setPostOnly] = useState(false);
  const [satellite, setSatellite] = useState(false);
  const [flowYear, setFlowYear] = useState<number | null>(null);
  const [flowType, setFlowType] = useState<FlowType>('all');
  const [limit, setLimit] = useState(220);
  const [fitAllKey, setFitAllKey] = useState(0);
  const [fitAoiKey, setFitAoiKey] = useState(0);
  const [legendOpen, setLegendOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1000);

  const years = meta.data?.years?.length ? meta.data.years : [2023, 2024, 2025];
  const aggs = derive(moves.data, 'flowAggs', aggregateMovements);
  const destById = useMemo(() => new Map((dests.data ?? []).map((d) => [d.id, d])), [dests.data]);
  const flows = useMemo(() => {
    if (!aggs || !ranchById) return null;
    return buildFlowLines(aggs, { years: flowYear ? [flowYear] : null, type: flowType, hiddenClasses: hidden, selected, limit }, ranchById, destById);
  }, [aggs, ranchById, destById, flowYear, flowType, hidden, selected, limit]);

  // Share of all moved head that is suspicious, independent of the current flow filter.
  const suspShare = useMemo(() => {
    if (!aggs) return null;
    let all = 0, susp = 0;
    for (const a of aggs) {
      all += a.head;
      if (a.susp) susp += a.head;
    }
    return all ? (susp / all) * 100 : null;
  }, [aggs]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { clean: 0, watch: 0, high: 0 };
    for (const r of ranches.data ?? []) c[r.risk.class] = (c[r.risk.class] ?? 0) + 1;
    return c;
  }, [ranches.data]);
  const deforStats = useMemo(() => {
    let post = 0, all = 0;
    for (const f of defor.data?.features ?? []) {
      all += f.properties.area_ha;
      if (f.properties.year > 2020) post += f.properties.area_ha;
    }
    return { post, all, n: defor.data?.features.length ?? 0 };
  }, [defor.data]);

  const featured = useMemo(() => {
    const list = ranches.data ?? [];
    const byId = new Map(list.map((r) => [r.id, r]));
    const fixed = FEATURED.map((id) => byId.get(id)).filter(Boolean) as Ranch[];
    if (fixed.length) return fixed;
    return [...list].filter((r) => r.risk.class === 'high').sort((a, b) => b.risk.flags.length - a.risk.flags.length).slice(0, 2);
  }, [ranches.data]);

  const go = (st: Step) => {
    setStep(st);
    if (st === 'explore') {
      setLayers({ defor: true, cleared: true, protected: true, ranches: true, flows: true, dest: true });
      setFlowType('all');
      setEmphasis('none');
      setLimit(220);
      return;
    }
    const v = STEP_VIEW[st];
    setLayers(v.layers);
    setFlowType(v.flowType);
    setPostOnly(v.postOnly);
    setEmphasis(v.emphasis);
    setLimit(v.limit);
    setHidden(new Set());
    setFlowYear(null);
    setMinYear(2008);
  };
  const story = step !== 'explore';

  const bbox = meta.data?.aoi?.bbox ?? null;
  const toggle = (k: keyof LayerToggles) => setLayers((l) => ({ ...l, [k]: !l[k] }));
  const toggleClass = (c: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });
  const loading = near && (ranches.status === 'loading' || defor.status === 'loading');
  const mockAny = [ranches, defor, prot, moves, dests].some((d) => d.origin === 'mock');

  return (
    <section id="map" className="section" ref={ref} aria-labelledby="map-title">
      <div className="wrap">
        <div className="section-head center">
          <p className="kicker">04 · Map explorer</p>
          <h2 className="title" id="map-title">
            Where the cattle come from
          </h2>
          <p className="deck">Four steps through the study area. Then explore it yourself.</p>
        </div>

        <div className="map-steps" role="tablist" aria-label="Map story">
          {STEPS.map((st) => (
            <button key={st.id} role="tab" aria-selected={step === st.id} className={step === st.id ? 'on' : undefined} onClick={() => go(st.id)}>
              {st.n && <span className="n">{st.n}</span>}
              {st.label}
            </button>
          ))}
        </div>

        <div className={`map-shell${story ? ' story' : ''}`}>
          <div className="map-box">
            {near ? (
              <Suspense fallback={<div className="map-loading">Loading map…</div>}>
                <MapView
                  ranches={ranches.data}
                  defor={defor.data}
                  cleared={cleared.data}
                  protectedAreas={prot.data}
                  aoi={aoi.data}
                  destinations={dests.data}
                  flows={flows?.fc ?? null}
                  bbox={bbox}
                  layers={layers}
                  hiddenClasses={hidden}
                  minYear={minYear}
                  postOnly={postOnly}
                  satellite={satellite}
                  selected={selected}
                  onSelect={onSelect}
                  fitAllKey={fitAllKey}
                  fitAoiKey={fitAoiKey}
                  evalMode={evalMode}
                  theme={theme}
                  emphasis={emphasis}
                />
              </Suspense>
            ) : (
              <div className="map-loading">Map loads as you scroll…</div>
            )}
            {loading && <div className="map-overlay tr float small" style={{ padding: '6px 10px' }}>Loading layers…</div>}
            <div className="map-overlay tl">
              <div className="seg float" role="group" aria-label="Base map">
                <button aria-pressed={!satellite} onClick={() => setSatellite(false)}>
                  Map
                </button>
                <button aria-pressed={satellite} onClick={() => setSatellite(true)}>
                  Satellite
                </button>
              </div>
              <div className="seg float" role="group" aria-label="Zoom to">
                <button aria-pressed={false} onClick={() => setFitAoiKey((k) => k + 1)}>
                  Study area
                </button>
                <button aria-pressed={false} onClick={() => setFitAllKey((k) => k + 1)}>
                  Where it goes
                </button>
              </div>
            </div>
            {story && (
              <StoryCard
                step={step}
                pal={pal}
                theme={theme}
                stats={{
                  post: deforStats.post,
                  all: deforStats.all,
                  high: counts.high ?? 0,
                  watch: counts.watch ?? 0,
                  clean: counts.clean ?? 0,
                  suspPct: suspShare,
                }}
                featured={featured}
                onSelect={onSelect}
                onNext={() => go(STEPS[STEPS.findIndex((x) => x.id === step) + 1].id)}
              />
            )}
            {!story && !legendOpen && (
              <div className="map-overlay bl float">
                <button className="legend-toggle" onClick={() => setLegendOpen(true)} aria-expanded={false}>
                  Legend <span aria-hidden>▴</span>
                </button>
              </div>
            )}
            {!story && legendOpen && (
            <div className="map-overlay bl float map-legend" aria-label="Legend">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>Ranches</b>
                <span className="row" style={{ gap: 6 }}>
                  <DataTag origin={ranches.origin} real={false} />
                  <button className="btn btn-ghost btn-sm" style={{ padding: '0 6px' }} onClick={() => setLegendOpen(false)} aria-label="Hide legend">
                    ▾
                  </button>
                </span>
              </div>
              <div className="row" style={{ gap: 10 }}>
                {(['clean', 'watch', 'high'] as const).map((c) => (
                  <span key={c} className="row" style={{ gap: 5 }}>
                    <span className="sw" style={{ background: RISK_COLOR[c], opacity: 0.85 }} />
                    {c === 'high' ? 'High' : c === 'watch' ? 'Watch' : 'Clean'}
                  </span>
                ))}
              </div>
              <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
                <b>Clearing by year</b> <DataTag origin={defor.origin} real />
              </div>
              <div className="row">
                <span className="year-ramp" style={{ width: 150, margin: 0 }} aria-hidden>
                  {Array.from({ length: 18 }, (_, i) => 2008 + i).map((y) => (
                    <span key={y} style={{ background: deforColor(y, theme) }} />
                  ))}
                </span>
              </div>
              <div className="row small muted" style={{ justifyContent: 'space-between', width: 150, marginTop: -3 }}>
                <span>2008</span>
                <span style={{ color: 'var(--defor)', fontWeight: 600 }}>2021+ EUDR</span>
              </div>
              <div className="row">
                <span className="sw" style={{ background: pal.cleared }} /> Cleared before 2008
              </div>
              <div className="row">
                <span className="sw" style={{ background: `repeating-linear-gradient(135deg,${pal.indigenous} 0 2px,transparent 2px 6px)`, border: `1px dashed ${pal.indigenous}` }} />
                Indigenous land
                <span className="sw" style={{ background: `repeating-linear-gradient(135deg,${pal.conservation} 0 2px,transparent 2px 6px)`, border: `1px dashed ${pal.conservation}`, marginLeft: 6 }} />
                Conservation unit
              </div>
              <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
                <b>Cattle flows</b> <DataTag origin={moves.origin} real={false} />
              </div>
              <div className="row">
                <span className="line" style={{ borderColor: pal.flow }} /> permits
                <span className="line" style={{ borderColor: pal.susp, marginLeft: 6 }} /> suspicious
                <span className="line dash" style={{ borderColor: pal.susp, marginLeft: 6 }} /> refused
              </div>
              <div className="row">
                <span className="sw" style={{ width: 10, height: 10, borderRadius: '50%', background: pal.dest }} /> slaughterhouse
                <span className="sw" style={{ width: 12, height: 12, borderRadius: '50%', background: pal.port, marginLeft: 6 }} /> export port
              </div>
            </div>
            )}
          </div>

          {!story && <aside className="map-side" aria-label="Map filters">
            <div className="ctl-group">
              <h5>
                Ranch risk <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>AI rating</span>
              </h5>
              {(['high', 'watch', 'clean'] as const).map((c) => (
                <label className="check-row" key={c}>
                  <input type="checkbox" checked={!hidden.has(c)} onChange={() => toggleClass(c)} />
                  <span className="sw" style={{ background: RISK_COLOR[c] }} />
                  {c === 'high' ? 'High risk' : c === 'watch' ? 'Watch' : 'Clean'}
                  <span className="count">{fmt(counts[c] ?? 0)}</span>
                </label>
              ))}
            </div>

            <div className="ctl-group">
              <h5>Deforestation (PRODES)</h5>
              <label className="small" htmlFor="minYear" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Cleared since</span>
                <b className="num">{postOnly ? Math.max(2021, minYear) : minYear}</b>
              </label>
              <input id="minYear" className="range" type="range" min={2008} max={2025} value={minYear} onChange={(e) => setMinYear(Number(e.target.value))} />
              <label className="switch" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={postOnly} onChange={(e) => setPostOnly(e.target.checked)} />
                Only after the EUDR cut-off (2021+)
              </label>
              <p className="small muted" style={{ margin: '8px 0 0' }}>
                {fmt(deforStats.n)} clearings, {compact(deforStats.all)} ha since 2008, <b style={{ color: 'var(--defor)' }}>{compact(deforStats.post)} ha after 2020</b>.
              </p>
            </div>

            <div className="ctl-group">
              <h5>Cattle flows</h5>
              <div className="seg" role="group" aria-label="Movement year" style={{ marginBottom: 8 }}>
                <button aria-pressed={flowYear === null} onClick={() => setFlowYear(null)}>
                  All years
                </button>
                {years.map((y) => (
                  <button key={y} aria-pressed={flowYear === y} onClick={() => setFlowYear(y)}>
                    {y}
                  </button>
                ))}
              </div>
              <select aria-label="Flow type" value={flowType} onChange={(e) => setFlowType(e.target.value as FlowType)} style={{ width: '100%' }}>
                <option value="all">All movements</option>
                <option value="suspicious">Suspicious only</option>
                <option value="ranch">Between ranches</option>
                <option value="slaughter">To slaughterhouses</option>
                <option value="export">To the export port</option>
                <option value="rejected">Refused by the ledger</option>
              </select>
              <label className="small" htmlFor="limit" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
                <span>Largest flows drawn</span>
                <b className="num">{limit}</b>
              </label>
              <input id="limit" className="range" style={{ accentColor: 'var(--forest-2)' }} type="range" min={100} max={2000} step={50} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
              {flows && (
                <div className="map-stats" style={{ marginTop: 10 }}>
                  Drawing <b>{fmt(flows.stats.shown)}</b> of {fmt(flows.stats.pairs)} ranch-to-ranch links · {fmt(flows.stats.nGta)} permits ·{' '}
                  {compact(flows.stats.totalHead)} head · <b style={{ color: 'var(--high)' }}>{flows.stats.totalHead ? fmt((flows.stats.suspHead / flows.stats.totalHead) * 100) : 0}% suspicious</b>
                </div>
              )}
            </div>

            <div className="ctl-group">
              <h5>Layers</h5>
              {(
                [
                  ['ranches', 'Ranch boundaries', false],
                  ['defor', 'PRODES clearings', true],
                  ['cleared', 'Cleared before 2008', true],
                  ['protected', 'Protected areas', true],
                  ['flows', 'Cattle flows', false],
                  ['dest', 'Slaughterhouses & port', true],
                ] as [keyof LayerToggles, string, boolean][]
              ).map(([k, label, real]) => (
                <label className="check-row" key={k}>
                  <input type="checkbox" checked={layers[k]} onChange={() => toggle(k)} />
                  {label}
                  <span className="count">
                    <SourceTag kind={mockAny ? 'mock' : real ? 'real' : 'synthetic'} />
                  </span>
                </label>
              ))}
            </div>
          </aside>}
        </div>
        <p className="note-line">
          <SourceTag kind="real" />
          Slaughterhouse and port locations are real; names are anonymised and every flow is synthetic. Nothing here implies anything about a real
          company or property.
        </p>
      </div>
    </section>
  );
}

const STORY: Record<Exclude<Step, 'explore'>, { title: string }> = {
  forest: { title: 'Forest lost since 2008' },
  ranches: { title: 'Every ranch, rated by the AI' },
  flows: { title: 'Cattle leaving flagged ranches' },
  refused: { title: 'Permits HerdLedger refused' },
};

function StoryCard({ step, pal, theme, stats, featured, onSelect, onNext }: {
  step: Exclude<Step, 'explore'> | 'explore';
  pal: (typeof MAP_PAL)['dark'];
  theme: 'dark' | 'light';
  stats: { post: number; all: number; high: number; watch: number; clean: number; suspPct: number | null };
  featured: Ranch[];
  onSelect: (id: string) => void;
  onNext: () => void;
}) {
  if (step === 'explore') return null;
  const key = (color: string, label: string, kind: 'sw' | 'line' | 'dash' | 'dot' = 'sw') => (
    <span className="story-key">
      <i className={kind} style={kind === 'line' || kind === 'dash' ? { borderColor: color } : { background: color }} />
      {label}
    </span>
  );
  return (
    <div className="map-overlay story-card float" aria-live="polite">
      <p className="story-title">{STORY[step].title}</p>
      {step === 'forest' && (
        <>
          <p className="story-big">
            {compact(stats.post)} <small>ha after 2020</small>
          </p>
          <p className="story-sub">of {compact(stats.all)} ha cleared in this window (INPE PRODES, real)</p>
          <div className="story-keys">
            {key(deforColor(2023, theme), 'after the EUDR cut-off')}
            {key(deforColor(2014, theme), 'before')}
            {key(pal.indigenous, 'Indigenous land', 'dash')}
          </div>
        </>
      )}
      {step === 'ranches' && (
        <>
          <p className="story-big">
            {stats.high} <small>high-risk ranches</small>
          </p>
          <p className="story-sub">
            {stats.watch} on watch · {stats.clean} clean · tap any ranch for its evidence
          </p>
          <div className="story-keys">
            {key(RISK_COLOR.high, 'high')}
            {key(RISK_COLOR.watch, 'watch')}
            {key(RISK_COLOR.clean, 'clean')}
          </div>
          {featured[0] && (
            <button className="btn btn-sm story-open" onClick={() => onSelect(featured[0].id)}>
              Open {featured[0].id}: {featureBlurb(featured[0]).toLowerCase()} ↗
            </button>
          )}
        </>
      )}
      {step === 'flows' && (
        <>
          <p className="story-big">
            {stats.suspPct != null ? `${Math.round(stats.suspPct)}%` : '…'} <small>of head moved is suspicious</small>
          </p>
          <p className="story-sub">Red lines carry cattle traced to flagged ranches, into slaughterhouses and the port</p>
          <div className="story-keys">
            {key(pal.susp, 'suspicious flow', 'line')}
            {key(pal.dest, 'slaughterhouse', 'dot')}
            {key(pal.port, 'export port', 'dot')}
          </div>
        </>
      )}
      {step === 'refused' && (
        <>
          <p className="story-big">
            Refused <small>before any AI looked</small>
          </p>
          <p className="story-sub">Dashed: herds that didn't exist, impossible births, embargoed origins</p>
          <div className="story-keys">{key(pal.susp, 'refused permit', 'dash')}</div>
        </>
      )}
      <button className="story-next" onClick={onNext}>
        {step === 'refused' ? 'Explore the map yourself' : 'Next'} <span aria-hidden>→</span>
      </button>
    </div>
  );
}

function featureBlurb(r: Ranch) {
  const codes = r.risk.flags.map((f) => f.code);
  if (codes.includes('PHANTOM_BIRTHS')) return `${r.role === 'intermediary' ? 'Intermediary' : 'Ranch'} that invents calves on paper`;
  if (codes.includes('EMBARGOED')) return 'Embargoed ranch with post-2020 clearing';
  if (codes.includes('PASS_THROUGH')) return 'Resells cattle within days';
  if (codes.includes('PROTECTED_AREA')) return 'Pasture inside a protected area';
  return r.risk.flags[0]?.title ?? 'High-risk ranch';
}
