"""Stage 2: simulate three years (2023-2025) of herds and GTAs on the real landscape.

The simulation lives in rastro/synth/world.py (configurable, scenario switches, lot lineage).
This stage runs its `evaluation` preset (or `redteam` with RASTRO_STRESS=1) and writes the
world.json that detect.py reads; the output is byte-identical to the original stage.

Writes data/derived/world.json (RASTRO_STRESS=1 -> world_stress.json).
"""
import json
import os
from pathlib import Path

from rastro.synth.generate import PRESETS
from rastro.synth.landscape import load_real
from rastro.synth.world import legacy_world_json, simulate

DER = Path(__file__).parent / "data" / "derived"
STRESS = os.environ.get("RASTRO_STRESS") == "1"


def main():
    w = simulate(PRESETS["redteam" if STRESS else "evaluation"], load_real())
    (DER / ("world_stress.json" if STRESS else "world.json")).write_text(json.dumps(legacy_world_json(w), default=str), encoding="utf-8")
    truth = {}
    for r in w.ranches.values():
        truth[r.truth] = truth.get(r.truth, 0) + 1
    head_moved = sum(x["head"] for x in w.gtas)
    to_sink = sum(x["head"] for x in w.gtas if x["to"] in w.sinks)
    ids = [i for i in w.ranches if i.startswith("R")]
    print(f"ranches by truth: {truth}")
    print(f"GTAs: {len(w.gtas)} ({sum(1 for x in w.gtas if x.get('attempt_embargoed'))} embargoed attempts) head moved {head_moved:,}; to sinks {to_sink:,}")
    print(f"smuggled (no GTA): {sum(s['head'] for s in w.smuggled):,} head in {len(w.smuggled)} moves; embargoed ranches {sum(1 for r in w.ranches.values() if r.embargo_day is not None)}")
    print(f"herd start {sum(w.ranches[i].initial_head for i in ids):,} end {sum(w.ranches[i].stock for i in ids):,}")


if __name__ == "__main__":
    main()
