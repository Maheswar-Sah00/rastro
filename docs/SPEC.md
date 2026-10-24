# Rastro — build spec (shared contract between pipeline, contracts and web)

> Rastro (Portuguese: "trace"). *A cow is born once, dies once, and can't be in two places. Neither can its paperwork.*

IEEE ClimateChain Global Hackathon 2026 · Track: **Sustainable Supply Chains** (product lifecycle tracking / transparency), with Climate Data & Environmental Monitoring as secondary.

Deadline: 25 Oct 2026 17:00 UTC+3. Everything here must be demo-ready and honest about what is real vs synthetic.

## 1. Problem (one paragraph)

Cattle pasture is the main driver of Amazon deforestation. Meatpackers monitor their *direct* suppliers, but animals are "laundered": raised on a farm with illegal deforestation (or inside an Indigenous land / conservation unit, or under an Ibama embargo), then moved through a "clean" intermediary that resells them within days to a slaughterhouse or live-export ship. The movement record that exposes this, the GTA (Guia de Trânsito Animal, the animal transit permit), exists for every movement. It is locked inside state agencies, though a federal court ordered Pará to publish it (Oct 2025). Pará postponed individual cattle tracking to 2030. EUDR applies to beef from 30 Dec 2026. Pará ships more than half of Brazil's live-cattle exports, and Türkiye is the top buyer. JBS's blockchain platform covers one company and relies on self-declared indirect suppliers, so tainted animals leak to other buyers.

## 2. Core idea: conservation of cattle

Physical/biological invariants that laundering breaks:

1. **Conservation**: a ranch cannot ship more head than it holds (initial + births + purchases − deaths − sales).
2. **Biology**: births per year ≤ breeding cows × max calving rate (0.85).
3. **Carrying capacity**: herd ≤ pasture capacity × tolerance (pasture ≈ deforested area inside the ranch; ~1.5 head/ha max).
4. **Pass-through**: animals bought and resold within a short window (< 45 days) with little weight gain = triangulation signature.
5. **One-time claims**: each GTA can back at most one lot certificate; each certificate can be consumed once (one export shipment, or one EUDR due-diligence statement).

AI (off-chain) finds laundering patterns on the movement graph; the ledger (on-chain) enforces the hard invariants across all buyers and anchors the AI's evidence so it cannot be edited later.

## 3. Repository layout

```
rastro/
  pipeline/     Python: real-data fetch, synthetic GTA simulator, detection AI, exports
    out/chain_seed.json    -> consumed by contracts/script replay
  contracts/    Foundry (preferred) or Hardhat: HerdLedger.sol + tests + deploy/replay scripts
    out/onchain.json       -> copied to web/public/data/onchain.json
  web/          Vite + React + TypeScript static site (GitHub Pages)
    public/data/*.json     -> produced by pipeline (+ onchain.json from contracts)
  docs/         this spec, architecture, judge walkthrough, deck
```

## 4. Smart contract: `HerdLedger.sol` (Solidity ^0.8.24, OpenZeppelin 5)

Roles (AccessControl): `DEFAULT_ADMIN_ROLE`, `REGISTRAR_ROLE` (state animal-health agency, e.g. Adepará), `ISSUER_ROLE` (issues GTA commitments; same agency), `REGULATOR_ROLE` (Ibama / prosecutors), `ORACLE_ROLE` (Rastro AI signer; EIP-712), `BUYER_ROLE` (meatpacker / exporter / importer).

Privacy: no personal data on-chain. Entity ids are `bytes32` = keccak256(salt ‖ official code); salts stay with the registrar.

State & functions (names are binding; add internals as needed):

- `registerRanch(bytes32 id, uint32 capacityHead, uint32 initialHead, uint32 breedingCows, bytes32 geomHash)`: REGISTRAR. Reverts on duplicate.
- `registerSink(bytes32 id, uint8 kind /*1=slaughterhouse 2=export port*/)`: REGISTRAR. Sinks have no balance constraint.
- `recordBirths(bytes32 ranch, uint32 head, uint16 year)`: REGISTRAR. Reverts `BirthsExceedBiology(ranch, year, total, max)` if cumulative births in `year` > breedingCows × 8500 / 10000.
- `recordDeaths(bytes32 ranch, uint32 head)`: REGISTRAR. Reverts on underflow.
- `recordMovement(bytes32 gtaHash, bytes32 from, bytes32 to, uint32 head, uint8 purpose /*0 breeding 1 rearing 2 fattening 3 slaughter 4 export*/, uint64 date)`: ISSUER.
  - Reverts `UnknownEntity`, `DuplicateGta`, `OriginEmbargoed(from)`, `InsufficientHerd(from, have, need)` (conservation).
  - Updates balances (to-ranch balance increases; sinks just count received head).
  - Emits `CapacityExceeded(ranch, head, capacity)` (event, not revert) when the receiving ranch goes above capacity × 1.10.
- `setEmbargo(bytes32 ranch, bool on, bytes32 reasonHash)`: REGULATOR.
- `attestRisk(RiskAttestation a, bytes sig)`: anyone may relay; must be EIP-712 signed by an ORACLE_ROLE key. `RiskAttestation{bytes32 ranch; uint8 riskClass /*0 clean 1 watch 2 high*/; uint16 scoreBps; bytes32 evidenceHash; uint64 asOf; uint256 nonce}`. Replay-protected nonce.
- `issueCertificate(Certificate c, bytes sig)`: oracle-signed. `Certificate{bytes32 lotId; bytes32 sink; bytes32[] gtaHashes; uint32 head; uint8 verdict /*0 clean 1 flagged 2 unknown*/; bytes32 evidenceHash; uint256 nonce}`.
  - Every gtaHash must exist, have `to == sink`, and not already be in a certificate (`GtaAlreadyCertified`). `head` ≤ sum of those GTAs' head.
- `consumeCertificate(bytes32 lotId, uint8 use /*0 export shipment 1 EUDR DDS 2 retail claim*/, bytes32 refHash)`: BUYER. Reverts `CertificateAlreadyUsed(lotId)`, `CertificateNotClean(lotId)` when verdict != clean, `CertificateRevoked`.
- `revokeCertificate(bytes32 lotId, bytes32 reasonHash)`: REGULATOR.
- Views: `balanceOf(bytes32)`, `ranch(bytes32)`, `gta(bytes32)`, `certificate(bytes32)`, totals for invariant checks.
- Events for every state change (web reads them).

Tests (required): unit tests for every revert path; **invariant/fuzz tests**: Σ ranch balances == Σ initial + Σ births − Σ deaths − Σ head moved into sinks; no balance ever negative; a certificate is consumed at most once; a GTA is in at most one certificate; an embargoed ranch has no outgoing movement after embargo.

Scripts: `Deploy` (deploys, grants roles to configured addresses); `Replay` reads `pipeline/out/chain_seed.json`, registers entities, records births/movements (subset is fine), posts signed risk attestations and certificates, consumes one clean certificate, and **attempts** (eth_call / expected revert) a double consumption, a flagged-certificate consumption and an embargoed-origin movement. Writes `contracts/out/onchain.json` (schema §6.8). Network: local anvil first; public testnet (Polygon Amoy or Base Sepolia) once a funded key exists in `.env` (gitignored).

## 5. Pipeline (Python 3.12)

Real data (fetched, cached in `pipeline/data/raw`, never committed if large):
- PRODES yearly deforestation polygons (INPE TerraBrasilis WFS `prodes-legal-amz:yearly_deforestation`), AOI in São Félix do Xingu (PA).
- Conservation units + Indigenous lands (TerraBrasilis WFS).
- IBGE PPM herd by municipality (SIDRA table 3939).
- Beef slaughterhouses in Pará + live-export port (Trase logistics map v6, CC BY 4.0).

Synthetic (clearly labelled): ~300 ranch polygons (Voronoi over the AOI), ranch roles, herd, 3 years of GTAs, injected laundering archetypes with ground-truth labels: `dirty_source` (post-2020 deforestation, inside protected area, or embargoed), `launderer` (pass-through intermediary), `phantom_births`, `over_capacity`; everything else `honest`.

Detection: hard invariants + graph features + IsolationForest + flow-weighted taint propagation. Evaluate against ground truth, and against the **status quo** (direct-supplier-only check, as meatpackers do today).

## 6. Data files for the web (`web/public/data/`)

All coordinates WGS84 [lon, lat]. All ids are strings. Dates ISO `YYYY-MM-DD`.

### 6.1 `meta.json`
```json
{
  "project": "Rastro",
  "aoi": {"name": "São Félix do Xingu, Pará (study window)", "bbox": [-52.4, -6.9, -51.8, -6.3]},
  "generated_at": "2026-10-24T12:00:00Z",
  "years": [2023, 2024, 2025],
  "eudr_cutoff": "2020-12-31",
  "synthetic_notice": "Ranch boundaries, herds and GTAs are synthetic, calibrated to public aggregates. Deforestation, protected areas, slaughterhouses and municipal herd are real.",
  "sources": [{"name": "INPE PRODES", "url": "https://terrabrasilis.dpi.inpe.br", "license": "CC BY-SA 4.0", "real": true}]
}
```

### 6.2 `ranches.geojson`: FeatureCollection, Polygon geometry, properties:
```json
{
  "id": "R0123", "onchain_id": "0x…32 bytes", "role": "breeder|rearer|fattener|intermediary",
  "area_ha": 812.4, "pasture_ha": 640.2, "capacity_head": 960, "head_now": 1180, "breeding_cows": 0,
  "defor_post2008_ha": 120.5, "defor_post2020_ha": 35.1, "in_protected": false, "protected_name": null,
  "embargoed": false,
  "inflow_head": 5400, "outflow_head": 5200, "median_holding_days": 18,
  "risk": {"class": "clean|watch|high", "score": 0.87,
           "flags": [{"code": "PASS_THROUGH", "severity": "high", "title": "Resells animals within 18 days", "text": "plain-language explanation", "evidence": {}}]},
  "upstream_taint_pct": 62.0,
  "status_quo_flagged": false,
  "truth": "honest|dirty_source|launderer|phantom_births|over_capacity"
}
```
Flag codes: `POST2020_DEFORESTATION`, `PROTECTED_AREA`, `EMBARGOED`, `INSUFFICIENT_HERD`, `PHANTOM_BIRTHS`, `OVER_CAPACITY`, `PASS_THROUGH`, `TAINTED_SUPPLY`, `ANOMALY`.

### 6.3 `movements.json`: array
```json
[{"gta": "GTA-PA-2025-000123", "hash": "0x…", "from": "R0123", "to": "R0456|S:<id>|P:BARCARENA",
  "head": 120, "date": "2025-03-14", "purpose": "breeding|rearing|fattening|slaughter|export", "suspicious": false}]
```

### 6.4 `destinations.json`: array (real slaughterhouses + port)
```json
[{"id": "S:SIF_1234", "kind": "slaughterhouse|port", "name": "…", "company": "…", "inspection": "SIF|SIE|SIM",
  "lat": -6.6, "lon": -51.9, "municipality": "…", "real": true}]
```

### 6.5 `shipments.json`: array (lots leaving to sinks; what a buyer would check)
```json
[{"id": "SHP-0007", "destination": "P:BARCARENA", "market": "TR|EU|BR|CN", "head": 2400, "date": "2025-06-02",
  "gtas": ["GTA-…"],
  "trace": {"clean_pct": 58.0, "flagged_pct": 37.0, "unknown_pct": 5.0, "max_hops": 3,
            "by_ranch": [{"ranch": "R0123", "head_equiv": 410.5, "risk_class": "high", "hops": 2}]},
  "status_quo_verdict": "pass|fail", "rastro_verdict": "pass|review|fail",
  "certificate": {"lot_id": "0x…", "verdict": "clean|flagged|unknown", "evidence_hash": "0x…"}}]
```

### 6.6 `metrics.json`
```json
{
  "counts": {"ranches": 300, "movements": 4200, "head_moved": 380000, "shipments": 120},
  "eval": {
    "status_quo": {"precision": 0.9, "recall": 0.21, "tainted_head_caught_pct": 18.0},
    "rastro":     {"precision": 0.88, "recall": 0.9, "tainted_head_caught_pct": 91.0}
  },
  "headline": {"tainted_head_pct_passing_status_quo": 0.0, "laundering_ranches_found": 0},
  "real_data": {"prodes_polygons": 0, "defor_post2020_ha": 0, "ibge_herd_municipality": 2452095, "ibge_year": 2023}
}
```

### 6.7 `layers/deforestation.geojson` (PRODES polygons in AOI; props `year`, `area_ha`), `layers/protected.geojson` (props `name`, `kind` = `indigenous|conservation`), `layers/aoi.geojson`.

### 6.8 `onchain.json` (written by contracts Replay; web must work without it: show "not yet deployed")
```json
{
  "network": "anvil|polygon-amoy|base-sepolia", "chainId": 80002, "address": "0x…",
  "explorer": "https://amoy.polygonscan.com", "rpc": "https://…", "deploy_tx": "0x…",
  "records": [{"kind": "registerRanch|recordMovement|attestRisk|issueCertificate|consumeCertificate|revertDemo",
               "ref": "R0123|GTA-…|SHP-…", "tx": "0x…|null", "block": 123, "status": "success|reverted",
               "revert_reason": "CertificateAlreadyUsed(0x…)|null", "note": "…"}],
  "abi_path": "data/HerdLedger.abi.json"
}
```

## 7. Ground rules
- Honest labelling: every synthetic number is marked synthetic in the UI and README.
- No personal data. No real CPF/CNPJ/CAR codes for ranches.
