import { useState } from 'react';
import { fetchEvidence, type Origin } from '../lib/data';
import { sha256Hex, tamperText, type Tamper } from '../lib/evidence';
import { shortHash } from '../lib/format';

interface Result { computed: string; tampered?: { hash: string; t: Tamper }; url: string; origin: Origin; size: number; text: string }

/**
 * Fetches the evidence bundle, hashes its exact bytes with SHA-256 (WebCrypto) and
 * compares with the anchored hash. "Tamper" edits one number in memory to show that
 * any change breaks the match.
 */
export function EvidenceVerify({ hash, anchored, anchoredLabel }: { hash?: string | null; anchored?: string | null; anchoredLabel?: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'missing'>('idle');
  const [res, setRes] = useState<Result | null>(null);
  const [tamper, setTamper] = useState(false);
  const target = (anchored || hash || '').toLowerCase();
  if (!hash) return <p className="small muted">No evidence bundle published for this record.</p>;

  const run = async (withTamper = tamper) => {
    setState('loading');
    const f = await fetchEvidence(hash);
    if (!f) {
      setState('missing');
      return;
    }
    const computed = await sha256Hex(f.bytes);
    const text = new TextDecoder().decode(f.bytes);
    let tampered: Result['tampered'];
    if (withTamper) {
      const t = tamperText(text);
      if (t) tampered = { hash: await sha256Hex(new TextEncoder().encode(t.text)), t };
    }
    setRes({ computed, tampered, url: f.url, origin: f.origin, size: f.bytes.byteLength, text });
    setState('done');
  };
  const onTamper = async (v: boolean) => {
    setTamper(v);
    if (res) {
      if (v) {
        const t = tamperText(res.text);
        setRes({ ...res, tampered: t ? { hash: await sha256Hex(new TextEncoder().encode(t.text)), t } : undefined });
      } else setRes({ ...res, tampered: undefined });
    }
  };
  const shown = res ? (tamper && res.tampered ? res.tampered.hash : res.computed) : null;
  const ok = shown != null && shown.toLowerCase() === target;

  return (
    <div className="verify">
      <div className="verify-row">
        <button className="btn btn-sm btn-primary" onClick={() => run()} disabled={state === 'loading'}>
          {state === 'loading' ? <span className="spinner" aria-hidden /> : <span aria-hidden>⛓</span>} Verify evidence
        </button>
        <label className="switch small">
          <input type="checkbox" checked={tamper} onChange={(e) => onTamper(e.target.checked)} />
          Tamper with one number
        </label>
      </div>
      {state === 'missing' && <p className="small muted" style={{ margin: '8px 0 0' }}>Evidence file not found for {shortHash(hash, 10, 6)}.</p>}
      {state === 'done' && res && (
        <div className="verify-res" aria-live="polite">
          <div className={`match ${ok ? 'ok' : 'bad'}`}>
            {ok ? '✓ Match: the evidence is exactly what was anchored' : '✕ Mismatch: this is not the evidence that was anchored'}
          </div>
          {tamper && res.tampered && (
            <div className="diff">
              edited in memory: "{res.tampered.t.key}": {res.tampered.t.before} → {res.tampered.t.after}
            </div>
          )}
          <div className="h">
            <span>SHA-256</span>
            <span>{shown}</span>
          </div>
          <div className="h">
            <span>{anchoredLabel ?? 'Anchored'}</span>
            <span>{target}</span>
          </div>
          <div className="small muted">
            <a href={res.url} target="_blank" rel="noreferrer">
              Open evidence file
            </a>{' '}
            · {res.size.toLocaleString('en-US')} bytes{res.origin === 'mock' ? ' · mock bundle' : ''} · hashed in your browser
          </div>
        </div>
      )}
    </div>
  );
}
