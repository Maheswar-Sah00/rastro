"""Risk findings, ranch risk and lot decisions (rastro.risk). Versioned separately."""
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

RISK_SCHEMA_VERSION = "risk/1.0.0"

Code = Literal[
    # A environmental
    "POST2020_DEFORESTATION", "EMBARGOED", "PROTECTED_AREA", "ENV_EVIDENCE_MISSING",
    # B inventory / births
    "INSUFFICIENT_HERD", "NEGATIVE_INVENTORY", "PHANTOM_BIRTHS", "BIRTHS_BORDERLINE", "DUPLICATE_MOVEMENT", "CHRONOLOGY",
    # C, D, E
    "PASS_THROUGH", "OVER_CAPACITY", "ANOMALY",
    # lot level (from lineage)
    "TAINTED_SUPPLY", "UNKNOWN_ORIGIN",
]
Detector = Literal["A_environmental", "B_inventory", "C_pass_through", "D_over_capacity", "E_isolation_forest", "lineage"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Threshold(Strict):
    name: str
    value: float | str
    comparison: str                       # e.g. ">=", "<", "outside"


class Finding(Strict):
    schema_version: Literal["risk/1.0.0"]
    finding_id: str
    entity_type: Literal["ranch", "gta", "shipment"]
    entity_id: str
    dataset_refs: list[str]
    detector: Detector
    detector_version: str
    code: Code
    category: Literal["environmental", "record_inconsistency", "behavioural", "unknown_provenance", "data_gap"]
    severity: Literal["info", "watch", "high"]
    confidence: Annotated[float, Field(ge=0, le=1)]
    blocking: bool                        # a defined blocking rule (feeds FLAGGED)
    features: dict[str, Any]              # input feature summary
    observed: dict[str, Any]              # observed values
    thresholds: list[Threshold]
    evidence_ids: list[str]
    explanation: str                      # generated from the values above, no free text
    limitations: list[str]
    observed_at: str
    evidence_hash: str | None = None


class RanchRisk(Strict):
    schema_version: Literal["risk/1.0.0"]
    ranch_id: str
    risk_class: Literal["high", "watch", "clean", "insufficient_data"]
    finding_ids: list[str]
    codes: list[str]
    anomaly_score: float | None          # IsolationForest score: a ranking, not a probability


class Decision(Strict):
    schema_version: Literal["risk/1.0.0"]
    shipment_id: str
    outcome: Literal["PASS", "REVIEW", "FLAGGED"]
    risk_categories: list[str]            # kept separate from the outcome
    reasons: list[str]
    blocking_finding_ids: list[str]
    review_finding_ids: list[str]
    exposure_pct: dict[str, float]
    coverage_pct: float
    direct_suppliers: list[str]
    thresholds: dict[str, float]
    evidence_hash: str
    decided_at: str
