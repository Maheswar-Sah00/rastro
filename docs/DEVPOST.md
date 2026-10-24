# Devpost submission: Rastro

Copy each block into the matching Devpost field.

| Field | Value |
| --- | --- |
| **Project name** | Rastro |
| **Elevator pitch** (≤ 200 chars) | AI that traces every head of Amazon cattle back to the ranch it was born on, and a shared on-chain ledger that refuses the paperwork laundering depends on. |
| **Track** | Sustainable Supply Chains |
| **Try it out** | Live demo: https://maheswar-sah00.github.io/rastro/ · Code: https://github.com/Maheswar-Sah00/rastro |
| **Video** | *(YouTube or Vimeo link, 3–5 min; see [VIDEO_SCRIPT.md](VIDEO_SCRIPT.md))* |
| **Team** | Meghana Pabba · Naga Bhargav Reddy |

---

## Track alignment

**Sustainable Supply Chains: product lifecycle tracking and verification of sustainability claims.** Rastro follows the
life of beef cattle from the ranch where a calf is born, through every farm it passes, to the slaughterhouse or export
ship, and checks the claim every buyer now has to make: that the animal did not come from land deforested after 2020,
from an Indigenous territory or from an embargoed ranch. In the track's terms it is **product lifecycle tracking** for
cattle, and its one-time lot certificate works as a **digital product passport** for a batch of animals: a signed,
verifiable claim that can be spent only once. It also uses real deforestation data, so it touches Climate Data &
Environmental Monitoring, but its job is supply-chain verification.

## Inspiration

Cattle pasture is the biggest driver of Amazon deforestation, and the loophole is well documented. Meatpackers check
only their **direct** suppliers. So a calf born on illegally cleared land is sold to a "clean" intermediary and resold
within days. It reaches the slaughterhouse or an export ship looking legal. In October 2025 Human Rights Watch traced
illegal ranches in Pará into a major meatpacker's supply chain exactly this way. Two months later Pará postponed
individual cattle tracking to 2030. Meanwhile the EU Deforestation Regulation applies to beef from **30 December
2026**. Pará also ships more than half of Brazil's live-cattle exports, mostly to Egypt, Iraq, Lebanon, Morocco and
Türkiye. **Türkiye, host of COP31, is Brazil's largest live-cattle buyer.**

The paperwork that exposes laundering already exists: every movement of cattle in Brazil needs a GTA (animal transit
permit). In October 2025 a federal court ruled that Pará must publish that data. What's missing is a neutral way for
competing buyers to use it.

## What it does

- **Traces every lot.** Rastro follows each permit as a lot through any number of farms (first-in-first-out, with a
  fully-mixed-herd alternative). It tells a buyer what share of a delivery or export voyage was born on ranches with
  post-2020 deforestation (real INPE PRODES data), Indigenous-land overlap, embargoes or impossible births.
- **Finds the launderers (AI).** Five detectors look for post-cut-off clearing, impossible inventories (phantom births,
  shipping more than held), pass-through fronts, over-capacity pastures and unusual behaviour (IsolationForest). Every
  finding stores its values, thresholds and a plain-language reason. Fixed rules turn findings into PASS, REVIEW or
  FLAGGED, and anything uncertain goes to a person, never to PASS.
- **Enforces conservation of cattle on-chain.** HerdLedger refuses a permit for more head than the ranch holds, births
  above what its breeding cows can produce, duplicate permits and any movement from an embargoed ranch. The rules hold
  for every buyer at once, so a refused permit can't be taken to another company.
- **Makes "clean" spendable once.** The oracle signs EIP-712 lot certificates, and each permit can back only one
  certificate. A buyer can consume a certificate exactly once, for one export or one EUDR due-diligence statement.
  Flagged and review lots never get one.
- **Lets anyone verify.** Each certificate anchors the SHA-256 of an RFC 8785 canonical evidence bundle. The console
  re-hashes the evidence, recovers the signer, checks it is an authorised oracle and reads the ledger: 11 checks, all
  read-only.

## Target users

| User | What Rastro gives them |
| --- | --- |
| **Ibama and the Federal Prosecutors (MPF)**, who run the meatpacking monitoring protocol | A ranked list of ranches and permits worth inspecting, each with its evidence |
| **Meatpackers and live-cattle exporters** | Indirect-supplier checks across the whole chain, without seeing competitors' data |
| **EU importers** | EUDR due-diligence evidence from 30 Dec 2026, as a certificate that can't be reused |
| **Importers in Türkiye, Egypt, Iraq and beyond** | The same assurance for live-cattle buyers that no EU law covers |
| **Banks** lending under Brazil's rural-credit environmental rules | A check on where a borrower's cattle really come from |

## How it scales

- **By data, not hardware.** The geospatial engine runs on public layers (PRODES, FUNAI, IBGE) that cover the whole
  Brazilian Amazon, and PRODES-style data exists for the Cerrado too. A new municipality is a new bounding box.
- **Same code for real permits.** The pipeline reads a canonical permit table. When a state publishes its GTA feed,
  it replaces the simulator with no change to the detectors, the API or the contract.
- **Cheap on-chain footprint.** Only salted hashes, counts and certificates go on-chain; the heavy analysis stays
  off-chain. Permits are batched into few transactions.
- **Deterministic and testable.** Every run is pinned to a dataset digest, so results can be reproduced and audited
  as coverage grows.

## How easily it can be adopted

- **No new data collection.** It uses the permits ranchers already file and satellite data that is already public.
- **No change for ranchers.** Nobody installs anything; the burden falls on the buyers who already run supplier checks.
- **Fits existing workflows.** Regulators get a ranked inspection list, buyers a PASS / REVIEW / FLAGGED answer per
  lot, and importers a certificate they can attach to an EUDR statement.
- **Open and verifiable.** MIT-licensed code, a read-only API, and certificates that anyone can verify without trusting
  Rastro.
- **Privacy-preserving.** Only salted hashes go on-chain, which addresses the data-protection objection that has kept
  GTAs closed.

## Results (synthetic ranches on a real landscape)

Measured on **11 held-out synthetic worlds** (a seed never used for tuning), each with 409 ranches and about 10,800
permits over three years around São Félix do Xingu, Brazil's largest municipal herd (2.73 M head):

- **Tainted cattle caught:** Rastro flags **64–84%** outright and sends **89–96%** to flag or review. Today's
  direct-supplier check catches **16–44%**.
- **Clean lots wrongly blocked:** about **10–15%** for Rastro in most scenarios, versus **22–26%** for today's check.
- **Red team** (launderers hold cattle 60–120 days and chain two hops): **70.6%** flagged, **92.5%** with review, versus
  **37.9%** for today's check, with **12.3%** of clean lots blocked versus 22.8%.
- **The ledger alone refused** 191 impossible birth declarations (13,234 head), 90 permits for animals the ranch didn't
  hold (13,542 head) and 15 permits from embargoed ranches (883 head).
- **All 36 live-export voyages** from Barcarena pass today's check. Rastro flags all 36 and fails 34. A Türkiye-bound
  voyage traces 51% of its cattle to flagged ranches, and the largest voyage, to Iraq, 58%.
- **Certificates, run live on a local chain:** a flagged lot was refused, a review lot held, a clean lot issued and
  consumed once. The replay reverted with `CertificateAlreadyIssued`, a second consumption with
  `CertificateAlreadyUsed`.

## How we built it

- **Real data:** INPE PRODES deforestation 2008–2025, Indigenous lands and conservation units (TerraBrasilis), the IBGE
  municipal herd, and Trase slaughterhouse and port locations (CC BY 4.0).
- **Synthetic layer:** a deterministic generator builds 409 ranches on the real landscape with herds, births, permits
  and planted laundering. The ground truth sits in a separate partition the detectors never read. Everything synthetic
  is labelled in the app.
- **AI (Python 3.12):** a GeoPandas/Shapely geospatial engine, a ledger replay identical to the contract's rules,
  multi-hop lot lineage, five detectors including a scikit-learn IsolationForest with reason codes, and an evaluation
  harness with 12 worlds and a held-out seed.
- **Blockchain:** HerdLedger.sol (Solidity 0.8.30, OpenZeppelin AccessControl and Pausable, EIP-712). 227 Foundry tests
  including 12 invariants, 100% line and branch coverage. A signer that cross-checks its digest with the contract
  before submitting. Run on a local anvil chain.
- **Backend:** a read-only FastAPI that holds no keys, with pure-Python EIP-712 signature recovery for verification.
- **Web:** React, TypeScript, Vite and MapLibre. A chart-first landing page and an investigator console with lineage
  graphs, risk breakdowns, certificate verification and a live map.
- **Tests:** 492 automated tests across the pipeline, API, contract and web, plus 9 end-to-end browser checks.

## Challenges we ran into

- **Making the evaluation honest.** Our first detector looked near-perfect on the world we built it on. We rebuilt the
  evaluation with 12 synthetic worlds and a held-out seed, added adversarial scenarios (slower resale, two hops, split
  lots, concealed inventory, missing records) and report the honest held-out numbers.
- **Not over-blocking honest ranchers.** Early versions smeared taint across whole herds and failed most clean lots.
  Lot-level lineage, a 25% blocking threshold and a review band for uncertain lots brought false blocks down to about
  12%.
- **Privacy versus transparency.** Pará objected to publishing GTAs under Brazil's data-protection law. HerdLedger
  stores only salted hashes and counts, and evidence bundles hold no personal data.

## Accomplishments that we're proud of

- The contract and the off-chain replay agree to the head: opening herd 385,912, births 236,221, sent to slaughter or
  export 315,096, on hand 307,037.
- Every verdict can be traced to its evidence, and every certificate can be verified by anyone without trusting us.
- We published where Rastro fails (missing records, split lots) instead of hiding it.

## What we learned

A blockchain alone can't see a cow, and AI alone can't make competitors share a rulebook. Physics-based rules
on-chain catch the impossible; AI catches the plausible-but-suspicious; and keeping uncertain cases with a human is what
makes the system usable by regulators.

## What's next

- Plug in real GTA feeds as states publish them, starting with Pará under the October 2025 ruling.
- Treat missing upstream records as review rather than block, our weakest scenario today.
- Enforce the export-shipment binding inside the contract, add a multi-party oracle, and deploy to a public testnet.
- Pilot with an exporter on one live-export route and with an EU importer preparing EUDR statements; add ear-tag IDs
  when they arrive in 2030.

## Built with

python · geopandas · shapely · scikit-learn · pydantic · fastapi · solidity · openzeppelin · foundry · anvil ·
ethers · eip-712 · rfc-8785 · react · typescript · vite · maplibre · d3 · viem · INPE PRODES · IBGE · Trase

---

**Honesty notes for the form:** ranches, herds, permits and laundering are synthetic; deforestation, protected areas,
the municipal herd and facility locations are real. HerdLedger runs on a local anvil chain, not a public testnet.
