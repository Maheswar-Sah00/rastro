# Rastro evaluation and red-team results

Synthetic evaluation. Every ranch, herd, permit and label is simulated on real environmental layers; nothing here measures real ranches or companies.

Reproduce: `cd pipeline && python -m rastro.evaluation.run `

Versions: pipeline 1.0.0, risk_engine 1.0.0, lineage 1.0.0, geospatial 1.0.0, iforest_model iforest/1.0.0, iforest_features iforest-features/1.0.0, sklearn 1.7.2, python 3.12.0

## Headline (lot level, cattle weighted)

| scenario | role | seed | Rastro caught (flagged) | Rastro caught (flag or review) | baseline caught | Rastro clean flagged | Rastro clean reviewed | baseline clean flagged | laundering found (Rastro / baseline) | review rate | coverage | unknown | time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DEV-reference | development | 7 | 75.01% | 94.1% | 35.58% | 14.42% | 31.59% | 26.02% | 13/14 / 3/14 | 24.11% | 92.3% | 7.7% | 56.4 |
| S00-clean | heldout | 101 | 69.29% | 89.41% | 44.39% | 12.17% | 20.89% | 25.03% | 0/0 / 0/0 | 18.67% | 93.69% | 6.31% | 179.5 |
| S01-reference | heldout | 101 | 68.34% | 91.31% | 16.06% | 14.92% | 26.84% | 23.1% | 14/14 / 1/14 | 22.1% | 92.75% | 7.25% | 207.3 |
| S02-hold-60 | heldout | 101 | 72.16% | 94.12% | 30.87% | 11.86% | 29.57% | 23.22% | 7/14 / 1/14 | 21.39% | 92.62% | 7.38% | 173.5 |
| S03-hold-120 | heldout | 101 | 75.6% | 92.08% | 37.91% | 9.73% | 31.57% | 22.3% | 7/14 / 1/14 | 20.13% | 91.91% | 8.09% | 163.5 |
| S04-two-hop | heldout | 101 | 68.16% | 91.91% | 24.42% | 14.66% | 29.2% | 21.99% | 14/14 / 1/14 | 23.24% | 93.08% | 6.92% | 160.9 |
| S05-redteam | heldout | 101 | 70.58% | 92.46% | 37.9% | 12.3% | 31.49% | 22.84% | 7/14 / 1/14 | 21.48% | 92.95% | 7.05% | 171.1 |
| S06-incomplete | heldout | 101 | 83.58% | 96.26% | 16.06% | 43.64% | 14.24% | 23.1% | 14/14 / 1/14 | 18.67% | 90.33% | 9.67% | 148.2 |
| S07-split-lots | heldout | 101 | 75.45% | 93.0% | 19.59% | 24.08% | 20.02% | 22.42% | 14/14 / 1/14 | 19.92% | 92.6% | 7.4% | 155.0 |
| S08-mixed-cover | heldout | 101 | 69.89% | 92.92% | 26.21% | 14.56% | 27.36% | 22.38% | 14/14 / 1/14 | 22.05% | 93.28% | 6.72% | 205.0 |
| S09-concealed | heldout | 101 | 64.28% | 91.09% | 16.06% | 12.47% | 28.76% | 23.1% | 14/14 / 1/14 | 22.1% | 92.05% | 7.95% | 98.3 |
| S10-rapid-legit | heldout | 101 | 69.99% | 91.17% | 19.27% | 21.79% | 26.1% | 26.18% | 14/14 / 1/14 | 24.76% | 92.71% | 7.29% | 70.8 |

Denominators: cattle-weighted = head born on dirty sources that reached a sink; clean lots = sink-bound permits with < 1 % dirty-source head; laundering = ranches labelled launderer, phantom_births or over_capacity; review rate = share of shipments.

## Baseline

direct-supplier-only: a lot is blocked when the ranch that sold it to the slaughterhouse or port has, on the real layers, post-2020 PRODES clearing >= 6.25 ha, overlap with a recognised Indigenous land or strict-protection unit, or an active embargo. Upstream ranches are not examined. Inputs: geo evidence + embargo list of the direct supplier.

## Comparison with the project brief

```json
{
 "brief_figures": {
  "tainted_caught": [
   33.0,
   90.4
  ],
  "clean_wrongly_blocked": [
   26.8,
   7.0
  ],
  "laundering_found": [
   "3/14",
   "14/14"
  ],
  "redteam": [
   45.2,
   83.0
  ]
 },
 "published_demo_metrics_json": {
  "tainted_caught": [
   33.0,
   90.4
  ],
  "clean_wrongly_blocked": [
   26.8,
   7.0
  ],
  "redteam": [
   45.2,
   83.0
  ]
 },
 "this_run_development_seed7": {
  "tainted_caught": [
   35.58,
   94.1,
   75.01
  ],
  "clean_wrongly_blocked": [
   26.02,
   14.42
  ],
  "laundering_found": [
   "3/14",
   "13/14"
  ]
 },
 "this_run_heldout_reference": {
  "tainted_caught": [
   16.06,
   91.31,
   68.34
  ],
  "clean_wrongly_blocked": [
   23.1,
   14.92
  ],
  "laundering_found": [
   "1/14",
   "14/14"
  ]
 },
 "this_run_heldout_redteam": {
  "tainted_caught": [
   37.9,
   92.46,
   70.58
  ]
 },
 "notes": [
  "tuples are (baseline, rastro flag-or-review, rastro flagged-only) for catch rates and (baseline, rastro) otherwise",
  "the brief's figures come from pipeline/detect.py (the published demo): its 'caught' counts fail + review, its lots are single sink-bound permits, and EU-market lots also count small post-2020 clearing; this engine has no market assignment",
  "the brief's 3/14 baseline count counts ranches the direct-supplier screen flags among those that sell direct; here the same rule is applied"
 ]
}
```

## Leakage controls

- detectors and decisions read only inputs/, environment/, derived/; truth/ is read only by rastro.risk.evaluate and rastro.evaluation.metrics
- a test re-runs the risk engine with truth/ deleted and requires byte-identical decisions
- IsolationForest is unsupervised (no labels) and fitted per world; no supervised model is trained, so no train/validation split applies
- thresholds and the decision rule were fixed on the seed-7 development world; scenarios run on seed 101, which was never used for any choice
- scenario ids appear only in the evaluation metadata, never in detector-visible tables

## Circularity and limits

- dirty sources are defined by the simulator from the same real PRODES/FUNAI layers detector A reads: ranch-level A scores are circular
- the simulator's behaviours (FIFO cohorts, holding times) resemble the detector's assumptions; real herds are messier
- lot-level and cattle-weighted results still depend on the simulator's rules and should be read as a consistency test, not a field accuracy

Scenario details, confusion matrices and error analysis: `summary.json`, `confusion.csv`, `errors.json`, `metrics.csv`.
