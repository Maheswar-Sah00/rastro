"""Run the whole Rastro pipeline: fetch real data -> landscape -> simulate -> red-team -> detect -> canonical dataset -> geospatial evidence -> lineage -> risk.

    python run_all.py            # everything (downloads are cached in data/raw)
    python run_all.py --no-fetch # reuse cached downloads
"""
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent


def run(script, *args, **env):
    print(f"\n=== {script} {' '.join(args)} {' '.join(f'{k}={v}' for k, v in env.items())}")
    cmd = [sys.executable, str(HERE / script)] if script.endswith(".py") else [sys.executable, "-m", script]
    subprocess.run([*cmd, *args], check=True, cwd=HERE, env={**os.environ, **env})


def main():
    if "--no-fetch" not in sys.argv:
        run("fetch_real.py")
    run("landscape.py")
    run("simulate.py", RASTRO_STRESS="1")
    run("detect.py", RASTRO_STRESS="1")
    run("simulate.py")
    run("detect.py")
    run("rastro.synth.generate", "--preset", "evaluation")  # canonical tables + manifest -> data/synthetic/
    run("rastro.geospatial.run", str(HERE.parent / "data" / "synthetic" / "evaluation"), "--publish")  # ranch evidence
    run("rastro.lineage.trace", str(HERE.parent / "data" / "synthetic" / "evaluation"), "--all")  # multi-hop lineage
    run("rastro.risk.run", str(HERE.parent / "data" / "synthetic" / "evaluation"))                 # findings + decisions
    run("rastro.risk.evaluate", str(HERE.parent / "data" / "synthetic" / "evaluation"), "--role", "development")


if __name__ == "__main__":
    main()
