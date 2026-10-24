"""Every threshold and biological assumption the risk engine uses, in one place.

Values are fixed a priori from domain sources and from the thresholds the published demo already
used (pipeline/detect.py). They are not tuned on the evaluation data; see rastro/risk/evaluate.py.
"""
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class RiskConfig:
    # ---- A. environmental exposure ----------------------------------------------------------
    deforestation_watch_ha: float = 6.25      # PRODES minimum mapping unit
    deforestation_high_ha: float = 50.0       # large clearing: rarely licensed
    protected_min_ha: float = 1.0             # overlap below this is treated as a boundary sliver

    # ---- B. inventory and births --------------------------------------------------------------
    # Biology: at most 0.85 calves per breeding cow per year (HerdLedger bound, 8500 bps). Typical
    # Amazon calving is 0.55-0.75. Breeding-cow counts are self-declared: +/-15 % uncertainty band.
    max_calving_rate: float = 0.85
    breeding_cow_uncertainty: float = 0.15

    # ---- C. pass-through intermediaries --------------------------------------------------------
    pass_through_hold_days: float = 45.0      # median days bought cattle stay before resale (too short to fatten)
    pass_through_resold_share: float = 0.8    # share of bought head that is resold
    pass_through_turnover: float = 1.0        # yearly outflow / capacity
    pass_through_min_bought: int = 100        # head bought over the period; below this, no pattern is claimed
    pass_through_high_upstream_pct: float = 35.0  # high only if this share of supply traces to risky origins

    # ---- D. over-capacity ------------------------------------------------------------------------
    # Carrying capacity = pasture ha x stocking rate. Amazon average ~1 head/ha; 1.5 is the ledger
    # ceiling; 2.0 is an optimistic bound for intensively managed pasture.
    stocking_central: float = 1.5
    stocking_high: float = 2.0
    over_capacity_watch: float = 1.25         # quarterly herd / (pasture x central)
    over_capacity_high: float = 1.10          # quarterly herd / (pasture x high): above even the optimistic bound

    # ---- E. IsolationForest ----------------------------------------------------------------------
    iforest_estimators: int = 400
    iforest_contamination: float = 0.04
    iforest_seed: int = 0
    reason_top_k: int = 3

    # ---- decision layer ----------------------------------------------------------------------------
    flag_exposure_pct: float = 25.0           # share of a lot traced to risky origins that blocks it
    review_exposure_pct: float = 5.0
    review_unknown_pct: float = 25.0
    min_coverage_pct: float = 75.0            # below this there is not enough evidence to PASS

    def as_dict(self):
        return asdict(self)
