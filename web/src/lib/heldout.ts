// Held-out evaluation headline, copied from reports/evaluation/summary.json ("headline" rows,
// role "heldout", seed 101: a synthetic world never used for tuning). The landing page reads
// static data, so these are pinned here; re-copy them if the evaluation is re-run.
//
// metrics.json holds the in-sample numbers (scored on the development world); the landing page
// no longer quotes those.

export interface HeldoutRun {
  scenario: string;
  flaggedPct: number; // tainted head flagged by Rastro
  flagOrReviewPct: number; // tainted head flagged or sent to human review
  baselinePct: number; // tainted head caught by today's direct-supplier check
  cleanBlockedPct: number; // clean lots Rastro flags
  baselineCleanBlockedPct: number; // clean lots today's check fails
}

export const HELDOUT_SEED = 101;

export const HELDOUT: { reference: HeldoutRun; redteam: HeldoutRun } = {
  reference: { scenario: 'S01-reference', flaggedPct: 68.34, flagOrReviewPct: 91.31, baselinePct: 16.06, cleanBlockedPct: 14.92, baselineCleanBlockedPct: 23.1 },
  redteam: { scenario: 'S05-redteam', flaggedPct: 70.58, flagOrReviewPct: 92.46, baselinePct: 37.9, cleanBlockedPct: 12.3, baselineCleanBlockedPct: 22.84 },
};

export const HELDOUT_LABEL = `Held-out synthetic world (seed ${HELDOUT_SEED}, never used for tuning)`;
