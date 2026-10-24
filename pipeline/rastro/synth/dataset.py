"""Write canonical tables as a versioned dataset directory with a machine-readable manifest."""
import hashlib
import json
from dataclasses import asdict
from pathlib import Path

from rastro import __version__
from rastro.config import RAW
from rastro.schemas.canonical import SCHEMA_VERSION, TABLES
from rastro.synth.canonical import boundaries, synthetic_layer_features
from rastro.synth.world import World

DATASET_VERSION = "1.0.0"

_SYN = "rastro.synth simulation"
PROVENANCE = {
    "ranches": ("synthetic", [_SYN, "landscape cells"], ["roles and herds simulated", "areas measured on real layers (real landscape)", "display names and owner groups hashed / drawn from the seed"]),
    "destinations": ("real", ["Trase Brazil beef logistics map v6 (CC BY 4.0)", "Port of Vila do Conde location"], ["filtered to active SIF/SIE plants near the window", "names anonymised"]),
    "birth_declarations": ("synthetic", [_SYN], ["calving drawn per breeding cow", "biology bound = declared cows x 0.85, band +/-15 %"]),
    "death_declarations": ("synthetic", [_SYN], ["monthly binomial mortality (0 in the evaluation preset)"]),
    "gta_movements": ("synthetic", [_SYN], ["FIFO lots moved between roles", "issue date 0-3 days before movement"]),
    "shipments": ("derived", ["gta_movements"], ["one delivery per slaughterhouse GTA", "one voyage per port-month"]),
    "prodes_deforestation": ("real", ["INPE PRODES / TerraBrasilis WFS (CC BY-SA 4.0)"], ["clipped to the study window by fetch_real.py", "PRODES year mapped to its 1 Aug-31 Jul period"]),
    "indigenous_territories": ("real", ["FUNAI Indigenous lands via TerraBrasilis"], ["clipped to the study window"]),
    "conservation_units": ("real", ["Conservation units via TerraBrasilis"], ["clipped to the study window"]),
    "embargoes": ("synthetic", [_SYN], ["half of the ranches with >= 100 ha post-2020 clearing, embargoed in 2023-2024; not Ibama records"]),
    "herd_inventory": ("derived", ["ranches", "birth_declarations", "death_declarations", "gta_movements", "embargoes"], ["HerdLedger rules replayed in date order (rastro.ledger)", "monthly buckets"]),
    "ledger_refusals": ("derived", ["ranches", "birth_declarations", "death_declarations", "gta_movements", "embargoes"], ["events HerdLedger would revert"]),
    "ranch_labels": ("synthetic", [_SYN], ["ground truth; evaluation only"]),
    "movement_labels": ("synthetic", [_SYN], ["ground truth; evaluation only"]),
    "smuggled_transfers": ("synthetic", [_SYN], ["movements without GTA; evaluation only"]),
    "lots": ("synthetic", [_SYN], ["physical single-origin lots; evaluation only"]),
    "lot_allocations": ("synthetic", [_SYN], ["physical lot-to-lot flows; evaluation only"]),
    "shipment_truth": ("synthetic", [_SYN], ["true origin mix of each shipment; evaluation only"]),
    "anomalies": ("derived", ["ledger_refusals", "truth"], ["each refusal attributed to the scenario that planted it"]),
    "missing_records": ("synthetic", [_SYN], ["permits removed from the agency records by the red team; evaluation only"]),
}
RAW_SOURCES = {
    "yearly_deforestation.geojson": ("INPE PRODES yearly deforestation", "CC BY-SA 4.0"),
    "accumulated_2007.geojson": ("INPE PRODES accumulated to 2007", "CC BY-SA 4.0"),
    "indigenous.geojson": ("FUNAI Indigenous lands (TerraBrasilis)", "public"),
    "conservation.geojson": ("Conservation units (TerraBrasilis)", "public"),
    "ibge_herd.json": ("IBGE PPM table 3939", "public"),
    "trase_beef_logistics_v6.geojson": ("Trase Brazil beef logistics v6", "CC BY 4.0"),
}

_SORT = {"herd_inventory": ("ranch_id", "period_start"), "ledger_refusals": ("date", "event_ref")}


def dumps(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def write(world: World, tables: dict[str, list[dict]], out: Path, preset: str) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    entries = {}
    for name, (partition, _, pk) in TABLES.items():
        rows = tables.get(name, [])
        keys = _SORT.get(name, (pk,) if pk else None)
        if keys:
            rows = sorted(rows, key=lambda r: tuple(str(r[k]) for k in keys))
        raw = b"".join(dumps(r) + b"\n" for r in rows)
        rel = f"{partition}/{name}.jsonl"
        (out / partition).mkdir(exist_ok=True)
        (out / rel).write_bytes(raw)
        status, sources, steps = PROVENANCE[name]
        if world.landscape.kind == "synthetic" and status == "real":
            status, sources = "synthetic", ["rastro.synth synthetic landscape (fixture; not real data)"]
        entries[name] = {"path": rel, "partition": partition, "rows": len(rows), "sha256": hashlib.sha256(raw).hexdigest(),
                         "data_status": status, "sources": sources, "transformations": steps,
                         "detector_visible": partition in ("inputs", "environment", "derived")}
    geo = dumps(boundaries(world)) + b"\n"
    (out / "inputs" / "ranch_boundaries.geojson").write_bytes(geo)
    entries["ranch_boundaries"] = {"path": "inputs/ranch_boundaries.geojson", "partition": "inputs",
                                   "rows": len(world.landscape.geometries), "sha256": hashlib.sha256(geo).hexdigest(),
                                   "data_status": "synthetic",
                                   "sources": ["landscape.py Voronoi cells" if world.landscape.kind == "real" else "synthetic grid"],
                                   "transformations": ["UTM 22S -> WGS84", "coordinates rounded to 1e-6 deg"],
                                   "detector_visible": True}

    if world.landscape.kind == "synthetic":
        for fname, fc in synthetic_layer_features(world).items():
            data = dumps(fc) + b"\n"
            (out / "environment" / f"{fname}.geojson").write_bytes(data)
            entries[fname] = {"path": f"environment/{fname}.geojson", "partition": "environment", "rows": len(fc["features"]),
                              "sha256": hashlib.sha256(data).hexdigest(), "data_status": "synthetic",
                              "sources": ["rastro.synth synthetic layer (fixture; not real data)"],
                              "transformations": ["rectangles in grid metres -> WGS84"], "detector_visible": True}

    raw_inputs = []
    if world.landscape.kind == "real":
        for f, (src, lic) in RAW_SOURCES.items():
            p = RAW / f
            if p.is_file():
                raw_inputs.append({"path": f"pipeline/data/raw/{f}", "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
                                   "source": src, "licence": lic, "data_status": "real"})
    cfg = asdict(world.config)
    cfg["start"] = world.config.start.isoformat()
    cfg["scenarios"] = sorted(world.config.scenarios)
    anomalies = {}
    for a in tables["anomalies"]:
        k = f"{a['kind']}:{a['scenario']}"
        anomalies.setdefault(k, {"events": 0, "head": 0})
        anomalies[k]["events"] += 1
        anomalies[k]["head"] += a["head"]
    manifest = {
        "dataset_id": f"rastro-synth-{preset}",
        "dataset_version": DATASET_VERSION,
        "schema_version": SCHEMA_VERSION,
        "generator": {"name": "rastro.synth", "version": __version__},
        "preset": preset,
        "seed": world.config.seed,
        "generated_at": world.config.generated_at,
        "landscape": world.landscape.kind,
        "config": cfg,
        "notice": "Ranches, herds, births, deaths, GTAs, embargoes, shipments and all labels are synthetic. "
                  "They are not government records and describe no real ranch or company.",
        "tables": entries,
        "raw_inputs": raw_inputs,
        "deliberate_anomalies": dict(sorted(anomalies.items())),
        "logical_digest": hashlib.sha256("".join(f"{k}:{v['sha256']}" for k, v in sorted(entries.items())).encode()).hexdigest(),
    }
    (out / "manifest.json").write_bytes(json.dumps(manifest, indent=1, ensure_ascii=False, sort_keys=True).encode("utf-8") + b"\n")
    return manifest
