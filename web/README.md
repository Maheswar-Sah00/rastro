# Rastro web app

Judge-facing site for **Rastro**: *A cow is born once, dies once, and can't be in two places. Neither can its paperwork.*

Single-page app (Vite + React + TypeScript, MapLibre GL, d3-sankey) with five sections and hash deep links:

| Section | Hash | What it shows |
|---|---|---|
| Problem | `#problem` | Tagline, sourced context tiles, headline result from `metrics.json`, the laundering pattern, the five "conservation of cattle" rules |
| Map explorer | `#map`, `#ranch/R0120` | PRODES clearings by year (post-2020 highlighted), cleared-before-2008 mask, protected areas, ranches by risk class, aggregated cattle flows (suspicious in red, ledger-refused dashed), slaughterhouses and port. Filters, legend, satellite toggle. Click a ranch for the detail panel |
| Trace a shipment | `#trace`, `#trace/SHP-0008` | Live-export voyage strip with destination filter (default `SHP-0008`, Türkiye-bound; `SHP-0018`, Iraq-bound, is offered as the biggest), delivery picker, clean / watch / flagged / unknown composition, origins → direct suppliers → shipment Sankey, "Today's check" vs "Rastro" verdicts, lot certificate with evidence verification |
| Ledger | `#ledger` | Permits refused by the contract, four "try to cheat" revert demos, on-chain record browser |
| How it works | `#how` | Architecture diagram, evaluation and stress test, honest limits, sources and licences, evaluation-mode toggle, team links |

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check (tsc -b) + production build into dist/
npm run preview    # serve dist/ at http://localhost:4173
```

Node 20+ (tested with Node 22).

## Data

The app reads JSON from `public/data/` (schemas: `docs/SPEC.md` §6). For every file it tries `data/<file>` first and falls back to `data/mock/<file>`; anything served from the mock bundle gets a visible **Mock** tag, and the header badge lists which files are mocks.

* Real files: written by the pipeline (`meta.json`, `metrics.json`, `ranches.geojson`, `movements.json`, `shipments.json`, `destinations.json`, `layers/*.geojson`, `evidence/*.json`) and by the contracts replay (`onchain.json`, `HerdLedger.abi.json`). Drop them in and rebuild; no code change.
* At build time a manifest `data/_files.json` is emitted listing which real and mock files exist, so the browser never requests a missing file (no 404s in the console). In `npm run dev` the manifest is generated live. **Rebuild after changing data.**
* URL switches: `?data=mock` forces the mock bundle, `?data=real` disables the fallback.
* Mock bundle: `npm run mock` regenerates `public/data/mock/` deterministically (`scripts/gen-mock.mjs`). Every mock layer is synthetic, including deforestation and the protected-area outline.
* Large files (`movements.json`, `shipments.json`, deforestation) load only when their section approaches the viewport. Flow aggregation over ~11k movements takes ~15 ms, so it runs on the main thread.

### Fields used beyond SPEC §6 (all optional)

| File | Field | Used for |
|---|---|---|
| `ranches.geojson` | `in_protected` (= Indigenous-land overlap), `uc_name`, `births_declared`, `births_biological_max`, `capacity_peak_pct`, `defor_by_year`, `ti_overlap_ha`, `uc_overlap_ha`, `rejected_gtas`, `sells_direct`, `risk.evidence_hash` | Ranch panel gauges, clearing-by-year bars, protected overlap, "today's check never sees it", evidence verification |
| `ranches.geojson` | `truth` | Shown only in **Evaluation mode** |
| `movements.json` | `rejected` (`OriginEmbargoed` / `InsufficientHerd` / null) | Dashed red flows on the map; excluded from flow tracing; refused counts |
| `shipments.json` | `kind` (`voyage` / `delivery`), `market` country codes for voyages (EG, IQ, LB, MA, TR, SA, JO), `direct_suppliers`, `trace.watch_pct`, `trace.n_origins`, `truth_tainted_pct` | Voyage strip, picker, verdict text, composition bar; ground truth in evaluation mode |
| `shipments.json` | `trace.links` = `[{origin, via, head, class}]` (`via` = direct supplier, `origin: "other:<class>"` = aggregated tail) | Exact origins → direct suppliers → shipment Sankey (top 18 origins drawn, the rest folded by class). Without it the Sankey is rebuilt from `trace.by_ranch` + `movements.json`, with the remainder split by class to match the published percentages |
| `metrics.json` | `headline.tainted_head_pct_caught_rastro`, `eval.*.clean_lots_failed_pct`, `eval.*.network_recall`, `ledger.refused`, `stress_test`, `thresholds`, `real_data.prodes_polygons_in_window` | Headline tile, evaluation bars, stress test, refused counts, verdict rule text |
| `onchain.json` | `roles`, `demo.labels`, record `evidence_hash`, record `call` | Live revert demos and demo targets; anchored hash for evidence verification |
| `evidence/<hex>.json` | file bytes | "Verify evidence": SHA-256 (WebCrypto) of the exact bytes vs. `risk.evidence_hash` / `certificate.evidence_hash` (or the on-chain record's `evidence_hash` when present). "Tamper" edits one number in memory to show the mismatch |

### Revert demos ("Try to cheat")

Buttons match `onchain.json` records with `kind: "revertDemo"` by error name: `CertificateAlreadyUsed`, `CertificateNotClean`, `OriginEmbargoed`, `BirthsExceedBiology` (or `ref: "PHANTOM_BIRTHS"`). By default they replay the recorded result. If `onchain.json` has an `rpc`, a **Live eth_call** switch appears (on automatically when `network` is not `anvil`, off otherwise): the call is rebuilt from the ABI and `roles` (or taken verbatim from a record's `call: {from, to?, data}`), sent as `eth_call`, and the revert is decoded with the ABI. Unreachable RPCs fall back to the recorded result. Live calls to a local anvil only work from `localhost` with the replayed chain state running.

## Deploy to GitHub Pages

1. Copy `web/.github/workflows/pages.yml` to `.github/workflows/pages.yml` at the repository root (it assumes this app lives in `web/`; adjust `working-directory` and the artifact path otherwise).
2. Repository settings → Pages → Source: **GitHub Actions**.
3. Push to `main`.

The default base path is `./`, which works from any sub-path because navigation uses the URL hash. To pin an absolute base: `VITE_BASE=/rastro/ npm run build`.

## Where things live

```
src/
  App.tsx                 layout, hash routing, ranch drawer
  lib/data.ts             loader (real → mock fallback, manifest, tolerant parsers), indexes, evidence fetch
  lib/trace.ts            Sankey graph builder for a shipment
  lib/flows.ts            movement aggregation → map flow lines
  lib/chain.ts            revert demos (recorded / live eth_call)
  lib/evidence.ts         SHA-256 + tamper
  lib/content.ts          sourced context facts, basemap credits, team links (placeholders), name repair
  components/Hero.tsx     problem section
  components/MapSection.tsx + MapView.tsx   map explorer (MapLibre loads lazily)
  components/RanchPanel.tsx                 ranch detail drawer
  components/TraceSection.tsx + Sankey.tsx  shipment trace
  components/LedgerSection.tsx              ledger + try to cheat
  components/HowItWorks.tsx                 architecture, evaluation, limits, sources, team
scripts/gen-mock.mjs      deterministic mock bundle
vite.config.ts            base path, data manifest plugin
```

## Honesty notes

* Ranch boundaries, herds, movement permits, embargo matches and every result derived from them are synthetic and tagged **Synthetic** in the UI. PRODES clearings, protected areas, slaughterhouse and port locations and the municipal herd are real and tagged **Real**. Slaughterhouse names are anonymised.
* Ground-truth labels from the simulator appear only in Evaluation mode.
* Basemap: OpenFreeMap vector tiles (© OpenMapTiles, © OpenStreetMap contributors) and Esri World Imagery for the satellite toggle; attribution is shown on the map.

## Known

* The OpenFreeMap Positron style logs one MapLibre warning (`Expected value to be of type number, but found null`) from its own layers; it is harmless.
* Team names, repo and video links in `src/lib/content.ts` are placeholders.
* Add `?debug` to the URL to expose the map instance as `window.__map` and log map errors.

## Analyst console (`console.html`)

A second page for investigators and compliance analysts, served next to the public site and backed by the Rastro API (`backend/`). It has Overview, Live Map, Ranches, Movements, Shipments (with the shipment investigation workspace), Investigations, Certificates, HerdLedger, Evaluation and Data Sources, plus a global id search (ranch, GTA, lot, shipment, certificate).

```bash
# API first (see backend/README or docs/api.md)
cd backend && .venv/Scripts/python -m uvicorn app.main:app --port 8000
# console
cd web && npm run dev            # then open http://localhost:5173/console.html
VITE_API_URL=http://127.0.0.1:8000 npm run build && npm run preview   # http://localhost:4173/console.html
npm test                         # vitest: lineage-graph and aggregation helpers
```

* **API only.** Every number comes from `/api/v1`. The typed client is `src/console/api/client.ts`, with all types in `src/console/api/types.ts`. Failures show an error state with the request id; nothing is silently replaced. The movement list reads the published bundle via `/api/v1/datasets/movements`, because the API has no global GTA list; each row opens `/api/v1/gtas/{id}`.
* **Environment banner** comes from `/health`, `/ready` and `/chain/status`: "Local simulation", "Local chain (anvil replay)" or "Public testnet". The last appears only when the API reports `verified_public`.
* **DEMO MODE** (`console.html?demo=1` or `VITE_CONSOLE_DEMO=1`) serves responses captured from a running API in `src/console/fixtures/`, behind a visible DEMO MODE badge. Views without a captured response say so.
* **Investigation workspace** (`#/shipments/SHP-…`) shows:
  * the lineage graph from `/lineage/graph`: summarised, full or branch views, category highlighting, and node and edge panels, with a FIFO note and the pro-rata alternative;
  * the risk breakdown from `/risk`;
  * findings with append-only investigator reviews (`/findings/{id}`, `POST /findings/{id}/reviews`);
  * downloads (evidence zip, lineage report JSON/MD/CSV), the canonical assessment and "Open on Live Map".

  No action can change a decision.
* Map layers are the published `public/data/layers/*.geojson`. Ranch cells are labelled synthetic; routes join ranch-cell centroids to real facility coordinates.
* Manual test results: [docs/console-test-checklist.md](../docs/console-test-checklist.md).
