import type { ReactNode } from 'react';
import type { DataStatus, Outcome, RiskClass, Severity } from '../api/types';
import { Tooltip } from './Tooltip';

const OUTCOME_HELP: Record<Outcome, string> = {
  PASS: 'No blocking issue and enough lineage evidence to support the lot.',
  REVIEW: 'Uncertain attribution, incomplete data or a suspicious pattern: needs an investigator. Never treated as a pass.',
  FLAGGED: 'A defined blocking rule fired, e.g. ≥ 25% of the lot traces to origins with a blocking finding.',
};

export function OutcomeBadge({ outcome }: { outcome: Outcome | null | undefined }) {
  if (!outcome) return <Tooltip text="The risk engine has not assessed this lot yet. This is not a pass."><span className="badge b-none">NOT ASSESSED</span></Tooltip>;
  const cls = outcome === 'PASS' ? 'b-pass' : outcome === 'REVIEW' ? 'b-review' : 'b-flagged';
  return (
    <Tooltip text={OUTCOME_HELP[outcome]}>
      <span className={`badge ${cls}`}>{outcome}</span>
    </Tooltip>
  );
}

const RISK_HELP: Record<RiskClass, string> = {
  high: 'At least one high-severity finding.',
  watch: 'Watch-level findings only: leads, not evidence.',
  clean: 'Assessed with evidence available and no finding.',
  insufficient_data: 'Environmental evidence missing: cannot be called clean.',
};

export function RiskBadge({ risk, assessed = true }: { risk: RiskClass | null | undefined; assessed?: boolean }) {
  if (!assessed || !risk) return <Tooltip text="Not assessed by the risk engine. Unknown is not clean."><span className="badge b-none">NOT ASSESSED</span></Tooltip>;
  const cls = { high: 'b-flagged', watch: 'b-review', clean: 'b-pass', insufficient_data: 'b-none' }[risk];
  return (
    <Tooltip text={RISK_HELP[risk]}>
      <span className={`badge ${cls}`}>{risk === 'insufficient_data' ? 'NO EVIDENCE' : risk.toUpperCase()}</span>
    </Tooltip>
  );
}

export function SeverityBadge({ severity, blocking }: { severity: Severity; blocking?: boolean }) {
  const cls = severity === 'high' ? 'b-flagged' : severity === 'watch' ? 'b-review' : 'b-none';
  return (
    <span className={`badge ${cls}`}>
      {severity.toUpperCase()}
      {blocking ? ' · BLOCKING' : ''}
    </span>
  );
}

const STATUS_HELP: Record<DataStatus, string> = {
  real: 'Public source data (e.g. INPE PRODES, FUNAI, Trase).',
  synthetic: 'Simulated for the demonstration. Not a government record and not a real ranch.',
  derived: 'Computed by Rastro from the inputs.',
  unavailable: 'Not present in this dataset.',
};

export function ProvenanceLabel({ status, children }: { status: DataStatus | string | null | undefined; children?: ReactNode }) {
  const s = (status || 'unavailable') as DataStatus;
  const known = s in STATUS_HELP;
  return (
    <Tooltip text={known ? STATUS_HELP[s] : `Status: ${s}`}>
      <span className={`prov prov-${known ? s : 'unavailable'}`}>
        {children ? <>{children}: </> : null}
        {s}
      </span>
    </Tooltip>
  );
}

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' | 'earth' }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}
