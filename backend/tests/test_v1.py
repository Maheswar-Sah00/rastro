"""/api/v1 over a canonical dataset: built from the pipeline's tiny fixture, plus the full evaluation
dataset when it is present (representative shipments SHP-D-001239 and SHP-D-001677)."""
import csv
import hashlib
import io
import json
import shutil
import zipfile
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import v1
from app.config import REPO, get_settings
from app.main import app
from app.services import chain as chain_svc
from app.store import DatasetStore

TINY = REPO / "pipeline" / "tests" / "fixtures" / "tiny"
EVAL = REPO / "data" / "synthetic" / "evaluation"
WEB = REPO / "web" / "public" / "data"


@pytest.fixture(scope="session")
def tiny_dataset(tmp_path_factory):
    from rastro.geospatial.run import run as run_geo
    from rastro.risk.run import run as run_risk
    d = tmp_path_factory.mktemp("api") / "tiny"
    shutil.copytree(TINY, d, ignore=shutil.ignore_patterns("geo_*", "lineage_*", "risk", "reviews"))
    run_geo(d)
    run_risk(d)
    from rastro.lineage.service import LineageService
    LineageService(d).trace_all()
    return d


def client_for(dataset: Path, web: Path = WEB) -> TestClient:
    store = DatasetStore(dataset, web)
    app.dependency_overrides[v1.get_store] = lambda: store
    return TestClient(app)


@pytest.fixture
def c(tiny_dataset):
    yield client_for(tiny_dataset)
    app.dependency_overrides.clear()


@pytest.fixture(scope="module")
def ev():
    if not (EVAL / "derived" / "risk" / "decisions.jsonl").is_file():
        pytest.skip("evaluation dataset with risk outputs not generated")
    store = DatasetStore(EVAL, WEB)
    app.dependency_overrides[v1.get_store] = lambda: store
    yield TestClient(app)
    app.dependency_overrides.clear()


def data(r, status=200):
    assert r.status_code == status, r.text
    return r.json()["data"]


def pick_shipment(c, *, min_hops=3, min_sources=2, multi_cat=True, unknown=True):
    """A shipment matching the investigation-workspace criteria, if the fixture has one."""
    best = None
    for s in data(c.get("/api/v1/shipments?limit=500")):
        t = data(c.get(f"/api/v1/shipments/{s['shipment_id']}"))["lineage"]
        srcs = [x for x in t["sources"] if x["ranch_id"] and x["origin_kind"] != "external"]
        ok = (t["max_hops"] >= min_hops and len(srcs) >= min_sources and (not unknown or t["exposure_pct"]["unknown_or_incomplete"] > 0)
              and (not multi_cat or any(len(set(x["categories"]) - {"unknown_origin"}) >= 2 for x in t["sources"])))
        if ok:
            return s["shipment_id"]
        if best is None and t["max_hops"] >= 2 and len(t["sources"]) >= 2:
            best = s["shipment_id"]
    return best


# ---- provenance, readiness, errors -------------------------------------------------------------------
def test_ready_and_summary_carry_provenance(c):
    assert c.get("/api/v1/ready").json()["ready"] is True
    body = c.get("/api/v1/summary").json()
    m = body["meta"]
    assert m["dataset_id"] == "rastro-synth-tiny" and m["logical_digest"]
    assert m["data_status"]["ranches"] == "synthetic" and m["data_status"]["risk"] == "derived"
    assert "truth" not in json.dumps(body["data"]["counts"])


def test_request_id_is_echoed_and_errors_are_structured(c):
    r = c.get("/api/v1/ranches/R9999", headers={"X-Request-ID": "test-req-1"})
    assert r.status_code == 404 and r.headers["X-Request-ID"] == "test-req-1"
    assert r.json()["error"] == {"code": "not_found", "message": "ranch R9999 not found", "details": None, "request_id": "test-req-1"}


@pytest.mark.parametrize("url", ["/api/v1/ranches/R12", "/api/v1/ranches/r0001", "/api/v1/gtas/GTA-1", "/api/v1/lots/GTA-PA-2023-000001/lineage",
                                 "/api/v1/shipments/SHP-0008", "/api/v1/certificates/0x1234", "/api/v1/ranches?limit=0", "/api/v1/ranches?limit=9999",
                                 "/api/v1/shipments?outcome=CLEAN", "/api/v1/findings/F-xyz"])
def test_invalid_identifiers_and_params_are_422(c, url):
    r = c.get(url)
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_request"


@pytest.mark.parametrize("url", ["/api/v1/ranches/R0999", "/api/v1/gtas/GTA-PA-2023-999999", "/api/v1/shipments/SHP-D-999999",
                                 "/api/v1/lots/LOT-GTA-PA-2023-999999/lineage", "/api/v1/findings/F-0000000000000000",
                                 "/api/v1/certificates/0x" + "ab" * 32])
def test_missing_records_are_404(c, url):
    assert c.get(url).status_code == 404


def test_malformed_data_is_a_structured_500(tmp_path):
    (tmp_path / "inputs").mkdir()
    (tmp_path / "manifest.json").write_text(json.dumps({"dataset_id": "broken", "tables": {}}), encoding="utf-8")
    (tmp_path / "inputs" / "ranches.jsonl").write_text('{"ranch_id": "R0001"}\n{not json\n', encoding="utf-8")
    try:
        r = client_for(tmp_path).get("/api/v1/ranches")
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 500
    e = r.json()["error"]
    assert e["code"] == "malformed_data" and e["details"]["file"] == "ranches.jsonl" and e["details"]["line"] == 2


def test_cache_invalidates_when_a_file_changes(tiny_dataset, tmp_path):
    d = tmp_path / "copy"
    shutil.copytree(tiny_dataset, d)
    c = client_for(d)
    try:
        n = c.get("/api/v1/ranches?limit=1").json()["page"]["total"]
        p = d / "inputs" / "ranches.jsonl"
        lines = p.read_text(encoding="utf-8").splitlines()
        p.write_text("\n".join(lines[:-1]) + "\n", encoding="utf-8")
        assert c.get("/api/v1/ranches?limit=1").json()["page"]["total"] == n - 1
    finally:
        app.dependency_overrides.clear()


# ---- ranches, movements, lineage ---------------------------------------------------------------------
def test_ranch_collection_is_paginated_and_distinguishes_missing_from_zero(c):
    body = c.get("/api/v1/ranches?limit=5&offset=2").json()
    assert body["page"] == {"limit": 5, "offset": 2, "total": body["page"]["total"]} and len(body["data"]) == 5
    rows = data(c.get("/api/v1/ranches?limit=500"))
    ext = [r for r in rows if r["entity_type"] == "external_supplier"]
    assert ext and all(r["environmental_evidence"] == "not_applicable" and r["post_cutoff_deforestation_ha"] is None for r in ext)
    zero = [r for r in rows if r["post_cutoff_deforestation_ha"] == 0]
    assert zero and all(r["environmental_evidence"] == "available" for r in zero)


def test_ranch_detail_risk_and_movements(c):
    rid = next(r["ranch_id"] for r in data(c.get("/api/v1/ranches?risk_class=high&limit=50")))
    d = data(c.get(f"/api/v1/ranches/{rid}"))
    assert d["ranch"]["ranch_id"] == rid and d["environmental"]["status"] == "available"
    risk = data(c.get(f"/api/v1/ranches/{rid}/risk"))
    assert risk["risk_status"] == "assessed" and risk["findings"] and "not a probability" in risk["anomaly_note"]
    mv = c.get(f"/api/v1/ranches/{rid}/movements?direction=out&limit=500").json()
    assert all(m["movement"]["origin_id"] == rid for m in mv["data"])
    assert mv["page"]["total"] == d["movements"]["out"]


def test_gta_and_lot_lineage(c):
    g = data(c.get("/api/v1/ranches?limit=1"))[0]
    gid = data(c.get(f"/api/v1/ranches/{g['ranch_id']}/movements?limit=1"))[0]["movement"]["gta_id"]
    d = data(c.get(f"/api/v1/gtas/{gid}?include_lineage=true"))
    assert d["movement"]["gta_id"] == gid and d["ledger_status"] in ("accepted", "refused", "not_moved")
    if d["ledger_status"] == "accepted":
        t = data(c.get(f"/api/v1/lots/LOT-{gid}/lineage?policy=pro_rata"))
        assert t["policy"] == "pro_rata" and t["lot_ids"] == [f"LOT-{gid}"]


# ---- shipments, risk, assessment ---------------------------------------------------------------------
def test_shipment_detail_risk_and_evidence(c):
    s = data(c.get("/api/v1/shipments?outcome=FLAGGED&limit=1"))[0]
    sid = s["shipment_id"]
    d = data(c.get(f"/api/v1/shipments/{sid}"))
    assert d["assessment_status"] == "assessed" and d["decision"]["outcome"] == "FLAGGED" and d["lineage"]["shipment_id"] == sid
    r = data(c.get(f"/api/v1/shipments/{sid}/risk"))
    assert r["findings_by_category"] and r["breakdown"]["declared_head"] == d["lineage"]["declared_head"]
    ev = data(c.get(f"/api/v1/shipments/{sid}/evidence"))
    assert ev["items"][0]["kind"] == "decision" and all(i["hash_verified"] for i in ev["items"])


def test_incomplete_lineage_is_reported_not_passed(c):
    rows = data(c.get("/api/v1/shipments?limit=500"))
    unk = [s for s in rows if s["coverage_pct"] is not None and s["coverage_pct"] < 75]
    assert unk, "fixture should contain a shipment with incomplete lineage"
    for s in unk[:5]:
        d = data(c.get(f"/api/v1/shipments/{s['shipment_id']}"))
        assert d["decision"]["outcome"] != "PASS"
        assert d["lineage"]["exposure_pct"]["unknown_or_incomplete"] > 0


def test_assessment_retrieves_canonical_decision_and_rejects_client_verdicts(c):
    s = data(c.get("/api/v1/shipments?limit=1"))[0]
    a = data(c.post(f"/api/v1/shipments/{s['shipment_id']}/assess", json={}))
    assert a["source"] == "precomputed" and a["outcome"] == s["outcome"] and a["detector_versions"] is not None
    assert a["decision_evidence_hash"] and a["engine_version"]
    for bad in ({"outcome": "PASS"}, {"verdict": "clean"}, {"recompute": False, "certification_status": "certified_clean"}):
        r = c.post(f"/api/v1/shipments/{s['shipment_id']}/assess", json=bad)
        assert r.status_code == 422


def test_recompute_reproduces_the_same_decision(tiny_dataset, tmp_path):
    d = tmp_path / "re"
    shutil.copytree(tiny_dataset, d)
    c = client_for(d)
    try:
        s = data(c.get("/api/v1/shipments?limit=1"))[0]
        a = data(c.post(f"/api/v1/shipments/{s['shipment_id']}/assess", json={"recompute": True}))
        assert a["source"] == "recomputed" and a["outcome"] == s["outcome"]
    finally:
        app.dependency_overrides.clear()


def test_assessment_failure_without_geo_evidence_is_409(tiny_dataset, tmp_path):
    d = tmp_path / "nogeo"
    shutil.copytree(tiny_dataset, d, ignore=shutil.ignore_patterns("geo_*", "risk"))
    c = client_for(d)
    try:
        sid = json.loads((d / "inputs" / "shipments.jsonl").read_text(encoding="utf-8").splitlines()[0])["shipment_id"]
        assert data(c.get(f"/api/v1/shipments/{sid}"))["assessment_status"] == "not_assessed"
        r = c.post(f"/api/v1/shipments/{sid}/assess", json={})
        assert r.status_code == 409 and r.json()["error"]["code"] == "assessment_unavailable"
        assert c.get("/api/v1/ready").status_code == 503
    finally:
        app.dependency_overrides.clear()


# ---- investigation workspace -----------------------------------------------------------------------
def test_graph_matches_trace(c):
    sid = pick_shipment(c)
    g = data(c.get(f"/api/v1/shipments/{sid}/lineage/graph"))
    t = data(c.get(f"/api/v1/shipments/{sid}"))["lineage"]
    assert sum(n["head_fifo"] for n in g["nodes"]) == pytest.approx(t["declared_head"], abs=1e-3 * len(g["nodes"]) + 1e-6)
    assert g["totals"]["source_head_pro_rata"] == pytest.approx(t["declared_head"], abs=0.05)
    gta_edges = [e for e in g["edges"] if e["kind"] == "gta"]
    assert sorted((e["gta_id"], e["attributed_head"]) for e in gta_edges) == sorted((p["gta_id"], p["attributed_head"]) for p in t["trace_path"])
    assert any(n["kind"] == "sink" for n in g["nodes"])


def test_graph_overview_keeps_totals_and_expand_returns_branch(c):
    sid = pick_shipment(c)
    full = data(c.get(f"/api/v1/shipments/{sid}/lineage/graph"))
    small = data(c.get(f"/api/v1/shipments/{sid}/lineage/graph?max_nodes=5"))
    assert sum(n["head_fifo"] for n in small["nodes"]) == pytest.approx(sum(n["head_fifo"] for n in full["nodes"]), abs=1e-6)
    inter = next((n["id"] for n in full["nodes"] if "intermediary" in n["roles"] or "direct_supplier" in n["roles"]), None)
    branch = data(c.get(f"/api/v1/shipments/{sid}/lineage/graph?expand={inter}"))
    assert branch["view"]["mode"] == "branch" and all(e["to"] in {n["id"] for n in branch["nodes"]} for e in branch["edges"])
    assert c.get(f"/api/v1/shipments/{sid}/lineage/graph?expand=R0999").status_code == 404


def test_breakdown_unique_total_is_a_union(c):
    for s in data(c.get("/api/v1/shipments?limit=40")):
        b = data(c.get(f"/api/v1/shipments/{s['shipment_id']}/risk"))["breakdown"]
        assert b["unique_affected_pct"] <= b["sum_of_category_pct"] + 1e-6
        assert b["unique_affected_head"] <= b["declared_head"] + 1e-6


def test_report_numbers_equal_api_numbers(c):
    sid = pick_shipment(c)
    t = data(c.get(f"/api/v1/shipments/{sid}"))["lineage"]
    risk = data(c.get(f"/api/v1/shipments/{sid}/risk"))
    rep = c.get(f"/api/v1/shipments/{sid}/lineage/report?format=json").json()
    assert rep["declared_head"] == t["declared_head"] and rep["coverage_pct"] == t["coverage_pct"]
    assert rep["exposure_pct"] == t["exposure_pct"] and rep["breakdown"] == risk["breakdown"]
    rows = list(csv.DictReader(io.StringIO(c.get(f"/api/v1/shipments/{sid}/lineage/report?format=csv").text)))
    assert [(r["origin_key"], float(r["head_fifo"])) for r in rows] == [(s["origin_key"], s["head_equiv"]) for s in t["sources"]]
    md = c.get(f"/api/v1/shipments/{sid}/lineage/report?format=md").text
    assert f"{risk['breakdown']['unique_affected_pct']:.1f}%" in md


def test_evidence_bundle_is_verifiable(c):
    sid = data(c.get("/api/v1/shipments?outcome=FLAGGED&limit=1"))[0]["shipment_id"]
    r = c.get(f"/api/v1/shipments/{sid}/evidence/download")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = z.namelist()
    assert f"{sid}/decision.json" in names and f"{sid}/lineage_trace.json" in names and f"{sid}/provenance.json" in names
    for n in names:
        if "/evidence/" in n:
            h = n.rsplit("-", 1)[1].removesuffix(".json")
            assert hashlib.sha256(z.read(n)).hexdigest() == h
    sums = dict(l.split("  ")[::-1] for l in z.read(f"{sid}/checksums.sha256").decode().splitlines())
    assert all(hashlib.sha256(z.read(f"{sid}/{k}")).hexdigest() == v for k, v in sums.items())


def test_reviews_annotate_but_never_change_findings_or_decisions(tiny_dataset, tmp_path):
    d = tmp_path / "rev"
    shutil.copytree(tiny_dataset, d)
    c = client_for(d)
    try:
        sid = data(c.get("/api/v1/shipments?outcome=FLAGGED&limit=1"))[0]["shipment_id"]
        dec = data(c.get(f"/api/v1/shipments/{sid}"))["decision"]
        fid = dec["blocking_finding_ids"][0]
        before = data(c.get(f"/api/v1/findings/{fid}"))
        assert before["review_status"] == "unreviewed"
        assert c.post(f"/api/v1/findings/{fid}/reviews", json={"status": "dismissed", "reviewer": "inv-1"}).status_code == 422
        assert c.post(f"/api/v1/findings/{fid}/reviews", json={"status": "dismissed", "reason": "short", "reviewer": "inv-1"}).status_code == 422
        assert c.post(f"/api/v1/findings/{fid}/reviews", json={"status": "under_review", "reviewer": "inv-1"}).status_code == 201
        r = c.post(f"/api/v1/findings/{fid}/reviews", json={"status": "dismissed", "reason": "boundary sliver on a synthetic cell", "reviewer": "inv-1"},
                   headers={"X-Request-ID": "rev-42"})
        after = data(r, 201)
        assert after["finding"] == before["finding"]
        assert after["review_status"] == "dismissed" and [x["status"] for x in after["reviews"]] == ["under_review", "dismissed"]
        assert after["reviews"][-1]["request_id"] == "rev-42" and after["reviews"][-1]["finding_evidence_hash"] == before["finding"]["evidence_hash"]
        imp = [i for i in after["decision_impact"] if i["shipment_id"] == sid][0]
        assert imp["outcome"] == "FLAGGED" and imp["note"] == "investigator disputes; blocking rule still applies"
        assert data(c.get(f"/api/v1/shipments/{sid}"))["decision"] == dec
        risk = data(c.get(f"/api/v1/shipments/{sid}/risk"))
        assert risk["review_status"][fid] == "dismissed" and risk["decision"]["outcome"] == "FLAGGED"
        assert any("blocking rule still applies" in s["why"] for s in risk["clearing_steps"])
        log = (d / "derived" / "reviews" / "annotations.jsonl").read_text(encoding="utf-8").splitlines()
        assert len(log) == 2
    finally:
        app.dependency_overrides.clear()


# ---- certificates and chain -----------------------------------------------------------------------
def _cert_ids():
    o = json.loads((WEB / "onchain.json").read_text(encoding="utf-8"))
    consumed = next(r["lot_id"] for r in o["records"] if r["kind"] == "consumeCertificate")
    flagged = next(r["lot_id"] for r in o["records"] if r["kind"] == "issueCertificate" and "flagged" in (r.get("note") or ""))
    return consumed, flagged


@pytest.fixture
def local_chain(monkeypatch):
    s = replace(get_settings(), chain_mode="local")
    monkeypatch.setattr(chain_svc, "get_settings", lambda: s)
    chain_svc._cache.clear()
    yield
    chain_svc._cache.clear()


def test_certificate_status_and_verification_are_labelled_local(c, local_chain):
    consumed, flagged = _cert_ids()
    cert = data(c.get(f"/api/v1/certificates/{consumed}"))
    assert cert["status"] == "consumed" and cert["chain"]["mode"] == "local_records" and cert["chain"]["verified_public"] is False
    assert "not a public testnet" in cert["chain"]["label"]
    v = data(c.post(f"/api/v1/certificates/{consumed}/verify"))
    assert v["evidence_hash_matches"] is True and v["onchain_hash_matches"] is True and v["usable"] is False
    vf = data(c.post(f"/api/v1/certificates/{flagged}/verify"))
    assert vf["status"] == "not_clean" and vf["usable"] is False


def test_unavailable_rpc_falls_back_to_labelled_records(c, monkeypatch):
    s = replace(get_settings(), chain_mode="auto", rpc_url="http://127.0.0.1:9", rpc_timeout_s=0.5)
    monkeypatch.setattr(chain_svc, "get_settings", lambda: s)
    chain_svc._cache.clear()
    st = data(c.get("/api/v1/chain/status"))["chain"]
    assert st["mode"] == "local_records" and "RPC unavailable" in st["detail"] and st["verified_public"] is False
    s2 = replace(s, chain_mode="rpc")
    monkeypatch.setattr(chain_svc, "get_settings", lambda: s2)
    chain_svc._cache.clear()
    r = c.get("/api/v1/chain/status")
    assert r.status_code == 503 and r.json()["error"]["code"] == "chain_unavailable"
    chain_svc._cache.clear()


def test_consume_request_is_unsigned_calldata(c, local_chain):
    from rastro.certificates.bundle import commit
    consumed, _ = _cert_ids()
    tx = data(c.post(f"/api/v1/certificates/{consumed}/consume-request", json={"use": 1, "ref_hash": "0x" + "11" * 32}))
    assert tx["signed"] is False and tx["data"].startswith("0x") and len(tx["data"]) == 2 + 8 + 3 * 64
    by_id = data(c.post(f"/api/v1/certificates/{consumed}/consume-request", json={"use": 1, "shipment_id": "SHP-0327"}))
    assert by_id["data"].endswith(commit("SHP-0327")[2:])  # the replay's shipment-commitment convention
    assert c.post(f"/api/v1/certificates/{consumed}/consume-request", json={"use": 7, "ref_hash": "0x00"}).status_code == 422
    assert c.post(f"/api/v1/certificates/{consumed}/consume-request", json={"use": 1}).status_code == 422


def test_canonical_certificate_bundle_only_pass_is_eligible(c):
    from rastro.certificates.bundle import commit, evidence_hash
    rows = data(c.get("/api/v1/shipments?limit=500"))
    passed = next((s["shipment_id"] for s in rows if s["outcome"] == "PASS"), None)
    flagged = next(s["shipment_id"] for s in rows if s["outcome"] == "FLAGGED")
    f = data(c.get(f"/api/v1/shipments/{flagged}/certificate/bundle"))
    assert f["eligible_for_clean_certificate"] is False and "FLAGGED" in f["ineligibility_reason"]
    assert f["evidence_hash"] == evidence_hash(f["bundle"]) and f["shipment_commitment"] == commit(flagged)
    if passed:
        p = data(c.get(f"/api/v1/shipments/{passed}/certificate/bundle"))
        assert p["eligible_for_clean_certificate"] is True and p["bundle"]["decision"]["outcome"] == "PASS"


def test_evaluation_summary_unavailable_is_not_an_error(c):
    e = data(c.get("/api/v1/evaluation/summary"))
    assert e["status"] in ("available", "unavailable")


def test_openapi_lists_every_required_endpoint(c):
    paths = c.get("/openapi.json").json()["paths"]
    for p in ["/api/v1/health", "/api/v1/ready", "/api/v1/summary", "/api/v1/ranches", "/api/v1/ranches/{ranch_id}",
              "/api/v1/ranches/{ranch_id}/movements", "/api/v1/ranches/{ranch_id}/risk", "/api/v1/gtas/{gta_id}", "/api/v1/lots/{lot_id}/lineage",
              "/api/v1/shipments", "/api/v1/shipments/{shipment_id}", "/api/v1/shipments/{shipment_id}/risk", "/api/v1/shipments/{shipment_id}/evidence",
              "/api/v1/certificates/{certificate_id}", "/api/v1/evaluation/summary", "/api/v1/shipments/{shipment_id}/assess",
              "/api/v1/certificates/{certificate_id}/verify", "/api/v1/shipments/{shipment_id}/lineage/graph",
              "/api/v1/shipments/{shipment_id}/lineage/report", "/api/v1/shipments/{shipment_id}/evidence/download",
              "/api/v1/findings/{finding_id}", "/api/v1/findings/{finding_id}/reviews"]:
        assert p in paths, p


# ---- representative shipments on the full evaluation dataset ------------------------------------------
@pytest.mark.parametrize("sid,unknown", [("SHP-D-001239", 16.505), ("SHP-D-001677", 40.0)])
def test_representative_shipments(ev, sid, unknown):
    t = data(ev.get(f"/api/v1/shipments/{sid}"))["lineage"]
    assert t["max_hops"] >= 3 and t["exposure_pct"]["unknown_or_incomplete"] == pytest.approx(unknown)
    g = data(ev.get(f"/api/v1/shipments/{sid}/lineage/graph"))
    assert sum(n["head_fifo"] for n in g["nodes"]) == pytest.approx(t["declared_head"], abs=1e-3)
    assert sorted(e["gta_id"] for e in g["edges"] if e["kind"] == "gta") == sorted(p["gta_id"] for p in t["trace_path"])
    b = data(ev.get(f"/api/v1/shipments/{sid}/risk"))["breakdown"]
    assert b["unique_affected_pct"] <= b["sum_of_category_pct"]
    multi = [n for n in g["nodes"] if len(set(n["categories"]) - {"unknown_origin"}) >= 2]
    assert multi and b["unique_affected_pct"] < b["sum_of_category_pct"]  # an overlapping source is counted once
    rep = ev.get(f"/api/v1/shipments/{sid}/lineage/report").json()
    assert rep["breakdown"] == b and rep["coverage_pct"] == t["coverage_pct"]
