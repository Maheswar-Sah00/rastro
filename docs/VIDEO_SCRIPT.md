# Demo video script: Rastro (about 4:20, hard limit 5:00)

The video mixes two kinds of shot. **On camera** lines are spoken to the lens and show the speaker's face, with the
key words popping up large on screen. **Voice-over** lines play over the product (recorded from the hosted site and
console) or over an animated card. No names are said; the video says only that Rastro was built for the IEEE
ClimateChain Global Hackathon 2026, and it ends by thanking the hackathon's sponsors, the IEEE Blockchain Committee and
IEEE Chapters.

The rules ask for three things: the climate problem (lines 1–10), how the solution works (11–29) and its real-world
impact (20–22, 26, 31). Lines 15 and 30 say plainly that ranches and permits are simulated on real deforestation data
and that the ledger runs on a local test chain. All numbers are the held-out results the site shows.

| # | Part | Shot | On screen | Line |
| --- | --- | --- | --- | --- |
| 1 | Hook | **On camera** | Face · big words: *BORN ONCE.* | A cow is born once. It dies once. And it can't be in two places at the same time. |
| 2 | Hook | **On camera** | Face · big words: *ITS PAPERWORK CAN.* | But its paperwork can. And that is how the Amazon is being cut down. |
| 3 | Problem | Voice-over | Card: Sentinel-2 image of São Félix do Xingu, "2.7 million cattle" | This is São Félix do Xingu, in the Brazilian Amazon. Two point seven million cattle, the biggest herd of any town in Brazil. |
| 4 | Problem | Voice-over | Card: "Cattle pasture is the #1 driver of deforestation" | Cattle pasture is the biggest driver of deforestation in the Amazon. |
| 5 | Problem | **On camera** | Face · big words: *A HOLE.* | And the rules meant to stop it have a hole. |
| 6 | Problem | Voice-over | Site, Problem: the "Rastro checks the whole path" diagram | Meatpackers only check the ranch that sold them the cattle. |
| 7 | Problem | Voice-over | Site, Problem: the "Rastro checks the whole path" diagram | So a calf born on illegally cleared land is sold to a clean-looking ranch, and resold a few days later. It arrives looking legal. |
| 8 | Problem | Voice-over | Site, Problem: the 2030 and 30 Dec 2026 tiles | Pará has postponed tracking individual cattle until 2030. And Europe's deforestation law covers beef from the thirtieth of December this year. |
| 9 | Problem | **On camera** | Face · big words: *TÜRKİYE.* | Here is what surprised us. Pará ships more than half of Brazil's live cattle. And the biggest buyer is Türkiye, the host of COP31. |
| 10 | Problem | **On camera** | Face · big words: *THE WHOLE CHAIN.* | So we asked: what if every buyer could see the whole chain, and not just the last seller? |
| 11 | Solution | Voice-over | Title card: Rastro, built for the IEEE ClimateChain Global Hackathon 2026 | We built Rastro for the IEEE ClimateChain Hackathon 2026. |
| 12 | Solution | Voice-over | Site, opening screen | It traces every head of cattle back to the ranch where it was born, and puts the rules on a ledger that every buyer shares. |
| 13 | Solution | Voice-over | Site, System: the three layers clicked in turn | Every animal transit permit, called a GTA, comes in as a lot. AI traces each lot back through every farm. And a smart contract enforces the rules for every buyer at once. |
| 14 | Demo | Voice-over | Site, Map step 1: forest lost after 2020 (real PRODES) | It starts with real satellite data. Every pink patch is forest cleared after 2020, mapped by INPE, Brazil's space agency. |
| 15 | Demo | Voice-over | Site, Map step 2: ranches rated (simulated) | The ranches are simulated, because the permit data is not public yet. Each one is checked against that clearing, Indigenous land, protected areas and embargoes. |
| 16 | Demo | Voice-over | Site, Trace: SHP-0008 to Türkiye, today's check PASS vs Rastro FAIL | Now pick a ship. This one sailed from Barcarena to Türkiye. Today's check passes it. |
| 17 | Demo | Voice-over | Site, Trace: SHP-0008 to Türkiye, today's check PASS vs Rastro FAIL | Rastro follows its permits back, farm by farm, finds half of its cattle came from flagged ranches, and fails it. |
| 18 | Demo | Voice-over | Site, Trace: the 36-voyage chart | Over three years, all thirty-six export voyages pass today's check. Rastro fails thirty-four. |
| 19 | Results | **On camera** | Face · big words: *TESTED HONESTLY.* | But a tool that flags everything is useless. So we tested it honestly. |
| 20 | Results | Voice-over | Site, Results: today's check vs Rastro | On worlds we never tuned on, Rastro flags about seven in ten laundered cattle, and over nine in ten with a human review. Today's check catches about one in six. |
| 21 | Results | Voice-over | Site, Results: today's check vs Rastro | And it wrongly stops fewer honest herds: about fifteen percent, against twenty-three today. |
| 22 | Results | Voice-over | Site, Results: hardest cheaters (red team) | Even when the cheaters hold cattle for months and hide behind two middlemen, it still flags seventy percent. |
| 23 | Ledger | **On camera** | Face · big words: *IT BREAKS PHYSICS.* | Some cheating does not even need AI to catch. It breaks physics. |
| 24 | Ledger | Voice-over | Site, Ledger: the Try it buttons revert | So those rules live on a blockchain. Use the same clean certificate twice: refused. Sell a flagged lot as clean: refused. |
| 25 | Ledger | Voice-over | Site, Ledger: the Try it buttons revert | Ship from an embargoed ranch: refused. Declare five hundred calves from forty cows: refused. |
| 26 | Ledger | Voice-over | Site, Ledger: refused by the ledger alone | Over three years, the ledger alone stopped more than twenty-seven thousand head of paper cattle. |
| 27 | Console | Voice-over | Console: SHP-D-001677 lineage graph | Investigators get a console. For any shipment, it shows where the cattle came from, which checks fired, and why. |
| 28 | Console | Voice-over | Console: risk breakdown and "Why this decision" | The AI finds the evidence. Fixed rules decide. And anything uncertain goes to a person, never straight to a pass. |
| 29 | Console | Voice-over | Console: verify a certificate, 11 checks pass | A clean lot gets a signed certificate that can be used exactly once. Anyone can verify it, and only salted hashes go on-chain, so no personal data is exposed. |
| 30 | Honesty | **On camera** | Face | To be clear: the ranches and permits here are simulated on real deforestation data, and the ledger runs on a local test chain. |
| 31 | Next | **On camera** | Face · big words: *PLUGS RIGHT IN.* | When Brazil's states publish their permit data, as a federal court has ordered Pará to do, Rastro plugs it in. No change to the detectors, or the contract. |
| 32 | Close | **On camera** | Face · big words: *NEITHER CAN ITS PAPERWORK.* | A cow is born once, dies once, and can't be in two places. Now, neither can its paperwork. |
| 33 | Close | Voice-over | End card: links and thanks to the IEEE Blockchain Committee and IEEE Chapters | This is Rastro. Thank you to the IEEE Blockchain Committee and the IEEE chapters behind ClimateChain. Try it at the link below. |

**Pronunciation:** São Félix do Xingu = *sow FAY-leeks doo shin-GOO* · Pará = *pa-RAH* · Türkiye = *TUR-kee-yeh* ·
Barcarena = *bar-ka-REH-na* · INPE = *IN-pay*.
