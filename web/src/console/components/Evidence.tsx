import { useState, type ReactNode } from 'react';
import type { Finding, GeoEvidence, LineageTrace } from '../api/types';
import { ha, label, num, pct, short } from '../lib/format';
import { href } from '../lib/router';
import { resolveSearch } from '../lib/ids';
import { ProvenanceLabel, SeverityBadge, Tag } from './Badges';

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** Link any entity id to its page; plain text if it is not a known id. */
export function IdLink({ id }: { id: string }) {
  const t = resolveSearch(id);
  if (!t) return <span className="mono">{id}</span>;
  return (
    <a className="mono" href={href(t.page, t.id)}>
      {id}
    </a>
  );
}

/** Environmental evidence for one ranch. Missing measurements stay visibly missing. */
export function EvidenceCard({ ev, status }: { ev: GeoEvidence | null; status: 'available' | 'missing' | 'not_applicable' }) {
  if (status === 'not_applicable') return <div className="note">Supplier outside the study window: no geometry, environmental status unknown.</div>;
  if (!ev || status === 'missing')
    return <div className="note warn">No environmental evidence for this ranch. Missing evidence is not a clean result.</div>;
  const d = ev.deforestation;
  const legalTone = ev.legal.eudr_cutoff_indicator === 'post_cutoff_clearing_detected' ? 'red' : ev.legal.eudr_cutoff_indicator === 'undetermined' ? 'amber' : 'green';
  return (
    <div className="evidence">
      <div className="evidence-head">
        <Tag tone={legalTone}>EUDR indicator: {label(ev.legal.eudr_cutoff_indicator)}</Tag>
        <Tag tone={ev.scientific_risk.class === 'high' ? 'red' : ev.scientific_risk.class === 'watch' ? 'amber' : 'neutral'}>
          Environmental risk: {ev.scientific_risk.class}
        </Tag>
        {Object.entries(ev.data_status).map(([k, v]) => (
          <ProvenanceLabel key={k} status={v}>
            {k}
          </ProvenanceLabel>
        ))}
      </div>
      <KV
        rows={[
          ['Post-cut-off clearing', ha(d.post_cutoff_ha)],
          ['Straddling PRODES 2021', ha(d.straddles_cutoff_ha)],
          ['Pre-cut-off clearing', ha(d.pre_cutoff_ha)],
          ['Unknown date', ha(d.unknown_date_ha)],
          ['Nearest post-cut-off clearing', d.nearest_post_cutoff_km === null ? '—' : `${num(d.nearest_post_cutoff_km, 2)} km (proximity is not a violation)`],
          ['Layer coverage', d.coverage],
          ['Indigenous land overlap', ev.indigenous_territory ? `${ha(ev.indigenous_territory.overlap_ha)} (${pct(100 * ev.indigenous_territory.overlap_share)})` : '— not measured'],
          ['Protected-area overlap', ev.protected_area ? `${ha(ev.protected_area.overlap_ha)} (${pct(100 * ev.protected_area.overlap_share)})` : '— not measured'],
          ['Embargo', `${ev.embargo.status}${ev.embargo.since ? ` since ${ev.embargo.since}` : ''}${ev.embargo.simulated ? ' (simulated)' : ''}`],
          ['Cut-off / as of', `${ev.cutoff_date} / ${ev.as_of}`],
        ]}
      />
      {[...(ev.indigenous_territory?.areas || []), ...(ev.protected_area?.areas || [])].map((a) => (
        <div className="note" key={a.feature_id}>
          <strong>{a.name}</strong>: {a.legal_context}
        </div>
      ))}
      <p className="small muted">{ev.legal.note}</p>
      {ev.warnings.length > 0 && (
        <ul className="warnings">
          {ev.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <details className="small">
        <summary>Dataset versions</summary>
        <KV rows={Object.entries(ev.dataset_versions).map(([k, v]) => [k, <span className="mono">{v}</span>])} />
      </details>
    </div>
  );
}

export function FindingCard({ f }: { f: Finding }) {
  const [open, setOpen] = useState(false);
  return (
    <article className={`finding sev-${f.severity}`}>
      <header>
        <SeverityBadge severity={f.severity} blocking={f.blocking} />
        <strong>{label(f.code)}</strong>
        <span className="muted small">
          {f.detector} · confidence {num(f.confidence, 2)}
        </span>
      </header>
      <p>{f.explanation}</p>
      <button type="button" className="btn btn-link small" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? 'Hide evidence' : 'Show values, thresholds and evidence'}
      </button>
      {open && (
        <div className="finding-detail">
          <KV
            rows={[
              ...Object.entries(f.observed).map(([k, v]) => [label(k), fmtVal(v)] as [ReactNode, ReactNode]),
              ...f.thresholds.map((t) => [`Threshold: ${t.name}`, `${t.comparison} ${fmtVal(t.value)}`] as [ReactNode, ReactNode]),
              ['Detector version', f.detector_version],
              ['Observed at', f.observed_at],
              ['Evidence hash', <span className="mono">{short(f.evidence_hash, 16)}</span>],
            ]}
          />
          {f.evidence_ids.length > 0 && (
            <div className="small">
              Evidence records:{' '}
              {f.evidence_ids.slice(0, 12).map((e) => (
                <code key={e} className="chip">
                  {e}
                </code>
              ))}
              {f.evidence_ids.length > 12 && <span className="muted"> +{f.evidence_ids.length - 12} more</span>}
            </div>
          )}
          {f.limitations.length > 0 && (
            <ul className="warnings">
              {f.limitations.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

export function FindingList({ findings, empty = 'No findings.' }: { findings: Finding[]; empty?: string }) {
  if (!findings.length) return <div className="note">{empty}</div>;
  const order = { high: 0, watch: 1, info: 2 } as const;
  return (
    <div className="findings">
      {[...findings]
        .sort((a, b) => order[a.severity] - order[b.severity] || Number(b.blocking) - Number(a.blocking))
        .map((f) => (
          <FindingCard key={f.finding_id} f={f} />
        ))}
    </div>
  );
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return num(v, Number.isInteger(v) ? 0 : 2);
  if (Array.isArray(v)) return v.join(', ') || '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const CAT_TONE: Record<string, 'red' | 'amber' | 'earth' | 'neutral'> = {
  post_cutoff_deforestation: 'red',
  embargo: 'red',
  protected_overlap: 'red',
  suspicious_births_or_inventory: 'amber',
  environmental_evidence_missing: 'amber',
  unknown_origin: 'neutral',
};

/** Lineage: exposure, attribution, the source contribution table and the upstream path. */
export function LineageView({ t, maxSources = 15 }: { t: LineageTrace; maxSources?: number }) {
  const [showPath, setShowPath] = useState(false);
  const a = t.attribution;
  return (
    <div className="lineage">
      <div className="kpis small-kpis">
        <Kpi label="Lineage coverage" value={pct(t.coverage_pct)} hint="Share traced to a declared birth or opening stock" />
        <Kpi label="Any risk (each head once)" value={pct(t.exposure_pct.any_risk)} />
        <Kpi label="Unknown origin" value={pct(t.exposure_pct.unknown_or_incomplete)} />
        <Kpi label="Max hops" value={String(t.max_hops)} />
      </div>
      <KV
        rows={[
          ['1. Record-level inconsistency', pct(a.record_inconsistency_pct)],
          ['2. Environmental overlap', pct(a.environmental_overlap_pct)],
          ['3. Suspected laundering', `${pct(a.suspected_laundering_pct)} (risky origin behind a supplier a direct-only check clears)`],
          ['4. Unknown provenance', pct(a.unknown_provenance_pct)],
          ['5. Human review of attribution', a.review_required ? 'required' : 'not required'],
          ['Policy sensitivity', `${pct(t.policy_sensitivity.fifo_any_risk_pct)} FIFO vs ${pct(t.policy_sensitivity.pro_rata_any_risk_pct)} pro-rata`],
        ]}
      />
      <h4>Source contributions ({t.policy})</h4>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Origin</th>
              <th>Kind</th>
              <th style={{ textAlign: 'right' }}>Head</th>
              <th style={{ textAlign: 'right' }}>Share</th>
              <th style={{ textAlign: 'right' }}>Hops</th>
              <th>Categories</th>
            </tr>
          </thead>
          <tbody>
            {t.sources.slice(0, maxSources).map((s) => (
              <tr key={s.origin_key}>
                <td>{s.ranch_id ? <IdLink id={s.ranch_id} /> : <span className="mono">{s.origin_key}</span>}</td>
                <td>{s.origin_kind}</td>
                <td style={{ textAlign: 'right' }}>{num(s.head_equiv, 1)}</td>
                <td style={{ textAlign: 'right' }}>{pct(s.share_pct)}</td>
                <td style={{ textAlign: 'right' }}>{s.min_hops}</td>
                <td className="wrap">
                  {s.categories.length ? s.categories.map((c) => <Tag key={c} tone={CAT_TONE[c] || 'neutral'}>{label(c)}</Tag>) : <span className="muted">none</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {t.sources.length > maxSources && (
        <div className="small muted">
          +{t.sources.length - maxSources} more origins ({pct(t.sources.slice(maxSources).reduce((s, x) => s + x.share_pct, 0))} of head)
        </div>
      )}
      <h4>
        Upstream path · {t.trace_path.length} movements · intermediaries: {t.intermediaries.length ? t.intermediaries.slice(0, 10).join(', ') : 'none'}
        {t.intermediaries.length > 10 ? '…' : ''}
      </h4>
      <LineagePath steps={t.trace_path} open={showPath} onToggle={() => setShowPath(!showPath)} />
      {(a.review_reasons.length > 0 || t.uncertainty_notes.length > 0 || t.unresolved.length > 0) && (
        <ul className="warnings">
          {a.review_reasons.map((r, i) => (
            <li key={`r${i}`}>{r}</li>
          ))}
          {t.uncertainty_notes.map((r, i) => (
            <li key={`n${i}`}>{r}</li>
          ))}
          {t.unresolved.map((u) => (
            <li key={u.gta_id}>
              Unresolved {num(u.head)} head on {u.gta_id}: {u.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The upstream movements, largest attributed quantity first, as a compact hop list. */
export function LineagePath({ steps, open, onToggle, limit = 12 }: { steps: LineageTrace['trace_path']; open: boolean; onToggle: () => void; limit?: number }) {
  if (!steps.length) return <div className="note">No upstream movements recorded.</div>;
  const ordered = [...steps].sort((a, b) => b.attributed_head - a.attributed_head);
  const shown = open ? ordered : ordered.slice(0, limit);
  return (
    <div>
      <ol className="path">
        {shown
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
          .map((s) => (
            <li key={s.lot_id}>
              <span className="path-date">{s.date}</span>
              <IdLink id={s.from} />
              <span className="arrow" aria-hidden>
                →
              </span>
              <span className="mono">{s.to}</span>
              <span className="muted small">
                {num(s.attributed_head, 1)} of {num(s.permit_head)} head · <IdLink id={s.gta_id} />
              </span>
            </li>
          ))}
      </ol>
      {steps.length > limit && (
        <button type="button" className="btn btn-link small" onClick={onToggle} aria-expanded={open}>
          {open ? 'Show the largest movements only' : `Show all ${steps.length} movements`}
        </button>
      )}
    </div>
  );
}

export function Kpi({ label: l, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'red' | 'amber' | 'green' }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ''}`} title={hint}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{l}</div>
    </div>
  );
}
