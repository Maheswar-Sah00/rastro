# Running the Rastro demo locally

Everything runs offline after the first data fetch. No restricted government feed is needed: GTAs are synthetic. The narrated video walkthrough is in [VIDEO_SCRIPT.md](VIDEO_SCRIPT.md).

## 0. Prerequisites

Python 3.12, Node 20+ (tested 22), Foundry 1.8 (`contracts/.tools/bin` on Windows). Copy `.env.example` to `.env` if you need non-default settings.

## 1. Data and AI (≈ 2 min; downloads cached)

```bash
cd pipeline
pip install -r requirements.txt -r requirements-dev.txt
python run_all.py --no-fetch     # drop --no-fetch on the first run
python -m pytest                 # published-bundle integrity
```

## 2. Ledger (anvil)

```bash
cd contracts
forge soldeer install && npm install
forge test
npm run demo:local -- --keep     # anvil + deploy + replay; writes web/public/data/onchain.json
```

## 3. API

```bash
cd backend
python -m venv .venv && .venv/Scripts/activate      # Windows; source .venv/bin/activate elsewhere
pip install -r requirements-dev.txt
uvicorn app.main:app --port 8000                    # http://127.0.0.1:8000/health, /docs
python -m pytest
```

## 4. Web

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build
```

## Walkthrough (5 minutes)

1. `#problem`: headline numbers come from `metrics.json`; header badge must not say "Mock".
2. `#ranch/R0291`: embargoed breeder with real post-2020 PRODES clearing.
3. `#ranch/R0120`: phantom births + pass-through. Click **Verify evidence**, then **Tamper**.
4. `#trace/SHP-0008`: Türkiye-bound voyage that today's check passes and Rastro fails.
5. `#ledger`: the four "try to cheat" reverts (live `eth_call` if anvil is running with `--keep`).
6. `#how`: architecture, red-team result, honest limits.
7. `GET /health` and `GET /api/v1/datasets/shipments` to show the validated, versioned API.

## Fallbacks

- Pipeline outputs missing: the web app serves the labelled mock bundle (`?data=mock` forces it).
- No chain running: revert demos replay recorded results from `onchain.json`.
