"""Evaluation summary: the dataset's aggregated report (rastro.risk.evaluate) and the red-team run
artifacts (rastro.evaluation.run -> reports/evaluation/summary.json). Never ground-truth rows."""
import json

from app.config import REPO
from app.store import DatasetStore

REDTEAM = REPO / "reports" / "evaluation" / "summary.json"
KEEP = ("run_command", "held_out_seed", "development_seed", "versions", "baseline_rule", "headline", "brief_comparison",
        "leakage_controls", "circularity")


def summary(store: DatasetStore) -> dict:
    rep = store.json("evaluation")
    red = None
    if REDTEAM.is_file():
        s = json.loads(REDTEAM.read_text(encoding="utf-8"))
        red = {k: s.get(k) for k in KEEP}
        red["artifacts"] = ["reports/evaluation/summary.json", "metrics.csv", "confusion.csv", "errors.json", "README.md"]
    return {"status": "available" if rep or red else "unavailable", "report": rep, "redteam": red}
