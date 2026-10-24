import { useState, type FormEvent } from 'react';
import { api, ApiError, unwrap } from '../api/client';
import { useAllRanches, useSummary } from '../api/hooks';
import type { CertificateEvent, EvaluationReport, RedTeamSummary, VerifyResult } from '../api/types';
import { useApi } from '../api/useApi';
import { ProvenanceLabel, RiskBadge, Tag } from '../components/Badges';
import { IdLink, KV, Section } from '../components/Evidence';
import { ConfirmDialog } from '../components/Overlays';
import { Async, Empty, ErrorState } from '../components/States';
import { DataTable } from '../components/Table';
import { ID_PATTERNS } from '../lib/ids';
import { label, nf, num, pct, short } from '../lib/format';
import { href, navigate, type Route } from '../lib/router';
import { ShipTable } from './Overview';

// ---- Investigations: the work queue -------------------------------------------------------------
export function Investigations() {
  const flagged = useApi((s) => api.shipments({ outcome: 'FLAGGED', limit: 15 }, s), []);
  const review = useApi((s) => api.shipments({ outcome: 'REVIEW', limit: 15 }, s), []);
  const ranches = useAllRanches();
  return (
    <div className="page">
      <header className="page-head">
        <h1>Investigations</h1>
        <p className="muted">Work queue from the risk engine. Open a shipment for its lineage graph, risk breakdown, evidence and investigator reviews.</p>
      </header>
      <div className="grid-2 align-start">
        <Section title="Flagged shipments" aside={<a href={href('shipments', null, { outcome: 'FLAGGED' })}>All</a>}>
          <Async state={flagged}>{(p) => <><div className="small muted">{nf.format(p.page.total)} flagged</div><ShipTable rows={p.data} compact /></>}</Async>
        </Section>
        <Section title="Shipments needing review" aside={<a href={href('shipments', null, { outcome: 'REVIEW' })}>All</a>}>
          <Async state={review}>{(p) => <><div className="small muted">{nf.format(p.page.total)} in review</div><ShipTable rows={p.data} compact /></>}</Async>
        </Section>
      </div>
      <Section title="Ranch leads (high risk)">
        <Async state={ranches}>
          {(p) => (
            <DataTable
              rows={p.data.filter((r) => r.risk_class === 'high')}
              rowKey={(r) => r.ranch_id}
              onRow={(r) => navigate('ranches', r.ranch_id)}
              columns={[
                { key: 'id', header: 'Ranch', render: (r) => <IdLink id={r.ranch_id} /> },
                { key: 'role', header: 'Role', render: (r) => r.role },
                { key: 'defo', header: 'Post-cut-off clearing', align: 'right', render: (r) => (r.post_cutoff_deforestation_ha === null ? '—' : `${num(r.post_cutoff_deforestation_ha, 1)} ha`) },
                { key: 'eudr', header: 'EUDR indicator', render: (r) => (r.eudr_indicator ? label(r.eudr_indicator) : '—') },
                { key: 'risk', header: 'Risk', render: (r) => <RiskBadge risk={r.risk_class} /> },
              ]}
            />
          )}
        </Async>
      </Section>
    </div>
  );
}

// ---- Certificates ---------------------------------------------------------------------------------
export function Certificates({ route }: { route: Route }) {
  const [text, setText] = useState(route.id || '');
  const [bad, setBad] = useState(false);
  const go = (e: FormEvent) => {
    e.preventDefault();
    if (!ID_PATTERNS.certificate.test(text.trim())) return setBad(true);
    setBad(false);
    navigate('certificates', text.trim().toLowerCase());
  };
  type OnchainBundle = { records: { kind: string; ref: string | null; status: string }[]; demo?: Record<string, { lot_id?: string; ref?: string; status_after?: string }> };
  const onchain = useApi((s) => api.bundle<OnchainBundle>('onchain', s), []);
  const [all, setAll] = useState<{ lot_id: string; ref: string; verdict: string }[] | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const [allErr, setAllErr] = useState<ApiError | null>(null);
  const demo = Object.entries(onchain.data?.data.demo || {})
    .filter(([, v]) => v && typeof v === 'object' && 'lot_id' in v && v.lot_id)
    .map(([k, v]) => ({ lot_id: v.lot_id!, ref: v.ref || '—', verdict: k === 'consume_clean' ? 'clean (demo consumption)' : k === 'consume_flagged' ? 'flagged (demo)' : k }));
  const loadAll = async () => {
    setLoadingAll(true);
    setAllErr(null);
    try {
      const issued = new Set((onchain.data?.data.records || []).filter((r) => r.kind === 'issueCertificate' && r.ref).map((r) => r.ref!));
      const ships = await api.bundle<{ id: string; certificate?: { lot_id: string; verdict: string } }[]>('shipments');
      setAll(ships.data.filter((x) => x.certificate && issued.has(x.id)).map((x) => ({ lot_id: x.certificate!.lot_id, ref: x.id, verdict: x.certificate!.verdict })));
    } catch (e) {
      setAllErr(e as ApiError);
    } finally {
      setLoadingAll(false);
    }
  };
  const certs = all || demo;
  return (
    <div className="page">
      <header className="page-head">
        <h1>Certificates</h1>
        <p className="muted">Oracle-signed lot certificates. Each can be used once; flagged and review lots never get one.</p>
      </header>
      <form className="filters" onSubmit={go}>
        <label className="field grow">
          <span>Certificate (lot id, 0x + 64 hex)</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="0x…" />
        </label>
        <button type="submit" className="btn">
          Look up
        </button>
        {bad && <span className="warn-text small">Not a 32-byte hex id.</span>}
      </form>
      {route.id ? (
        <CertificateDetail id={route.id} />
      ) : (
        <>
        <IssuanceRegistry />
        <Section
          title={all ? `All issued certificates (${nf.format(all.length)})` : 'Demo certificates (recorded replay)'}
          aside={
            !all && (
              <button type="button" className="btn btn-small" onClick={loadAll} disabled={loadingAll || !onchain.data}>
                {loadingAll ? 'Loading…' : 'Load all issued certificates (2.8 MB bundle)'}
              </button>
            )
          }
        >
          {allErr && <ErrorState error={allErr} />}
          <Async state={onchain} what="Loading ledger records">
            {() =>
              certs.length ? (
                <DataTable
                  rows={certs}
                  rowKey={(r) => r.lot_id!}
                  onRow={(r) => navigate('certificates', r.lot_id!)}
                  columns={[
                    { key: 'lot', header: 'Certificate (lot id)', render: (r) => <a className="mono" href={href('certificates', r.lot_id)}>{short(r.lot_id, 14)}</a> },
                    { key: 'ref', header: 'Shipment (published demo id)', render: (r) => <span className="mono">{r.ref}</span> },
                    { key: 'v', header: 'Verdict', render: (r) => r.verdict },
                  ]}
                />
              ) : (
                <Empty title="No certificate records in the published ledger replay" />
              )
            }
          </Async>
        </Section>
        </>
      )}
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  issue: 'issued', issue_rejected: 'rejected by ledger', issue_failed: 'signer failed', refused: 'refused before signing',
  consume: 'consumption', consume_refused: 'consumption refused', replay_attempt: 'replay attempt',
};

/** Canonical certificates from the trusted issuer (rastro.certificates.issue), newest first. */
function IssuanceRegistry() {
  const st = useApi((s) => api.certificateEvents(s), []);
  return (
    <Section title="Issuance registry (canonical certificates)">

      <Async state={st} what="Loading the issuance registry">
        {(r) =>
          r.data.length ? (
            <DataTable
              rows={r.data}
              rowKey={(e: CertificateEvent) => `${e.logged_at}-${e.event}-${e.lot_id || e.shipment_id}`}
              onRow={(e: CertificateEvent) => e.lot_id && navigate('certificates', e.lot_id)}
              columns={[
                { key: 'when', header: 'Logged', render: (e: CertificateEvent) => <span className="small">{e.logged_at}</span> },
                { key: 'ev', header: 'Event', render: (e: CertificateEvent) => <Tag tone={e.event === 'issue' || (e.event === 'consume' && e.receipt_status === 1) ? 'green' : e.event.includes('refused') || e.event === 'refused' ? 'amber' : e.receipt_status === 1 ? 'green' : 'red'}>{EVENT_LABEL[e.event] || e.event}</Tag> },
                { key: 'ship', header: 'Shipment', render: (e: CertificateEvent) => (e.shipment_id ? <IdLink id={e.shipment_id} /> : '—') },
                { key: 'lot', header: 'Certificate', render: (e: CertificateEvent) => (e.lot_id ? <a className="mono" href={href('certificates', e.lot_id)}>{short(e.lot_id, 12)}</a> : '—') },
                { key: 'tx', header: 'Transaction', render: (e: CertificateEvent) => (e.tx_hash ? <span className="mono small">{short(e.tx_hash, 12)} · block {e.block_number}</span> : '—') },
                { key: 'why', header: 'Result', render: (e: CertificateEvent) => <span className="small">{typeof e.error === 'object' && e.error?.name ? `reverted: ${e.error.name}` : e.reason || e.status_after || '—'}</span> },
              ]}
            />
          ) : (
            <Empty title="No certificate has been issued or refused yet">
              <span className="mono small">cd pipeline &amp;&amp; python -m rastro.certificates.issue demo ../data/synthetic/evaluation</span>
            </Empty>
          )
        }
      </Async>
    </Section>
  );
}

const OUTCOME_TONE: Record<string, 'green' | 'amber' | 'red'> = { valid: 'green', consumed: 'amber', unverifiable: 'amber', not_on_ledger: 'amber' };

function CertificateDetail({ id }: { id: string }) {
  const state = useApi((s) => api.certificate(id, s).then(unwrap), [id]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<VerifyResult | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const verify = async () => {
    setBusy(true);
    try {
      setRes(unwrap(await api.verifyCertificate(id)));
      setErr(null);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  return (
    <Async state={state} what="Loading certificate">
      {(c) => (
        <Section title={`Certificate ${short(c.certificate_id, 14)}`} aside={<Tag tone={c.chain.verified_public ? 'green' : 'amber'}>{c.chain.label}</Tag>}>
          <KV
            rows={[
              ['Certificate id', <span className="mono">{c.certificate_id}</span>],
              ['Shipment reference', c.shipment_ref ? <span className="mono">{c.shipment_ref}</span> : '—'],
              ['Verdict', c.verdict || '—'],
              ['Status', `${c.status} (${c.status_source})`],
              ['Evidence hash', <span className="mono">{c.evidence_hash || '—'}</span>],
              ['Chain', `${c.chain.mode} · ${c.chain.network || '—'} · ${c.chain.address ? short(c.chain.address, 10) : '—'}`],
            ]}
          />
          <div className="actions">
            <button type="button" className="btn" onClick={() => setConfirm(true)}>
              Verify evidence and status
            </button>
            {c.records.some((r) => r.kind === 'issue' && r.status === 'success') && (
              <>
                <a className="btn btn-ghost" href={api.certificateReportUrl(c.certificate_id, 'html')} target="_blank" rel="noreferrer">
                  Open certificate report
                </a>
                <a className="btn btn-ghost" href={api.certificateReportUrl(c.certificate_id, 'json')} download>
                  Download evidence bundle (JSON)
                </a>
              </>
            )}
          </div>
          {err && <ErrorState error={err} />}
          {res && res.outcome && (
            <div className="note">
              <p>
                <Tag tone={OUTCOME_TONE[res.outcome] || 'red'}>outcome: {res.outcome}</Tag> {res.reason}
              </p>
              {res.checks && res.checks.length > 0 && (
                <DataTable
                  rows={res.checks}
                  rowKey={(c) => c.check}
                  columns={[
                    { key: 'c', header: 'Check', render: (c) => <span className="mono small">{c.check}</span> },
                    { key: 'r', header: 'Result', render: (c) => <Tag tone={c.ok === true ? 'green' : c.ok === false ? 'red' : 'amber'}>{c.ok === true ? 'pass' : c.ok === false ? 'FAIL' : 'not checkable'}</Tag> },
                    { key: 'd', header: 'Detail', render: (c) => <span className="small">{c.detail}</span> },
                  ]}
                />
              )}
              <div className="small muted">Verified {res.verified_at} · signer {res.signer || '—'}</div>
            </div>
          )}
          {res && !res.outcome && (
            <div className={`note ${res.usable ? '' : 'warn'}`}>
              Status {res.status} · usable {res.usable ? 'yes' : 'no'} · evidence file {res.evidence_file_present ? 'present' : 'missing'} · evidence hash{' '}
              {res.evidence_hash_matches === null ? 'not checkable' : res.evidence_hash_matches ? 'matches' : 'MISMATCH'} · on-chain hash{' '}
              {res.onchain_hash_matches === null ? 'not checkable' : res.onchain_hash_matches ? 'matches' : 'MISMATCH'}
              {res.notes.map((n, i) => (
                <div key={i} className="small">
                  {n}
                </div>
              ))}
            </div>
          )}
          {confirm && (
            <ConfirmDialog title="Verify certificate" confirmLabel="Verify" busy={busy} onCancel={() => setConfirm(false)} onConfirm={verify}
              body={<p>Re-hashes the stored evidence, recovers the EIP-712 signer, checks it is an authorised oracle and reads the ledger state. Read-only: nothing is written to the ledger.</p>} />
          )}
        </Section>
      )}
    </Async>
  );
}

// ---- HerdLedger -------------------------------------------------------------------------------------
export function Ledger() {
  const st = useApi((s) => api.chainStatus(s).then(unwrap), []);
  const [ranch, setRanch] = useState('');
  const [bal, setBal] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const read = async (e: FormEvent) => {
    e.preventDefault();
    const id = ranch.trim().toUpperCase();
    if (!ID_PATTERNS.ranch.test(id)) return setErr(new ApiError(-1, 'invalid_id', 'Enter a ranch id such as R0120.'));
    try {
      setBal(unwrap(await api.ranchBalance(id)));
      setErr(null);
    } catch (x) {
      setBal(null);
      setErr(x as ApiError);
    }
  };
  return (
    <div className="page">
      <header className="page-head">
        <h1>HerdLedger</h1>
        <p className="muted">Shared ledger state. The console only reads; it never holds a key or signs a transaction.</p>
      </header>
      <Async state={st} what="Reading chain status">
        {(s) => (
          <div className="grid-2 align-start">
            <Section title="Connection" aside={<Tag tone={s.chain.verified_public ? 'green' : 'amber'}>{s.chain.verified_public ? 'public testnet' : 'not a public network'}</Tag>}>
              <KV
                rows={[
                  ['Label', s.chain.label],
                  ['Mode', s.chain.mode === 'rpc' ? 'live eth_call' : 'recorded replay (onchain.json)'],
                  ['Network / chain id', `${s.chain.network || '—'} / ${s.chain.chain_id ?? '—'}`],
                  ['Contract', <span className="mono">{s.chain.address || '—'}</span>],
                  ['Available', s.chain.available ? 'yes' : 'no'],
                  ['Detail', s.chain.detail || '—'],
                  ['Oracle role check', s.oracle_check ? (s.oracle_check.is_oracle === null ? 'unknown' : s.oracle_check.is_oracle ? 'oracle holds ORACLE_ROLE' : 'oracle NOT authorised') : '—'],
                  ['Herd conserved (replay)', s.conserved === null ? '—' : s.conserved ? 'yes' : 'NO'],
                ]}
              />
            </Section>
            <Section title="Totals">
              {s.totals ? <KV rows={Object.entries(s.totals).map(([k, v]) => [label(k), nf.format(v)])} /> : <Empty title="No totals recorded" />}
              <h4>Roles</h4>
              {s.roles ? <KV rows={Object.entries(s.roles).map(([k, v]) => [k, <span className="mono">{v}</span>])} /> : <Empty title="No roles recorded" />}
            </Section>
            <Section title="Read a ranch balance">
              <form className="filters" onSubmit={read}>
                <label className="field">
                  <span>Ranch</span>
                  <input value={ranch} onChange={(e) => setRanch(e.target.value)} placeholder="R0120" />
                </label>
                <button type="submit" className="btn">
                  Read balanceOf
                </button>
              </form>
              {err && <ErrorState error={err} />}
              {bal && <KV rows={Object.entries(bal).filter(([k]) => k !== 'chain').map(([k, v]) => [label(k), typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')])} />}
            </Section>
          </div>
        )}
      </Async>
    </div>
  );
}

// ---- Evaluation ----------------------------------------------------------------------------------------
export function Evaluation() {
  const st = useApi((s) => api.evaluation(s).then(unwrap), []);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Evaluation</h1>
        <p className="muted">How often Rastro catches laundered cattle, and how often it wrongly blocks clean lots, measured on synthetic worlds with known ground truth.</p>
      </header>
      <Async state={st} what="Loading evaluation">
        {(e) =>
          e.status !== 'available' ? (
            <Empty title="No evaluation report for this dataset">{e.note}</Empty>
          ) : (
            <div className="stack">
              {e.redteam && <RedTeam s={e.redteam} />}
              {e.report && <Report r={e.report} />}
            </div>
          )
        }
      </Async>
    </div>
  );
}

const SCENARIO_NAMES: Record<string, string> = {
  'S00-clean': 'Honest world',
  'S01-reference': 'Reference laundering',
  'S02-hold-60': 'Launderers hold ~60 days',
  'S03-hold-120': 'Launderers hold ~120 days',
  'S04-two-hop': 'Two laundering hops',
  'S05-redteam': 'Red team: 60-120 days, two hops',
  'S06-incomplete': '10% of permits missing',
  'S07-split-lots': 'Split lots',
  'S08-mixed-cover': 'Mixed with clean cover',
  'S09-concealed': 'Concealed inventory',
  'S10-rapid-legit': 'Legitimate rapid trading',
};

function RedTeam({ s }: { s: RedTeamSummary }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const p = (x: number | null) => (x === null ? '—' : pct(x));
  const rows = s.headline.filter((h) => h.role === 'heldout');
  const toggle = (
    <div className="seg seg-tight" role="group" aria-label="View">
      {(['chart', 'table'] as const).map((v) => (
        <button key={v} type="button" className={view === v ? 'on' : ''} aria-pressed={view === v} onClick={() => setView(v)}>
          {v === 'chart' ? 'Chart' : 'Table'}
        </button>
      ))}
    </div>
  );
  return (
    <Section title="Rastro vs today's direct-supplier check" aside={toggle}>
      <p className="small muted section-sub">
        {rows.length} held-out synthetic worlds (seed {s.held_out_seed}, never used for tuning). Method and limits: docs/evaluation.md.
      </p>
      {view === 'chart' ? (
        <div className="grid-2 eval-charts">
          <div>
            <div className="chart-title">
              Tainted cattle caught <span className="muted">higher is better</span>
            </div>
            <div className="legend-inline small">
              <span><i style={{ background: 'var(--series)' }} /> Rastro flagged</span>
              <span><i style={{ background: 'var(--series)', opacity: 0.4 }} /> + sent to review</span>
              <span><i style={{ background: 'var(--grey)' }} /> Today's check</span>
            </div>
            {rows.map((h) => (
              <PairBars key={h.scenario} scenario={h.scenario} a={h.rastro_cattle_caught_flagged_pct} aExtra={h.rastro_cattle_caught_flag_or_review_pct} b={h.baseline_cattle_caught_pct} />
            ))}
          </div>
          <div>
            <div className="chart-title">
              Clean lots blocked <span className="muted">lower is better</span>
            </div>
            <div className="legend-inline small">
              <span><i style={{ background: 'var(--series)' }} /> Rastro</span>
              <span><i style={{ background: 'var(--grey)' }} /> Today's check</span>
            </div>
            {rows.map((h) => (
              <PairBars key={h.scenario} scenario={h.scenario} a={h.rastro_clean_lots_flagged_pct} b={h.baseline_clean_lots_flagged_pct} warn={(h.rastro_clean_lots_flagged_pct ?? 0) > (h.baseline_clean_lots_flagged_pct ?? 100)} />
            ))}
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Tainted cattle caught</th>
                <th>…incl. review</th>
                <th>Today's check</th>
                <th>Clean lots blocked</th>
                <th>Today's check</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.scenario}>
                  <th scope="row">
                    {SCENARIO_NAMES[h.scenario] || h.scenario} <span className="mono small muted">{h.scenario}</span>
                  </th>
                  <td>{p(h.rastro_cattle_caught_flagged_pct)}</td>
                  <td>{p(h.rastro_cattle_caught_flag_or_review_pct)}</td>
                  <td>{p(h.baseline_cattle_caught_pct)}</td>
                  <td>{p(h.rastro_clean_lots_flagged_pct)}</td>
                  <td>{p(h.baseline_clean_lots_flagged_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/** One scenario: Rastro (optionally extended by the review share) above today's check, both on a 0-100% scale. */
function PairBars({ scenario, a, aExtra, b, warn }: { scenario: string; a: number | null; aExtra?: number | null; b: number | null; warn?: boolean }) {
  const w = (x: number | null | undefined) => `${Math.max(0, Math.min(100, x ?? 0))}%`;
  return (
    <div className="pair">
      <div className="pair-label">
        {SCENARIO_NAMES[scenario] || scenario}
        <span className="mono muted">{scenario}</span>
      </div>
      <div className="pair-bars">
        <div className="pair-row">
          <div className="pair-track">
            {aExtra != null && <div className="pair-fill pair-extra" style={{ width: w(aExtra) }} />}
            <div className={`pair-fill pair-a ${warn ? 'pair-warn' : ''}`} style={{ width: w(a) }} />
          </div>
          <span className="pair-val">
            {a === null ? '—' : pct(a)}
            {aExtra != null && <span className="muted"> / {pct(aExtra)}</span>}
          </span>
        </div>
        <div className="pair-row">
          <div className="pair-track">
            <div className="pair-fill pair-b" style={{ width: w(b) }} />
          </div>
          <span className="pair-val muted">{b === null ? '—' : pct(b)}</span>
        </div>
      </div>
    </div>
  );
}

function Report({ r }: { r: EvaluationReport }) {
  const lot = r.lot_level.rastro_multi_hop;
  const base = r.lot_level.baseline_direct_supplier_only;
  if (!lot || !base) return null;
  return (
    <Section title={`This dataset (seed ${r.seed}, ${r.role})`}>
      <div className="compare-grid">
        <Compare
          label="Tainted head caught"
          better="higher"
          rastro={lot.tainted_head_caught_pct_flagged_only}
          extra={`${pct(lot.tainted_head_caught_pct_flag_or_review)} including review`}
          today={base.tainted_head_caught_pct_flagged_only}
        />
        <Compare label="Clean lots blocked" better="lower" rastro={lot.clean_lots_flagged_pct} today={base.clean_lots_flagged_pct} />
      </div>
    </Section>
  );
}

function Compare({ label: l, rastro, today, extra, better }: { label: string; rastro: number | null; today: number | null; extra?: string; better: 'higher' | 'lower' }) {
  const wins = rastro !== null && today !== null && (better === 'higher' ? rastro > today : rastro < today);
  const w = (x: number | null) => `${Math.max(0, Math.min(100, x ?? 0))}%`;
  return (
    <div className="compare">
      <div className="compare-label">
        {l} <span className="muted">{better} is better</span>
      </div>
      <div className="compare-nums">
        <span className={`compare-big ${wins ? 'tone-text-green' : ''}`}>{rastro === null ? '—' : pct(rastro)}</span>
        <span className="muted">vs {today === null ? '—' : pct(today)} today</span>
      </div>
      {extra && <div className="small muted">{extra}</div>}
      <div className="pair-track compare-track">
        <div className="pair-fill pair-a" style={{ width: w(rastro) }} />
      </div>
      <div className="pair-track compare-track">
        <div className="pair-fill pair-b" style={{ width: w(today) }} />
      </div>
    </div>
  );
}

// ---- Data sources --------------------------------------------------------------------------------------
export function Sources() {
  const health = useApi((s) => api.health(s), []);
  const ready = useApi((s) => api.ready(s), []);
  const summary = useSummary();
  const meta = useApi((s) => api.ranches({ limit: 1 }, s).then((r) => r.meta), []);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Data Sources</h1>
        <p className="muted">What is real, what is synthetic, and how fresh it is. Everything here is read from the API.</p>
      </header>
      <div className="grid-2 align-start">
        <Section title="Canonical dataset">
          <Async state={meta}>
            {(m) => (
              <>
                <KV
                  rows={[
                    ['Dataset', m.dataset_id || '—'],
                    ['Version / schema', `${m.dataset_version || '—'} / ${m.schema_version || '—'}`],
                    ['Logical digest', <span className="mono">{short(m.logical_digest, 20)}</span>],
                    ['Generated at', m.generated_at || '—'],
                  ]}
                />
                <h4>Component status</h4>
                <div className="prov-list">
                  {Object.entries(m.data_status).map(([k, v]) => (
                    <ProvenanceLabel key={k} status={v}>
                      {k}
                    </ProvenanceLabel>
                  ))}
                </div>
                {Object.keys(m.freshness || {}).length > 0 && (
                  <>
                    <h4>Freshness</h4>
                    <KV rows={Object.entries(m.freshness).map(([k, v]) => [k, v === null ? 'unavailable' : typeof v === 'number' && v > 1e9 ? new Date(v * 1000).toISOString() : String(v)])} />
                  </>
                )}
              </>
            )}
          </Async>
        </Section>
        <Section title="API health and readiness">
          <Async state={health}>
            {(h) => (
              <KV
                rows={[
                  ['Status', <Tag tone={h.status === 'ok' ? 'green' : 'amber'}>{h.status}</Tag>],
                  ['API / schema', `${h.api_version} / ${h.schema_version} (app ${h.version})`],
                  ...Object.entries(h.datasets).map(([k, v]) => [`published ${k}`, v === null ? 'missing' : v === 'mock' ? 'MOCK bundle' : 'real file'] as [string, string]),
                ]}
              />
            )}
          </Async>
          {ready.data && (
            <>
              <h4>Readiness: {ready.data.ready ? 'ready' : 'not ready'}</h4>
              <KV rows={Object.entries(ready.data.checks).map(([k, v]) => [k, v ? 'ok' : 'missing'])} />
            </>
          )}
          {ready.error && <ErrorState error={ready.error} />}
        </Section>
        <Section title="Sources">
          <ul className="sources">
            <li><ProvenanceLabel status="real" /> INPE PRODES yearly deforestation 2008–2025 and accumulated mask to 2007 (TerraBrasilis, CC BY-SA 4.0)</li>
            <li><ProvenanceLabel status="real" /> FUNAI Indigenous lands and conservation units (TerraBrasilis)</li>
            <li><ProvenanceLabel status="real" /> IBGE PPM municipal herd; Trase slaughterhouse locations (CC BY 4.0); Vila do Conde port</li>
            <li><ProvenanceLabel status="synthetic" /> Ranch boundaries, herds, births, deaths, GTAs, embargoes and shipments (rastro.synth)</li>
            <li><ProvenanceLabel status="derived" /> Geospatial evidence, lineage traces, risk findings and decisions</li>
          </ul>
        </Section>
        <Section title="Dataset contents">
          <Async state={summary}>
            {(s) => {
              const c = (s as { counts?: Record<string, number> }).counts || {};
              return <KV rows={Object.entries(c).map(([k, v]) => [label(k), nf.format(v)])} />;
            }}
          </Async>
        </Section>
      </div>
    </div>
  );
}
