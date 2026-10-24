"""Typed HerdLedger adapters.

- RpcAdapter: read-only JSON-RPC `eth_call` against a node. Selectors, argument types, struct
  layouts, enum widths and custom errors are all read from HerdLedger.abi.json at runtime.
- LocalRecordAdapter: reads the recorded replay (onchain.json). Everything it returns is labelled
  as a local demonstration and is never presented as a verified public-testnet state.

No adapter holds a private key. `prepare_consume` returns unsigned calldata for the buyer's own
wallet to sign; this service never submits transactions.
"""
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import httpx

from app.chain.keccak import keccak256

# IHerdLedger.CertificateStatus, in declaration order. Unknown values are reported as `status_<n>`.
CERT_STATUS = ["none", "valid", "consumed", "revoked", "not_clean", "expired"]
# IHerdLedger certificate verdicts: only 0 (clean) is ever consumable.
VERDICTS = ["clean", "flagged", "unknown", "review"]
LOCAL_LABEL = "local demonstration (recorded anvil replay), not a public testnet"
PUBLIC_NETS = {"base-sepolia", "polygon-amoy"}


class ChainUnavailable(Exception):
    pass


class ContractRevert(Exception):
    def __init__(self, name: str, args: dict):
        super().__init__(f"{name}({', '.join(f'{k}={v}' for k, v in args.items())})")
        self.name, self.args_ = name, args


def _canon(p):
    if p["type"].startswith("tuple"):
        return "(" + ",".join(_canon(c) for c in p["components"]) + ")" + p["type"][5:]
    return p["type"]


def signature(item: dict) -> str:
    return f"{item['name']}({','.join(_canon(i) for i in item['inputs'])})"


def selector(fn: dict) -> bytes:
    return keccak256(signature(fn).encode())[:4]


def _enc(typ: str, v) -> bytes:
    if typ == "bytes32":
        b = bytes.fromhex(v[2:] if v.startswith("0x") else v)
        if len(b) != 32:
            raise ValueError("bytes32 must be 32 bytes")
        return b
    if typ == "address":
        b = bytes.fromhex(v[2:])
        if len(b) != 20:
            raise ValueError("address must be 20 bytes")
        return bytes(12) + b
    if typ.startswith("uint"):
        n = int(v)
        if n < 0 or n >= 1 << int(typ[4:] or 256):
            raise ValueError(f"{typ} out of range")
        return n.to_bytes(32, "big")
    if typ == "bool":
        return int(bool(v)).to_bytes(32, "big")
    raise ValueError(f"unsupported argument type {typ}")


def _dec_word(typ: str, word: bytes):
    if typ.startswith("uint"):
        return int.from_bytes(word, "big")
    if typ == "bool":
        return bool(int.from_bytes(word, "big"))
    if typ == "address":
        return "0x" + word[12:].hex()
    if typ == "bytes32":
        return "0x" + word.hex()
    raise ValueError(f"unsupported static type {typ}")


def _static_words(p) -> int:
    if p["type"] == "tuple":
        return sum(_static_words(c) for c in p["components"])
    return 1


def _decode(params: list[dict], raw: bytes) -> list:
    """ABI-decode static types, static tuples and one-dimensional arrays of static types."""
    out, head = [], 0
    for p in params:
        t = p["type"]
        if t.endswith("[]"):
            off = int.from_bytes(raw[head:head + 32], "big")
            n = int.from_bytes(raw[off:off + 32], "big")
            out.append([_dec_word(t[:-2], raw[off + 32 + 32 * i: off + 64 + 32 * i]) for i in range(n)])
            head += 32
        elif t == "tuple":
            w = _static_words(p)
            vals = _decode(p["components"], raw[head:head + 32 * w])
            out.append({c["name"]: v for c, v in zip(p["components"], vals)})
            head += 32 * w
        else:
            out.append(_dec_word(t, raw[head:head + 32]))
            head += 32
    return out


class Abi:
    def __init__(self, path: Path):
        items = json.loads(path.read_text(encoding="utf-8"))
        self.fns = {f["name"]: f for f in items if f.get("type") == "function"}
        self.errors = {selector(e): e for e in items if e.get("type") == "error"}

    def has(self, name: str) -> bool:
        return name in self.fns

    def calldata(self, name: str, *args) -> str:
        fn = self.fns[name]
        if len(args) != len(fn["inputs"]):
            raise ValueError(f"{name} takes {len(fn['inputs'])} arguments")
        return "0x" + (selector(fn) + b"".join(_enc(i["type"], a) for i, a in zip(fn["inputs"], args))).hex()

    def decode_result(self, name: str, result_hex: str):
        vals = _decode(self.fns[name]["outputs"], bytes.fromhex(result_hex[2:]))
        return vals[0] if len(vals) == 1 else vals

    def decode_error(self, data_hex: str | None) -> ContractRevert | None:
        if not data_hex or len(data_hex) < 10:
            return None
        raw = bytes.fromhex(data_hex[2:])
        e = self.errors.get(raw[:4])
        if not e:
            return ContractRevert("UnknownError", {"selector": "0x" + raw[:4].hex()})
        try:
            vals = _decode(e["inputs"], raw[4:])
        except ValueError:
            vals = []
        return ContractRevert(e["name"], {i["name"] or f"arg{k}": v for k, (i, v) in enumerate(zip(e["inputs"], vals))})


@dataclass
class ChainInfo:
    mode: str                 # "rpc" | "local_records"
    network: str | None
    chain_id: int | None
    address: str | None
    label: str
    verified_public: bool     # true only for a reachable public testnet RPC
    available: bool
    detail: str | None = None


class Adapter(Protocol):
    info: ChainInfo

    def certificate_status(self, lot_id: str) -> dict: ...
    def certificate_record(self, lot_id: str) -> dict: ...
    def balance_of(self, entity_hash: str) -> dict: ...
    def is_oracle(self, address: str) -> dict: ...
    def ledger_flags(self) -> dict: ...


class LocalRecordAdapter:
    """State reconstructed from the replay records in onchain.json."""

    def __init__(self, onchain: dict | None, detail: str | None = None):
        self.o = onchain or {}
        self.info = ChainInfo("local_records", self.o.get("network"), self.o.get("chainId"), self.o.get("address"),
                              LOCAL_LABEL, False, bool(onchain), detail)

    def _records(self, lot_id):
        return [r for r in self.o.get("records", []) if r.get("lot_id") == lot_id]

    def certificate_status(self, lot_id):
        rs = self._records(lot_id)
        issued = next((r for r in rs if r["kind"] == "issueCertificate" and r["status"] == "success"), None)
        exp = (issued or {}).get("expires_at")
        if not issued:
            st = "none"
        elif any(r["kind"] == "revokeCertificate" and r["status"] == "success" for r in rs):
            st = "revoked"
        elif any(r["kind"] == "consumeCertificate" and r["status"] == "success" for r in rs):
            st = "consumed"
        elif "verdict clean" not in (issued.get("note") or ""):
            st = "not_clean"
        elif exp and int(exp) < time.time():
            st = "expired"
        else:
            st = "valid"
        return {"status": st, "source": "recorded", "label": LOCAL_LABEL,
                "records": [{k: r.get(k) for k in ("kind", "ref", "tx", "block", "status", "revert_reason", "note", "evidence_hash")} for r in rs]}

    def certificate_record(self, lot_id):
        return {"record": None, "source": "recorded", "label": LOCAL_LABEL, "detail": "struct fields need a live node; see records"}

    def balance_of(self, entity_hash):
        return {"balance": None, "source": "recorded", "label": LOCAL_LABEL,
                "detail": "per-entity balances are not part of the recorded replay; totals only", "totals": self.o.get("totals")}

    def is_oracle(self, address):
        oracle = (self.o.get("roles") or {}).get("oracle")
        return {"is_oracle": None if oracle is None else oracle.lower() == address.lower(), "source": "recorded", "label": LOCAL_LABEL}

    def ledger_flags(self):
        return {"paused": None, "min_policy_version": None, "oracles": [r for r in [(self.o.get("roles") or {}).get("oracle")] if r],
                "source": "recorded", "label": LOCAL_LABEL}


class RpcAdapter:
    def __init__(self, rpc_url: str, address: str, abi: Abi, timeout: float = 2.0, network: str | None = None):
        self.url, self.address, self.abi, self.timeout = rpc_url, address, abi, timeout
        chain_id = int(self._rpc("eth_chainId", []), 16)  # raises ChainUnavailable
        public = (network or "") in PUBLIC_NETS
        self.info = ChainInfo("rpc", network, chain_id, address,
                              f"live eth_call on {network or 'unknown network'} (chain {chain_id})" + ("" if public else ": local node, not a public testnet"),
                              public, True)

    def _rpc(self, method, params):
        try:
            r = httpx.post(self.url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=self.timeout)
            body = r.json()
        except (httpx.HTTPError, ValueError) as e:
            raise ChainUnavailable(f"{self.url}: {e.__class__.__name__}") from None
        if "error" in body:
            err = body["error"]
            data = err.get("data")
            if isinstance(data, dict):  # some nodes nest the revert payload
                data = data.get("data")
            rev = self.abi.decode_error(data if isinstance(data, str) else None)
            if rev:
                raise rev  # a contract revert (e.g. UnknownCertificate), not an outage
            raise ChainUnavailable(f"{method}: {err.get('message')}")
        return body["result"]

    def call(self, name, *args) -> Any:
        res = self._rpc("eth_call", [{"to": self.address, "data": self.abi.calldata(name, *args)}, "latest"])
        return self.abi.decode_result(name, res)

    def certificate_status(self, lot_id):
        n = self.call("certificateStatus", lot_id)
        return {"status": CERT_STATUS[n] if n < len(CERT_STATUS) else f"status_{n}", "source": "eth_call", "label": self.info.label}

    def certificate_record(self, lot_id):
        rec = self.call("certificate", lot_id) if self.abi.has("certificate") else None
        if isinstance(rec, dict) and "verdict" in rec:
            v = rec["verdict"]
            rec["verdict_name"] = VERDICTS[v] if v < len(VERDICTS) else f"verdict_{v}"
        return {"record": rec, "source": "eth_call", "label": self.info.label}

    def balance_of(self, entity_hash):
        out = {"balance": self.call("balanceOf", entity_hash), "source": "eth_call", "label": self.info.label}
        if self.abi.has("isEmbargoed"):
            out["embargoed"] = self.call("isEmbargoed", entity_hash)
        return out

    def is_oracle(self, address):
        if self.abi.has("isOracle"):
            ok = self.call("isOracle", address)
        else:
            ok = self.call("hasRole", "0x" + keccak256(b"ORACLE_ROLE").hex(), address)
        return {"is_oracle": ok, "source": "eth_call", "label": self.info.label}

    def ledger_flags(self):
        g = lambda n: self.call(n) if self.abi.has(n) else None  # noqa: E731
        return {"paused": g("paused"), "min_policy_version": g("minPolicyVersion"), "oracles": g("oracles"),
                "source": "eth_call", "label": self.info.label}


def prepare_consume(abi: Abi, address: str | None, lot_id: str, use: int, ref_hash: str) -> dict:
    """Unsigned calldata for consumeCertificate; the buyer signs and submits it from its own wallet."""
    return {"to": address, "data": abi.calldata("consumeCertificate", lot_id, use, ref_hash), "value": "0x0",
            "signed": False, "note": "unsigned transaction: sign with the BUYER_ROLE wallet; this API never holds keys"}


def make_adapter(mode: str, onchain: dict | None, abi_path: Path, rpc_url: str | None, timeout: float) -> Adapter:
    local = LocalRecordAdapter(onchain)
    if mode == "local" or not onchain:
        return local
    url = rpc_url or onchain.get("rpc")
    if not url or not abi_path.is_file():
        return LocalRecordAdapter(onchain, "no RPC endpoint or ABI configured")
    try:
        return RpcAdapter(url, onchain["address"], Abi(abi_path), timeout, onchain.get("network"))
    except ChainUnavailable as e:
        if mode == "rpc":
            raise
        return LocalRecordAdapter(onchain, f"RPC unavailable ({e}); serving recorded replay")
