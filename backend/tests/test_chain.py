"""HerdLedger adapter against a fake JSON-RPC node: everything is decoded from the published ABI."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from app.chain.adapter import Abi, ContractRevert, RpcAdapter, selector
from app.chain.keccak import keccak256
from app.config import REPO

ABI_PATH = REPO / "web" / "public" / "data" / "HerdLedger.abi.json"
pytestmark = pytest.mark.skipif(not ABI_PATH.is_file(), reason="HerdLedger ABI not published")
LOT_OK, LOT_EXPIRED, LOT_UNKNOWN = "0x" + "11" * 32, "0x" + "22" * 32, "0x" + "33" * 32
ORACLE = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc"


def word(n: int) -> str:
    return n.to_bytes(32, "big").hex()


@pytest.fixture(scope="module")
def abi():
    return Abi(ABI_PATH)


@pytest.fixture(scope="module")
def node(abi):
    sel = {name: "0x" + selector(f).hex() for name, f in abi.fns.items()}
    unknown_err = next(s for s, e in abi.errors.items() if e["name"] == "UnknownCertificate")
    comps = abi.fns["certificate"]["outputs"][0]["components"]

    def record():
        vals = {"verdict": 3, "head": 120, "issued": 1, "expiresAt": 1_900_000_000, "policyVersion": 1,
                "evidenceHash": int("ab" * 32, 16), "oracle": int(ORACLE, 16)}
        return "".join(word(vals.get(c["name"], 0)) for c in comps)

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            res, err = None, None
            if req["method"] == "eth_chainId":
                res = "0x7a69"
            else:
                data = req["params"][0]["data"]
                fn, arg = data[:10], data[10:74]
                if fn == sel["certificateStatus"]:
                    if arg == LOT_UNKNOWN[2:]:
                        err = {"code": 3, "message": "execution reverted", "data": "0x" + unknown_err.hex() + LOT_UNKNOWN[2:]}
                    else:
                        res = "0x" + word(5 if arg == LOT_EXPIRED[2:] else 1)
                elif fn == sel["certificate"]:
                    res = "0x" + record()
                elif fn == sel["isOracle"]:
                    res = "0x" + word(1 if data.endswith(ORACLE[2:]) else 0)
                elif fn == sel["oracles"]:
                    res = "0x" + word(32) + word(1) + word(int(ORACLE, 16))
                elif fn in (sel["paused"],):
                    res = "0x" + word(0)
                elif fn == sel["minPolicyVersion"]:
                    res = "0x" + word(1)
                elif fn == sel["balanceOf"]:
                    res = "0x" + word(77)
                elif fn == sel["isEmbargoed"]:
                    res = "0x" + word(1)
            body = json.dumps({"jsonrpc": "2.0", "id": 1, **({"error": err} if err else {"result": res})}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    srv = HTTPServer(("127.0.0.1", 0), H)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def test_keccak_and_selectors(abi):
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert selector({"name": "balanceOf", "inputs": [{"type": "address"}]}).hex() == "70a08231"
    assert {"consumeCertificate", "certificateStatus", "isOracle", "isEmbargoed", "oracles", "paused", "minPolicyVersion"} <= abi.fns.keys()


def test_rpc_adapter_decodes_everything_from_the_abi(abi, node):
    a = RpcAdapter(node, "0x5FbDB2315678afecb367f032d93F642f64180aa3", abi, 2.0, "anvil")
    assert a.info.chain_id == 31337 and a.info.verified_public is False and "not a public testnet" in a.info.label
    assert a.certificate_status(LOT_OK)["status"] == "valid"
    assert a.certificate_status(LOT_EXPIRED)["status"] == "expired"
    rec = a.certificate_record(LOT_OK)["record"]
    assert rec["verdict"] == 3 and rec["verdict_name"] == "review" and rec["expiresAt"] == 1_900_000_000 and rec["oracle"] == ORACLE
    assert a.is_oracle(ORACLE)["is_oracle"] is True and a.is_oracle("0x" + "00" * 20)["is_oracle"] is False
    assert a.ledger_flags() | {} == {"paused": False, "min_policy_version": 1, "oracles": [ORACLE], "source": "eth_call", "label": a.info.label}
    b = a.balance_of("0x" + "44" * 32)
    assert b["balance"] == 77 and b["embargoed"] is True
    with pytest.raises(ContractRevert) as e:
        a.certificate_status(LOT_UNKNOWN)
    assert e.value.name == "UnknownCertificate"


def test_consume_calldata_layout(abi):
    data = abi.calldata("consumeCertificate", LOT_OK, 1, "0x" + "55" * 32)
    assert data[:10] == "0x" + selector(abi.fns["consumeCertificate"]).hex()
    assert data[10:] == LOT_OK[2:] + word(1) + "55" * 32
    with pytest.raises(ValueError):
        abi.calldata("consumeCertificate", LOT_OK, 300, "0x" + "55" * 32)
