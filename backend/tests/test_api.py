import json
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx

BACKEND = Path(__file__).resolve().parents[1]


def test_health_ok_on_published_bundle(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["api_version"] == "v1" and body["schema_version"] == "1"
    assert set(body["datasets"]) == {"meta", "metrics", "ranches", "movements", "shipments", "destinations", "onchain"}
    assert client.get("/api/v1/health").json() == body


def test_health_degraded_without_data(client_for, tmp_path):
    body = client_for(tmp_path / "missing").get("/health").json()
    assert body["status"] == "degraded"
    assert body["data_dir_found"] is False
    assert all(v is None for v in body["datasets"].values())


def test_dataset_envelope(client):
    r = client.get("/api/v1/datasets/meta")
    assert r.status_code == 200
    body = r.json()
    assert body["schema"] == "rastro.meta/v1"
    assert body["source"] in {"real", "mock"}
    assert body["data"]["project"] == "Rastro"


def test_mock_fallback_is_labelled(client_for, tmp_path):
    (tmp_path / "mock").mkdir()
    (tmp_path / "mock" / "destinations.json").write_text(
        json.dumps([{"id": "P:BARCARENA", "kind": "port", "name": "Vila do Conde", "lat": -1.5, "lon": -48.7, "real": True}]),
        encoding="utf-8",
    )
    c = client_for(tmp_path)
    assert c.get("/api/v1/datasets/destinations").json()["source"] == "mock"
    assert client_for(tmp_path, allow_mock=False).get("/api/v1/datasets/destinations").status_code == 404


def test_unknown_and_missing_datasets(client_for, client, tmp_path):
    assert client.get("/api/v1/datasets/secrets").status_code == 404
    assert client_for(tmp_path).get("/api/v1/datasets/meta").status_code == 404


def test_contract_violation_is_refused(client_for, tmp_path):
    (tmp_path / "destinations.json").write_text(json.dumps([{"id": "not-a-sink", "kind": "port"}]), encoding="utf-8")
    r = client_for(tmp_path).get("/api/v1/datasets/destinations")
    assert r.status_code == 500
    assert "does not match schema v1" in r.json()["error"]["message"]


def test_uvicorn_boots():
    """The real server process starts and answers /health."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(port)],
        cwd=BACKEND, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.time() + 20
        while True:
            try:
                r = httpx.get(f"http://127.0.0.1:{port}/health", timeout=1)
                break
            except httpx.TransportError:
                if time.time() > deadline or proc.poll() is not None:
                    raise
                time.sleep(0.2)
        assert r.status_code == 200
    finally:
        proc.terminate()
        proc.wait(timeout=10)
