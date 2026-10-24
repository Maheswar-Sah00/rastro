# Rastro API (v1)

FastAPI service in `backend/`. It serves the canonical dataset (`data/synthetic/<preset>`), the lineage engine, the risk engine, evidence files and HerdLedger reads. It **imports the pipeline package** (`rastro.lineage`, `rastro.risk`, `rastro.certificates`, `rastro.schemas`) instead of re-implementing it, so API numbers are pipeline numbers.

All ranch, herd, permit, embargo and shipment data is **synthetic**; environmental layers are real (INPE PRODES, FUNAI, conservation units). Nothing returned establishes a legal violation by any real ranch or company.

## Run

```bash
cd backend
python -m venv .venv && .venv/Scripts/activate        # Windows; source .venv/bin/activate elsewhere
pip install -r requirements-dev.txt                    # pins match the pipeline's runtime (geopandas, sklearn, …)
# the dataset needs derived outputs: from pipeline/,
#   python -m rastro.geospatial.run ../data/synthetic/evaluation
#   python -m rastro.risk.run ../data/synthetic/evaluation
uvicorn app.main:app --port 8000                       # OpenAPI: /docs, /openapi.json
python -m pytest                                       # 66 tests
```

Configuration (environment, see `../.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `RASTRO_DATASET_DIR` | `data/synthetic/evaluation` | canonical dataset served under `/api/v1` |
| `RASTRO_DATA_DIR` | `web/public/data` | published web bundle (certificates, onchain.json, ABI, evidence files) |
| `RASTRO_PIPELINE_DIR` | `pipeline` | where the `rastro` package lives |
| `RASTRO_CHAIN_MODE` | `auto` | `auto`: live RPC, else labelled recorded replay; `local`: recorded replay only; `rpc`: live only (503 when down) |
| `RASTRO_RPC_URL` | onchain.json `rpc` | read-only JSON-RPC endpoint |
| `RASTRO_RPC_TIMEOUT_S` | `2` | per-call timeout; an unreachable node is re-probed at most every 30 s |
| `RASTRO_STATE_DIR` | `<dataset>/derived/reviews` | investigator annotation log |
| `RASTRO_CORS_ORIGINS` | `http://localhost:5173,http://localhost:4173` | the only browser origins allowed |
| `RASTRO_WARM_LINEAGE` | `true` | build the lineage replay (≈10 s on the full dataset) in the background at startup |
| `RASTRO_LOG_LEVEL` | `INFO` | JSON logs, one line per request with `request_id` and latency |

**Fixture mode for the demo:** point `RASTRO_DATASET_DIR` at any generated dataset, e.g. the 48-ranch fixture after running the geo and risk stages on a copy of `pipeline/tests/fixtures/tiny`. No external service is required; the chain defaults to the recorded replay when anvil is not running.

The backend **holds no private keys**. Oracle signing happens in `contracts/replay` (trusted tooling). The only write-like chain endpoint returns **unsigned** calldata for the buyer's wallet.

## Conventions

- **Envelope.** Every data response is `{"meta": Provenance, "data": …}`; collections add `"page": {"limit", "offset", "total"}` (`limit` 1–500, default 50).
- **Provenance** (`meta`): `dataset_id`, `dataset_version`, `logical_digest` (manifest), `generated_at`, `schema_version`, `data_status` per component (`real` | `synthetic` | `derived` | `unavailable`), `freshness` (mtime of geo, lineage and risk outputs).
- **Errors** are always `{"error": {"code", "message", "details", "request_id"}}`: `invalid_request` (422: bad id pattern, bad query, unknown body field), `not_found` (404), `assessment_unavailable` (409), `contract_revert` (409, decoded custom error), `chain_unavailable` (503), `dataset_unavailable` (503), `malformed_data` (500, file + line), `assessment_failed` / `internal_error` (500).
- **Request ids.** Send `X-Request-ID` to correlate; it is echoed back (or generated) and written to the log and to review entries.
- **Identifiers** are validated by pattern before any lookup: ranch `R\d{4}` / supplier `X\d{2}`, GTA `GTA-PA-YYYY-NNNNNN`, lot `LOT-<gta>`, shipment `SHP-D-NNNNNN` / `SHP-V-YYYYMM`, finding `F-<16 hex>`, certificate `0x<64 hex>`.
- **Zero vs missing.** `null` means *not measured*, never "no risk". Status fields say why: `environmental_evidence` = `available` | `missing` | `not_applicable`; `risk_status` / `assessment_status` = `assessed` | `not_assessed`. A ranch with `post_cutoff_deforestation_ha: 0` and `environmental_evidence: "available"` was measured and has none.
- **Caching.** Tables are loaded lazily and cached per file (mtime + size); a pipeline re-run is picked up on the next request. The lineage service is cached per fingerprint of its input files.

## Endpoints

| Method | Path | What |
|---|---|---|
| GET | `/health`, `/api/v1/health` | liveness + published-bundle inventory |
| GET | `/api/v1/ready` | dataset and derived artifacts present, risk outputs current (503 when not ready) |
| GET | `/api/v1/summary` | counts, deliberate anomalies, risk/lineage/geo summaries |
| GET | `/api/v1/ranches` | `?role=&risk_class=&entity_type=&limit=&offset=` |
| GET | `/api/v1/ranches/{ranch_id}` | registry row, geo evidence (`GeoEvidence`), risk, movement counts |
| GET | `/api/v1/ranches/{ranch_id}/movements` | `?direction=in\|out\|all`; each with ledger status (`accepted` / `refused` + reason / `not_moved`) and shipment |
| GET | `/api/v1/ranches/{ranch_id}/risk` | risk class, all ranch findings, IsolationForest score (a ranking, not a probability) |
| GET | `/api/v1/ranches/{ranch_id}/balance` | on-chain balance and embargo flag (live RPC only; recorded replay has totals only) |
| GET | `/api/v1/gtas/{gta_id}` | permit, ledger status, shipment; `?include_lineage=true` adds its trace |
| GET | `/api/v1/lots/{lot_id}/lineage` | `LineageTrace`; `?policy=fifo\|pro_rata` |
| GET | `/api/v1/shipments` | `?kind=&outcome=PASS\|REVIEW\|FLAGGED&destination=` |
| GET | `/api/v1/shipments/{id}` | shipment, decision, FIFO lineage trace |
| GET | `/api/v1/shipments/{id}/risk` | decision, findings by category, **breakdown**, **clearing steps**, review status per finding |
| GET | `/api/v1/shipments/{id}/evidence` | decision + finding evidence hashes, each re-hashed against its stored file |
| GET | `/api/v1/shipments/{id}/evidence/download` | zip bundle (decision, findings + canonical evidence files, lineage trace, geo evidence of involved ranches, reviews, provenance, `checksums.sha256`) |
| GET | `/api/v1/shipments/{id}/lineage/graph` | nodes + edges; `?max_nodes=` overview, `?expand=<node>` branch |
| GET | `/api/v1/shipments/{id}/lineage/report` | `?format=json\|md\|csv`; same numbers as the API |
| GET | `/api/v1/shipments/{id}/certificate/bundle` | canonical RFC 8785 evidence bundle + SHA-256 + commitments; eligible only when PASS |
| POST | `/api/v1/shipments/{id}/assess` | canonical lineage + risk assessment (`{"recompute": bool}` only) |
| GET | `/api/v1/findings/{finding_id}` | machine finding (unchanged) + review history + decision impact |
| POST | `/api/v1/findings/{finding_id}/reviews` | append an investigator review |
| GET | `/api/v1/certificates/{certificate_id}` | status (`none`/`valid`/`consumed`/`revoked`/`not_clean`/`expired`), records, decoded on-chain record |
| POST | `/api/v1/certificates/{certificate_id}/verify` | evidence hash re-computed + compared with the anchored hash + status |
| POST | `/api/v1/certificates/{certificate_id}/consume-request` | unsigned `consumeCertificate` calldata (`{"use", "shipment_id" \| "ref_hash"}`) |
| GET | `/api/v1/chain/status` | adapter mode and label, roles, `isOracle`, `paused`, `minPolicyVersion`, `oracles()` |
| GET | `/api/v1/evaluation/summary` | aggregated evaluation report (`reports/evaluation.json`) or `status: unavailable` |
| GET | `/api/v1/datasets/{name}` | the published web bundle files, validated against schema v1 (unchanged from v0.1) |

### Assessment

`POST /api/v1/shipments/{id}/assess` returns the risk engine's decision for the lot: `outcome`, `risk_categories` (kept separate from the outcome), `reasons`, `findings_by_category`, `evidence_refs`, `decision_evidence_hash`, `coverage_pct`, `exposure_pct`, `policy_sensitivity` (FIFO vs pro-rata), `uncertainty_notes`, `detector_versions`, `engine_version`, and `source`: `precomputed` when `derived/risk` matches the dataset's `logical_digest`, `recomputed` when it was stale or `{"recompute": true}` (runs `rastro.risk.run` under a lock). The body accepts **only** `recompute`; any other field (`outcome`, `verdict`, `certification_status`, …) is rejected with 422, so a browser can never declare its own lot clean. Missing geospatial evidence gives 409 `assessment_unavailable`.

### Investigation workspace

- **Graph.** Nodes are built from the trace's `sources` (head per origin, FIFO) and `trace_path`: `kind` = `ranch` | `unknown_origin` (external suppliers, `UNRESOLVED#<gta>`, unregistered senders) | `sink` | `folded`; `roles` ⊂ {`source`, `intermediary`, `direct_supplier`, `destination`}; `head_fifo`, `head_pro_rata`, `share_pct`, `categories`, ranch `finding_ids`. Edges carry `gta_id`, `date`, `permit_head` and `attributed_head` (head on that permit attributable to this shipment); `unattributed_inflow` edges show where unresolved head entered. Node `head_fifo` sums to the declared head. The pro-rata model spreads head thinly over many origins: per-node `head_pro_rata` is given for drawn nodes and the rest is summarised in `uncertainty.pro_rata_only_origins` (count, head, top 10); `totals.source_head_pro_rata` includes them. `?max_nodes=N` keeps the sink, direct suppliers and the largest sources, folding the rest into `other:<category>` nodes with exact totals (`view.folded` lists members). `?expand=<node>` returns that node's upstream branch.
- **Breakdown** (`/risk` → `breakdown`): per category head and %: `post_cutoff_deforestation`, `embargo`, `indigenous_territory` and `protected_area` (the lineage `protected_overlap` split with geo evidence: recognised Indigenous land vs strict protection), `inventory_birth_anomalies`, `suspicious_movement_behaviour` (sources or intermediaries with PASS_THROUGH / OVER_CAPACITY / ANOMALY; per-intermediary throughput is listed in `via_intermediaries` and the category head is a lower bound, because FIFO composition does not record which origins passed through which intermediary), `unknown_origin`. `unique_affected_head/pct` is the union over sources (each head once, equals the lineage `any_risk`), always ≤ `sum_of_category_pct`.
- **Clearing steps** (`/risk` → `clearing_steps`): derived from the decision. FLAGGED lots list the blocking findings ("only corrected underlying records can change the outcome"); REVIEW reasons map to actions: obtain upstream GTAs for external suppliers (coverage < 75 %), resolve refused/unresolved permits, obtain lot- or ear-tag records for the intermediaries when FIFO and pro-rata disagree, obtain missing environmental evidence, investigator review of each review finding not yet confirmed or dismissed.
- **Reviews.** `POST /findings/{id}/reviews` with `{"status": "under_review"|"confirmed"|"dismissed", "reason": "…", "reviewer": "…"}`; `reason` (≥ 10 characters) is required to confirm or dismiss. Entries are appended to `annotations.jsonl` with timestamp, request id and the finding's `evidence_hash` at review time. A review never edits the finding, its hash, a decision or anything on-chain; dismissing a blocking finding is reported as "investigator disputes; blocking rule still applies" and the lot stays FLAGGED.

### Certificates and the ledger

Certificates are looked up by lot id. Two evidence schemes coexist: published demo certificates (`SHP-0008` style, from `web/public/data/shipments.json`) are verified by re-hashing `web/public/data/evidence/<hash>.json`; canonical shipments (`SHP-D-`/`SHP-V-`) use `rastro.certificates.bundle` (RFC 8785 bundle, SHA-256) and are re-built and re-hashed. `consume-request` commits a shipment id as `sha256("rastro-demo-salt-v1|" + id)`, the replay's convention.

The **contract adapter** reads everything from `HerdLedger.abi.json` at runtime: function selectors (Keccak-256), struct layouts (`CertificateRecord`, `Ranch`, `EvidenceRecord`), `address[]` returns and custom-error selectors (reverts surface as 409 `contract_revert` with the decoded error name). Status enum: `none`, `valid`, `consumed`, `revoked`, `not_clean`, `expired`; verdicts `clean`, `flagged`, `unknown`, `review` (only `clean` is consumable). `chain.mode` is `rpc` or `local_records`; `chain.verified_public` is `true` only for a reachable public testnet RPC; the recorded replay is always labelled **"local demonstration (recorded anvil replay), not a public testnet"**.

## Examples (evaluation dataset, trimmed)

```http
POST /api/v1/shipments/SHP-D-001677/assess
{}
→ 200
{"meta": {"dataset_id": "rastro-synth-evaluation", "logical_digest": "614e89ad…", "data_status": {"ranches": "synthetic", "environmental_layers": "real", "risk": "derived", …}},
 "data": {"shipment_id": "SHP-D-001677", "source": "precomputed", "outcome": "FLAGGED",
          "risk_categories": ["post_cutoff_deforestation", "protected_overlap", "unknown_or_incomplete"],
          "reasons": ["[blocking] 50.0% of the 105 head in SHP-D-001677 trace to origins with a blocking finding (R0332 50.0%) …",
                      "[review] 40.0% of SHP-D-001677 has unknown or incomplete origin …", …],
          "coverage_pct": 60.0, "decision_evidence_hash": "8dd0e206…",
          "exposure_pct": {"any_risk": 94.286, "blocking_origin_fifo": 50.007, "blocking_origin_pro_rata": 20.439, "unknown_or_incomplete": 40.0, …},
          "detector_versions": ["L/1.0.0 (engine 1.0.0)"], "engine_version": "1.0.0", …}}

POST /api/v1/shipments/SHP-D-001677/assess
{"outcome": "PASS"}
→ 422 {"error": {"code": "invalid_request", "message": "request failed validation",
                 "details": [{"loc": ["body", "outcome"], "msg": "Extra inputs are not permitted", "type": "extra_forbidden"}], "request_id": "91926591dc084fff"}}
```

```http
GET /api/v1/shipments/SHP-D-001677/lineage/graph
→ 200 data:
{"declared_head": 105.0, "destination": "S:SIF_02", "view": {"mode": "full", "folded": []},
 "nodes": [{"id": "R0332", "kind": "ranch", "roles": ["source"], "origin_kinds": ["opening"], "head_fifo": 52.507, "head_pro_rata": 0.721,
            "share_pct": 50.007, "categories": ["indigenous_territory", "post_cutoff_deforestation"], "finding_ids": ["F-83378ac8554e6a4c", "F-b38fe6d96ffdad6a"]},
           {"id": "X04", "kind": "unknown_origin", "roles": ["source"], "origin_kinds": ["external"], "head_fifo": 42.0, "head_pro_rata": 2.97, …},
           {"id": "R0114", …, "head_fifo": 6.0}, {"id": "R0358", …, "head_fifo": 4.493},
           {"id": "R0201", "roles": ["intermediary"], …}, {"id": "R0289", "roles": ["direct_supplier"], …}, {"id": "S:SIF_02", "kind": "sink", …}],
 "edges": [{"gta_id": "GTA-PA-2023-003111", "kind": "gta", "from": "R0332", "to": "R0201", "date": "2023-08-26", "permit_head": 203.0, "attributed_head": 52.507}, …],
 "totals": {"source_head_fifo": 105.0, "source_head_pro_rata": 104.996, "pro_rata_only_head": 101.154},
 "uncertainty": {"policy_sensitivity": {"fifo_any_risk_pct": 94.286, "pro_rata_any_risk_pct": 39.432, "spread_pct": 54.854}, …}}
```

```http
GET /api/v1/shipments/SHP-D-001677/risk   → data.breakdown / data.clearing_steps
{"categories": {"post_cutoff_deforestation": {"head": 57.0, "pct": 54.286, "sources": ["R0332", "R0358"]},
                "indigenous_territory": {"head": 52.507, "pct": 50.007, "sources": ["R0332"]},
                "protected_area": {"head": 0.0, "pct": 0.0, …}, "embargo": {…0}, "inventory_birth_anomalies": {…0},
                "suspicious_movement_behaviour": {"head": 57.0, "pct": 54.286, "via_intermediaries": [{"ranch_id": "R0201", "codes": ["PASS_THROUGH"], "attributed_head": 57.0}]},
                "unknown_origin": {"head": 42.0, "pct": 40.0, "sources": ["X04"]}},
 "unique_affected_head": 99.0, "unique_affected_pct": 94.286, "sum_of_category_pct": 198.579}
[{"action": "blocking rule applies", "finding_id": "F-51345f32e6f77400", "why": "TAINTED_SUPPLY on SHP-D-001677. Only corrected underlying records … can change the outcome."},
 {"action": "obtain upstream GTAs for external supplier(s) X04", "why": "raises lineage coverage (60.0%) toward the 75% needed to pass"},
 {"action": "obtain lot- or animal-level records (ear tags) for intermediaries R0201, R0289", "why": "the outcome depends on whether mixed herds are allocated FIFO or pro-rata"},
 {"action": "investigator review of finding F-2b287af2242f7622", "why": "UNKNOWN_ORIGIN (watch) on SHP-D-001677; current review status: unreviewed"}]
```

```http
GET /api/v1/shipments/SHP-D-001677/lineage/report?format=csv
shipment_id,node,origin_key,origin_kind,head_fifo,head_pro_rata,share_pct,min_hops,categories
SHP-D-001677,R0332,R0332#opening,opening,52.507,0.721,50.007,3,indigenous_territory;post_cutoff_deforestation
SHP-D-001677,X04,X04#external,external,42.0,2.97,40.0,2,unknown_origin
SHP-D-001677,R0114,R0114#opening,opening,6.0,0.051,5.714,2,
SHP-D-001677,R0358,R0358#opening,opening,4.493,0.1,4.279,3,post_cutoff_deforestation
```

```http
POST /api/v1/certificates/0x75f77fecc3de0e88065220c88396bda411e8da5f0cafdaba8315f299488b7f82/verify
→ 200 data:
{"evidence_file_present": true, "evidence_hash_matches": true, "onchain_hash_matches": true, "status": "consumed", "usable": false,
 "chain": {"mode": "local_records", "network": "anvil", "chain_id": 31337, "label": "local demonstration (recorded anvil replay), not a public testnet",
           "verified_public": false, "detail": "RPC unavailable (http://127.0.0.1:8545: ConnectTimeout); serving recorded replay"},
 "notes": ["local demonstration (recorded anvil replay), not a public testnet", "certificate status is consumed: it cannot back a shipment or an EUDR statement"]}

GET /api/v1/shipments/SHP-D-001677/certificate/bundle
→ 200 data: {"eligible_for_clean_certificate": false, "ineligibility_reason": "SHP-D-001677: decision is FLAGGED; only PASS lots can be certified clean",
             "evidence_hash": "0xd27f0fbd…", "shipment_commitment": "0x33f1bdee…", "lot_commitment": "0x011df192…", "policy_version": 1, "bundle": {…}}
```

```http
GET /api/v1/findings/F-51345f32e6f77400
→ 200 data: {"finding": {"code": "TAINTED_SUPPLY", "severity": "high", "blocking": true, "evidence_hash": "36d374c0…", …},
             "review_status": "unreviewed", "reviews": [],
             "decision_impact": [{"shipment_id": "SHP-D-001677", "outcome": "FLAGGED", "role": "blocking",
                                  "note": "decision unchanged: reviews annotate findings and never alter the machine decision"}]}

GET /api/v1/ranches/R99
→ 422 {"error": {"code": "invalid_request", "details": [{"loc": ["path", "ranch_id"], "msg": "String should match pattern '^(R\\d{4}|X\\d{2,})$'"}], …}}
```

Measured server-side latency on the full dataset (409 ranches, 10,844 GTAs, 2,853 shipments), warm: 2–30 ms for lookups, risk, graph and assess; ≈ 220 ms for a shipment detail with its trace on first read; the first lineage call after startup waits for the background warm-up (≈ 10 s). An unreachable RPC costs one timeout per 30 s, then the labelled fallback is cached.

## How the frontend should consume the API

1. **Base URL** from `VITE_API_URL` (no secrets in `VITE_*`). Keep the static bundle (`web/public/data`) as the fallback when the API is down: the judge site already works from it.
2. **Gate on readiness.** Call `/api/v1/ready`; if 503, show what is missing (`missing`) instead of empty charts.
3. **Always render provenance.** Show `meta.data_status` as badges (Synthetic / Real / Derived / Unavailable) and `meta.generated_at` / `logical_digest` in a footer.
4. **Never turn `null` into 0.** Check `environmental_evidence`, `risk_status`, `assessment_status` first; render "not measured" / "not assessed" distinctly from "0 ha" / "clean".
5. **Show outcome and categories separately.** `outcome` (PASS / REVIEW / FLAGGED) is the operational decision; `risk_categories` and the breakdown explain it. A REVIEW is never displayed as clean.
6. **Uncertainty is first-class.** Draw `head_fifo` as the primary estimate and `head_pro_rata` as the alternative (e.g. a range bar); show `policy_sensitivity.spread_pct` and `uncertainty.notes` next to the graph.
7. **Use `unique_affected_pct` for "share affected"**, never the sum of category percentages.
8. **Pagination.** Use `page.total` with `limit`/`offset`; filter server-side (`outcome`, `risk_class`, …).
9. **Errors.** Branch on `error.code`; show `error.request_id` in error toasts so a report can be traced in the logs.
10. **Chain.** Display `chain.label` verbatim wherever on-chain status appears; only show "verified on testnet" when `chain.verified_public` is true. For consumption, request `consume-request` and hand the unsigned `data` to the user's wallet.
11. **Reviews** are annotations: after a POST, refresh `/findings/{id}` and `/shipments/{id}/risk` (`review_status`), but keep the decision as returned by the engine.
