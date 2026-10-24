"""Paths and shared constants for the pipeline package."""
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1]
REPO = PIPELINE.parent
RAW = PIPELINE / "data" / "raw"
DERIVED = PIPELINE / "data" / "derived"
SYNTHETIC = REPO / "data" / "synthetic"

MUNICIPALITY = {"name": "São Félix do Xingu", "state": "PA", "ibge_code": "1507300"}
EUDR_CUTOFF = "2020-12-31"
# Births per breeding cow per year that the ledger treats as the biological ceiling (HerdLedger 8500 bps).
MAX_CALVING_RATE = 0.85
# Head per hectare of pasture the ledger treats as carrying capacity.
CAPACITY_HEAD_PER_HA = 1.5
