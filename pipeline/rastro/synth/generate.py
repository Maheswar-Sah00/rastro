"""Generate a canonical synthetic dataset.

    python -m rastro.synth.generate --preset evaluation          # 409 ranches, 10,844 GTAs (real landscape)
    python -m rastro.synth.generate --preset tiny --out DIR      # small synthetic fixture, no geodata needed
    python -m rastro.synth.generate --preset baseline --seed 11  # honest world: no planted anomalies

Presets differ only in configuration. Default output: data/synthetic/<preset>/.
"""
import argparse
import json
import sys
from pathlib import Path

from rastro.config import SYNTHETIC
from rastro.synth import canonical, dataset
from rastro.synth.landscape import load_real, make_synthetic
from rastro.synth.world import ALL_SCENARIOS, SynthConfig, simulate
from rastro.validation import validate

# Seed 21 over 24 months plants all three ledger anomalies (phantom births, the herd deficit
# they cause, embargoed GTA attempts) in a ~680-GTA world: small enough for unit tests.
_TINY = dict(seed=21, landscape="synthetic", n_ranches=48, months=24, n_launderers=3, n_phantom=1, n_traders=3,
             n_fronts=1, n_external=2, mortality_annual=0.02)
PRESETS = {
    # The world the published demo and its metrics were built on.
    "evaluation": SynthConfig(),
    # Red team: launderers hold 60-120 days and chain two hops.
    "redteam": SynthConfig(two_hop=True),
    # Honest world on the same landscape: embargoes and documented deaths, no laundering.
    "baseline": SynthConfig(scenarios=frozenset(), mortality_annual=0.02),
    "tiny": SynthConfig(**_TINY),
    "tiny-baseline": SynthConfig(**_TINY, scenarios=frozenset()),
}


def generate(cfg: SynthConfig, out: Path, preset: str):
    land = load_real() if cfg.landscape == "real" else make_synthetic(cfg.n_ranches or 48, cfg.seed)
    world = simulate(cfg, land)
    tables = canonical.build(world)
    manifest = dataset.write(world, tables, out, preset)
    return world, tables, manifest


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--preset", choices=sorted(PRESETS), default="evaluation")
    ap.add_argument("--seed", type=int)
    ap.add_argument("--n-ranches", type=int, help="synthetic landscape only")
    ap.add_argument("--months", type=int)
    ap.add_argument("--scenarios", help=f"comma list from {sorted(ALL_SCENARIOS)}, or 'none'")
    ap.add_argument("--out", type=Path)
    a = ap.parse_args(argv)
    cfg = PRESETS[a.preset]
    if a.seed is not None:
        cfg = cfg.with_(seed=a.seed)
    if a.n_ranches:
        cfg = cfg.with_(n_ranches=a.n_ranches)
    if a.months:
        cfg = cfg.with_(months=a.months)
    if a.scenarios:
        cfg = cfg.with_(scenarios=frozenset() if a.scenarios == "none" else frozenset(a.scenarios.split(",")))
    out = a.out or SYNTHETIC / a.preset
    _, tables, manifest = generate(cfg, out, a.preset)
    rep = validate(tables, manifest)
    counts = {k: v["rows"] for k, v in manifest["tables"].items()}
    print(json.dumps({"out": str(out), "seed": cfg.seed, "logical_digest": manifest["logical_digest"], "counts": counts,
                      "deliberate_anomalies": manifest["deliberate_anomalies"], "validation": rep.summary()}, indent=1))
    return 0 if rep.ok else 1


if __name__ == "__main__":
    sys.exit(main())
