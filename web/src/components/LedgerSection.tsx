import { useMemo, useRef, useState } from 'react';
import { ensure, peek, useData } from '../lib/data';
import { DEMOS, findDemo, hasRpc, isLocalRpc, runDemo, type DemoDef, type DemoResult } from '../lib/chain';
import { explorerAddr, explorerTx, fmt, shortHash } from '../lib/format';
import type { ChainRecord, OnChain } from '../lib/types';
import { useNear } from './MapSection';
import { ChartCard, DataTable, HBars, STATUS } from './charts';
import { SourceTag } from './Tags';

const REFUSAL: Record<string, string> = {
  InsufficientHerd: 'Shipped more than held',
  BirthsExceedBiology: 'Impossible births',
  OriginEmbargoed: 'Embargoed origin',
};

const ROLE: Record<string, string> = { double: 'BUYER (exporter)', flagged: 'BUYER (meatpacker)', embargo: 'ISSUER (animal-health agency)', births: 'REGISTRAR (animal-health agency)' };

export function LedgerSection({ onRanch, onShipment }: { onRanch: (id: string) => void; onShipment: (id: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  const near = useNear(ref, '600px');
  const oc = useData('onchain', near);
  const metrics = useData('metrics');
  const needMoves = near && metrics.status === 'ready' && !metrics.data?.ledger?.refused;
  const moves = useData('movements', needMoves);
  const chain = oc.data;
  const [liveChoice, setLive] = useState<boolean | null>(null);
  const live = liveChoice ?? (hasRpc(chain) && chain?.network !== 'anvil');

  const refused = useMemo(() => {
    const fromMetrics = metrics.data?.ledger?.refused;
    if (fromMetrics && Object.keys(fromMetrics).length) {
      return Object.entries(fromMetrics).map(([k, v]) => ({ k, n: v.gtas_or_events, head: v.head }));
    }
    const m = new Map<string, { n: number; head: number }>();
    for (const mv of moves.data ?? []) {
      if (!mv.rejected) continue;
      const e = m.get(mv.rejected) ?? { n: 0, head: 0 };
      e.n += 1;
      e.head += mv.head;
      m.set(mv.rejected, e);
    }
    return [...m.entries()].map(([k, v]) => ({ k, ...v }));
  }, [metrics.data, moves.data]);
  const gtaRefused = refused.filter((r) => r.k !== 'BirthsExceedBiology');
  const totalGta = gtaRefused.reduce((s, r) => s + r.n, 0);
  const totalHead = gtaRefused.reduce((s, r) => s + r.head, 0);
  const refusedFromMetrics = !!metrics.data?.ledger?.refused;

  return (
    <section id="ledger" className="section" ref={ref} aria-labelledby="ledger-title" style={{ minHeight: oc.status === 'ready' ? undefined : 1500 }}>
      <div className="wrap">
        <div className="section-head center">
          <p className="kicker">06 · HerdLedger</p>
          <h2 className="title" id="ledger-title">
            Try to cheat the ledger
          </h2>
          <p className="deck">Physics can't be argued with. Press a button and watch the contract refuse.</p>
        </div>

        {refused.length > 0 && (
          <div className="ledger-viz">
            <ChartCard
              title="Refused by the ledger alone"
              sub={`${fmt(totalGta)} permits and ${fmt(totalHead)} head stopped before any AI looked`}
              tag={<SourceTag kind={refusedFromMetrics ? (metrics.origin === 'mock' ? 'mock' : 'synthetic') : moves.origin === 'mock' ? 'mock' : 'synthetic'} />}
              table={<DataTable head={['Rule', 'Refused', 'Head']} rows={refused.map((r) => [REFUSAL[r.k] ?? r.k, fmt(r.n), fmt(r.head)])} />}
            >
              <HBars
                rows={[...refused].sort((a, b) => b.head - a.head).map((r) => ({ label: REFUSAL[r.k] ?? r.k, value: r.head, sub: `head · ${fmt(r.n)} ${r.k === 'BirthsExceedBiology' ? 'declarations' : 'permits'}` }))}
                color={STATUS.high}
                fmt={(v) => `${fmt(v)} head`}
              />
            </ChartCard>
          </div>
        )}

        <div className="cheats">
          {DEMOS.map((d) => (
            <CheatCard key={d.key} d={d} oc={chain} rec={findDemo(chain?.records, d)} origin={oc.origin} live={live} onRanch={onRanch} onShipment={onShipment} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
          {hasRpc(chain) && (
            <label className="switch small">
              <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
              Live eth_call against <span className="mono">{chain!.rpc}</span>
              {isLocalRpc(chain) && <span className="muted">(needs the local node with the replayed state running)</span>}
            </label>
          )}
          <p className="small muted" style={{ margin: 0 }}>
            {live ? 'Live eth_call from the role account; falls back to the recorded result.' : 'Replays the recorded eth_call results.'}
          </p>
        </div>

        <div className="card" style={{ marginTop: 28 }}>
          <ChainHeader oc={chain} origin={oc.origin} status={oc.status} />
          {!chain && <div className="empty">{oc.status === 'loading' ? 'Loading ledger…' : 'Not yet deployed.'}</div>}
        </div>
      </div>
    </section>
  );
}

function ChainHeader({ oc, origin, status }: { oc: OnChain | null; origin: string; status: string }) {
  if (!oc)
    return (
      <div className="chain-head">
        <div>
          <span className="k">Network</span>
          <b>{status === 'loading' ? '…' : 'not yet deployed'}</b>
        </div>
      </div>
    );
  const addr = explorerAddr(oc.explorer, oc.address);
  const dep = explorerTx(oc.explorer, oc.deploy_tx);
  return (
    <div className="chain-head" style={{ borderBottom: '1px solid var(--rule)' }}>
      <div>
        <span className="k">Network</span>
        <b>{oc.network}</b> {oc.chainId != null && <span className="muted">· chain {oc.chainId}</span>}
      </div>
      <div>
        <span className="k">HerdLedger contract</span>
        {addr ? (
          <a className="mono" href={addr} target="_blank" rel="noreferrer">
            {shortHash(oc.address, 8, 6)}
          </a>
        ) : (
          <span className="mono">{shortHash(oc.address, 8, 6)}</span>
        )}
      </div>
      <div>
        <span className="k">Deploy tx</span>
        {dep ? (
          <a className="mono" href={dep} target="_blank" rel="noreferrer">
            {shortHash(oc.deploy_tx)}
          </a>
        ) : (
          <span className="mono">{shortHash(oc.deploy_tx)}</span>
        )}
      </div>
      <div>
        <span className="k">Records</span>
        <b>{fmt(oc.records.length)}</b>
      </div>
      <div style={{ marginLeft: 'auto' }}>
        <SourceTag kind={origin === 'mock' ? 'mock' : 'chain'} />
        {!oc.explorer && <span className="small muted"> local chain, no explorer</span>}
      </div>
    </div>
  );
}

const LABEL_KEY: Record<string, string> = { double: 'eu', flagged: 'tr', embargo: 'embargoed_ranch', births: 'phantom_ranch' };

function CheatCard({ d, oc, rec, origin, live, onRanch, onShipment }: { d: DemoDef; oc: OnChain | null; rec: ChainRecord | null; origin: string; live: boolean; onRanch: (id: string) => void; onShipment: (id: string) => void }) {
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [step, setStep] = useState(0);
  const [res, setRes] = useState<DemoResult | null>(null);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const go = async () => {
    setPhase('running');
    setRes(null);
    setStep(1);
    await sleep(380);
    setStep(2);
    await sleep(380);
    setStep(3);
    let gtaTo: string | null = null, gtaHead: number | null = null;
    if (live && d.key === 'embargo' && rec?.ref) {
      await Promise.all([ensure('movements'), ensure('ranches')]);
      const mv = peek('movements')?.find((m) => m.gta === rec.ref);
      const to = mv ? peek('ranches')?.find((x) => x.id === mv.to) : null;
      gtaTo = to?.onchain_id ?? null;
      gtaHead = mv?.head ?? null;
    }
    const [r] = await Promise.all([runDemo(oc, rec, d, { live, gtaTo, gtaHead }), sleep(520)]);
    setRes(r);
    setStep(4);
    setPhase('done');
  };
  const target = (() => {
    const label = oc?.demo?.labels?.[LABEL_KEY[d.key]];
    if (label) return label;
    if (rec?.ref && (rec.ref.startsWith('SHP-') || /^R\d+$/.test(rec.ref))) return rec.ref;
    return rec?.note?.match(/\bR\d{3,5}\b/)?.[0] ?? null;
  })();
  const refLink = target ? (
    <button className="linkish" onClick={() => (target.startsWith('SHP-') ? onShipment(target) : onRanch(target))}>
      {target}
    </button>
  ) : null;

  return (
    <div className="card cheat">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span className="eyebrow">Attempt</span>
        {origin === 'mock' && <SourceTag kind="mock" />}
      </div>
      <h4>{d.title}</h4>
      <div className="fn">{d.fn}</div>
      {phase === 'idle' && <p className="small" style={{ margin: 0, color: 'var(--ink-2)' }}>{d.verb}.{refLink && <> Target: {refLink}.</>}</p>}
      {phase !== 'idle' && (
        <ol className="steps" aria-live="polite">
          {step >= 1 && <StepLi done={step > 1}>build call</StepLi>}
          {step >= 2 && <StepLi done={step > 2}>sign as {ROLE[d.key]}</StepLi>}
          {step >= 3 && <StepLi done={step > 3}>eth_call → HerdLedger</StepLi>}
        </ol>
      )}
      {phase === 'done' && res && (
        <>
          {res.mode === 'missing' ? (
            <div className="notice small">Not recorded in this deployment yet.</div>
          ) : res.reverted ? (
            <div className="revert-box">
              <div className="rv">✕ TRANSACTION REVERTED</div>
              <div className="err">
                {res.name}
                {res.args.length > 0 && <>({res.args.map((a) => (a.startsWith('0x') && a.length > 20 ? shortHash(a, 6, 4) : a)).join(', ')})</>}
              </div>
              <div className="src">
                {res.mode === 'live' ? `Live eth_call on ${oc?.network}` : `Recorded during the contract replay${res.block != null ? `, block ${res.block}` : ''}`}
                {res.detail ? ` · ${res.detail}` : ''}
              </div>
            </div>
          ) : (
            <div className="notice small">The call did not revert{res.detail ? `: ${res.detail}` : '.'}</div>
          )}
          <p className="small" style={{ margin: 0, color: 'var(--ink-2)' }}>{d.explain}</p>
        </>
      )}
      <div className="actions">
        <button className={`btn btn-sm ${phase === 'done' ? '' : 'btn-danger'}`} onClick={go} disabled={phase === 'running' || !rec}>
          {phase === 'running' ? <span className="spinner" aria-hidden /> : null}
          {phase === 'done' ? 'Try again' : 'Try it'}
        </button>
        {!rec && <span className="small muted">{oc ? 'not recorded yet' : 'ledger not yet deployed'}</span>}
        {phase === 'done' && refLink && <span className="small muted">Target: {refLink}</span>}
      </div>
    </div>
  );
}

function StepLi({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li>
      {done ? <span className="ok">✓</span> : <span className="spinner" aria-hidden />} {children}
    </li>
  );
}
