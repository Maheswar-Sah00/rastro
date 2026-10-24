"""Scenario registry: named, configurable synthetic worlds. No expected answers are stored here.

Each scenario is a SynthConfig override on the `evaluation` preset. Ground truth comes from the
simulator (truth/ partition) and is never visible to the detectors. Scenario ids are evaluation
metadata only; nothing in a world's detector-visible tables names its scenario.
"""
from dataclasses import dataclass, field

from rastro.synth.generate import PRESETS
from rastro.synth.world import SynthConfig

HELD_OUT_SEED = 101  # never used to choose a threshold or rule (development world: seed 7)


@dataclass(frozen=True)
class Scenario:
    id: str
    title: str
    tests: str                       # what the scenario stresses, in words
    overrides: dict = field(default_factory=dict)

    def config(self, seed: int = HELD_OUT_SEED) -> SynthConfig:
        return PRESETS["evaluation"].with_(seed=seed, **self.overrides)


SCENARIOS = [
    Scenario("S00-clean", "Honest world", "false positives when no laundering exists (embargoes and real clearing remain)",
             {"scenarios": frozenset(), "mortality_annual": 0.02}),
    Scenario("S01-reference", "Reference laundering world", "the four planted behaviours: laundering, phantom births, embargo attempts, over-capacity fronts"),
    Scenario("S02-hold-60", "Launderers hold ~60 days", "pass-through detection when resale is slower than the 45-day rule", {"launderer_hold": (55, 66)}),
    Scenario("S03-hold-120", "Launderers hold ~120 days", "pass-through detection far beyond the 45-day rule", {"launderer_hold": (115, 126)}),
    Scenario("S04-two-hop", "Two laundering hops", "lineage through two intermediaries with fast resale", {"two_hop": True, "launderer_hold": (2, 22)}),
    Scenario("S05-redteam", "Published red team", "launderers hold 60-120 days and chain two hops (the published stress test)", {"two_hop": True}),
    Scenario("S06-incomplete", "10 % of permits missing", "incomplete source records: unknown origin and inventory gaps", {"drop_gta_share": 0.10}),
    Scenario("S07-split-lots", "Split lots", "launderers split resales into many small permits", {"launderer_split": (5, 26)}),
    Scenario("S08-mixed-cover", "Mixed with clean cover", "launderers also buy clean calves, diluting the tainted share", {"cover_buying": 0.15}),
    Scenario("S09-concealed", "Concealed inventory", "phantom ranches inflate declared cows and cover the rest with permits from outside suppliers",
             {"conceal_phantom": True, "phantom_declared_cows": 400}),
    Scenario("S10-rapid-legit", "Legitimate rapid trading", "more honest traders reselling within days (false-positive trap)",
             {"n_traders": 20, "trader_hold": (1, 10)}),
]
BY_ID = {s.id: s for s in SCENARIOS}
