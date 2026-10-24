import { useMemo, useState } from 'react';
import { api, ApiError, unwrap } from '../api/client';
import type { Assessment, Breakdown, Finding, FindingView, ReviewStatus, ShipmentDetail, ShipmentRiskDetail } from '../api/types';
import { useApi } from '../api/useApi';
import { OutcomeBadge, ProvenanceLabel, Tag } from '../components/Badges';
import { FindingCard, IdLink, Kpi, KV, LineageView, Section } from '../components/Evidence';
import { LineageGraphView, type GraphSelection } from '../components/LineageGraph';
import { ConfirmDialog } from '../components/Overlays';
import { Async, ErrorState, Loading } from '../components/States';
import { fromApi, graphChecks } from '../lib/graph';
import { label, nf, num, pct } from '../lib/format';
import { href } from '../lib/router';
import { Explain } from '../../lib/explain';

const CATEGORY_ORDER = ['post_cutoff_deforestation', 'embargo', 'indigenous_territory', 'protected_area', 'inventory_birth_anomalies', 'suspicious_movement_behaviour', 'unknown_origin'];

export function Investigation({ id }: { id: string }) {
  const detail = useApi((s) => api.shipment(id, s), [id]);
  return (
    <div className="page">
      <header className="page-head">
        <div className="crumbs">
          <a href={href('shipments')}>Shipments</a> / <span className="mono">{id}</span>
        </div>
      </header>
      <Async state={detail} what={`Loading ${id}`}>
        {({ data }) => <Workspace id={id} d={data} />}
      </Async>
    </div>
  );
}

function Workspace({ id, d }: { id: string; d: ShipmentDetail }) {
  const t = d.lineage;
  const risk = useApi((s) => api.shipmentRisk(id, s).then(unwrap), [id]);
  const [category, setCategory] = useState<string | null>(null);

  return (
    <div className="stack">
      <section className="inv-head panel">
        <div className="inv-title">
          <h1 className="mono">{id}</h1>
          <OutcomeBadge outcome={d.assessment_status === 'assessed' ? d.decision?.outcome : null} />
          <ProvenanceLabel status="synthetic" />
        </div>
        <Explain>
          One shipment under investigation: the lineage graph back to its birth ranches, why the engine scored it as it did, the evidence behind each finding, and where a reviewer records a decision.
        </Explain>
        <div className="kpis small-kpis">
          <Kpi label="Destination" value={<IdLink id={d.shipment.destination_id} />} />
          <Kpi label="Date" value={d.shipment.shipment_date} />
          <Kpi label="Cattle declared" value={nf.format(d.shipment.declared_head_count)} />
          <Kpi label="Ranches behind it" value={t ? nf.format(t.sources.filter((s) => s.ranch_id).length) : '—'} />
          <Kpi label="Traced back to birth" value={t ? pct(t.coverage_pct) : '—'} />
        </div>
      </section>

      <Actions id={id} d={d} />

      <Section title="Lineage graph" aside={<CategoryPicker value={category} onChange={setCategory} r={risk.data} />}>
        <GraphPanel id={id} category={category} />
      </Section>
      <Section title="Risk breakdown">
        <Async state={risk} what="Loading risk">
          {(r) => <BreakdownPanel r={r} d={d} />}
        </Async>
      </Section>

      <Section title="Findings and evidence">
        <Async state={risk} what="Loading findings">
          {(r) => <FindingsPanel r={r} />}
        </Async>
      </Section>

      {d.decision && (
        <Section title="Why this decision">
          <ul className="reasons">
            {d.decision.reasons.map((r, i) => (
              <li key={i} className={r.startsWith('[blocking]') ? 'r-block' : r.startsWith('[review]') ? 'r-review' : 'r-pass'}>
                {r}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {t && (
        <details className="tech">
          <summary>Full origin table (for investigators)</summary>
          <Section title="Where the cattle came from, in detail">
            <LineageView t={t} />
          </Section>
        </details>
      )}
    </div>
  );
}

function CategoryPicker({ value, onChange, r }: { value: string | null; onChange: (v: string | null) => void; r: ShipmentRiskDetail | null }) {
  const cats = r ? Object.entries(r.breakdown.categories).filter(([, v]) => v.head > 0).map(([k]) => k) : [];
  return (
    <label className="field inline">
      <span>Highlight paths</span>
      <select value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">none</option>
        {cats.map((c) => (
          <option key={c} value={c}>
            {label(c)}
          </option>
        ))}
      </select>
    </label>
  );
}

function GraphPanel({ id, category }: { id: string; category: string | null }) {
  const [full, setFull] = useState(false);
  const [expand, setExpand] = useState<string | null>(null);
  const [sel, setSel] = useState<GraphSelection | null>(null);
  const graph = useApi((s) => api.lineageGraph(id, { max_nodes: full ? undefined : 40, expand: expand || undefined }, s).then(unwrap), [id, full, expand]);
  const drawn = useMemo(() => (graph.data ? fromApi(graph.data) : null), [graph.data]);
  const checks = useMemo(() => (graph.data ? graphChecks(graph.data) : null), [graph.data]);
  if (graph.error) return <ErrorState error={graph.error} onRetry={graph.reload} />;
  if (!drawn || !graph.data) return <Loading what="Building lineage graph" />;
  const g = graph.data;
  return (
    <div>
      <p className="small muted">
        Left: the ranches the cattle came from. Right: where they were delivered. Origins are estimated from permits, not tracked animal by animal.
      </p>
      <div className="graph-tools small">
        <span>
          {g.view.mode === 'overview' && `Showing the main ${g.view.max_nodes} ranches; smaller ones are grouped.`}
          {g.view.mode === 'branch' && `Showing one branch, from ${g.view.root}.`}
        </span>
        <span className="btn-group">
          {g.view.mode === 'branch' || expand ? (
            <button type="button" className="btn btn-small" onClick={() => setExpand(null)}>
              Back to the whole lot
            </button>
          ) : g.view.mode === 'overview' || full ? (
            <button type="button" className="btn btn-small" onClick={() => setFull(!full)} aria-pressed={full}>
              {full ? 'Summarised view' : 'Full graph'}
            </button>
          ) : null}
        </span>
      </div>
      <LineageGraphView graph={drawn} category={category} onSelect={setSel} />
      {checks && (checks.originsMatchApi === false || !checks.destinationMatchesDeclared) && (
        <div className="small muted">
          Consistency: origins {num(checks.originHead, 1)} head (API source total {num(checks.apiSourceHead, 1)}) · into destination {num(checks.intoDestination, 1)} of {num(checks.declared)} declared
          {checks.originsMatchApi === false || !checks.destinationMatchesDeclared ? ' · MISMATCH, check the API response' : ' · consistent'}
          {g.view.mode === 'branch' && ' (branch view shows part of the lot)'}
        </div>
      )}
      {sel && <Selection sel={sel} onClose={() => setSel(null)} onExpand={(r) => (setExpand(r), setSel(null))} />}
    </div>
  );
}

function Selection({ sel, onClose, onExpand }: { sel: GraphSelection; onClose: () => void; onExpand: (ranch: string) => void }) {
  const n = sel.node;
  const ranch = n?.ranch_id || null;
  const rr = useApi((s) => api.ranchRisk(ranch!, s).then(unwrap), [ranch], !!ranch);
  return (
    <div className="selection panel">
      <header className="panel-head">
        <h4 className="mono">{n ? n.label : `${sel.edge!.source} → ${sel.edge!.target}`}</h4>
        <button type="button" className="btn btn-small" onClick={onClose}>
          Close
        </button>
      </header>
      {n && (
        <>
          <KV
            rows={[
              ['Type', `${label(n.kind)}${n.roles.length ? ` · ${n.roles.join(', ')}` : ''}`],
              ['Cattle from this ranch (estimate)', n.head > 0 ? `${num(n.head, 1)} head · ${pct(n.share_pct)}` : 'not an origin (passes cattle through)'],
              ['Estimate if herds mix evenly', `${num(n.headProRata, 1)} head`],
              ['Categories', n.categories.length ? n.categories.map(label).join(', ') : 'none'],
              ['Data', <ProvenanceLabel status={n.data_status} />],
            ]}
          />
          {ranch && (
            <div className="small actions-inline">
              <a href={href('ranches', ranch)}>Ranch page</a>
              <a href={href('map', null, { ranch, focus: ranch })}>Open on Live Map</a>
              <button type="button" className="btn btn-link" onClick={() => onExpand(ranch)}>
                Expand this branch
              </button>
            </div>
          )}
          {rr.data && rr.data.findings.length > 0 && (
            <ul className="small">
              {rr.data.findings.map((f) => (
                <li key={f.finding_id}>
                  {label(f.code)} ({f.severity}{f.blocking ? ', blocking' : ''}): {f.explanation}
                </li>
              ))}
            </ul>
          )}
          {n.kind === 'folded' && (
            <div>
              <div className="small muted">Smaller ranches grouped together. Pick one to see its branch:</div>
              <div className="chips">
                {n.members.slice(0, 60).map((m) =>
                  /^R\d{4}$|^X\d{2}$/.test(m) ? (
                    <button key={m} type="button" className="chip btn-link" onClick={() => onExpand(m)}>
                      {m}
                    </button>
                  ) : (
                    <code key={m} className="chip">
                      {m}
                    </code>
                  ),
                )}
                {n.members.length > 60 && <span className="small muted">+{n.members.length - 60} more</span>}
              </div>
            </div>
          )}
        </>
      )}
      {sel.edge && (
        <KV
          rows={[
            ['Permit', sel.edge.gta_id ? <IdLink id={sel.edge.gta_id} /> : `${sel.edge.gta_count ?? '?'} grouped permits`],
            ['Date', sel.edge.date || '—'],
            ['Head on the permit', num(sel.edge.permit_head)],
            ['Head attributed to this lot', num(sel.edge.head, 1)],
          ]}
        />
      )}
    </div>
  );
}

function BreakdownPanel({ r, d }: { r: ShipmentRiskDetail; d: ShipmentDetail }) {
  const b: Breakdown = r.breakdown;
  const all = Object.entries(b.categories).sort(([a], [c]) => idx(a) - idx(c));
  const rows = all.filter(([, v]) => v.head > 0);
  const none = all.filter(([, v]) => v.head === 0).map(([cat]) => label(cat));
  return (
    <div>
      {none.length > 0 && <p className="small muted">None measured: {none.join(', ')}.</p>}
      <div className="bars">
        {rows.map(([cat, v]) => (
          <div className="bar-row" key={cat}>
            <span className="bar-label">{label(cat)}</span>
            <span className="bar" aria-hidden>
              <span className={`bar-fill ${tone(cat)}`} style={{ width: `${Math.min(100, v.pct)}%` }} />
            </span>
            <span className="bar-val">
              {pct(v.pct)} · {num(v.head, 0)} head
            </span>
            {(v.sources.length > 0 || v.via_intermediaries?.length || v.note) && (
              <span className="bar-detail small muted">
                {v.sources.length > 0 && (
                  <>
                    from{' '}
                    {v.sources.slice(0, 8).map((s, i) => (
                      <span key={s}>
                        {i > 0 && ', '}
                        <IdLink id={s} />
                      </span>
                    ))}
                    {v.sources.length > 8 ? ` +${v.sources.length - 8} more` : ''}
                  </>
                )}
                {v.via_intermediaries?.length ? (
                  <>
                    {' '}via{' '}
                    {v.via_intermediaries.map((x, i) => (
                      <span key={x.ranch_id}>
                        {i > 0 && '; '}
                        <IdLink id={x.ranch_id} /> ({x.codes.map(label).join(', ')}, {num(x.attributed_head, 0)} head)
                      </span>
                    ))}
                  </>
                ) : null}
              </span>
            )}
          </div>
        ))}
        <div className="bar-row total">
          <span className="bar-label">Total cattle at risk</span>
          <span className="bar" aria-hidden>
            <span className="bar-fill tone-dark" style={{ width: `${Math.min(100, b.unique_affected_pct)}%` }} />
          </span>
          <span className="bar-val">
            {pct(b.unique_affected_pct)} · {num(b.unique_affected_head, 0)} head
          </span>
        </div>
      </div>
      <p className="small muted">An animal can fall into more than one category, so the total counts each animal once.</p>
      {r.clearing_steps.length > 0 && (
        <details className="tech">
          <summary>{d.decision?.outcome === 'REVIEW' ? 'What would clear the review' : 'What could change this outcome'}</summary>
          <ul className="reasons">
            {r.clearing_steps.map((c, i) => (
              <li key={i}>
                <strong>{c.action}</strong>: {c.why}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!r.decision && <div className="note warn">Not assessed by the risk engine yet. This is not a pass.</div>}
    </div>
  );
}

function idx(c: string) {
  const i = CATEGORY_ORDER.indexOf(c);
  return i < 0 ? 99 : i;
}
function tone(c: string) {
  if (/unknown/.test(c)) return 'tone-grey';
  if (/birth|inventory|behaviour/.test(c)) return 'tone-amber';
  return 'tone-red';
}

function FindingsPanel({ r }: { r: ShipmentRiskDetail }) {
  const groups = Object.entries(r.findings_by_category);
  if (!groups.length) return <div className="note">{r.decision ? 'No findings on this lot or its direct suppliers.' : 'Not assessed.'}</div>;
  return (
    <div className="stack">
      {groups.map(([cat, fs]) => (
        <div key={cat}>
          <h4>
            {label(cat)} <span className="muted small">({fs.length})</span>
          </h4>
          {fs.map((f) => (
            <ReviewableFinding key={f.finding_id} f={f} initial={r.review_status[f.finding_id]} />
          ))}
        </div>
      ))}
    </div>
  );
}

const REVIEW_LABEL: Record<string, string> = { under_review: 'under review', confirmed: 'confirmed', dismissed: 'dismissed', unreviewed: 'not reviewed' };
const REVIEWER_KEY = 'rastro.console.reviewer';

function ReviewableFinding({ f, initial }: { f: Finding; initial?: string }) {
  const [open, setOpen] = useState(false);
  const view = useApi((s) => api.finding(f.finding_id, s).then(unwrap), [f.finding_id], open);
  const [saved, setSaved] = useState<FindingView | null>(null);
  const [form, setForm] = useState<{ status: ReviewStatus; reason: string; reviewer: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const data = saved || view.data;
  const status = data?.review_status || initial || 'unreviewed';
  const related = f.evidence_ids.map((e) => e.replace(/^(gta|ranch|lineage):/, '')).filter((e) => /^(R\d{4}|X\d{2}|GTA-[A-Z]{2}-\S+|SHP-[DV]-\d+)$/.test(e));

  const submit = async () => {
    if (!form) return;
    if (form.reason.trim().length < 3 || !form.reviewer.trim()) {
      setErr(new ApiError(-1, 'reason_required', 'A reason and a reviewer name are required.'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      setSaved(unwrap(await api.reviewFinding(f.finding_id, form.status, form.reason.trim(), form.reviewer.trim())));
      try {
        localStorage.setItem(REVIEWER_KEY, form.reviewer.trim());
      } catch {
        /* per-browser convenience only */
      }
      setForm(null);
      setOpen(true);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const startForm = (s: ReviewStatus) => {
    let reviewer = '';
    try {
      reviewer = localStorage.getItem(REVIEWER_KEY) || '';
    } catch {
      reviewer = '';
    }
    setErr(null);
    setForm({ status: s, reason: '', reviewer });
  };

  return (
    <div className="reviewable">
      <FindingCard f={f} />
      <div className="review-bar small">
        <span>
          <Tag tone={status === 'confirmed' ? 'red' : status === 'under_review' ? 'amber' : 'neutral'}>review: {REVIEW_LABEL[status] || status}</Tag>
          {status === 'dismissed' && f.blocking && <span className="warn-text"> Blocking rule still applies.</span>} About <IdLink id={f.entity_id} /> · seen {f.observed_at.slice(0, 10)}
          {related.length > 0 && (
            <>
              {' '}· related{' '}
              {related.slice(0, 8).map((x, i) => (
                <span key={x}>
                  {i > 0 && ', '}
                  <IdLink id={x} />
                </span>
              ))}
            </>
          )}
        </span>
        <span className="btn-group">
          <button type="button" className="btn btn-small" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide review history' : 'Review history'}
          </button>
          {(['under_review', 'confirmed', 'dismissed'] as ReviewStatus[]).map((s) => (
            <button key={s} type="button" className="btn btn-small" onClick={() => startForm(s)}>
              Mark {REVIEW_LABEL[s]}
            </button>
          ))}
        </span>
      </div>
      {open && (
        <div className="review-box">
          {view.loading && !data && <Loading what="Loading review history" />}
          {view.error && !saved && <ErrorState error={view.error} onRetry={view.reload} />}
          {data && (
            <>
              {data.decision_impact.map((x, i) => (
                <div key={i} className="small">
                  Decision on <IdLink id={x.shipment_id} />: <OutcomeBadge outcome={x.outcome} /> ({x.role}) · {x.note}
                </div>
              ))}
              {status === 'dismissed' && f.blocking && (
                <div className="note warn small">Dismissed by an investigator, but the blocking rule still applies: reviews annotate findings and never alter the machine decision.</div>
              )}
              {data.reviews.length ? (
                <ol className="history">
                  {data.reviews.map((rv) => (
                    <li key={rv.review_id}>
                      <strong>{REVIEW_LABEL[rv.status] || rv.status}</strong> · {rv.at} · {rv.reviewer}
                      <div>{rv.reason || <span className="muted">no reason recorded</span>}</div>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="small muted">No reviews yet.</div>
              )}
            </>
          )}
        </div>
      )}
      {form && (
        <ConfirmDialog
          title={`Mark finding ${REVIEW_LABEL[form.status]}`}
          busy={busy}
          confirmLabel="Record review"
          onCancel={() => (setForm(null), setErr(null))}
          onConfirm={submit}
          body={
            <>
              <p>Your note is added to this finding's history. It never changes the risk decision or the evidence.</p>
              <label className="field">
                <span>Reviewer (required)</span>
                <input value={form.reviewer} onChange={(e) => setForm({ ...form, reviewer: e.target.value })} maxLength={120} />
              </label>
              <label className="field">
                <span>Reason (required)</span>
                <textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} rows={3} maxLength={2000} />
              </label>
              {err && <div className="warn-text small">{err.message}</div>}
            </>
          }
        />
      )}
    </div>
  );
}

function Actions({ id, d }: { id: string; d: ShipmentDetail }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setAssessment(unwrap(await api.assess(id, false)));
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  const firstRanch = d.lineage?.sources.find((s) => s.ranch_id && /^R\d{4}$/.test(s.ranch_id))?.ranch_id;
  return (
    <div className="actions panel">
      <a className="btn btn-small" href={href('map', null, { shipment: id, ranch: firstRanch, focus: firstRanch })}>
        Show on the map
      </a>
      <a className="btn btn-small" href={api.evidenceDownloadUrl(id)} download>
        Download evidence
      </a>
      <details className="more">
        <summary className="btn btn-small">More</summary>
        <div className="more-menu">
          {(['json', 'md', 'csv'] as const).map((f) => (
            <a key={f} href={api.lineageReportUrl(id, f)} download>
              Origin report ({f.toUpperCase()})
            </a>
          ))}
          <button type="button" className="btn-link" onClick={() => setConfirm(true)}>
            Re-check with the risk engine
          </button>
        </div>
      </details>
      {err && <ErrorState error={err} />}
      {assessment && (
        <div className="note">
          Risk engine says: <OutcomeBadge outcome={assessment.outcome} /> · same as the decision above: {assessment.outcome === d.decision?.outcome ? 'yes' : 'NO'}
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title="Re-check with the risk engine"
          busy={busy}
          confirmLabel="Re-check"
          onCancel={() => setConfirm(false)}
          onConfirm={run}
          body={<p>Asks the risk engine for its decision on this shipment again. Nothing you do here can change the outcome.</p>}
        />
      )}
    </div>
  );
}
