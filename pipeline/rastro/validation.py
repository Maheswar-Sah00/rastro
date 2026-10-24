"""Validation and referential-integrity checks for a canonical dataset.

    python -m rastro.validation data/synthetic/evaluation
"""
import json
import sys
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

from pydantic import ValidationError

from rastro.ledger import replay
from rastro.schemas.canonical import TABLES

MAX_ERRORS_PER_CHECK = 20


class Report:
    def __init__(self):
        self.errors: dict[str, list[str]] = defaultdict(list)
        self.checked: Counter = Counter()

    def fail(self, check, msg):
        if len(self.errors[check]) < MAX_ERRORS_PER_CHECK:
            self.errors[check].append(msg)
        self.checked[f"{check}:failed"] += 1

    @property
    def ok(self):
        return not self.errors

    def summary(self):
        return {"ok": self.ok, "checked": dict(sorted(self.checked.items())), "errors": dict(self.errors)}


def load(path: Path) -> tuple[dict, dict[str, list[dict]]]:
    manifest = json.loads((path / "manifest.json").read_text(encoding="utf-8"))
    tables = {}
    for name, (partition, _, _) in TABLES.items():
        f = path / partition / f"{name}.jsonl"
        tables[name] = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l] if f.is_file() else []
    return manifest, tables


def validate(tables: dict[str, list[dict]], manifest: dict | None = None) -> Report:
    rep = Report()
    _schema_and_keys(tables, rep)
    _foreign_keys(tables, rep)
    _dates(tables, manifest, rep)
    # The ledger replay assumes well-formed, linked records; only run it once those checks pass.
    _conservation(tables, manifest, rep, replay_ok=not ({"schema", "unique_ids", "foreign_keys", "dates"} & rep.errors.keys()))
    _lineage(tables, rep)
    _anomalies(tables, manifest, rep)
    return rep


def _schema_and_keys(t, rep):
    for name, (_, model, pk) in TABLES.items():
        seen = set()
        for row in t.get(name, []):
            rep.checked["schema"] += 1
            try:
                model.model_validate(row)
            except ValidationError as e:
                rep.fail("schema", f"{name} {row.get(pk) if pk else ''}: {e.errors()[0]['loc']} {e.errors()[0]['msg']}")
            if pk:
                rep.checked["unique_ids"] += 1
                if row.get(pk) in seen:
                    rep.fail("unique_ids", f"{name}: duplicate {pk} {row.get(pk)}")
                seen.add(row.get(pk))


def _foreign_keys(t, rep):
    ranches = {r["ranch_id"] for r in t["ranches"]}
    inside = {r["ranch_id"] for r in t["ranches"] if r["entity_type"] == "ranch"}
    sinks = {d["destination_id"] for d in t["destinations"]}
    gtas = {g["gta_id"]: g for g in t["gta_movements"]}
    truth_gtas = set(gtas) | {m["gta_id"] for m in t.get("missing_records", [])}  # truth may name permits the agency lacks
    lots = {l["lot_id"] for l in t["lots"]}
    ships = {s["shipment_id"] for s in t["shipments"]}

    def fk(check, value, domain, where):
        rep.checked["foreign_keys"] += 1
        if value not in domain:
            rep.fail("foreign_keys", f"{where}: {check} {value!r} not found")

    for g in t["gta_movements"]:
        fk("origin_id", g["origin_id"], ranches, g["gta_id"])
        fk("destination_id", g["destination_id"], ranches | sinks, g["gta_id"])
        rep.checked["foreign_keys"] += 1
        if (g["destination_type"] == "ranch") != (g["destination_id"] in ranches):
            rep.fail("foreign_keys", f"{g['gta_id']}: destination_type {g['destination_type']} does not match {g['destination_id']}")
    for b in t["birth_declarations"]:
        fk("ranch_id", b["ranch_id"], inside, b["birth_event_id"])
    for d in t["death_declarations"]:
        fk("ranch_id", d["ranch_id"], inside, d["death_event_id"])
    for e in t["embargoes"]:
        fk("ranch_id", e["ranch_id"], inside, e["embargo_id"])
    for r in t["herd_inventory"]:
        fk("ranch_id", r["ranch_id"], inside, f"inventory {r['period_start']}")
    used = Counter()
    for s in t["shipments"]:
        for gid in s["gta_ids"]:
            fk("gta_id", gid, gtas, s["shipment_id"])
            used[gid] += 1
            g = gtas.get(gid)
            rep.checked["foreign_keys"] += 1
            if g and (g["destination_id"] != s["destination_id"] or g["permit_status"] != "issued"):
                rep.fail("foreign_keys", f"{s['shipment_id']}: {gid} is not an issued permit to {s['destination_id']}")
        for a in s["lot_allocations"]:
            fk("lot_id", a["lot_id"], {gtas[g]["lot_id"] for g in s["gta_ids"] if g in gtas}, s["shipment_id"])
    for gid, n in used.items():
        rep.checked["unique_ids"] += 1
        if n > 1:
            rep.fail("unique_ids", f"{gid} appears in {n} shipments")
    for x in t["ranch_labels"]:
        fk("ranch_id", x["ranch_id"], ranches, "ranch_labels")
    for x in t["movement_labels"]:
        fk("gta_id", x["gta_id"], gtas, "movement_labels")
    for x in t["shipment_truth"]:
        fk("shipment_id", x["shipment_id"], ships, "shipment_truth")
    for x in t["smuggled_transfers"]:
        fk("from_id", x["from_id"], inside, x["transfer_id"])
        fk("to_id", x["to_id"], inside, x["transfer_id"])
        if x["laundered_as_birth_event_id"]:
            fk("birth_event_id", x["laundered_as_birth_event_id"], {b["birth_event_id"] for b in t["birth_declarations"]}, x["transfer_id"])
        if x.get("laundered_as_gta_id"):
            fk("gta_id", x["laundered_as_gta_id"], gtas, x["transfer_id"])
    for l in t["lots"]:
        fk("location_id", l["location_id"], ranches | sinks, l["lot_id"])
        fk("birth_origin_id", l["birth_origin_id"], ranches, l["lot_id"])
        if l["parent_lot_id"]:
            fk("parent_lot_id", l["parent_lot_id"], lots, l["lot_id"])
        if l["via_gta_id"]:
            fk("via_gta_id", l["via_gta_id"], truth_gtas, l["lot_id"])
    for a in t["lot_allocations"]:
        fk("from_lot_id", a["from_lot_id"], lots, a["allocation_id"])
        if a["to_lot_id"]:
            fk("to_lot_id", a["to_lot_id"], lots, a["allocation_id"])
        if a["gta_id"]:
            fk("gta_id", a["gta_id"], truth_gtas, a["allocation_id"])


def _dates(t, manifest, rep):
    cfg = (manifest or {}).get("config", {})
    start = date.fromisoformat(cfg.get("start", "2023-01-01"))
    months = cfg.get("months", 36)
    # Window end + 31 days: a lot bought late in the last month may ship just after it.
    end = date(start.year + (start.month - 1 + months) // 12, (start.month - 1 + months) % 12 + 1, 1) + timedelta(days=30)

    def check(where, value, lo=start, hi=end):
        rep.checked["dates"] += 1
        try:
            d = date.fromisoformat(value)
        except (TypeError, ValueError):
            rep.fail("dates", f"{where}: invalid date {value!r}")
            return None
        if not lo <= d <= hi:
            rep.fail("dates", f"{where}: {value} outside {lo}..{hi}")
        return d

    for g in t["gta_movements"]:
        check(g["gta_id"], g["movement_date"])
        check(g["gta_id"] + " issue", g["issue_date"], lo=date(start.year - 1, 1, 1))
    for b in t["birth_declarations"]:
        d = check(b["birth_event_id"], b["date"])
        rep.checked["dates"] += 1
        if d and d.year != b["year"]:
            rep.fail("dates", f"{b['birth_event_id']}: year {b['year']} != date {b['date']}")
    for d in t["death_declarations"]:
        check(d["death_event_id"], d["date"])
    for e in t["embargoes"]:
        check(e["embargo_id"], e["start_date"])


def _conservation(t, manifest, rep, replay_ok=True):
    start = date.fromisoformat((manifest or {}).get("config", {}).get("start", "2023-01-01"))
    opening = {r["ranch_id"]: r["opening_head"] for r in t["ranches"]}
    prev = {}
    for row in sorted(t["herd_inventory"], key=lambda r: (r["ranch_id"], r["period_start"])):
        i = row["ranch_id"]
        rep.checked["conservation"] += 1
        expect_open = prev.get(i, opening.get(i))
        if row["opening_head"] != expect_open:
            rep.fail("conservation", f"{i} {row['period_start']}: opening {row['opening_head']} != previous closing {expect_open}")
        flow = row["opening_head"] + row["births"] + row["arrivals"] - row["departures"] - row["deaths"] - row["other_removals"]
        if row["closing_head"] != flow:
            rep.fail("conservation", f"{i} {row['period_start']}: closing {row['closing_head']} != {flow}")
        if row["closing_head"] < 0:
            rep.fail("conservation", f"{i} {row['period_start']}: negative inventory {row['closing_head']}")
        prev[i] = row["closing_head"]
    # The stored inventory and refusals must be exactly what the ledger rules produce.
    if not replay_ok:
        rep.checked["ledger_replay:skipped"] += 1
        return
    inv, refusals = replay(t["ranches"], t["birth_declarations"], t["death_declarations"], t["gta_movements"], t["embargoes"], start)
    rep.checked["ledger_replay"] += 1
    key = lambda r: (r["ranch_id"], r["period_start"])
    if sorted(inv, key=key) != sorted(t["herd_inventory"], key=key):
        rep.fail("ledger_replay", "herd_inventory differs from a replay of the declarations under the ledger rules")
    rkey = lambda r: (r["date"], r["event_ref"])
    if sorted(refusals, key=rkey) != sorted(t["ledger_refusals"], key=rkey):
        rep.fail("ledger_replay", "ledger_refusals differ from a replay of the declarations")


def _lineage(t, rep):
    out = defaultdict(int)
    into = defaultdict(int)
    gta_head = defaultdict(int)
    for a in t["lot_allocations"]:
        out[a["from_lot_id"]] += a["head"]
        if a["to_lot_id"]:
            into[a["to_lot_id"]] += a["head"]
        if a["gta_id"]:
            gta_head[a["gta_id"]] += a["head"]
    for l in t["lots"]:
        rep.checked["lot_conservation"] += 1
        if out[l["lot_id"]] + l["remaining_head"] > l["head"]:
            rep.fail("lot_conservation", f"{l['lot_id']}: {out[l['lot_id']]} out + {l['remaining_head']} left > {l['head']} head")
        if l["kind"] in ("transfer", "smuggled") and into[l["lot_id"]] != l["head"]:
            rep.fail("lot_conservation", f"{l['lot_id']}: created with {l['head']} head but {into[l['lot_id']]} allocated in")
    cold = {m["gta_id"] for m in t["movement_labels"] if "cold_permit" in m["scenario_tags"]}
    for g in t["gta_movements"]:
        if g["permit_status"] != "issued" or g["gta_id"] in cold:  # a cold permit moves no animals by design
            continue
        rep.checked["lot_conservation"] += 1
        if gta_head[g["gta_id"]] != g["head_count"]:
            rep.fail("lot_conservation", f"{g['gta_id']}: permit says {g['head_count']} head, lots moved {gta_head[g['gta_id']]}")


def _anomalies(t, manifest, rep):
    cfg = (manifest or {}).get("config", {})
    allowed = set(cfg.get("scenarios", [])) | ({"records_missing"} if cfg.get("drop_gta_share") else set())
    rep.checked["anomalies"] += 1
    if len(t["anomalies"]) != len(t["ledger_refusals"]):
        rep.fail("anomalies", f"{len(t['ledger_refusals'])} refusals but {len(t['anomalies'])} attributed anomalies")
    for a in t["anomalies"]:
        rep.checked["anomalies"] += 1
        if a["scenario"] not in allowed:
            rep.fail("anomalies", f"{a['anomaly_id']} {a['kind']} at {a['ranch_id']} ({a['event_ref']}) not planted by an enabled scenario: {a['scenario']}")


def main(argv=None):
    path = Path((argv or sys.argv[1:])[0])
    manifest, tables = load(path)
    rep = validate(tables, manifest)
    print(json.dumps(rep.summary(), indent=1))
    return 0 if rep.ok else 1


if __name__ == "__main__":
    sys.exit(main())
