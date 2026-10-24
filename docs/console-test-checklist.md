# Rastro console: test checklist

Run on 2026-10-24 against the live API (`backend/`, uvicorn on port 8017) serving the canonical `data/synthetic/evaluation` dataset. The console was built with `VITE_API_URL=http://127.0.0.1:8017 npm run build` and served by `vite preview` at `http://localhost:4173/console.html`.

How it was exercised: headless Chrome 1440×1000, driven over the DevTools protocol. A script navigates, types into fields, picks options, clicks buttons, nodes and map cells, and reads the rendered page. These are real browser interactions on the built app, not component mocks. The investigator-review rows wrote two append-only reviews (reviewer `console-test`) on finding `F-28c5b677a249a708` of SHP-D-001239.

Result: **47/47 live checks, 3/3 offline/demo checks, 13/13 responsive checks, 18/18 unit tests passed.**

## Navigation, search, filters, detail views

| Check | Result | Notes |
|---|---|---|
| Overview: KPIs from API | PASS | 414 ranches, 10,844 movements, 2,853 shipments assessed, 688 review, 572 flagged |
| Environment banner shows local chain, not public | PASS | "Local chain (anvil replay)"; RPC unreachable, recorded replay |
| No DEMO MODE badge against the live API | PASS | |
| Global search routes ranch id (r0120 → #/ranches/R0120) | PASS | |
| Ranch detail: findings and environmental evidence | PASS | |
| Global search routes shipment id | PASS | |
| Global search rejects unknown text with guidance | PASS | |
| Ranch filter risk=high returns only HIGH | PASS | 25 rows |
| Ranch pagination moves to page 2 | PASS | |
| Live Map: ranch drawer opens with evidence and findings | PASS | |
| Live Map: layer selector and legend | PASS | |
| Live Map: canvas rendered | PASS | |
| Live Map: clicking a ranch cell selects it (URL ranch= updates) | PASS | #/map?ranch=R0114 |
| Movements filter: refused (origin embargoed) only | PASS | 15 rows |
| Movement row opens canonical GTA page with ledger status | PASS | |
| Movements filter: date range | PASS | 30 rows on page 1 |
| Movements filter: ranch (origin or destination) | PASS | 30 rows on page 1 |
| GTA page shows lineage of its lot | PASS | |
| Lot page: pro-rata policy toggle re-traces | PASS | |
| Shipments filter decision=REVIEW | PASS | 30 rows |
| Investigations queue lists flagged + review shipments + ranch leads | PASS | |
| Certificate verify: status, usable flag, hash checks, local label | PASS | demo certificate: consumed, not usable, hashes match |
| Load all issued certificates joins replay + bundle | PASS | |
| HerdLedger: connection label says not a public network | PASS | |
| HerdLedger balance read: result or explicit chain-unavailable error | PASS | RPC down: structured 503 error shown |
| Evaluation page: confusion matrices and metrics from API | PASS | |
| Data Sources: dataset digest, component status, readiness | PASS | |
| Unknown route shows not-found state | PASS | |
| Missing record shows 404 state | PASS | #/ranches/R9999 |

## Shipment investigation workspace (SHP-D-001239, SHP-D-001677)

| Check | Result | Notes |
|---|---|---|
| Header: decision, synthetic label, coverage, freshness | PASS | FLAGGED, "Not a verified record", 83.5%, 2026-10-24 |
| Graph totals consistent with API | PASS | SHP-D-001239: origins 103.0 = API `totals.source_head_fifo` 103.0 = 103 declared |
| Breakdown: separate bars, unique total, non-additivity note | PASS | bars sum to 183.5 %, unique 100.0 % (103 head) |
| Highlight a category lights its paths | PASS | unknown origin: 2 links |
| Node panel: contribution, pro-rata alternative, categories, provenance | PASS | |
| Expand a branch via the API (`?expand=`) | PASS | view switches to "branch", back to whole lot |
| Edge panel: GTA id, date, head | PASS | |
| Finding evidence: observed values vs thresholds, detector version, hash | PASS | |
| Review form requires reviewer and reason | PASS | |
| Review recorded: status + history entry, original hash kept | PASS | |
| Dismissed blocking finding shows "blocking rule still applies" | PASS | |
| Decision unchanged after review | PASS | still FLAGGED |
| Assess action returns the canonical decision, same outcome | PASS | |
| Download evidence + JSON/MD/CSV report links answer 200 | PASS | `Content-Disposition: attachment` confirmed with curl (zip, csv) |
| Downloaded JSON report breakdown equals the risk breakdown shown | PASS | |
| Open on Live Map routes with shipment + focus | PASS | |
| Map shows the shipment's upstream routes | PASS | |
| SHP-D-001677: graph consistent, unknown origin explicit, overlapping categories | PASS | origins 105.0 = 105.0 = 105; unique 94.3 % (99 head) |

## Offline and demo mode

| Check | Result | Notes |
|---|---|---|
| API down: error state, banner "API offline", no fabricated numbers | PASS | API process stopped |
| DEMO MODE: labelled badge, investigation served from captured fixtures | PASS | `console.html?demo=1` |
| DEMO MODE: uncaptured view says so instead of inventing data | PASS | |

## Responsive (390 px, mobile emulation)

No horizontal page overflow on Overview, Live Map, Ranches, Movements, Shipments, SHP-D-001677, R0120, a GTA page, Investigations, Evaluation, Data Sources, Certificates, HerdLedger (`documentElement.scrollWidth` = 390). Wide tables and the graph scroll inside their own panels; navigation moves into a toggle menu.

## Unit tests (`npm test`, vitest)

`src/console/lib/graph.test.ts`, 18 tests on responses captured from the live API for SHP-D-001239 and SHP-D-001677: every API node and edge is kept with its numbers; origin total = API `source_head_fifo`; head into the destination = declared head; columns run origins → destination; unknown-origin nodes match the breakdown's unknown head; category bars overlap (sum > unique); the JSON lineage report's breakdown equals `/risk`'s, and every report source equals the graph node of the same id; category highlighting only lights paths downstream of marked nodes; cycle breaking and malformed edges; id search routing; missing ≠ zero formatting.

## Not covered

- Screenshots from a headed browser on a physical phone; the responsive pass used Chrome's mobile emulation.
- A live RPC chain: the anvil node was not running, so chain reads came from the recorded replay (labelled as such).
