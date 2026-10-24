# Rastro architecture

Rastro has four parts with one rule each:

| Part | Owns | Never does |
|---|---|---|
| `pipeline/` (Python 3.12) | ingestion of real layers, the synthetic world, geospatial analysis, lineage, risk scoring, evaluation, evidence bundles, the chain seed | serve users; hold deployed-chain state |
| `contracts/` (Solidity 0.8.30, Foundry) | authoritative state transitions: herd balances, GTA uniqueness, embargoes, birth bounds, one-time certificates | compute risk; read off-chain data |
| `backend/` (FastAPI) | validated, versioned read API over the published bundle | hold keys; recompute risk |
| `web/` (Vite + React + TS) | visualisation and interaction; re-hashes evidence and simulates reverts | decide a verdict; hold a private key |

Oracle signatures (EIP-712) are produced by the replay tooling in `contracts/replay/` from a key in a gitignored env file. No key reaches `backend/` or the browser; the browser only issues read-only `eth_call`s.

## Components

```mermaid
flowchart LR
  subgraph Real["Real public data"]
    PRODES[INPE PRODES 2008-2025]
    PROT[Indigenous lands + conservation units]
    IBGE[IBGE PPM herd]
    TRASE[Trase slaughterhouses + port]
  end

  subgraph Pipeline["pipeline/ (Python)"]
    FETCH[fetch_real.py] --> LAND[landscape.py<br/>ranch cells on real layers]
    LAND --> SIM[rastro.synth<br/>synthetic herds, births, GTAs]
    SIM --> CANON[rastro canonical tables<br/>+ manifest + validation]
    CANON --> GEO[rastro.geospatial<br/>ranch evidence vs PRODES,<br/>TI, UC, embargoes]
    GEO -->|ranch_evidence.geojson| BUNDLE
    SIM --> DET[detect.py<br/>ledger mirror, flags, lineage,<br/>IsolationForest, evaluation]
    DET --> EVID[evidence bundles<br/>SHA-256 addressed]
  end

  subgraph Chain["contracts/ (EVM)"]
    HL[HerdLedger.sol]
    REPLAY[replay.mjs<br/>oracle signs EIP-712]
  end

  subgraph Serve["serving"]
    BUNDLE[(web/public/data<br/>versioned JSON bundle)]
    API[backend/ FastAPI<br/>/health, /api/v1/datasets/*]
    WEB[web/ React app]
  end

  PRODES & PROT & IBGE & TRASE --> FETCH
  DET -->|chain_seed.json| REPLAY --> HL
  REPLAY -->|onchain.json + ABI| BUNDLE
  DET -->|ranches, movements, shipments,<br/>metrics, layers| BUNDLE
  EVID --> BUNDLE
  BUNDLE --> API --> WEB
  BUNDLE -->|static hosting| WEB
  WEB -.->|read-only eth_call| HL
```

The web app works from the static bundle alone (GitHub Pages), so the demo never depends on a running server or a restricted government feed. The API is the validated path for clients that need contract guarantees; both read the same files.

## Data flow

```mermaid
sequenceDiagram
  autonumber
  participant Src as Real sources
  participant P as pipeline
  participant L as HerdLedger (chain)
  participant B as data bundle
  participant W as web / API client

  Src->>P: PRODES, protected areas, IBGE herd, facilities (cached in pipeline/data/raw)
  P->>P: landscape: synthetic ranch cells measured on real layers
  P->>P: synth: births, GTAs, laundering scenarios (+ ground truth, kept apart)
  P->>P: detect: ledger mirror refuses impossible events, flags, FIFO lineage, verdicts
  P->>B: ranches / movements / shipments / metrics / layers / evidence/<sha256>.json
  P->>L: chain_seed.json via replay: register, births, movements, embargoes
  P->>L: oracle-signed attestRisk + issueCertificate (evidence hash anchored)
  L-->>B: onchain.json (tx hashes, totals, conserved, revert demos) + ABI
  W->>B: load bundle (real first, mock fallback, labelled)
  W->>W: SHA-256 of evidence file == anchored hash?
  W-->>L: optional live eth_call of the four "try to cheat" reverts
```

## Identifiers and hashing (shared across all parts)

See [data-dictionary.md](data-dictionary.md) for every field. The cross-cutting conventions:

| Thing | Off-chain id | On-chain id |
|---|---|---|
| Ranch | `R0001`… (synthetic), `X01`… external supplier | `sha256("rastro-demo-salt-v1\|" + id)` as `bytes32` |
| Sink | `S:<SIF\|SIE>_<n>` slaughterhouse, `P:BARCARENA` port | same salted hash |
| GTA | `GTA-PA-<year>-<seq6>`; refused attempts `GTA-PA-ATTEMPT-<seq4>` | salted hash of the GTA record |
| Shipment | `SHP-<seq4>` | certificate `lotId` = hash of the lot |
| Evidence | file `evidence/<sha256-hex>.json` | `evidenceHash` = SHA-256 of the file bytes |

Only salted hashes go on-chain. SPEC §4 says keccak256; the implementation uses SHA-256 of canonical JSON (`detect.py: h32`) for every off-chain-derived id, and both are 32-byte opaque values to the contract.

## Versioning

- Data files are contract **v1** (SPEC §6). Their Python definition is `backend/app/schemas/v1.py`; tests validate every real and mock file against it.
- API routes are prefixed `/api/v1`; data responses are wrapped as `{schema: "rastro.<dataset>/v1", source: "real"|"mock", data}`.
- Additive fields are allowed within v1. Renames, removals or narrowed enums require v2.
- On-chain: EIP-712 domain `Rastro HerdLedger`, version `1`.

## What is real and what is synthetic

Real: PRODES clearings, Indigenous-land and conservation-unit boundaries, IBGE municipal herd, slaughterhouse and port locations. Synthetic: ranch boundaries, herds, births, GTAs, embargoes, laundering behaviour and every result derived from them. The UI tags each; ground truth appears only in Evaluation mode.
