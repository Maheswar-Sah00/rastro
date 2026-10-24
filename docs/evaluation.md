# Evaluation and red team: method, results, discrepancies

Synthetic evaluation. Ranches, herds, permits, embargoes and every label are simulated on real environmental layers (INPE PRODES, FUNAI, conservation units). Nothing here measures a real ranch, company or export shipment, and the voyages are synthetic reconstructions.

Reproduce from a clean state (about 35 minutes):

```bash
cd pipeline
python run_all.py --no-fetch          # development world (seed 7) incl. risk + evaluation
python -m rastro.evaluation.run       # 11 held-out scenarios (seed 101) + the development reference
```

Artifacts in [reports/evaluation/](../reports/evaluation/): `summary.json` (everything, incl. versions and seeds), `metrics.csv`, `confusion.csv`, `errors.json`, `README.md` (headline table).

## Method

- **Ground truth** lives only in each world's `truth/` partition (ranch labels, physical lot lineage, true origin mix per permit, missing records, planted anomalies). Detectors read `inputs/`, `environment/`, `derived/` only; a test deletes `truth/` and requires byte-identical decisions.
- **Scenario registry** (`pipeline/rastro/evaluation/scenarios.py`): configuration overrides only, no expected answers.

  | id | stresses |
  |---|---|
  | S00-clean | no laundering (embargoes, real clearing and deaths remain) |
  | S01-reference | laundering, phantom births, embargo attempts, over-capacity fronts |
  | S02 / S03 | launderers hold ~60 / ~120 days |
  | S04-two-hop | two laundering hops, fast resale |
  | S05-redteam | the published stress test: 60–120 days and two hops |
  | S06-incomplete | 10 % of ranch-to-ranch permits missing from the records |
  | S07-split-lots | launderers split resales into 5–25 head permits |
  | S08-mixed-cover | launderers also buy clean calves |
  | S09-concealed | phantom ranches inflate declared cows to 400 and cover the rest with permits in the name of outside suppliers |
  | S10-rapid-legit | 20 honest traders reselling within 1–10 days |

- **Baseline** (direct supplier only): a lot is blocked when its direct supplier has post-2020 clearing ≥ 6.25 ha, a recognised Indigenous-land or strict-protection overlap, or an active embargo. No upstream tracing. This is today's practice and is not weakened: it uses the same real layers and the same 6.25 ha mapping unit as Rastro.
- **Tuning.** Thresholds and the decision rule were fixed on the seed-7 development world (the rule was revised twice there; see `reports/evaluation.json` of that world). All scenarios use seed 101, generated after the rule was frozen. IsolationForest is unsupervised and fitted per world without labels, so there is no supervised train/test split to leak.
- **Denominators.** Cattle weighted: head born on dirty sources that reached a sink. Clean lots: sink-bound permits with < 1 % dirty-source head. Shipment level: deliveries + monthly voyages. Ranch level: the 409 ranches. Laundering ranches: labels launderer, phantom_births, over_capacity (14).

## Results (held-out, seed 101)

| scenario | Rastro caught, flagged | Rastro caught, flagged or review | baseline caught | Rastro clean lots flagged | baseline clean lots flagged | laundering ranches high (Rastro / baseline) |
|---|---|---|---|---|---|---|
| S01 reference | 68.3 % | 91.3 % | 16.1 % | 14.9 % | 23.1 % | 14/14 / 1/14 |
| S05 red team | 70.6 % | 92.5 % | 37.9 % | 12.3 % | 22.8 % | 7/14 / 1/14 |
| S02 hold 60 | 72.2 % | 94.1 % | 30.9 % | 11.9 % | 23.2 % | 7/14 / 1/14 |
| S03 hold 120 | 75.6 % | 92.1 % | 37.9 % | 9.7 % | 22.3 % | 7/14 / 1/14 |
| S04 two hop | 68.2 % | 91.9 % | 24.4 % | 14.7 % | 22.0 % | 14/14 / 1/14 |
| S06 incomplete | 83.6 % | 96.3 % | 16.1 % | **43.6 %** | 23.1 % | 14/14 / 1/14 |
| S07 split lots | 75.5 % | 93.0 % | 19.6 % | 24.1 % | 22.4 % | 14/14 / 1/14 |
| S08 mixed cover | 69.9 % | 92.9 % | 26.2 % | 14.6 % | 22.4 % | 14/14 / 1/14 |
| S09 concealed | 64.3 % | 91.1 % | 16.1 % | 12.5 % | 23.1 % | 14/14 / 1/14 |
| S10 rapid legit | 70.0 % | 91.2 % | 19.3 % | 21.8 % | 26.2 % | 14/14 / 1/14 |
| S00 clean world | 69.3 % | 89.4 % | 44.4 % | 12.2 % | 25.0 % | n/a |

Shipment review rate is 19–25 %; head-weighted lineage coverage 90–94 %; unknown origin 6–10 % (suppliers outside the window).

## What the results show, including failures

- **Multi-hop beats the direct-supplier check on catch rate in every scenario** (flagged alone: 64–84 % vs 16–44 %) while blocking fewer clean lots in 9 of 11 scenarios.
- **Incomplete records (S06) are the clear failure.** Missing permits leave buyers with declared inventory below what they ship; the ledger refuses those permits and the engine treats a refused permit as blocking. 465 of 588 wrongly flagged lots come from a direct supplier with an `INSUFFICIENT_HERD` finding. The engine cannot tell a missing record from laundering. A data-gap policy (refusals caused by missing upstream records → REVIEW rather than FLAGGED) is the obvious next change; it has not been made because it would be tuned on this result.
- **Split lots (S07) and rapid honest traders (S10)** raise clean-lot blocking to 22–24 %, mostly through lineage mixing; still at or below the baseline.
- **Slow launderers (S02, S03, S05) evade the pass-through detector** (laundering ranches found as high falls to 7/14) but their tainted cattle are still caught through lineage, because the risk sits with the origin, not with the intermediary.
- **Every false negative is a lineage-attribution miss**: the tainted origin did carry a blocking finding, but FIFO attributed less than 25 % of the lot to it. These lots are where FIFO and the physical mix diverge most.
- **The lot-level clean-flag rate (12–15 %) is higher than the shipment-level rate (7 %)** because one blocked voyage blocks every permit on it.

## Discrepancies with the project brief

| brief figure | source of the brief | this evaluation | why it differs |
|---|---|---|---|
| tainted caught 33.0 % → 90.4 % | `pipeline/detect.py` on the development world, counting fail + review | dev world: 35.6 % → 94.1 % (flag or review), 75.0 % flagged; held-out: 16.1 % → 91.3 % / 68.3 % | different engine (canonical lineage, decision rule revised); brief's figure is on the development world only; held-out baseline is much lower because the seed-101 world puts less dirty supply on direct sellers |
| clean lots wrongly blocked 26.8 % → 7.0 % | detect.py lots | dev 26.0 % → 14.4 %, held-out 23.1 % → 14.9 % (lot level); shipment level 7.1 % | the brief's 7 % is a shipment-level figure; per permit it is 14–15 % because blocked voyages carry clean permits |
| laundering ranches 3/14 → 14/14 | detect.py, development world | dev 3/14 → 13/14; held-out 1/14 → 14/14; slow-hold scenarios 7/14 | one development ranch is found only at watch level; slower launderers escape the pass-through rule |
| red team 45.2 % → 83.0 % | detect.py stress run on the development world | held-out S05: 37.9 % → 92.5 % (flag or review), 70.6 % flagged | brief counts fail + review; the comparable figure here is 92.5 % |
| every one of 36 voyages passed today's check; Rastro flags all 36 | detect.py voyages are built only from lots that passed today's check | canonical voyages carry every port lot of the month: baseline blocks 33–36 of 36; Rastro flags 14–20, reviews 13–21, passes 0–8 | "all 36 pass today's check" holds by construction in the published demo, not in this evaluation. "All 36 flagged" is **not** established here (S01: 18 flagged, 17 review, 1 pass) |
| voyages to Türkiye | brief | the canonical dataset does not model destination countries; the published demo assigns them synthetically (2 of 36 TR) | no claim about Türkiye-bound shipments is made |

## Circularity and limits

- Dirty sources are defined from the same real layers detector A reads, so ranch-level environmental scores are circular by construction.
- The simulator's mechanics (FIFO cohorts, holding times) resemble the detector's assumptions; real herds are messier, so these are consistency tests rather than field accuracy.
- All results depend on synthetic GTAs. Real validation needs the GTA data a federal court ordered Pará to publish.
