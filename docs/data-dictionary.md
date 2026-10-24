# Rastro data dictionary

Two versioned contracts:

| Contract | Version | Definition | Where |
|---|---|---|---|
| **Canonical dataset**: the model the pipeline stages share | `1.0.0` | `pipeline/rastro/schemas/canonical.py` | `data/synthetic/<preset>/` |
| **Published bundle**: what the web app and API read | `v1` | `backend/app/schemas/v1.py`, SPEC §6 | `web/public/data/` |

Everything about ranches, herds, births, deaths, GTAs, embargoes and shipments is **synthetic**. None of it is a government record or describes a real ranch or company. Real data: PRODES deforestation, Indigenous-land and conservation-unit boundaries, IBGE municipal herd, slaughterhouse and port locations.

## Conventions

- **Identifiers** are stable strings, never row numbers:

  | Entity | Pattern | Example |
  |---|---|---|
  | ranch (study window) | `R\d{4}` | `R0120` |
  | external supplier (outside the window, status unknown) | `X\d{2}` | `X03` |
  | slaughterhouse / port | `S:<SIF\|SIE>_<id>` / `P:<NAME>` | `S:SIF_02`, `P:BARCARENA` |
  | GTA | `GTA-PA-<year>-<seq6>`; refused attempt `GTA-PA-ATTEMPT-<seq4>` | `GTA-PA-2024-004211` |
  | declared lot (the consignment on one GTA) | `LOT-<gta_id>` | `LOT-GTA-PA-2024-004211` |
  | physical parcel (truth) | `LOT-<gta_id>-<k>`, `LOT-<I\|B\|C\|S\|E>-<ranch>-<seq4>` (initial, birth, cull, smuggled, external) | `LOT-B-R0007-0003` |
  | birth / death declaration | `B-<ranch>-<seq5>` / `D-<ranch>-<seq5>` | `B-R0120-00031` |
  | embargo | `EMB-<seq4>` | `EMB-0004` |
  | shipment (canonical) | `SHP-D-<seq6>` delivery, `SHP-V-<yyyymm>` voyage | `SHP-V-202308` |
  | shipment (published bundle, detect.py) | `SHP-<seq4>` | `SHP-0008` |
  | environmental record | `<dataset>:<source record id>` | `prodes_deforestation:24` |
  | on-chain id | `0x` + SHA-256(`rastro-demo-salt-v1\|` + id) | |
- **Dates** are ISO `YYYY-MM-DD`; timestamps ISO 8601 UTC. Generated timestamps are fixed by configuration (`generated_at`), never wall-clock, so identical seeds give identical bytes.
- **Coordinates** are WGS84 `[lon, lat]`. Areas and distances are computed in SIRGAS 2000 / UTM 22S (EPSG:31982).
- **Missing is `null`, never 0.** An external supplier has `total_area_hectares: null`; a GTA has `source_lot_ids: null` because real GTAs carry no lot ids; an accumulated PRODES polygon has `relevant_date: null`.
- **Files** are JSON Lines, UTF-8, `\n` line endings, keys sorted, one row per line, rows sorted by primary key.

## Partitions (canonical dataset)

| Partition | Detector may read | Contents |
|---|---|---|
| `inputs/` | yes | registry, declarations, permits, shipments, ranch boundaries: what an agency or buyer holds |
| `environment/` | yes | one dataset per environmental source |
| `derived/` | yes | computed from inputs: herd inventory, ledger refusals |
| `truth/` | **no** | ground-truth labels, physical lot lineage, deliberate anomalies; evaluation only |

`manifest.json` lists every table with its partition, row count, SHA-256, data status (`real` / `synthetic` / `derived`), sources, transformation steps and `detector_visible`. It also records the generator version, preset, full configuration, seed, raw input files with their hashes and licences, a summary of deliberate anomalies, and a `logical_digest` over all table hashes.

## inputs/

### ranches.jsonl

| Field | Type | Notes |
|---|---|---|
| `ranch_id` | `R\d{4}` \| `X\d{2}` | primary key |
| `entity_type` | `ranch` \| `external_supplier` | |
| `display_name` | string | anonymised: hash of seed and id |
| `municipality`, `municipality_ibge` | string, string\|null | São Félix do Xingu (PA), `1507300` |
| `geometry_ref` | string\|null | `inputs/ranch_boundaries.geojson#R0001` |
| `total_area_hectares`, `pasture_area_hectares` | number\|null | pasture ≤ area |
| `estimated_cattle_capacity` | int\|null | pasture × 1.5 head/ha |
| `breeding_cows_declared` | int | declared at registration; bounds births |
| `opening_head` | int | declared herd on `registered_on` |
| `role` | `breeder` \| `rearer` \| `fattener` \| `intermediary` \| `external` | |
| `owner_group_id` | string | synthetic ownership groups (about 12 % share an owner) |
| `registered_on` | date | |
| `data_source` | `synthetic` | |
| `data_quality` | object | `geometry`: `synthetic_voronoi_on_real_layers` \| `synthetic_grid` \| `none`; `attributes`: `measured_on_real_layers` \| `synthetic` \| `unknown` |

### destinations.jsonl
`destination_id`, `destination_type` (`slaughterhouse` \| `export_port`), `name` (anonymised), `inspection`, `lat`, `lon`, `data_source`, `licence`.

### birth_declarations.jsonl

| Field | Notes |
|---|---|
| `birth_event_id`, `ranch_id`, `date`, `year`, `declared_head` | |
| `breeding_cow_estimate` | `{point, low, high}`: declared count ± 15 % (census error, culls, heifers) |
| `max_calving_rate` | 0.85 calves per cow per year (ledger bound) |
| `maximum_plausible_births` | per year: `point × 0.85` (what HerdLedger enforces) |
| `maximum_plausible_births_high` | per year: `high × 0.85` |
| `cumulative_year_head` | this ranch's declared births this year up to and including this one |
| `validation_status` | `within_biology` (≤ ledger bound), `borderline` (above the bound but inside the uncertainty band), `exceeds_biology` |

A borderline declaration is not evidence of fraud; the band exists because breeding-cow counts are uncertain.

### death_declarations.jsonl
`death_event_id`, `ranch_id`, `date`, `declared_head`, `source`. The evaluation preset declares no deaths (matching the published v1 world); `baseline` and `tiny` use 2 % per year.

### gta_movements.jsonl

| Field | Notes |
|---|---|
| `gta_id`, `lot_id` | |
| `origin_id`, `origin_type` | `ranch` or `external_supplier` |
| `destination_id`, `destination_type` | `ranch`, `slaughterhouse`, `export_port` |
| `issue_date` ≤ `movement_date` | permits are issued 0–3 days before the move |
| `head_count` | > 0 |
| `purpose` | `breeding`, `rearing`, `fattening`, `slaughter`, `export` |
| `source_lot_ids` | always `null`: GTAs do not carry lot ids |
| `permit_status` | `issued` \| `attempted_while_embargoed` (a red-team request the ledger must refuse) |
| `provenance` | generator, version, seed |

### shipments.jsonl
`shipment_id`, `kind` (`delivery`: one slaughterhouse GTA; `voyage`: all port GTAs in a month), `destination_id`, `shipment_date`, `gta_ids`, `lot_allocations` (`[{lot_id, head}]`, summing to `declared_head_count`), `declared_head_count`, `lineage_coverage` (`null` until the lineage engine runs), `certification_status` (`not_assessed` until certified). Each GTA appears in at most one shipment.

### ranch_boundaries.geojson
FeatureCollection, `id` = ranch id, Polygon/MultiPolygon in WGS84, rounded to 1e-6°.

## environment/

### prodes_deforestation.jsonl, indigenous_territories.jsonl, conservation_units.jsonl

| Field | Notes |
|---|---|
| `record_id` | `<dataset>:<source_record_id>` |
| `dataset`, `dataset_version` | version = source file name + first 12 hex of its SHA-256 |
| `source`, `source_record_id`, `licence`, `data_status` | `real` for TerraBrasilis layers, `synthetic` in fixtures |
| `observation_period_start/end` | PRODES year *Y* covers 1 Aug *Y−1* to 31 Jul *Y*; the accumulated-to-2007 mask has no start |
| `relevant_date` | image date from `julian_day` when known, else `null` |
| `geometry_ref` | `pipeline/data/raw/<file>.geojson#<source id>` |
| `geometry_sha256` | SHA-256 of the canonical GeoJSON geometry |
| `attributes` | selected source attributes (year, area, class, names) |
| `ingested_at` | fixed by configuration |

### embargoes.jsonl
`embargo_id`, `ranch_id`, `start_date`, `end_date`, `status` (`active` \| `lifted` \| `unverified`), `reason`, `source`, `data_status`. **All embargoes are simulated** (`source: "simulated embargo (not an Ibama record)"`).

## derived/

### herd_inventory.jsonl
One row per ranch per month, from replaying the declarations under the HerdLedger rules (`rastro/ledger.py`).

```
closing_head = opening_head + births + arrivals − departures − deaths − other_removals
```

`departures` go to other ranches; `other_removals` are documented removals to slaughterhouses and the port. `opening_head` of a month equals the previous month's `closing_head`. Refused events change no balance, so inventory is never negative. `inventory_confidence`: `low` if the ledger refused an event at this ranch that month, `medium` if it received animals from outside the window, else `high`.

### ledger_refusals.jsonl
`event_ref`, `event_type`, `ranch_id`, `date`, `head`, `reason` (`BirthsExceedBiology`, `InsufficientHerd`, `OriginEmbargoed`), `declared_balance`.

### geo_evidence.jsonl (schema `geo-evidence/1.0.0`, `pipeline/rastro/schemas/geo.py`)
One record per ranch from the geospatial engine (`python -m rastro.geospatial.run <dataset>`). Areas and distances in EPSG:31982.

| Field | Notes |
|---|---|
| `post_cutoff_deforestation_area_hectares` | clearing in PRODES periods that start after the cut-off (default 31 Dec 2020) |
| `intersecting_deforestation_polygon_ids` | every intersecting polygon (`prodes_deforestation:<uuid>`); per class in `deforestation.intersecting_polygon_ids` |
| `deforestation` | `pre_cutoff_ha`, `straddles_cutoff_ha` (PRODES 2021 = Aug 2020–Jul 2021 cannot be placed either side), `post_cutoff_ha`, `unknown_date_ha`, `pre_cutoff_undated_ha` (accumulated ≤ 2007 mask), `nearest_post_cutoff_km`, `post_cutoff_nearby_not_intersecting`, `coverage` (`full` \| `partial` \| `none` \| `undeclared`) |
| `indigenous_territory`, `protected_area` | `overlap_ha`, `overlap_share` of the ranch, and per area: name, phase/category, `legal_context` |
| `embargo` | `status` (`active` \| `historical` \| `unverified` \| `none`, never merged), `embargo_ids`, `sources`, `simulated` |
| `legal` | screening indicators only: `eudr_cutoff_indicator` (`post_cutoff_clearing_detected` \| `no_post_cutoff_clearing_detected` \| `undetermined`), recognised Indigenous-land overlap, strict-protection overlap, embargo |
| `scientific_risk` | `class` (`low` \| `watch` \| `high` \| `unknown`) and reasons; proximity alone is at most `watch` and labelled "not a violation" |
| `geometry` | `status` (`valid` \| `repaired` \| `missing` \| `empty` \| `rejected`), `area_ha`, `source_crs`, `data_status` |
| `dataset_versions`, `data_status`, `warnings` | layer versions (`<file>@<sha256[:12]>`), real/synthetic per input, data-quality warnings |

A measure that cannot be computed (no geometry, no layer, outside coverage) is `null`, never 0. Sustainable-use units such as APA Triunfo do Xingu, where ranching can be lawful, are reported as context, not as risk. Companion outputs: `geo_evidence.geojson` (map export, also published to `web/public/data/layers/ranch_evidence.geojson`), `geo_qa_log.jsonl` (CRS assumptions, repairs, rejections), `geo_provenance.json/.md` (which results use real and synthetic inputs), `geo_evidence.meta.json` (input fingerprint; unchanged inputs skip the run, any changed file recalculates).

### lineage_traces.jsonl (schema `lineage-trace/1.0.0`, `pipeline/rastro/schemas/lineage.py`)
One trace per shipment from the lineage engine (`python -m rastro.lineage.trace <dataset> <SHP-…|GTA-…|LOT-…>`, or `--all`). Inputs: permits, births, deaths, ledger refusals and geo evidence; never `truth/`.

- **Policy.** Events replay in date order (births, then movements, then deaths, then by reference). Outgoing head is allocated `fifo` (oldest lot first) and, for comparison, `pro_rata` (fully mixed herd). Both are estimates under a cohort assumption, not animal identity.
- **Origins.** `<ranch>#birth`, `<ranch>#opening` (on the ranch when records start; earlier origin unknown), `<supplier>#external`, `UNRESOLVED#<gta>` (shipped head the ranch did not hold, or a refused permit), `MISSING#<id>` (unregistered origin). Unknown mass is carried downstream, never dropped.
- **Fields.** `sources` (head and share per origin, min hops, categories), `exposure_pct` per category plus `any_risk` (union, each head once), `attribution` (record-level inconsistency, environmental overlap, suspected laundering, unknown provenance, review required with reasons), `policy_sensitivity` (FIFO vs pro-rata any-risk), `coverage_pct` (share traced to a birth or opening stock), `trace_path` (every upstream GTA with the head attributable to this lot), `unresolved`, `evidence_refs`, `uncertainty_notes`.
- **Review.** Review is required when FIFO and pro-rata put the lot in different bands (< 5 %, 5–25 %, ≥ 25 %), when unknown origin ≥ 25 %, coverage < 75 %, sources lack environmental evidence, or a permit was refused.

`lineage_summary.json` holds conservation totals for both policies (opening + births + unresolved + missing = deaths + to sinks + to unknown + on hand) and issue counts.

### risk/ (schema `risk/1.0.0`, `pipeline/rastro/schemas/risk.py`)
Written by `python -m rastro.risk.run <dataset>`; every threshold is in `pipeline/rastro/risk/config.py`.

| File | Contents |
|---|---|
| `findings.jsonl` | one finding per detector hit: `finding_id`, entity, `dataset_refs`, `detector` + version, `code`, `category`, `severity`, `confidence`, `blocking`, input `features`, `observed` values, `thresholds`, `evidence_ids`, an `explanation` assembled from those values, `limitations`, `observed_at`, `evidence_hash` |
| `ranch_risk.jsonl` | `risk_class` (`high` \| `watch` \| `clean` \| `insufficient_data`), finding ids, codes, IsolationForest `anomaly_score` (a ranking, not a probability) |
| `decisions.jsonl` | per shipment: `outcome` (`PASS` \| `REVIEW` \| `FLAGGED`), `risk_categories` (separate from the outcome), `reasons`, blocking and review finding ids, exposures (incl. blocking-origin share under FIFO and pro-rata), coverage, thresholds, `evidence_hash` |
| `evidence/<sha256>.json` | canonical JSON of each finding and decision; the file name is its SHA-256 |
| `model/` | `iforest-v1.joblib` and `feature_schema.json` (`iforest-features/1.0.0`) |

Detectors: **A** environmental exposure (post-cut-off clearing, embargo, recognised Indigenous land or strict protection, missing evidence), **B** inventory and births (shipping without inventory, negative inventory, births above the breeding-cow band, duplicate permits, chronology), **C** pass-through (bought cattle resold within 45 days; high only with ≥ 35 % risky supply; never blocking), **D** over-capacity (peak quarterly herd vs pasture at 1.5 and 2.0 head/ha; a lead, never blocking), **E** IsolationForest over 12 behavioural features with reason codes. Lot findings come from lineage: `TAINTED_SUPPLY` (share from origins with a blocking finding, plus refused permits) and `UNKNOWN_ORIGIN`.

Decision rule: **FLAGGED** if ≥ 25 % of the lot traces to blocking origins or refused permits, or a direct supplier has a blocking finding. **REVIEW** for 5–25 %, unknown origin ≥ 25 %, coverage < 75 %, a refused permit, a non-blocking finding on a direct supplier, or when FIFO and pro-rata attributions straddle the 25 % threshold. **PASS** otherwise. Watch-level clearing (6.25–50 ha) is reported as EUDR exposure but neither blocks nor reviews on its own.

`reports/evaluation.{json,md}` (from `python -m rastro.risk.evaluate`, the only risk step that reads `truth/`): per-detector and overall confusion counts, precision, recall, F1 and false-positive rate; lot-level confusion against truth taint classes; ablation against a direct-supplier-only check.

## truth/ (evaluation only)

| Table | Contents |
|---|---|
| `ranch_labels` | `label` (`honest`, `dirty_source`, `launderer`, `phantom_births`, `over_capacity`, `unknown`), `scenario`, `reasons`, `case_tags` (`honest_fast_trader`, `high_volume_honest`, `small_post2020_clearing`, `embargoed`: the hard cases), `embargoed_from` |
| `movement_labels` | per GTA: `scenario_tags` (`laundering_hop`, `embargo_attempts`, `carries_dirty_origin`), `true_origin_mix` |
| `smuggled_transfers` | animals moved without a GTA, each laundered as a phantom birth declaration |
| `lots` | physical single-origin parcels: `kind`, `location_id`, `created_date`, `head`, `birth_origin_id`, `parent_lot_id`, `via_gta_id`, `remaining_head` |
| `lot_allocations` | immutable parcel-to-parcel flows: `channel` (`gta`, `smuggled`, `death`), `gta_id`, `from_lot_id`, `to_lot_id`, `head`, `date` |
| `shipment_truth` | true origin mix and tainted share of each shipment |
| `anomalies` | every ledger refusal, attributed to the scenario that planted it |

Dirty source (ground truth): real PRODES clearing ≥ 50 ha after 2020 inside the ranch cell, or Indigenous-land overlap ≥ 1 ha.

## Detector output

`RiskFinding` (defined in `canonical.py`, written by the risk engine): `finding_id`, `entity_type`, `entity_id`, `risk_category` (flag codes), `severity` (`info`, `watch`, `high`), `confidence`, `evidence_refs`, `detector_version`, `observed_at`, `review_status` (`pending`, `confirmed`, `dismissed`).

## Generator and presets

```bash
cd pipeline
python -m rastro.synth.generate --preset evaluation            # -> data/synthetic/evaluation
python -m rastro.synth.generate --preset tiny --out DIR         # no geodata needed
python -m rastro.synth.generate --preset baseline --seed 11
python -m rastro.validation ../data/synthetic/evaluation        # re-validate a dataset on disk
```

| Preset | Landscape | Scenarios | Size (seed) |
|---|---|---|---|
| `evaluation` | real (409 cells) | all four | 409 ranches + 5 external, 10,844 GTAs, 36 months (seed 7) |
| `redteam` | real | all + two-hop, longer holds | 10,868 GTAs |
| `baseline` | real | none (embargoes and 2 %/yr deaths only) | 10,397 GTAs, 0 refusals |
| `tiny` | synthetic grid, 48 | all four | 682 GTAs, 24 months (seed 21); committed at `pipeline/tests/fixtures/tiny` |
| `tiny-baseline` | synthetic grid, 48 | none | |

Scenarios: `laundering`, `phantom_births`, `embargo_attempts`, `over_capacity`. With none enabled the generator produces no record the ledger would refuse. The 10,844 GTA count is what seed 7 produces under the evaluation configuration, not a forced target; other seeds give other counts.

## Published bundle (web/public/data, v1)

Field-level definitions in [SPEC.md §6](SPEC.md); extra fields in [web/README.md](../web/README.md). Additions found while formalising v1: flag `severity` is `watch` or `high` from the pipeline and `medium` in the mock bundle (accepted as an alias); `movements.rejected` is `OriginEmbargoed` \| `InsufficientHerd` \| `null`; ranch `onchain_id` is SHA-256 of salt + id.
