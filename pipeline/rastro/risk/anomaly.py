"""Detector E: IsolationForest over movement behaviour.

Feature schema `iforest-features/1.0.0` (no identifiers, labels or ground-truth fields):

| feature | transform | missing |
|---|---|---|
| turnover_x_capacity | log1p | capacity unknown -> median, `capacity_missing` = 1 |
| median_hold_days_bought | log1p | never bought -> 95th percentile, `no_purchases` = 1 |
| bought_x_capacity | log1p(bought / capacity) | capacity unknown -> median |
| resold_share | as is (0-1) | never bought -> 0 |
| births_ratio | min(x, 10) | births without declared cows -> 10 |
| capacity_use | as is | capacity unknown -> median |
| upstream_risky_pct | / 100 | |
| n_suppliers, n_buyers | log1p | |
| top_buyer_share | as is | never sold -> 0 |
| capacity_missing, no_purchases | indicator | |

Features are scaled with a RobustScaler (median / IQR). The score is the IsolationForest anomaly
score: a ranking of how unusual a ranch is among its peers, NOT a calibrated probability of fraud.
Each alert carries reason codes: the features furthest from the population median, in raw units.
"""
import json
import math
from pathlib import Path

import joblib
import numpy as np
import sklearn
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import RobustScaler

from rastro.risk.config import RiskConfig

FEATURE_SCHEMA_VERSION = "iforest-features/1.0.0"
MODEL_VERSION = "iforest/1.0.0"
FEATURES = ["turnover_x_capacity", "median_hold_days_bought", "bought_x_capacity", "resold_share", "births_ratio",
            "capacity_use", "upstream_risky_pct", "n_suppliers", "n_buyers", "top_buyer_share", "capacity_missing", "no_purchases"]
LABELS = {
    "turnover_x_capacity": "yearly turnover (x capacity)", "median_hold_days_bought": "median days bought cattle are held",
    "bought_x_capacity": "head bought (x capacity)", "resold_share": "share of bought head resold",
    "births_ratio": "births vs biological maximum", "capacity_use": "peak herd vs capacity",
    "upstream_risky_pct": "% of supply from risky origins", "n_suppliers": "distinct suppliers", "n_buyers": "distinct buyers",
    "top_buyer_share": "share sold to the top buyer", "capacity_missing": "pasture area missing", "no_purchases": "never bought cattle",
}


def matrix(feats: dict[str, dict]):
    ids = sorted(feats)
    caps = [f["capacity_central"] for f in feats.values() if f["capacity_central"]]
    holds = [f["median_hold_days_bought"] for f in feats.values() if f["median_hold_days_bought"] is not None]
    hold_fill = float(np.percentile(holds, 95)) if holds else 365.0
    raw = {}
    for i in ids:
        f = feats[i]
        cap_missing = f["capacity_central"] is None
        cap = f["capacity_central"] or (float(np.median(caps)) if caps else 1.0)
        raw[i] = {
            "turnover_x_capacity": f["sold_head"] / f["years"] / cap,
            "median_hold_days_bought": f["median_hold_days_bought"] if f["median_hold_days_bought"] is not None else hold_fill,
            "bought_x_capacity": f["bought_head"] / cap,
            "resold_share": f["resold_share"] or 0.0,
            "births_ratio": min(f["births_ratio"], 10.0) if f["births_ratio"] is not None else 10.0,
            "capacity_use": f["capacity_use"] if f["capacity_use"] is not None else float("nan"),
            "upstream_risky_pct": f["upstream_risky_pct"],
            "n_suppliers": f["n_suppliers"], "n_buyers": f["n_buyers"], "top_buyer_share": f["top_buyer_share"] or 0.0,
            "capacity_missing": float(cap_missing), "no_purchases": float(f["median_hold_days_bought"] is None),
        }
    cu = [r["capacity_use"] for r in raw.values() if not math.isnan(r["capacity_use"])]
    for r in raw.values():
        if math.isnan(r["capacity_use"]):
            r["capacity_use"] = float(np.median(cu)) if cu else 1.0
    X = np.array([[_transform(n, raw[i][n]) for n in FEATURES] for i in ids])
    return ids, X, raw


def _transform(name, v):
    if name in ("turnover_x_capacity", "median_hold_days_bought", "bought_x_capacity", "n_suppliers", "n_buyers"):
        return math.log1p(max(v, 0.0))
    if name == "upstream_risky_pct":
        return v / 100
    return float(v)


def fit_score(feats: dict[str, dict], cfg: RiskConfig, model_dir: Path | None = None, dataset_id: str = ""):
    ids, X, raw = matrix(feats)
    scaler = RobustScaler().fit(X)
    Z = scaler.transform(X)
    model = IsolationForest(n_estimators=cfg.iforest_estimators, contamination=cfg.iforest_contamination,
                            random_state=cfg.iforest_seed).fit(Z)
    score = -model.score_samples(Z)
    pred = model.predict(Z)
    med = {n: float(np.median([raw[i][n] for i in ids])) for n in FEATURES}
    out = {}
    for k, i in enumerate(ids):
        z = Z[k]
        top = sorted(range(len(FEATURES)), key=lambda j: -abs(z[j]))[: cfg.reason_top_k]
        reasons = [{"feature": FEATURES[j], "label": LABELS[FEATURES[j]], "value": round(raw[i][FEATURES[j]], 3),
                    "population_median": round(med[FEATURES[j]], 3), "robust_z": round(float(z[j]), 2)} for j in top]
        out[i] = {"score": round(float(score[k]), 4), "outlier": bool(pred[k] == -1), "reasons": reasons}
    if model_dir:
        model_dir.mkdir(parents=True, exist_ok=True)
        joblib.dump({"scaler": scaler, "model": model}, model_dir / "iforest-v1.joblib")
        (model_dir / "feature_schema.json").write_text(json.dumps({
            "feature_schema_version": FEATURE_SCHEMA_VERSION, "model_version": MODEL_VERSION, "features": FEATURES,
            "labels": LABELS, "scaler": "RobustScaler", "n_estimators": cfg.iforest_estimators,
            "contamination": cfg.iforest_contamination, "random_state": cfg.iforest_seed, "sklearn": sklearn.__version__,
            "fitted_on": dataset_id, "n_ranches": len(ids),
            "note": "Unsupervised; fitted without labels. Scores rank unusualness among peers and are not probabilities of fraud.",
        }, indent=1), encoding="utf-8")
    return out
