# Integration and security report (Task 11)

Date: 24 Oct 2026. Environment: Windows 11, Python 3.12.0, Node 22.17.1, Foundry 1.8.6, local anvil (chain 31337). Everything below was executed; nothing is extrapolated. Ranch, herd and permit data is synthetic.

## Test matrix

| Category | Command | Result | Remaining failures / notes |
|---|---|---|---|
| Python pipeline: unit + integration | `cd pipeline && python -m pytest -rs` | **152 passed, 0 skipped**, 159 s | none |
| Backend API: unit + integration | `cd backend && .venv/Scripts/python -m pytest -rs` | **86 passed, 0 skipped**, 68 s | one third-party deprecation warning (Starlette TestClient) |
| Contracts (Foundry) | `cd contracts && forge test` | **227 passed, 0 failed, 0 skipped** (10 suites, 12 invariants) | Task 05 coverage: 100 % lines/branches/functions of `HerdLedger.sol` |
| Frontend unit | `cd web && npm test` | **18 passed** | |
| Frontend production build | `cd web && npm run build` | **success** (both `index.html` and `console.html`) | maplibre chunk > 500 kB warning (known) |
| End-to-end browser | `cd web && API_URL=http://127.0.0.1:8010 npm run e2e` (API on 8010, `vite preview` on 4173, anvil on 8545) | **9 / 9 passed** | needs the three servers running; not part of the default test commands |
| Live certificate workflow | `cd pipeline && python -m rastro.certificates.issue demo ../data/synthetic/evaluation` (anvil) | 8 / 8 cases behaved as specified | see [certificates.md](certificates.md) |
| Red-team evaluation | `cd pipeline && python -m rastro.evaluation.run` | 12 worlds generated, validated and assessed | see [evaluation.md](evaluation.md) |
| Full pipeline | `cd pipeline && python run_all.py --no-fetch` | succeeded; the published web bundle was byte-identical before and after | last executed before the lineage, risk and evaluation steps were appended; those steps were each run separately afterwards |
| Dependency audit | `pip-audit -r backend/requirements.txt`; `npm audit` in `web/` and `contracts/` | Python: no known vulnerabilities (after `geopandas` 1.1.2); contracts: 0; web: 1 critical (`maplibre-gl`, accepted, see below) | |

Untested, stated plainly:
- No public-testnet deployment was executed, so nothing claims one.
- No physical mobile device was used; the console agent checked phone width in Chrome's mobile emulation.
- The browser e2e is not wired into a CI job.

## Demonstration workflow (all 11 steps executed)

| # | Step | How | Evidence |
|---|---|---|---|
| 1 | Generate / load the dataset | `python -m rastro.synth.generate --preset evaluation` | validated; digest `614e89ad…` (seed 7) |
| 2 | Geospatial analysis | `python -m rastro.geospatial.run <dataset>` | 409 ranch evidence records |
| 3 | Herd inventory and movements | canonical tables + ledger replay | 14,724 inventory rows; refusals match `detect.py` and the on-chain replay |
| 4 | Trace a shipment | `python -m rastro.lineage.trace <dataset> SHP-D-001677`, console investigation page | conservation matches the on-chain totals exactly |
| 5 | Risk detection | `python -m rastro.risk.run <dataset>` | 1,963 findings; decisions FLAGGED / REVIEW / PASS |
| 6 | Evidence bundle | `rastro.certificates.bundle.build_bundle` | RFC 8785 bytes stored under their hash |
| 7 | Hash the canonical evidence | SHA-256 over the RFC 8785 bytes | verifier recomputes from the stored bytes |
| 8 | Issue or reject a certificate | `rastro.certificates.issue` | SHP-D-000080 (FLAGGED) refused; SHP-D-000006 issued (tx `0x5153…680f`, block 101) |
| 9 | Verify against the ledger | `POST /api/v1/certificates/{id}/verify`, console Certificates page | `valid`, 11 checks; the UI shows the same outcome (e2e) |
| 10 | Replay attempt rejected | `issue resubmit`, second `consume` | `CertificateAlreadyIssued`, `CertificateAlreadyUsed` |
| 11 | Export the investigation report | `GET /shipments/{id}/lineage/report`, `/evidence/download`, `/certificates/{id}/report` | JSON, Markdown, CSV, zip and HTML; e2e checks the certificate report |

## Contract, backend and UI consistency

- **Quantities.** The UI matches the backend: the e2e compares the decision, declared head, graph totals (source plus unknown head equals the declared head) and the summary counts with the API. The console unit tests compare the report, breakdown and graph numbers on captured API responses.
- **Certificate state.** The backend matches the contract. Status, evidence hash, shipment and oracle are read with live `eth_call` (`certificateStatus`, `certificate`, `isOracle`) whenever a node is reachable. The recorded replay is used only as a labelled fallback, with `verified_public: false`.
- **Evidence hashes.** Each hash matches the exact canonical bytes. The verifier re-hashes the stored bytes, also checks they are in canonical form, and rebuilds the bundle to report whether the assessment changed. The signer refuses to submit if its EIP-712 digest differs from `HerdLedger.hashCertificate`.
- **No status guessed in the UI.** The console shows only API responses. A failed request shows an error with the request id and is never replaced by fixtures. DEMO MODE is opt-in and badged.
- **Transaction failures are visible.** Reverts are decoded by name in the registry, the API and the console. Nothing is recorded as successful without a mined receipt with status 1.
- **Mock vs real chain.** The banner reads *Local simulation*, *Local chain (anvil)*, *Local chain (anvil replay)* or *Public testnet*, the last only when `verified_public` is true. The e2e asserts the banner never says "Public testnet" for local data.

## Data-integrity coverage

| Case | Tests |
|---|---|
| Duplicate GTA ingestion | `test_synth::test_duplicate_identifier_is_rejected`, `test_lineage::test_impossible_chronology_and_duplicates_and_self_loops`, contract `DuplicateGta` |
| Missing upstream records | `test_lineage::test_missing_upstream_record`, `test_redteam::test_missing_records`, scenario S06 |
| Negative inventory | `test_synth::test_negative_inventory_is_rejected`, risk `NEGATIVE_INVENTORY` |
| Impossible births | `test_synth` anomalies, `test_risk` births, contract `BirthsExceedBiology` |
| Out-of-order movements | `test_lineage::test_out_of_order_input_gives_the_same_result`, `..._same_day_ties_are_deterministic` |
| Conflicting source data | `test_issue::test_conflicting_published_permit_is_not_used_as_the_ledger_hash`, risk `DUPLICATE_MOVEMENT` |
| Missing geospatial layers | `test_geospatial::test_missing_layer_gives_nulls_not_zeros`, `..._ranch_outside_layer_coverage_is_null` |
| Changed evidence files | `test_certificate_verify::test_tampered_evidence_is_invalid`, `test_certificates::test_tampering_changes_the_hash`, `test_geospatial::test_changing_a_source_triggers_recalculation` |
| Duplicated certificates | `test_issue::test_duplicate_issuance_is_refused_locally`, contract `CertificateAlreadyIssued` / `GtaAlreadyCertified`, live run |
| Repeated consumption | contract tests, live `CertificateAlreadyUsed`, `test_certificate_verify::test_ledger_state_is_reported[consumed]` |
| Expired certificates | contract `CertificateExpired` (Safeguards), `test_certificate_verify::test_expired_signature_window`, `[expired]` |
| Invalid oracle signatures | contract `InvalidSigner`, `test_certificate_verify::test_unauthorised_signer_is_invalid`, `..._malleable_and_malformed_signatures_are_rejected`, `..._altered_certificate_terms_break_the_signature` |

## Security review

| Area | Finding | Status |
|---|---|---|
| Secret management | No private key in source or frontend env. Anvil's public development keys are used only when the chain id is 31337 (`certify.mjs`). `.env` and `.env.*` are gitignored; `contracts/.env.testnet` exists locally, is ignored, and was not read. | ok |
| Path traversal | **Found and fixed.** `POST /certificates/{id}/verify` used a supplied `evidenceHash` as a file name. Every certificate field is now type-checked (32-byte hex, integers, address) before use; `../` payloads get 422. | fixed, tested |
| API validation | Identifiers are validated by regex in path and query, Pydantic `extra="forbid"` is on, the assess and verify bodies cannot set outcomes (422), and investigator reasons are required for confirm and dismiss (**was optional; fixed**). | ok |
| Access control | The API has no authentication. Read endpoints serve synthetic data. `POST /findings/{id}/reviews` is an append-only annotation that cannot change a decision, but it is unauthenticated and must sit behind auth before any public exposure. There are no admin endpoints. The contract uses OpenZeppelin AccessControl roles, Pausable, and an admin-only unpause. | demo-only; documented |
| Signature replay | EIP-712 domain (chain id + contract), single-use nonces, one certificate per lot and per GTA, digest cross-checked with the contract, high-s rejected. | ok |
| Rate limiting | **Added.** A per-client 60/min sliding window (`RASTRO_RATE_LIMIT_PER_MIN`) on assess, verify, reports, graph, lineage and downloads, returning 429 with `Retry-After`. It is in-memory and per process. | ok for a single process |
| File uploads | None exist. | n/a |
| Cross-origin | CORS allows only `RASTRO_CORS_ORIGINS`, methods GET and POST; `Content-Disposition` is exposed for downloads. Tested: a foreign origin is refused. | ok |
| Dependencies | `geopandas` 1.1.1 → 1.1.2 (PYSEC-2026-62), and `vitest` → 5.0.5 (dev-only critical chain). `maplibre-gl` 5.24 has a critical XSS advisory in `DOM.sanitize()` (fixed only in 6.x). The app never passes HTML to MapLibre (no `setHTML`, `innerHTML` or `dangerouslySetInnerHTML` anywhere in `web/src`), so the vulnerable path is unreachable. **Accepted**, with the 6.x upgrade after the hackathon. | 1 accepted |
| Logging | Structured JSON lines (method, path, status, ms, request id). No bodies, keys or investigator text are logged. | ok |
| Injection | The HTML certificate report escapes every value; the CSV export prefixes `= + - @` cells (**added**); the Markdown report holds only system values; there is no SQL. | ok |

## Operational readiness

- **Structured logging and request ids.** `backend/app/observability.py`; errors return `{error: {code, message, details, request_id}}`.
- **Startup validation.** `/api/v1/ready` (503 until the dataset, geo evidence, lineage and risk artefacts exist) now also reports `build`: dataset id, seed, logical digest, and API, schema and engine versions. Lifespan startup builds the lineage replay in the background.
- **Dependency health.** `/api/v1/chain/status` (RPC, or the labelled fallback); `/health` reports the published bundle.
- **Reproducible setup.** Pinned requirements, a lockfile, Foundry `soldeer.lock`, and [demo-script.md](demo-script.md).
- **Reset for demos.** `python scripts/reset_demo.py`, which clears certificates and reviews. `--chain` also runs `anvil_reset` and re-replays; it refuses any chain except 31337.
- **Safe local defaults.** Mock fallback is labelled, the chain mode `auto` falls back to labelled records, there are no keys in the backend, and the rate limit is on.

## Remaining gaps (not hidden)

1. **On-chain shipment binding.** For export use, the consuming shipment must equal the certificate's signed shipment, but only the trusted consumption service enforces that today. The contract should revert on a mismatch (see [certificates.md](certificates.md)).
2. **Incomplete records over-block.** Scenario S06 wrongly flags 43.6 % of clean lots; see [evaluation.md](evaluation.md).
3. **Port clash.** On this machine port 8000 is used by another local project, so the e2e ran the API on 8010 and built the console with `VITE_API_URL=http://127.0.0.1:8010`. The default remains 8000.
4. **No git repository.** `rastro/` is not its own git repository yet, which the Devpost submission needs.
5. **Accepted `maplibre-gl` advisory**, as above.
