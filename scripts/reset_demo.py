"""Reset demonstration state.

    python scripts/reset_demo.py                 # clear certificates and investigator reviews of the dataset
    python scripts/reset_demo.py --chain         # also reset the local anvil chain and replay the seed on it
    python scripts/reset_demo.py --dataset data/synthetic/evaluation --rpc http://127.0.0.1:8545

Never touches generated data (inputs, environment, derived tables, truth) or a public network: the
chain reset uses anvil's `anvil_reset` and refuses any chain id other than 31337.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def rpc(url, method, params=()):
    req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": list(params)}).encode(),
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        body = json.loads(r.read())
    if "error" in body:
        raise RuntimeError(body["error"])
    return body["result"]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", type=Path, default=REPO / "data" / "synthetic" / "evaluation")
    ap.add_argument("--chain", action="store_true", help="reset the local anvil chain and replay the seed")
    ap.add_argument("--rpc", default="http://127.0.0.1:8545")
    a = ap.parse_args(argv)
    ds = a.dataset.resolve()
    if not (ds / "manifest.json").is_file():
        sys.exit(f"{ds} is not a canonical dataset")
    state = Path(os.environ["RASTRO_STATE_DIR"]) if os.environ.get("RASTRO_STATE_DIR") else ds / "derived" / "reviews"
    for d in (ds / "certificates", state):
        if d.exists():
            shutil.rmtree(d)
            print(f"removed {d}")
    if a.chain:
        chain_id = int(rpc(a.rpc, "eth_chainId"), 16)
        if chain_id != 31337:
            sys.exit(f"refusing to reset chain {chain_id}: only a local anvil (31337) can be reset")
        rpc(a.rpc, "anvil_reset")
        print(f"anvil at {a.rpc} reset to genesis")
        env = {**os.environ, "PATH": str(REPO / "contracts" / ".tools" / "bin") + os.pathsep + os.environ.get("PATH", "")}
        npm = "npm.cmd" if os.name == "nt" else "npm"
        subprocess.run([npm, "run", "demo:local", "--", "--keep"], cwd=REPO / "contracts", env=env, check=True)
    print("demo state reset")


if __name__ == "__main__":
    main()
