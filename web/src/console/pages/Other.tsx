import { useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, unwrap } from '../api/client';
import { useAllRanches, useSummary } from '../api/hooks';
import type { CertificateEvent, EvaluationReport, RedTeamSummary, VerifyResult } from '../api/types';
import { useApi } from '../api/useApi';
import { RiskBadge, Tag } from '../components/Badges';
import { IdLink, Kpi, KV, Section } from '../components/Evidence';
import { ConfirmDialog } from '../components/Overlays';
import { Async, Empty, ErrorState } from '../components/States';
import { DataTable } from '../components/Table';
import { ID_PATTERNS } from '../lib/ids';
import { label, nf, num, pct, short } from '../lib/format';
import { href, navigate, type Route } from '../lib/router';
import { ShipTable } from './Overview';
import { Term } from '../../lib/glossary';

// ---- Investigations: the work queue -------------------------------------------------------------
export function Investigations() {
  const flagged = useApi((s) => api.shipments({ outcome: 'FLAGGED', limit: 15 }, s), []);
  const review = useApi((s) => api.shipments({ outcome: 'REVIEW', limit: 15 }, s), []);
  const ranches = useAllRanches();
  return (
    <div className="page">
      <header className="page-head">
        <h1>Investigations</h1>
        <p className="muted">Shipments Rastro flagged or wants a person to check. Open one to see where its cattle came from and why.</p>
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
                { key: 'defo', header: 'Forest cleared after 2020', align: 'right', render: (r) => (r.post_cutoff_deforestation_ha === null ? '—' : `${num(r.post_cutoff_deforestation_ha, 1)} ha`) },
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
    .map(([k, v]) => ({ lot_id: v.lot_id!, ref: v.ref || '—', verdict: k === 'consume_clean' ? 'clean' : k === 'consume_flagged' ? 'flagged' : label(k) }));
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
        <p className="muted">Proof that a batch of cattle is clean. Each certificate can be used only once, and risky batches never get one.</p>
      </header>
      <form className="filters" onSubmit={go}>
        <label className="field grow">
          <span>Certificate id</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="0x… (paste a certificate id)" />
        </label>
        <button type="submit" className="btn">
          Look up
        </button>
        {bad && <span className="warn-text small">That is not a certificate id: it starts with 0x followed by 64 characters.</span>}
      </form>
      {route.id ? (
        <CertificateDetail id={route.id} />
      ) : (
        <>
        <IssuanceRegistry />
        <Section
          title={all ? `All issued certificates (${nf.format(all.length)})` : 'Example certificates'}
          aside={
            !all && (
              <button type="button" className="btn btn-small" onClick={loadAll} disabled={loadingAll || !onchain.data}>
                {loadingAll ? 'Loading…' : 'Show all issued'}
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
                    { key: 'lot', header: 'Certificate', render: (r) => <a className="mono" href={href('certificates', r.lot_id)}>{short(r.lot_id, 14)}</a> },
                    { key: 'ref', header: 'Shipment', render: (r) => <span className="mono">{r.ref}</span> },
                    { key: 'v', header: 'Verdict', render: (r) => <Tag tone={/clean/.test(r.verdict) ? 'green' : /flag/.test(r.verdict) ? 'red' : 'neutral'}>{r.verdict}</Tag> },
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
  issue: 'Issued', issue_rejected: 'Refused by ledger', issue_failed: 'Signing failed', refused: 'Not issued',
  consume: 'Used', consume_refused: 'Use refused', replay_attempt: 'Reuse attempt',
};
/** ok = certificate issued, used = spent once, held = not issued (needs review or flagged), blocked = refused by the ledger. */
type EventKind = 'ok' | 'used' | 'held' | 'blocked';
const EVENT_KIND: Record<string, EventKind> = {
  issue: 'ok', consume: 'used', refused: 'held', issue_rejected: 'blocked', issue_failed: 'blocked', consume_refused: 'blocked', replay_attempt: 'blocked',
};
const EVENT_ICON: Record<EventKind, string> = { ok: 'M3.5 8.5l3 3 6-7', used: 'M3 8h7M7.5 4.5L11 8l-3.5 3.5', held: 'M5.5 4v8M10.5 4v8', blocked: 'M4.5 4.5l7 7M11.5 4.5l-7 7' };
function EventChip({ kind, children }: { kind: EventKind; children: ReactNode }) {
  return (
    <span className={`event-chip event-${kind}`}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
        <path d={EVENT_ICON[kind]} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {children}
    </span>
  );
}
const ERROR_TEXT: Record<string, string> = {
  GtaAlreadyCertified: 'Refused: these permits already have a certificate',
  CertificateAlreadyUsed: 'Refused: this certificate was already used',
};

/** One plain sentence for what happened to a certificate request. */
function eventResult(e: CertificateEvent): string {
  const err = typeof e.error === 'object' && e.error?.name ? e.error.name : null;
  if (err) return ERROR_TEXT[err] || `Refused: ${err.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`;
  const why = e.reason || '';
  if (/decision is REVIEW/.test(why)) return 'Not issued: waiting for a human check';
  if (/commitment mismatch/.test(why)) return 'Refused: this certificate belongs to a different shipment';
  if (/duplicate issuance|already certified/.test(why)) return 'Not issued: this lot already has a certificate';
  if (/decision is FLAGGED/.test(why)) return 'Not issued: shipment was flagged';
  if (e.status_after === 'consumed') return 'Certificate used';
  if (e.status_after === 'valid') return 'Certificate issued';
  return why || e.status_after || '—';
}
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

/** Certificate activity from the trusted issuer, newest first. Rows open the certificate. */
function IssuanceRegistry() {
  const st = useApi((s) => api.certificateEvents(s), []);
  return (
    <Section title="Certificate activity">
      <Async state={st} what="Loading certificate activity">
        {(r) =>
          r.data.length ? (
            <DataTable
              rows={r.data}
              rowKey={(e: CertificateEvent) => `${e.logged_at}-${e.event}-${e.lot_id || e.shipment_id}`}
              onRow={(e: CertificateEvent) => e.lot_id && navigate('certificates', e.lot_id)}
              columns={[
                { key: 'when', header: 'When', render: (e: CertificateEvent) => when(e.logged_at) },
                {
                  key: 'ev',
                  header: 'What happened',
                  render: (e: CertificateEvent) => {
                    const failed = e.event === 'consume' && e.receipt_status !== 1;
                    const ev = failed ? 'consume_refused' : e.event;
                    return <EventChip kind={EVENT_KIND[ev] || 'blocked'}>{EVENT_LABEL[ev] || label(ev)}</EventChip>;
                  },
                },
                { key: 'ship', header: 'Shipment', render: (e: CertificateEvent) => (e.shipment_id ? <IdLink id={e.shipment_id} /> : '—') },
                { key: 'why', header: 'Result', wrap: true, render: (e: CertificateEvent) => eventResult(e) },
              ]}
            />
          ) : (
            <Empty title="No certificate has been issued or refused yet">
              <span className="small">Certificates appear here once the demo has issued them.</span>
            </Empty>
          )
        }
      </Async>
    </Section>
  );
}

const OUTCOME_TONE: Record<string, 'green' | 'amber' | 'red'> = { valid: 'green', consumed: 'amber', unverifiable: 'amber', not_on_ledger: 'amber' };
const CERT_STATUS: Record<string, string> = { valid: 'Valid', consumed: 'Already used', revoked: 'Cancelled', not_on_ledger: 'Not on the ledger', unknown: 'Unknown' };

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
        <Section
          title={`Certificate ${short(c.certificate_id, 14)}`}
          aside={<Tag tone={c.status === 'valid' ? 'green' : c.status === 'consumed' ? 'amber' : 'red'}>{CERT_STATUS[c.status] || label(c.status)}</Tag>}
        >
          <KV
            rows={[
              ['Shipment', c.shipment_ref ? <IdLink id={c.shipment_ref} /> : '—'],
              ['Verdict', c.verdict ? <Tag tone={c.verdict === 'clean' ? 'green' : 'red'}>{c.verdict}</Tag> : '—'],
              ['Recorded on', c.chain.verified_public ? `Public test network (${c.chain.network})` : c.chain.mode === 'rpc' ? 'Private test blockchain on this computer' : 'Recorded copy of the blockchain'],
            ]}
          />
          <div className="cert-actions">
            <button type="button" className="btn btn-primary" onClick={() => setConfirm(true)}>
              Verify this certificate
            </button>
            {c.records.some((r) => r.kind === 'issue' && r.status === 'success') && (
              <>
                <a className="btn" href={api.certificateReportUrl(c.certificate_id, 'html')} target="_blank" rel="noreferrer">
                  View report
                </a>
                <a className="btn" href={api.certificateReportUrl(c.certificate_id, 'json')} download>
                  Download evidence
                </a>
              </>
            )}
          </div>
          {err && <ErrorState error={err} />}
          {res && res.outcome && (
            <div className="note">
              <p>
                <Tag tone={OUTCOME_TONE[res.outcome] || 'red'}>{CERT_STATUS[res.outcome] || label(res.outcome)}</Tag> {res.reason}
              </p>
              {res.checks && res.checks.length > 0 && (
                <DataTable
                  rows={res.checks}
                  rowKey={(c) => c.check}
                  columns={[
                    { key: 'c', header: 'Check', render: (c) => label(c.check) },
                    { key: 'r', header: 'Result', render: (c) => <Tag tone={c.ok === true ? 'green' : c.ok === false ? 'red' : 'amber'}>{c.ok === true ? 'pass' : c.ok === false ? 'FAIL' : 'not checkable'}</Tag> },
                    { key: 'd', header: 'Detail', wrap: true, render: (c) => <span className="small">{c.detail}</span> },
                  ]}
                />
              )}
              <div className="small muted">Checked {when(res.verified_at ?? '')}</div>
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
              body={<p>Checks the certificate's evidence has not been altered, that it was signed by Rastro's approved checker, and what the blockchain says about it. Read-only: nothing is changed.</p>} />
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
  const [bal, setBal] = useState<{ id: string; balance: unknown; embargoed: unknown } | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const read = async (e: FormEvent) => {
    e.preventDefault();
    const id = ranch.trim().toUpperCase();
    if (!ID_PATTERNS.ranch.test(id)) return setErr(new ApiError(-1, 'invalid_id', 'Enter a ranch id such as R0120.'));
    try {
      const b = unwrap(await api.ranchBalance(id));
      setBal({ id, balance: b.balance, embargoed: b.embargoed });
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
        <p className="muted">What the shared blockchain ledger has recorded. This page only reads it; it can never change anything.</p>
      </header>
      <Async state={st} what="Reading the ledger">
        {(s) => {
          const t = s.totals || {};
          const n = (k: string) => (typeof t[k] === 'number' ? (t[k] as number) : null);
          const network = s.chain.verified_public ? `Public test network (${s.chain.network || s.chain.chain_id})` : s.chain.mode === 'rpc' ? 'Private test blockchain on this computer' : 'Recorded copy of the blockchain';
          return (
            <div className="stack">
              <div className="ledger-status">
                <span className={`dot ${s.chain.available ? 'ok' : 'warn'}`} aria-hidden />
                <strong>{s.chain.available ? 'Connected' : 'Not connected'}</strong>
                <span className="muted">{network}</span>
                {s.chain.address && <span className="mono muted">{short(s.chain.address, 14)}</span>}
                {s.oracle_check?.is_oracle && <span className="muted">· Rastro&apos;s checker approved ✓</span>}
              </div>

              <div className="kpis kpis-4">
                <Kpi label="Permits recorded" value={n('movements') === null ? '—' : nf.format(n('movements')!)} />
                <Kpi label="Ranches" value={n('ranches') === null ? '—' : nf.format(n('ranches')!)} />
                <Kpi label="Certificates issued" value={n('certificates') === null ? '—' : nf.format(n('certificates')!)} />
                <Kpi label="Certificates used" value={n('consumed') === null ? '—' : nf.format(n('consumed')!)} />
              </div>

              {n('initialHead') !== null && (
                <Section
                  title="Herd balance"
                  aside={s.conserved === null ? undefined : <Tag tone={s.conserved ? 'green' : 'red'}>{s.conserved ? 'adds up ✓' : 'does NOT add up'}</Tag>}
                >
                  <p className="small muted section-sub">Every animal is accounted for: what came in must equal what went out plus what is still on ranches.</p>
                  <div className="balance">
                    <BalanceTerm v={n('initialHead')} l="starting herds" />
                    <span className="op">+</span>
                    <BalanceTerm v={n('births')} l="births" />
                    <span className="op">−</span>
                    <BalanceTerm v={n('deaths')} l="deaths" />
                    <span className="op eq">=</span>
                    <BalanceTerm v={n('headToSinks')} l="delivered" />
                    <span className="op">+</span>
                    <BalanceTerm v={n('ranchHead')} l="still on ranches" />
                  </div>
                </Section>
              )}

              <Section title="Look up a ranch">
                <form className="lookup" onSubmit={read}>
                  <label className="sr-only" htmlFor="ledger-ranch">
                    Ranch id
                  </label>
                  <input id="ledger-ranch" value={ranch} onChange={(e) => setRanch(e.target.value)} placeholder="Ranch id, e.g. R0120" />
                  <button type="submit" className="btn btn-primary">
                    Look up
                  </button>
                </form>
                {err && <ErrorState error={err} />}
                {bal && (
                  <p className="lookup-result">
                    <strong>{bal.id}</strong> has <strong>{typeof bal.balance === 'number' ? nf.format(bal.balance) : String(bal.balance ?? '—')}</strong> cattle on the ledger
                    {bal.embargoed === true ? <> · <Tag tone="red">embargoed</Tag></> : bal.embargoed === false ? ' · not embargoed' : ''}
                  </p>
                )}
              </Section>
            </div>
          );
        }}
      </Async>
    </div>
  );
}

function BalanceTerm({ v, l }: { v: number | null; l: string }) {
  return (
    <span className="balance-term">
      <span className="balance-v">{v === null ? '—' : nf.format(v)}</span>
      <span className="balance-l">{l}</span>
    </span>
  );
}

// ---- Evaluation ----------------------------------------------------------------------------------------
export function Evaluation() {
  const st = useApi((s) => api.evaluation(s).then(unwrap), []);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Evaluation</h1>
        <p className="muted">How often Rastro catches illegal cattle, and how often it wrongly stops honest herds, tested where the right answer is known.</p>
      </header>
      <Async state={st} what="Loading evaluation">
        {(e) =>
          e.status !== 'available' ? (
            <Empty title="No evaluation report for this dataset">{e.note}</Empty>
          ) : (
            <div className="stack">
              {e.report && <Report r={e.report} />}
              {e.redteam && <Scenarios s={e.redteam} />}
            </div>
          )
        }
      </Async>
    </div>
  );
}

const SCENARIO_NAMES: Record<string, string> = {
  'S00-clean': 'Honest world',
  'S01-reference': 'Typical laundering',
  'S02-hold-60': 'Cheaters hold cattle ~60 days',
  'S03-hold-120': 'Cheaters hold cattle ~120 days',
  'S04-two-hop': 'Hidden two ranches back',
  'S05-redteam': 'Hardest cheaters',
  'S06-incomplete': '10% of permits missing',
  'S07-split-lots': 'Herds split into small lots',
  'S08-mixed-cover': 'Mixed with clean cattle',
  'S09-concealed': 'Hidden herd counts',
  'S10-rapid-legit': 'Honest fast trading',
};

type Metric = 'caught' | 'stopped';

function Scenarios({ s }: { s: RedTeamSummary }) {
  const [metric, setMetric] = useState<Metric>('caught');
  const rows = s.headline.filter((h) => h.role === 'heldout');
  const pick = (h: (typeof rows)[number]) =>
    metric === 'caught' ? { a: h.rastro_cattle_caught_flagged_pct, b: h.baseline_cattle_caught_pct } : { a: h.rastro_clean_lots_flagged_pct, b: h.baseline_clean_lots_flagged_pct };
  const switcher = (
    <div className="seg seg-tight" role="group" aria-label="Measure">
      {([
        ['caught', 'Illegal cattle caught'],
        ['stopped', 'Honest herds wrongly stopped'],
      ] as const).map(([k, l]) => (
        <button key={k} type="button" className={metric === k ? 'on' : ''} aria-pressed={metric === k} onClick={() => setMetric(k)}>
          {l}
        </button>
      ))}
    </div>
  );
  return (
    <Section title={`Across ${rows.length} test scenarios`} aside={switcher}>
      <div className="eval-legend small muted">
        <span><i className="sw-a" /> Rastro</span>
        <span><i className="sw-b" /> Today&apos;s check</span>
        <span>{metric === 'caught' ? 'Higher is better.' : 'Lower is better.'} None of these scenarios were used to tune Rastro.</span>
      </div>
      <div className="eval-rows">
        {rows.map((h) => {
          const { a, b } = pick(h);
          const worse = a !== null && b !== null && (metric === 'caught' ? a < b : a > b);
          return <EvalRow key={h.scenario} name={SCENARIO_NAMES[h.scenario] || h.scenario} a={a} b={b} worse={worse} />;
        })}
      </div>
    </Section>
  );
}

function EvalRow({ name, a, b, worse }: { name: string; a: number | null; b: number | null; worse: boolean }) {
  const w = (x: number | null) => `${Math.max(0, Math.min(100, x ?? 0))}%`;
  const r = (x: number | null) => (x === null ? '—' : `${Math.round(x)}%`);
  return (
    <div className="eval-row">
      <span className="eval-name">{name}</span>
      <span className="eval-bars" aria-hidden>
        <span className="eval-track">
          <span className={`eval-fill a ${worse ? 'worse' : ''}`} style={{ width: w(a) }} />
        </span>
        <span className="eval-track">
          <span className="eval-fill b" style={{ width: w(b) }} />
        </span>
      </span>
      <span className="eval-val">
        <strong className={worse ? 'worse-text' : undefined}>{r(a)}</strong> <span className="muted">vs {r(b)} today</span>
      </span>
    </div>
  );
}

function Report({ r }: { r: EvaluationReport }) {
  const lot = r.lot_level.rastro_multi_hop;
  const base = r.lot_level.baseline_direct_supplier_only;
  if (!lot || !base) return null;
  return (
    <div className="headline-grid">
      <Headline label="Illegal cattle caught" better="higher" rastro={lot.tainted_head_caught_pct_flagged_only} today={base.tainted_head_caught_pct_flagged_only}
        extra={`${pct(lot.tainted_head_caught_pct_flag_or_review)} if you include cases sent for a human check`} />
      <Headline label="Honest herds wrongly stopped" better="lower" rastro={lot.clean_lots_flagged_pct} today={base.clean_lots_flagged_pct} />
    </div>
  );
}

function Headline({ label: l, rastro, today, extra, better }: { label: string; rastro: number | null; today: number | null; extra?: string; better: 'higher' | 'lower' }) {
  const wins = rastro !== null && today !== null && (better === 'higher' ? rastro > today : rastro < today);
  return (
    <div className="headline">
      <div className="headline-label">{l}</div>
      <div className="headline-nums">
        <span className={`headline-big ${wins ? 'win' : ''}`}>{rastro === null ? '—' : pct(rastro)}</span>
        <span className="muted">with Rastro</span>
      </div>
      <div className="headline-today">
        {today === null ? '—' : pct(today)} with today&apos;s check · {better} is better
      </div>
      {extra && <div className="small muted">{extra}</div>}
    </div>
  );
}

// ---- Data sources --------------------------------------------------------------------------------------
export function Sources() {
  const health = useApi((s) => api.health(s), []);
  const ready = useApi((s) => api.ready(s), []);
  const summary = useSummary();
  const meta = useApi((s) => api.ranches({ limit: 1 }, s).then((r) => r.meta), []);
  const allReady = !!ready.data?.ready && health.data?.status === 'ok';
  return (
    <div className="page">
      <header className="page-head">
        <h1>Data Sources</h1>
        <p className="muted">What is real, what is simulated, and what Rastro works out from them.</p>
      </header>
      <p className="status-line">
        <span className={`dot ${allReady ? 'ok' : 'warn'}`} aria-hidden />
        {ready.loading || health.loading ? 'Checking data…' : allReady ? 'All data loaded' : 'Some data is missing (see technical details)'}
        {meta.data?.generated_at && <span className="muted"> · dataset built {meta.data.generated_at.slice(0, 10)}</span>}
      </p>
      <div className="source-groups">
        <Section title="Real public data">
          <ul className="sources">
            <li>Forest clearing from satellites, 2008–2025 (<Term k="PRODES" />)</li>
            <li>Indigenous lands and protected areas (<Term k="FUNAI" />)</li>
            <li>Cattle counts per municipality (<Term k="IBGE PPM" />)</li>
            <li>Slaughterhouse locations (<Term k="Trase" />) and the Vila do Conde export port</li>
          </ul>
        </Section>
        <Section title="Simulated for this demo">
          <ul className="sources">
            <li>Ranches, their herds, births and deaths</li>
            <li>Cattle-transport permits (<Term k="GTA">GTAs</Term>) and embargoes</li>
            <li>Shipments to slaughterhouses and export ships</li>
          </ul>
          <p className="small muted">No real ranch, person or company is described.</p>
        </Section>
        <Section title="Worked out by Rastro">
          <ul className="sources">
            <li>Which ranches overlap cleared or protected land</li>
            <li>Where each shipment&apos;s cattle came from</li>
            <li>Risk scores and pass / review / flag decisions</li>
          </ul>
        </Section>
      </div>
      <Section title="What is in the dataset">
        <Async state={summary}>
          {(s) => {
            const c = (s as { counts?: Record<string, number> }).counts || {};
            const keys = ['ranches', 'gta_movements', 'shipments', 'birth_declarations', 'prodes_deforestation', 'embargoes'].filter((k) => k in c);
            return (
              <div className="kpis">
                {keys.map((k) => [k, c[k]] as const).map(([k, v]) => (
                  <Kpi key={k} label={label(k)} value={nf.format(v)} />
                ))}
              </div>
            );
          }}
        </Async>
      </Section>
    </div>
  );
}
