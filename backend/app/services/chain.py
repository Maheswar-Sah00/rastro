"""Contract reads through the configured adapter (live RPC, or labelled recorded replay)."""
import time
from dataclasses import asdict

from app import pipeline_bridge  # noqa: F401
from app.chain.adapter import Abi, ChainUnavailable, ContractRevert, make_adapter, prepare_consume
from app.config import get_settings
from app.observability import APIError
from app.store import DatasetStore
from rastro.certificates.bundle import commit  # sha256("rastro-demo-salt-v1|" + id): the replay's commitment scheme

ADAPTER_TTL_S = 30.0
_cache: dict = {}


def onchain_id(entity_id: str) -> str:
    return commit(entity_id)


def adapter(store: DatasetStore):
    """Adapter for the current onchain.json, re-probed at most every ADAPTER_TTL_S (an unreachable RPC
    would otherwise cost a full timeout on every request)."""
    s = get_settings()
    onchain = store.web_json("onchain.json")
    key = (id(store), s.chain_mode, s.rpc_url, (onchain or {}).get("address"), (onchain or {}).get("generated_at"))
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < ADAPTER_TTL_S:
        return hit[1]
    try:
        a = make_adapter(s.chain_mode, onchain, store.web / "HerdLedger.abi.json", s.rpc_url, s.rpc_timeout_s)
    except ChainUnavailable as e:
        raise APIError(503, "chain_unavailable", str(e)) from None
    _cache.clear()
    _cache[key] = (time.monotonic(), a)
    return a


def info(a) -> dict:
    return asdict(a.info)


def guarded(fn, *args):
    try:
        return fn(*args)
    except ChainUnavailable as e:
        raise APIError(503, "chain_unavailable", str(e)) from None
    except ContractRevert as e:
        raise APIError(409, "contract_revert", str(e), {"error": e.name, "args": e.args_}) from None


def status(store: DatasetStore) -> dict:
    a = adapter(store)
    o = store.web_json("onchain.json") or {}
    oracle = (o.get("roles") or {}).get("oracle")
    try:
        is_oracle = a.is_oracle(oracle) if oracle else None
        flags = a.ledger_flags()
    except (ChainUnavailable, ContractRevert) as e:
        is_oracle, flags = {"is_oracle": None, "detail": str(e)}, {"detail": str(e)}
    return {"chain": info(a), "roles": o.get("roles"), "oracle_check": is_oracle, "ledger": flags, "totals": o.get("totals"),
            "conserved": o.get("conserved")}


def balance(store: DatasetStore, ranch_id: str) -> dict:
    a = adapter(store)
    b = guarded(a.balance_of, onchain_id(ranch_id))
    return {"ranch_id": ranch_id, "onchain_id": onchain_id(ranch_id), **b, "chain": info(a)}


def prepare(store: DatasetStore, lot_id: str, use: int, ref_hash: str) -> dict:
    abi_path = store.web / "HerdLedger.abi.json"
    if not abi_path.is_file():
        raise APIError(503, "chain_unavailable", "HerdLedger ABI not published")
    abi = Abi(abi_path)
    if not abi.has("consumeCertificate"):
        raise APIError(503, "chain_unavailable", "ABI has no consumeCertificate")
    try:
        return prepare_consume(abi, (store.web_json("onchain.json") or {}).get("address"), lot_id, use, ref_hash)
    except ValueError as e:
        raise APIError(422, "invalid_request", str(e)) from None
