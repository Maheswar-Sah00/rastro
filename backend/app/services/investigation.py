"""Shipment investigation workspace: lineage graph, risk breakdown, clearing steps, reports, exports.

Everything here is a view over the pipeline's canonical FIFO lineage trace (rastro.lineage) and the
risk engine's findings and decisions (rastro.risk). No number is recomputed differently: graph node
contributions are the trace's `sources`, edges are its `trace_path`, and the breakdown is a union
over those same sources.
"""
import csv
import hashlib
import io
import json
import zipfile
from collections import defaultdict

from app.observability import APIError
from app.services import lineage, shipments
from app.store import DatasetStore

BEHAVIOUR_CODES = {"PASS_THROUGH", "OVER_CAPACITY", "ANOMALY"}
UNKNOWN_KINDS = {"external", "unresolved", "missing"}
CATEGORIES = ("post_cutoff_deforestation", "embargo", "indigenous_territory", "protected_area",
              "inventory_birth_anomalies", "suspicious_movement_behaviour", "unknown_origin")


def _node_id(src: dict) -> str:
    """Graph node for a lineage source: the ranch (birth/opening/external), the unregistered sender
    for MISSING#<id> (it appears as that id in the trace path), or UNRESOLVED#<gta> itself."""
    key = src["origin_key"]
    if key.startswith("UNRESOLVED#"):
        return key
    if key.startswith("MISSING#"):
        return key.split("#", 1)[1]
    return src["ranch_id"]


def _findings_by_entity(store: DatasetStore) -> dict[str, list[dict]]:
    return store.by("findings", "entity_id")


def _pro_rata(store: DatasetStore, sid: str) -> dict[str, float]:
    t = store.lineage_service().trace_shipment(sid, "pro_rata")
    out = defaultdict(float)
    for s in t["sources"]:
        out[_node_id(s)] += s["head_equiv"]
    return dict(out)


def _geo_flags(store: DatasetStore, ranch_id: str | None) -> tuple[bool, bool]:
    g = store.get("geo", ranch_id) if ranch_id else None
    if not g:
        return False, False
    return bool(g["legal"]["recognised_indigenous_land_overlap"]), bool(g["legal"]["strict_protection_overlap"])


def _source_categories(store: DatasetStore, src: dict, fby: dict) -> list[str]:
    cats = set()
    c = set(src["categories"])
    if "post_cutoff_deforestation" in c:
        cats.add("post_cutoff_deforestation")
    if "embargo" in c:
        cats.add("embargo")
    if "protected_overlap" in c:  # split the lineage category with the geo evidence
        ti, pa = _geo_flags(store, src["ranch_id"])
        cats |= ({"indigenous_territory"} if ti else set()) | ({"protected_area"} if pa else set())
    if "suspicious_births_or_inventory" in c or src["origin_kind"] == "unresolved":
        cats.add("inventory_birth_anomalies")
    if src["ranch_id"] and any(f["code"] in BEHAVIOUR_CODES for f in fby.get(src["ranch_id"], [])):
        cats.add("suspicious_movement_behaviour")
    if src["origin_kind"] in UNKNOWN_KINDS or "unknown_origin" in c:
        cats.add("unknown_origin")
    return sorted(cats)


# ---- graph --------------------------------------------------------------------------------------
def graph(store: DatasetStore, sid: str, max_nodes: int | None = None, expand: str | None = None) -> dict:
    s = shipments.require(store, sid)
    t = lineage.shipment_trace(store, sid)
    fby = _findings_by_entity(store)
    pr = _pro_rata(store, sid)
    sink = s["destination_id"]
    nodes: dict[str, dict] = {}

    def node(nid, kind, ranch_id=None):
        if nid not in nodes:
            nodes[nid] = {"id": nid, "kind": kind, "ranch_id": ranch_id, "roles": [], "origin_kinds": [], "head_fifo": 0.0,
                          "head_pro_rata": 0.0, "share_pct": 0.0, "categories": [], "finding_ids": [], "data_status": "synthetic"}
        return nodes[nid]

    node(sink, "sink")["roles"].append("destination")
    for src in t["sources"]:
        nid = _node_id(src)
        unknown = src["origin_kind"] in UNKNOWN_KINDS
        n = node(nid, "unknown_origin" if unknown else "ranch", src["ranch_id"])
        if "source" not in n["roles"]:
            n["roles"].append("source")
        n["origin_kinds"] = sorted(set(n["origin_kinds"]) | {src["origin_kind"]})
        n["head_fifo"] += src["head_equiv"]
        n["share_pct"] += src["share_pct"]
        n["categories"] = sorted(set(n["categories"]) | set(_source_categories(store, src, fby)))
    # Pro-rata spreads head thinly over many origins: give each FIFO node its pro-rata head and
    # summarise the origins only the pro-rata model sees, instead of drawing them all.
    pr_only = {}
    for nid, h in pr.items():
        if nid in nodes:
            nodes[nid]["head_pro_rata"] = h
        else:
            pr_only[nid] = h

    edges = []
    for p in t["trace_path"]:
        for end in (p["from"], p["to"]):
            if end not in nodes:
                node(end, "sink" if end == sink or end.startswith(("S:", "P:")) else "ranch", None if end.startswith(("S:", "P:")) else end)
        edges.append({"gta_id": p["gta_id"], "kind": "gta", "from": p["from"], "to": p["to"], "date": p["date"],
                      "permit_head": p["permit_head"], "attributed_head": p["attributed_head"]})
    out_deg = defaultdict(int)
    in_deg = defaultdict(int)
    for e in edges:
        out_deg[e["from"]] += 1
        in_deg[e["to"]] += 1
    for src in t["sources"]:  # where unattributed head enters the flow
        if src["origin_kind"] == "unresolved":
            gid = src["origin_key"].split("#", 1)[1]
            g = store.get("gtas", gid)
            applied = any(e["gta_id"] == gid for e in edges)
            to = (g["origin_id"] if applied else sink) if g else sink
            edges.append({"gta_id": None, "kind": "unattributed_inflow", "from": _node_id(src), "to": to, "date": g["movement_date"] if g else None,
                          "permit_head": float(g["head_count"]) if g else src["head_equiv"], "attributed_head": src["head_equiv"]})
    for nid, n in nodes.items():
        if n["kind"] == "ranch" and nid in set(t["direct_suppliers"]) and "direct_supplier" not in n["roles"]:
            n["roles"].append("direct_supplier")
        if n["kind"] == "ranch" and in_deg[nid] and out_deg[nid] and nid not in t["direct_suppliers"] and "intermediary" not in n["roles"]:
            n["roles"].append("intermediary")
        if n["ranch_id"]:
            n["finding_ids"] = sorted(f["finding_id"] for f in fby.get(n["ranch_id"], []) if f["entity_type"] == "ranch")
            if n["kind"] == "ranch" and not n["roles"]:
                n["roles"].append("intermediary")
        n["head_fifo"] = round(n["head_fifo"], 3)
        n["head_pro_rata"] = round(n["head_pro_rata"], 3)
        n["share_pct"] = round(n["share_pct"], 3)

    view = {"mode": "full", "folded": []}
    if expand:
        if expand not in nodes:
            raise APIError(404, "not_found", f"{expand} is not in the lineage graph of {sid}")
        keep, frontier = {expand}, [expand]
        while frontier:
            x = frontier.pop()
            for e in edges:
                if e["to"] == x and e["from"] not in keep:
                    keep.add(e["from"])
                    frontier.append(e["from"])
        edges = [e for e in edges if e["to"] in keep and e["from"] in keep]
        nodes = {k: v for k, v in nodes.items() if k in keep}
        view = {"mode": "branch", "root": expand, "folded": []}
    elif max_nodes and len(nodes) > max_nodes:
        nodes, edges, folded = _fold(nodes, edges, max_nodes, sink, set(t["direct_suppliers"]))
        view = {"mode": "overview", "max_nodes": max_nodes, "folded": folded}

    return {"shipment_id": sid, "declared_head": t["declared_head"], "destination": sink, "policy": t["policy"], "view": view,
            "nodes": sorted(nodes.values(), key=lambda n: (-n["head_fifo"], n["id"])), "edges": edges,
            "totals": {"source_head_fifo": round(sum(n["head_fifo"] for n in nodes.values()), 3),
                       "source_head_pro_rata": round(sum(n["head_pro_rata"] for n in nodes.values()) + sum(pr_only.values()), 3),
                       "pro_rata_only_head": round(sum(pr_only.values()), 3)},
            "uncertainty": {"policy_sensitivity": t["policy_sensitivity"], "notes": t["uncertainty_notes"],
                            "model": "FIFO cohort estimate; head_pro_rata shows the fully-mixed-herd alternative",
                            "pro_rata_only_origins": {"count": len(pr_only), "head": round(sum(pr_only.values()), 3),
                                                      "top": [{"id": k, "head": round(v, 3)} for k, v in sorted(pr_only.items(), key=lambda kv: -kv[1])[:10]]}}}


def _fold(nodes, edges, max_nodes, sink, direct):
    """Keep the sink, direct suppliers and the largest sources; fold the rest into one node per
    primary category. Node head totals stay exact; folded edges are aggregated per (category, to)."""
    pinned = {sink} | {n for n in direct if n in nodes}
    others = sorted((n for k, n in nodes.items() if k not in pinned), key=lambda n: (-n["head_fifo"], n["id"]))
    room = max(0, max_nodes - len(pinned) - 4)
    keep = pinned | {n["id"] for n in others[:room]}
    out = {k: v for k, v in nodes.items() if k in keep}
    folded_map, folded = {}, defaultdict(list)
    for n in others[room:]:
        cat = n["categories"][0] if n["categories"] else "no_risk_category"
        fid = f"other:{cat}"
        folded_map[n["id"]] = fid
        folded[fid].append(n["id"])
        f = out.setdefault(fid, {"id": fid, "kind": "folded", "ranch_id": None, "roles": ["folded"], "origin_kinds": [], "head_fifo": 0.0,
                                 "head_pro_rata": 0.0, "share_pct": 0.0, "categories": [cat] if n["categories"] else [], "finding_ids": [],
                                 "data_status": "synthetic"})
        f["head_fifo"] = round(f["head_fifo"] + n["head_fifo"], 3)
        f["head_pro_rata"] = round(f["head_pro_rata"] + n["head_pro_rata"], 3)
        f["share_pct"] = round(f["share_pct"] + n["share_pct"], 3)
        f["origin_kinds"] = sorted(set(f["origin_kinds"]) | set(n["origin_kinds"]))
    agg = {}
    for e in edges:
        a, b = folded_map.get(e["from"], e["from"]), folded_map.get(e["to"], e["to"])
        if a == b:
            continue
        if e["from"] in folded_map or e["to"] in folded_map:
            k = (a, b)
            x = agg.setdefault(k, {"gta_id": None, "kind": "folded", "from": a, "to": b, "date": None, "permit_head": 0.0, "attributed_head": 0.0, "gta_count": 0})
            x["permit_head"] = round(x["permit_head"] + e["permit_head"], 3)
            x["attributed_head"] = round(x["attributed_head"] + e["attributed_head"], 3)
            x["gta_count"] += 1
        else:
            agg[(e["gta_id"], a, b, e["kind"])] = e
    return out, list(agg.values()), [{"node": k, "members": v} for k, v in sorted(folded.items())]


# ---- breakdown ------------------------------------------------------------------------------------
def breakdown(store: DatasetStore, sid: str) -> dict:
    t = lineage.shipment_trace(store, sid)
    fby = _findings_by_entity(store)
    declared = t["declared_head"]
    per = {c: {"head": 0.0, "sources": []} for c in CATEGORIES}
    affected = 0.0
    for src in t["sources"]:
        cats = _source_categories(store, src, fby)
        for c in cats:
            per[c]["head"] += src["head_equiv"]
            per[c]["sources"].append(_node_id(src))
        if cats:
            affected += src["head_equiv"]
    # Behaviour at intermediaries: FIFO lot composition does not record which origins passed through
    # which intermediary, so their head is reported per intermediary and not added to the union.
    via = []
    path_out = defaultdict(float)
    for p in t["trace_path"]:
        path_out[p["from"]] += p["attributed_head"]
    srcs = {_node_id(s) for s in t["sources"]}
    for r, h in sorted(path_out.items()):
        if r in srcs or not r.startswith("R"):
            continue
        codes = sorted({f["code"] for f in fby.get(r, []) if f["code"] in BEHAVIOUR_CODES})
        if codes:
            via.append({"ranch_id": r, "codes": codes, "attributed_head": round(min(h, declared), 3)})
    beh = per["suspicious_movement_behaviour"]
    beh_lower = max([beh["head"]] + [v["attributed_head"] for v in via])
    cats = {}
    for c in CATEGORIES:
        h = beh_lower if c == "suspicious_movement_behaviour" else per[c]["head"]
        cats[c] = {"head": round(h, 3), "pct": round(100 * h / declared, 3) if declared else 0.0, "sources": per[c]["sources"]}
    cats["suspicious_movement_behaviour"]["via_intermediaries"] = via
    cats["suspicious_movement_behaviour"]["note"] = "lower bound when only intermediaries are involved: per-intermediary throughput, not origin-resolved"
    return {"shipment_id": sid, "declared_head": declared, "categories": cats,
            "unique_affected_head": round(affected, 3), "unique_affected_pct": round(100 * affected / declared, 3) if declared else 0.0,
            "sum_of_category_pct": round(sum(v["pct"] for v in cats.values()), 3),
            "note": "unique_affected counts each source's head once (union over source ranches), never a sum of percentages"}


def clearing_steps(store: DatasetStore, sid: str, decision: dict | None, review_status: dict[str, str]) -> list[dict]:
    """What evidence would resolve each non-PASS reason. Derived from the decision's own reasons."""
    if decision is None:
        return [{"action": "run the assessment", "why": "no decision has been computed for this shipment"}]
    t = lineage.shipment_trace(store, sid)
    ext = [s["ranch_id"] for s in t["sources"] if s["origin_kind"] == "external"]
    unres = [s["origin_key"].split("#", 1)[1] for s in t["sources"] if s["origin_kind"] == "unresolved"]
    inter = sorted({p["to"] for p in t["trace_path"] if p["to"].startswith("R")})  # ranches whose mixed herds were allocated
    steps = []
    idx = store.by("findings", "finding_id")
    if decision["outcome"] == "FLAGGED":
        for fid in decision["blocking_finding_ids"]:
            f = idx.get(fid, [{}])[0]
            disputed = review_status.get(fid) == "dismissed"
            steps.append({"action": "blocking rule applies", "finding_id": fid,
                          "why": f"{f.get('code')} on {f.get('entity_id')}" + ("; investigator disputes it, but the blocking rule still applies" if disputed else "")
                                 + ". Only corrected underlying records (e.g. a lifted embargo, corrected permits) can change the outcome."})
    text = " ".join(decision["reasons"]).lower()
    if ("coverage" in text or "unknown" in text) and ext:
        steps.append({"action": f"obtain upstream GTAs for external supplier(s) {', '.join(sorted(set(ext)))}",
                      "why": f"raises lineage coverage ({t['coverage_pct']:.1f}%) toward the 75% needed to pass"})
    if unres:
        steps.append({"action": f"resolve refused or unresolved permit(s) {', '.join(unres)} with the issuing agency",
                      "why": "their head has no traceable origin"})
    if inter and any(k in text for k in ("allocation", "pro-rata", "pro_rata", "bands")):
        steps.append({"action": f"obtain lot- or animal-level records (ear tags) for intermediaries {', '.join(inter) or '(none recorded)'}",
                      "why": "the outcome depends on whether mixed herds are allocated FIFO or pro-rata"})
    if "environmental evidence" in text:
        steps.append({"action": "obtain environmental evidence for the source ranches without it", "why": "missing evidence is never treated as clean"})
    for fid in decision["review_finding_ids"]:
        f = idx.get(fid, [{}])[0]
        st = review_status.get(fid, "unreviewed")
        if st not in ("confirmed", "dismissed"):
            steps.append({"action": f"investigator review of finding {fid}", "finding_id": fid,
                          "why": f"{f.get('code')} ({f.get('severity')}) on {f.get('entity_id')}; current review status: {st}"})
    return steps


# ---- reports and exports ---------------------------------------------------------------------------
def report(store: DatasetStore, sid: str) -> dict:
    t = lineage.shipment_trace(store, sid)
    g = graph(store, sid)
    b = breakdown(store, sid)
    d = store.get("decisions", sid)
    pr = {n["id"]: n["head_pro_rata"] for n in g["nodes"]}
    return {"shipment_id": sid, "declared_head": t["declared_head"], "coverage_pct": t["coverage_pct"], "max_hops": t["max_hops"],
            "outcome": d["outcome"] if d else None, "exposure_pct": t["exposure_pct"], "attribution": t["attribution"],
            "breakdown": b, "sources": [{"node": _node_id(s), "origin_key": s["origin_key"], "origin_kind": s["origin_kind"], "head_fifo": s["head_equiv"],
                                         "head_pro_rata": pr.get(_node_id(s), 0.0), "share_pct": s["share_pct"], "min_hops": s["min_hops"],
                                         "categories": _source_categories(store, s, _findings_by_entity(store))} for s in t["sources"]],
            "path": t["trace_path"], "uncertainty_notes": t["uncertainty_notes"], "provenance": store.provenance()}


def _cell(v):
    """Spreadsheet-safe cell: text starting with = + - @ (or a tab/CR) is prefixed with ' so it is never
    evaluated as a formula when the report is opened in a spreadsheet."""
    return "'" + v if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r") else v


def report_csv(rep: dict) -> str:
    buf = io.StringIO()
    raw = csv.writer(buf, lineterminator="\n")

    class _W:
        @staticmethod
        def writerow(row):
            raw.writerow([_cell(c) for c in row])
    w = _W()
    w.writerow(["shipment_id", "node", "origin_key", "origin_kind", "head_fifo", "head_pro_rata", "share_pct", "min_hops", "categories"])
    for s in rep["sources"]:
        w.writerow([rep["shipment_id"], s["node"], s["origin_key"], s["origin_kind"], s["head_fifo"], s["head_pro_rata"], s["share_pct"],
                    s["min_hops"], ";".join(s["categories"])])
    return buf.getvalue()


def report_md(rep: dict) -> str:
    b = rep["breakdown"]
    L = [f"# Lineage report {rep['shipment_id']}", "",
         f"Declared head {rep['declared_head']:g}; coverage {rep['coverage_pct']:.1f}%; up to {rep['max_hops']} hops; decision {rep['outcome']}.",
         "", "> Synthetic data. Origins are FIFO cohort estimates, not individual animals; no legal conclusion is implied.", "",
         "| Source | Kind | Head (FIFO) | Head (pro-rata) | Share | Hops | Categories |", "|---|---|---:|---:|---:|---:|---|"]
    L += [f"| {s['node']} | {s['origin_kind']} | {s['head_fifo']:g} | {s['head_pro_rata']:g} | {s['share_pct']:.1f}% | {s['min_hops']} | {', '.join(s['categories']) or '-'} |"
          for s in rep["sources"]]
    L += ["", "| Category | Head | % |", "|---|---:|---:|"]
    L += [f"| {c} | {v['head']:g} | {v['pct']:.1f}% |" for c, v in b["categories"].items()]
    L += [f"| **unique affected (union)** | {b['unique_affected_head']:g} | {b['unique_affected_pct']:.1f}% |", "",
          "| Date | GTA | From | To | Permit head | Attributed head |", "|---|---|---|---|---:|---:|"]
    L += [f"| {p['date']} | {p['gta_id']} | {p['from']} | {p['to']} | {p['permit_head']:g} | {p['attributed_head']:g} |" for p in rep["path"]]
    L += ["", "Uncertainty:"] + [f"- {n}" for n in rep["uncertainty_notes"]]
    return "\n".join(L) + "\n"


def bundle_zip(store: DatasetStore, sid: str, reviews: list[dict]) -> bytes:
    shipments.require(store, sid)
    d = store.get("decisions", sid)
    t = lineage.shipment_trace(store, sid)
    ev_dir = store.dir / "derived" / "risk" / "evidence"
    files: dict[str, bytes] = {}

    def put(name, obj):
        files[name] = json.dumps(obj, indent=1, ensure_ascii=False, sort_keys=True).encode("utf-8")
    m = store.json("manifest") or {}
    put("provenance.json", {"provenance": store.provenance(), "manifest_notice": m.get("notice"), "raw_inputs": m.get("raw_inputs")})
    put("lineage_trace.json", t)
    if d:
        p = ev_dir / f"{d['evidence_hash']}.json"
        if p.is_file():
            files[f"evidence/decision-{d['evidence_hash']}.json"] = p.read_bytes()
        put("decision.json", d)
    fs = []
    idx = store.by("findings", "finding_id")
    ids = set(f["finding_id"] for f in store.by("findings", "entity_id").get(sid, []))
    if d:
        ids |= set(d["blocking_finding_ids"]) | set(d["review_finding_ids"])
    for fid in sorted(ids):
        f = idx.get(fid, [None])[0]
        if not f:
            continue
        fs.append(f)
        p = ev_dir / f"{f['evidence_hash']}.json"
        if p.is_file():
            files[f"evidence/finding-{f['evidence_hash']}.json"] = p.read_bytes()  # canonical bytes: re-hash to verify
    put("findings.json", fs)
    ranches = sorted({s["ranch_id"] for s in t["sources"] if s["ranch_id"]} | set(t["intermediaries"]) | set(t["direct_suppliers"]))
    for r in ranches:
        g = store.get("geo", r)
        if g:
            put(f"geo_evidence/{r}.json", g)
    put("reviews.json", reviews)
    files["README.txt"] = (f"Rastro evidence bundle for {sid}.\nSynthetic demonstration data; not a legal determination.\n"
                           "evidence/*.json are canonical files: SHA-256 of each file's bytes equals the hash in its name.\n"
                           "Investigator reviews annotate findings; they never change a finding, its hash or the decision.\n").encode()
    files["checksums.sha256"] = "".join(f"{hashlib.sha256(v).hexdigest()}  {k}\n" for k, v in sorted(files.items())).encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(files):
            zi = zipfile.ZipInfo(f"{sid}/{name}", date_time=(2026, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, files[name])
    return buf.getvalue()
