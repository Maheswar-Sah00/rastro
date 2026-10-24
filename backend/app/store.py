"""Lazy, cached access to the canonical dataset and the published bundle.

Each table is read on first use and cached under its (path, mtime, size). When the pipeline rewrites
a file the key changes and the next request reloads it; nothing else is invalidated. The lineage
service is cached under the fingerprint of every file it reads.
"""
import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app import pipeline_bridge  # noqa: F401  (puts `rastro` on sys.path)

# Tables a detector may read (never truth/), by partition.
TABLES = {
    "ranches": "inputs/ranches.jsonl", "destinations": "inputs/destinations.jsonl", "births": "inputs/birth_declarations.jsonl",
    "deaths": "inputs/death_declarations.jsonl", "gtas": "inputs/gta_movements.jsonl", "shipments": "inputs/shipments.jsonl",
    "embargoes": "environment/embargoes.jsonl", "inventory": "derived/herd_inventory.jsonl", "refusals": "derived/ledger_refusals.jsonl",
    "geo": "derived/geo_evidence.jsonl", "lineage": "derived/lineage_traces.jsonl", "findings": "derived/risk/findings.jsonl",
    "ranch_risk": "derived/risk/ranch_risk.jsonl", "decisions": "derived/risk/decisions.jsonl",
}
JSON_FILES = {"manifest": "manifest.json", "geo_meta": "derived/geo_evidence.meta.json", "geo_provenance": "derived/geo_provenance.json",
              "lineage_summary": "derived/lineage_summary.json", "risk_summary": "derived/risk/risk_summary.json",
              "evaluation": "reports/evaluation.json"}
KEYS = {"ranches": "ranch_id", "destinations": "destination_id", "gtas": "gta_id", "shipments": "shipment_id", "geo": "ranch_id",
        "lineage": "shipment_id", "findings": "finding_id", "ranch_risk": "ranch_id", "decisions": "shipment_id"}
# Which inputs the lineage service depends on (its cache key).
LINEAGE_INPUTS = ("ranches", "destinations", "births", "deaths", "gtas", "shipments", "refusals", "inventory", "geo", "embargoes")


class MalformedData(Exception):
    def __init__(self, path: Path, line: int, msg: str):
        super().__init__(f"{path.name}:{line}: {msg}")
        self.path, self.line = path, line


def _stamp(p: Path):
    st = p.stat()
    return (st.st_mtime_ns, st.st_size)


@dataclass
class _Entry:
    stamp: tuple
    rows: Any
    index: dict = field(default_factory=dict)


class DatasetStore:
    def __init__(self, dataset_dir: Path, web_dir: Path):
        self.dir, self.web = dataset_dir, web_dir
        self._cache: dict[str, _Entry] = {}
        self._lock = threading.RLock()
        self._lineage_lock = threading.Lock()
        self._lineage = None
        self._lineage_key = None
        self.assess_lock = threading.Lock()

    # ---- files ------------------------------------------------------------------------------
    def path(self, name: str) -> Path:
        rel = TABLES.get(name) or JSON_FILES[name]
        return self.dir / rel

    def exists(self, name: str) -> bool:
        return self.path(name).is_file()

    def _load(self, key: str, path: Path, jsonl: bool):
        if not path.is_file():
            return None
        stamp = _stamp(path)
        with self._lock:
            e = self._cache.get(key)
            if e and e.stamp == stamp:
                return e
            if jsonl:
                rows = []
                for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                    if not line.strip():
                        continue
                    try:
                        rows.append(json.loads(line))
                    except json.JSONDecodeError as ex:
                        raise MalformedData(path, n, ex.msg) from None
                idx = {r[KEYS[key]]: r for r in rows} if key in KEYS and all(KEYS[key] in r for r in rows) else {}
                if key in KEYS and rows and not idx:
                    raise MalformedData(path, 0, f"rows lack key {KEYS[key]}")
                e = _Entry(stamp, rows, idx)
            else:
                try:
                    e = _Entry(stamp, json.loads(path.read_text(encoding="utf-8")))
                except json.JSONDecodeError as ex:
                    raise MalformedData(path, ex.lineno, ex.msg) from None
            self._cache[key] = e
            return e

    def rows(self, name: str) -> list[dict] | None:
        e = self._load(name, self.path(name), True)
        return None if e is None else e.rows

    def get(self, name: str, key: str) -> dict | None:
        e = self._load(name, self.path(name), True)
        return None if e is None else e.index.get(key)

    def json(self, name: str) -> Any:
        e = self._load(name, self.path(name), False)
        return None if e is None else e.rows

    def web_json(self, rel: str) -> Any:
        e = self._load(f"web:{rel}", self.web / rel, False)
        return None if e is None else e.rows

    def by(self, name: str, field_: str) -> dict[str, list[dict]]:
        """Secondary index (cached with the table)."""
        e = self._load(name, self.path(name), True)
        if e is None:
            return {}
        k = f"by:{field_}"
        if k not in e.index:
            out: dict[str, list[dict]] = {}
            for r in e.rows:
                v = r.get(field_)
                for x in (v if isinstance(v, list) else [v]):
                    out.setdefault(x, []).append(r)
            e.index[k] = out
        return e.index[k]

    # ---- provenance -----------------------------------------------------------------------------
    def provenance(self) -> dict:
        m = self.json("manifest") or {}
        tables = m.get("tables", {})

        def status(table, derived_name=None):
            if derived_name:
                return "derived" if self.exists(derived_name) else "unavailable"
            t = tables.get(table)
            return t["data_status"] if t else "unavailable"
        geo_prov = self.json("geo_provenance") or {}
        env = "unavailable"
        if geo_prov:
            env = "real" if "deforestation" in geo_prov.get("real_inputs", []) else "synthetic"
        return {
            "dataset_id": m.get("dataset_id"), "dataset_version": m.get("dataset_version"), "logical_digest": m.get("logical_digest"),
            "generated_at": m.get("generated_at"), "schema_version": m.get("schema_version"),
            "data_status": {
                "ranches": status("ranches"), "gta_movements": status("gta_movements"), "shipments": status("shipments"),
                "embargoes": status("embargoes"), "environmental_layers": env, "geo_evidence": status(None, "geo"),
                "lineage": status(None, "lineage"), "risk": status(None, "decisions"),
                "onchain": "synthetic" if self.web_json("onchain.json") else "unavailable",
            },
            "freshness": {n: (self.path(n).stat().st_mtime if self.exists(n) else None) for n in ("geo", "lineage", "decisions")},
        }

    def risk_is_current(self) -> bool:
        rs, m = self.json("risk_summary"), self.json("manifest")
        return bool(rs and m and rs.get("dataset", "").endswith(m["logical_digest"][:12]) and self.exists("decisions"))

    # ---- lineage --------------------------------------------------------------------------------
    def lineage_service(self):
        from rastro.lineage.service import LineageService
        key = tuple((n, _stamp(self.path(n)) if self.exists(n) else None) for n in LINEAGE_INPUTS)
        with self._lineage_lock:  # separate from the table lock: a slow build must not block table reads
            if self._lineage is None or self._lineage_key != key:
                self._lineage = LineageService(self.dir)
                self._lineage_key = key
            return self._lineage

    def invalidate(self):
        with self._lock, self._lineage_lock:
            self._cache.clear()
            self._lineage = None
