# Devpost submission: Rastro

**Tagline (≤ 200 chars):** AI that traces every lot of Amazon cattle to the ranch it was born on, plus an on-chain ledger that enforces "conservation of cattle" across every buyer, so laundered animals can't slip through.

**Track:** Sustainable Supply Chains: product lifecycle tracking and verification of sustainability claims. It also covers Climate Data & Environmental Monitoring: verification of deforestation data.

---

## Inspiration

Cattle pasture is the biggest driver of Amazon deforestation, and the loophole is well documented. Meatpackers check only their direct suppliers. So a calf born on illegally cleared land, or inside an Indigenous territory, is sold to a "clean" intermediary and resold within days. It reaches the slaughterhouse or an export ship looking legal. In October 2025 Human Rights Watch traced illegal ranches in Pará into JBS's supply chain this way. Two months later Pará postponed individual cattle tracking to 2030. Meanwhile the EU Deforestation Regulation applies to beef from **30 December 2026**. Pará also ships more than half of Brazil's live-cattle exports, mostly to Egypt, Iraq, Lebanon, Morocco and Türkiye. **Türkiye, host of COP31, is Brazil's largest live-cattle buyer.**

The paperwork that exposes laundering already exists: every movement of cattle in Brazil needs a GTA (animal transit permit). In October 2025 a federal court ruled that Pará must publish that data. What's missing is a neutral way to use it across competing buyers.

## What it does

- **Traces every lot.** Rastro follows each GTA as a lot, first-in-first-out, through any number of farms. It tells a buyer what share of a slaughter delivery or export voyage was born on ranches with post-2020 deforestation (from real INPE PRODES data), Indigenous-land overlap, environmental embargoes or impossible births.
- **Finds the launderers.** It flags pass-through intermediaries, over-capacity "fronts" and phantom births, and runs an IsolationForest over movement behaviour for patterns nobody named. Every flag carries a plain-language explanation and its evidence.
- **Enforces conservation of cattle on-chain.** HerdLedger refuses a GTA for more head than the ranch holds, births above what its breeding cows can biologically produce, and any movement from an embargoed ranch. It also flags herds above pasture capacity.
- **Makes "clean" spendable once.** The Rastro oracle signs lot certificates (EIP-712), and each GTA can back only one certificate. A buyer can consume a certificate exactly once, for one export shipment or one EUDR due-diligence statement. Flagged lots can't be passed off as clean.
- **Makes evidence tamper-evident.** The SHA-256 of every evidence bundle is anchored on-chain, and the web app re-hashes the published file in your browser.

## Results (synthetic evaluation on a real landscape)

On 409 ranches, 10,844 GTAs and 3 years around São Félix do Xingu (2.73 M head, Brazil's largest municipal herd):

- Today's direct-supplier check lets **67% of tainted cattle** through. Rastro catches **90%**, and wrongly blocks **7%** of clean lots versus 27% today.
- It finds **14 of 14** laundering ranches. Today's check finds 3.
- **Red team:** when launderers hold cattle 60–120 days and chain two hops, Rastro still catches **83%** (today: 45%).
- The ledger alone refused **191 impossible birth declarations, 90 GTAs for animals the ranch didn't hold, and 15 GTAs from embargoed ranches.**
- **All 36 live-export voyages** from Barcarena passed today's check. Rastro flags all 36 and fails 34. A Türkiye-bound voyage traces 51% of its cattle to flagged ranches, and the largest voyage 58%.

## How we built it

- **Real data:** INPE PRODES yearly deforestation 2008–2025 and clearing up to 2007, Indigenous lands and conservation units (TerraBrasilis WFS), IBGE municipal herd (SIDRA), and Trase's slaughterhouse locations (CC BY 4.0).
- **Synthetic layer:** 409 ranch boundaries over the real landscape, 3 years of herds, births and GTAs, and planted laundering behaviour as ground truth. All of it is labelled synthetic in the app.
- **AI (Python):** a geopandas/shapely geo-checker, a ledger mirror, FIFO lot lineage, behavioural rules and a scikit-learn IsolationForest. We evaluate against the status quo and a red-team variant.
- **Blockchain:** HerdLedger.sol (Solidity, OpenZeppelin AccessControl + EIP-712). It has role-separated issuers, regulators, oracle and buyers, with fuzz and invariant tests for conservation, one-time certificates and embargo enforcement. Deployed to a public testnet.
- **Web:** React + TypeScript + MapLibre. Map explorer, ranch evidence panel, shipment trace Sankey, "Try to cheat" buttons that hit the contract, and in-browser evidence verification.

## Challenges

- **Making the evaluation honest.** Our first version smeared taint across whole herds and failed 53% of clean lots. Lot-level lineage, a quarterly capacity rule and a review band brought that down to 7%.
- **Not fooling ourselves.** Ranch-level scores look perfect because dirty sources come from the same real layers the detector reads. So we lead with lot-level catch rate, false alarms and a red-team run where the launderers adapt.
- **Privacy versus transparency.** Pará objected to publishing GTAs under Brazil's data-protection law (LGPD). HerdLedger stores only salted hashes and counts, and the evidence bundles hold no personal data.

## What's next

- Plug in real GTA feeds as states publish them, starting with Pará, under the October 2025 ruling, and Paraná.
- Pilot with an exporter on one live-export route, and with an EU importer preparing EUDR due-diligence statements.
- Add individual ear-tag IDs where they exist, and Sentinel-1 pasture-occupancy checks to catch over-capacity directly.

## Built with

python · geopandas · shapely · scikit-learn · solidity · openzeppelin · foundry · eip-712 · react · typescript · vite · maplibre · d3 · viem · INPE PRODES · IBGE · Trase
