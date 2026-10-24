# Rastro interface contracts

> The full HTTP API (all `/api/v1` endpoints, error codes, examples, frontend guidance) is documented in [api.md](api.md); section 1 below covers only the original read-only routes.

Three interfaces cross a process boundary. Each is versioned.

## 1. HTTP API (`backend/`, v1)

Base URL in local runs: `http://127.0.0.1:8000`. Read-only, `GET` only, CORS limited to `RASTRO_CORS_ORIGINS`. OpenAPI at `/docs` and `/openapi.json`.

### `GET /health` (alias `GET /api/v1/health`)

```json
{
  "status": "ok",
  "version": "0.1.0",
  "api_version": "v1",
  "schema_version": "1",
  "data_dir_found": true,
  "datasets": {"meta": "real", "metrics": "real", "ranches": "real", "movements": "real",
               "shipments": "real", "destinations": "real", "onchain": "real"}
}
```

`status` is `degraded` when the data directory or any dataset is missing. Each dataset reports `real`, `mock` (served from `mock/`) or `null`.

### `GET /api/v1/datasets/{name}`

`name` ∈ `meta`, `metrics`, `ranches`, `movements`, `shipments`, `destinations`, `onchain`.

```json
{"schema": "rastro.shipments/v1", "source": "real", "data": [ ... ]}
```

| Status | When |
|---|---|
| 200 | file found and valid against `backend/app/schemas/v1.py` |
| 404 | unknown dataset name, or the file has not been generated |
| 500 | the file exists but breaks the v1 contract (the API refuses to serve it) |

## 2. Data bundle (`web/public/data/`, v1)

Produced by `pipeline/detect.py` and `contracts/replay/replay.mjs`, consumed by the web app and the API. Field definitions: [SPEC.md §6](SPEC.md) and [data-dictionary.md](data-dictionary.md). Machine-checked by `backend/tests/test_schemas.py` and `pipeline/tests/test_published_integrity.py`.

| File | Producer | Shape |
|---|---|---|
| `meta.json` | pipeline | object |
| `metrics.json` | pipeline | object |
| `ranches.geojson` | pipeline | FeatureCollection of Polygon |
| `movements.json` | pipeline | array |
| `shipments.json` | pipeline | array |
| `destinations.json` | pipeline | array |
| `layers/{aoi,deforestation,protected,cleared_before_2008}.geojson` | pipeline | FeatureCollection |
| `evidence/<sha256>.json` | pipeline | canonical JSON; file name = SHA-256 of its bytes |
| `onchain.json`, `HerdLedger.abi.json` | contracts replay | object, ABI array |

`mock/` holds a deterministic synthetic bundle with the same shapes (`web/scripts/gen-mock.mjs`).

## 3. Chain seed (`pipeline/out/chain_seed.json`, version 1)

Pipeline → contracts replay. Registers sinks and ranches, then applies `events` in order (births, movements, embargoes), then relays oracle messages. The replay checks it offline against a JavaScript mirror of the ledger before sending anything. Example: `contracts/test/fixtures/chain_seed.sample.json`.

## 4. Smart contract (`HerdLedger`, EIP-712 domain `Rastro HerdLedger` v1)

Full table of functions, roles and reverts: [contracts/README.md](../contracts/README.md). Interface: `contracts/src/IHerdLedger.sol`.

| Role | Holder in the real world | Calls |
|---|---|---|
| REGISTRAR | state animal-health agency | `registerRanch`, `registerSink`, `recordBirths`, `recordDeaths` |
| ISSUER | same agency | `recordMovement` |
| REGULATOR | Ibama / federal prosecutors | `setEmbargo`, `revokeCertificate` |
| ORACLE | Rastro model signer (off-chain key) | signs `RiskAttestation`, `Certificate` |
| BUYER | meatpacker, exporter, importer | `consumeCertificate` |

Signed messages:

```
RiskAttestation(bytes32 ranch,uint8 riskClass,uint16 scoreBps,bytes32 evidenceHash,uint64 asOf,uint256 nonce)
Certificate(bytes32 lotId,bytes32 sink,bytes32[] gtaHashes,uint32 head,uint8 verdict,bytes32 evidenceHash,uint256 nonce)
```
