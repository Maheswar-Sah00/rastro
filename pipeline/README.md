# Rastro pipeline

Real data in, laundering evidence out.

```
fetch_real.py   real layers  -> data/raw/        (PRODES, Indigenous lands, conservation units, IBGE herd, Trase facilities)
landscape.py    study window -> data/derived/landscape.gpkg, destinations.json
simulate.py     3 years of herds and GTAs -> data/derived/world.json  (RASTRO_STRESS=1 -> world_stress.json)
                (runs rastro.synth's `evaluation` / `redteam` preset; byte-identical to the original stage)
detect.py       ledger rules + detection + evaluation -> ../web/public/data/*, out/chain_seed.json
run_all.py      all of the above, including the red-team run, then the canonical dataset
rastro/         package: canonical model (schemas/canonical.py), generator (synth/), ledger replay,
                validation; `python -m rastro.synth.generate --preset evaluation|redteam|baseline|tiny`
tests/          generator determinism, conservation, ids, dates, foreign keys, bundle integrity
```

The canonical dataset (`data/synthetic/<preset>/`, with `manifest.json`) separates detector inputs from
ground truth; see [docs/data-dictionary.md](../docs/data-dictionary.md).

```bash
pip install -r requirements.txt
python run_all.py            # ~2 minutes; downloads are cached
python run_all.py --no-fetch
```

## What is real and what is simulated

| Real (public) | Simulated (calibrated to the real data) |
|---|---|
| INPE PRODES deforestation 2008–2025 and clearing up to 2007, inside a 0.7° × 0.7° window around São Félix do Xingu (PA) | 409 ranch boundaries (Voronoi cells over the window, denser near town). Each ranch's pasture, post-2020 clearing and protected-area overlap are measured on the real layers |
| Kayapó Indigenous land and Triunfo do Xingu APA boundaries | Herds (≈1 head/ha), births, deaths, 10,844 GTAs over 2023–2025 |
| IBGE herd: São Félix do Xingu 2,730,818 head (2025); the window holds ≈12.8% of it | Embargoes (13), external suppliers (5), laundering behaviour |
| Six real slaughterhouse locations (Trase, CC BY 4.0) and the Vila do Conde live-export port | Which slaughterhouse buys what (names anonymised: no implication about any real company) |

Ground truth: a ranch is a **dirty source** if the real PRODES layer shows ≥ 50 ha cleared after 2020 inside it, or it overlaps an Indigenous land. The simulator also plants 7 **launderers** (quick-resale intermediaries that buy from dirty sources), 3 **phantom-births** launderers (they receive cattle without GTAs from embargoed ranches and declare them as births), and 4 **over-capacity** fattening fronts.

## Detection (detect.py)

1. **Ledger mirror.** A Python copy of `HerdLedger.sol` replays every declared event in date order and refuses what the contract would refuse: births above `breeding cows × 0.85` per year, GTAs from embargoed ranches, and GTAs for more head than the ranch holds.
2. **Hard flags from real geodata.** Post-2020 clearing (watch ≥ 6.25 ha, high ≥ 50 ha), Indigenous-land overlap, embargo.
3. **Physics flags.** Impossible births; a quarterly time-weighted herd above 1.25 × pasture capacity (1.5 head/ha).
4. **Lot lineage.** Every GTA becomes a FIFO lot that carries its origin mix, so each slaughter delivery or export voyage is traced to the ranches where its animals were born, across any number of hops.
5. **Behaviour.** Pass-through: a median holding time under 45 days and turnover above 1× capacity. It is only *high* risk when ≥ 35% of supply traces to flagged ranches; honest traders also resell fast. On top of that, an IsolationForest over 8 behavioural features catches unnamed patterns (watch level only).
6. **Verdicts per lot.** Fail if ≥ 25% of the lot traces to flagged origins (for EU-bound lots, origins with any post-2020 clearing also count), or if the direct supplier is high risk. Review at ≥ 5%.

Today's practice (the **status quo** baseline) screens only the direct supplier's polygon and the embargo list.

## Results (synthetic evaluation; see `web/public/data/metrics.json`)

| | Status quo (direct suppliers only) | Rastro |
|---|---|---|
| Tainted cattle caught at slaughter / export | 33.0% | **90.4%** (fail + review) |
| Clean lots wrongly failed | 26.8% | **7.0%** (12.9% sent to review) |
| Laundering ranches found (launderers, phantom births, over-capacity) | 3 / 14 | **14 / 14** |
| **Red team**: launderers hold 60–120 days and chain two hops, tainted cattle caught | 45.2% | **83.0%** (network recall falls to 71%) |

The ledger alone refuses 191 impossible birth declarations (13,234 head), 90 GTAs shipping animals the ranch did not hold (13,542 head), and 15 GTAs from embargoed ranches (883 head).

Caveat: the evaluation runs against the simulator's ground truth. Ranch-level recall on dirty sources is high by construction, because those sources are defined from the same real layers. The meaningful numbers are lot-level catch rate, false alarms, and the red-team run. Real validation needs GTA data, which a federal court has ordered Pará to publish.
