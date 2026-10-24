# Demo video script: Rastro (target 4:30, hard limit 5:00)

Record in a 1920×1080 browser window at 100% zoom, dark theme. Before recording: anvil running with the replayed
state, the API up, the console built against it, and the landing page open at its empty hash (hero only). Speak
slowly; the numbers matter more than the words. The rules ask for three things: the climate problem, how the solution
works, and its real-world impact. Scenes 1–2, 3–7 and 8 cover them in that order.

| # | Time | On screen | Voice-over |
| --- | --- | --- | --- |
| 1 | 0:00–0:25 | Landing hero over the Sentinel-2 image of São Félix do Xingu | "This is São Félix do Xingu, in the Brazilian Amazon: 2.7 million cattle, the largest herd of any municipality in Brazil. Cattle pasture is the biggest driver of deforestation in the Amazon, and the rules meant to stop it have a hole." |
| 2 | 0:25–0:55 | Click **Explore Rastro**; the Problem section | "Meatpackers check only their direct suppliers. So a calf born on illegally cleared land is sold to a clean-looking ranch and resold days later. It arrives looking legal. Pará has postponed individual cattle tracking to 2030. The EU deforestation law covers beef from 30 December this year. And Pará ships more than half of Brazil's live cattle, mostly to the Middle East, North Africa and Türkiye, Brazil's biggest buyer." |
| 3 | 0:55–1:25 | Map section: step 1 *Forest lost* (pink = after the EUDR cut-off), step 2 *Ranches rated* | "Rastro starts from real satellite data: every pink patch is forest cleared after 2020, mapped by INPE. The ranches on top are simulated, because the government permits aren't public yet. Rastro checks each one against the clearing, Indigenous land, protected areas and embargoes." |
| 4 | 1:25–2:05 | Trace section: **Trace a ship to Türkiye** (SHP-0008), its source ranches and both verdicts; then the 36-voyage chart | "Every movement of cattle needs a permit, a GTA. Rastro follows those permits back, lot by lot, through every farm. This ship left Barcarena for Türkiye. Today's check passes it. Rastro traces half of its cattle to flagged ranches, up to three farms back, and fails it. All 36 export voyages in our three years pass today's check. Rastro fails 34." |
| 5 | 2:05–2:35 | Results section: today's check vs Rastro; switch to the red-team toggle | "On worlds we never tuned on, Rastro flags about 7 in 10 tainted animals outright, and sends 9 in 10 to a flag or a human review. Today's check catches 2 to 4 in 10. And Rastro wrongly blocks about half as many honest ranchers. When launderers adapt, holding cattle for months and chaining two intermediaries, it still flags 70%." |
| 6 | 2:35–3:15 | Ledger section: press the four **Try it** buttons; then the refusals chart | "Some cheating breaks physics, so we put those rules on a blockchain that every buyer shares. Use the same clean certificate twice: refused. Sell a flagged lot as clean: refused. Ship from an embargoed ranch: refused. Declare 500 calves for a farm with 40 cows: refused. Over three years the ledger alone stopped more than 27,000 head of paper cattle." |
| 7 | 3:15–4:05 | **Console**: Investigations → `SHP-D-001677` (lineage graph, risk breakdown, "why this decision"); then Certificates → **Verify** a live certificate (11 checks pass) | "This is the investigator console. For any shipment it shows where the cattle came from, which findings fired, and why the verdict is what it is. The AI produces findings; fixed rules decide; and anything uncertain goes to a person. A clean lot gets a signed certificate that can be used exactly once, for one export or one EU statement. Anyone can verify it: the evidence is re-hashed, the signature checked, and the ledger read directly. Only salted hashes go on-chain, so no personal data is exposed." |
| 8 | 4:05–4:30 | README on GitHub (system diagram), then the landing hero | "Rastro runs on public data for any Amazon municipality. When states publish their permit data, as a federal court ordered Pará to do, it plugs in with no change to the detectors or the contract. A cow is born once, dies once, and can't be in two places. Neither can its paperwork. This is Rastro." |

**Say it honestly on screen:** ranches and permits are simulated on real deforestation data; the ledger runs on a local
chain, not a public testnet. Don't show or say 90%: quote the held-out numbers above.

Checklist before recording:
- The console banner reads *Local chain (anvil)*, and the certificate verifies as *valid* (run
  `python scripts/reset_demo.py --chain` and re-issue if not).
- The ledger section's **Live eth_call** toggle works against `http://127.0.0.1:8545`, or the recorded results are shown.
- Browser zoom 100%, notifications off, bookmarks bar hidden.
