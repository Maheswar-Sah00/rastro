import type { ReactNode } from 'react';
import type { Origin } from '../lib/data';
import { RISK_LABEL } from '../lib/colors';
import { BULL_CELLS, BULL_H, BULL_W } from './pixel';

export function SourceTag({ kind, title }: { kind: 'real' | 'synthetic' | 'mock' | 'chain'; title?: string }) {
  const label = kind === 'real' ? 'Real' : kind === 'synthetic' ? 'Synthetic' : kind === 'mock' ? 'Mock' : 'On-chain';
  const tip =
    title ??
    (kind === 'real'
      ? 'Public data (real)'
      : kind === 'synthetic'
        ? 'Simulated data, calibrated to public aggregates'
        : kind === 'mock'
          ? 'Placeholder data for interface preview'
          : 'Recorded by the HerdLedger contract');
  return (
    <span className={`tag tag-${kind}`} title={tip}>
      {label}
    </span>
  );
}

/** Real/Synthetic tag that turns into "Mock" when the file came from the mock bundle. */
export function DataTag({ origin, real }: { origin: Origin; real: boolean }) {
  if (origin === 'mock') return <SourceTag kind="mock" />;
  return <SourceTag kind={real ? 'real' : 'synthetic'} />;
}

export function RiskChip({ cls, children }: { cls: string; children?: ReactNode }) {
  const c = ['clean', 'watch', 'high', 'unknown'].includes(cls) ? cls : 'unknown';
  return (
    <span className={`chip chip-${c}`}>
      <span className="dot" aria-hidden />
      {children ?? RISK_LABEL[c]}
    </span>
  );
}

export function Stamp({ verdict, small }: { verdict: string; small?: string }) {
  const v = verdict === 'pass' ? 'pass' : verdict === 'fail' ? 'fail' : 'review';
  const icon = v === 'pass' ? '✓' : v === 'fail' ? '✕' : '!';
  return (
    <span className={`stamp ${v}`} role="img" aria-label={`Verdict: ${v}`}>
      <span aria-hidden>{icon}</span> {v}
      {small ? <small>{small}</small> : null}
    </span>
  );
}

export function Mark() {
  // Brand mark: a pixel bull's head. One pixel, one head of cattle.
  return (
    <svg className="brand-mark" viewBox={`0 0 ${BULL_W} ${BULL_H}`} aria-hidden>
      {BULL_CELLS.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x + 0.06} y={y + 0.06} width="0.88" height="0.88" fill="currentColor" />
      ))}
    </svg>
  );
}
