"""Deterministic simulation of three years of herds, births and GTAs.

Every animal travels in single-origin lots, so the simulator knows the TRUE origin of each head
that reaches a slaughterhouse or the export port. Detectors never see that; they see what a
state agency would hold: the ranch registry, declared births, deaths and GTAs.

The honest world is always simulated. Laundering is added only through explicit scenarios
(`SynthConfig.scenarios`):

- `laundering`: dirty sources sell calves and culls to intermediaries that resell within days.
- `phantom_births`: embargoed ranches move animals WITHOUT a GTA to a laundering intermediary,
  which declares them as births ("esquentamento"). Breaks biology and, later, conservation.
- `embargo_attempts`: embargoed ranches occasionally still request a GTA.
- `over_capacity`: fattening fronts that hold far more animals than their pasture supports.
- `two_hop`: red team. Launderers hold 60-120 days and chain a second laundering hop.

With every scenario off (`baseline`) the generator produces no record a correct ledger would
refuse. With `evaluation` it reproduces, draw for draw, the world the published demo was built
on (seed 7: 409 ranches, 10,844 GTAs).
"""
from collections import defaultdict, deque
from dataclasses import dataclass, field, replace
from datetime import date, timedelta

import numpy as np

from rastro.synth.landscape import Landscape

ALL_SCENARIOS = frozenset({"laundering", "phantom_births", "embargo_attempts", "over_capacity"})


@dataclass(frozen=True)
class SynthConfig:
    seed: int = 7
    start: date = date(2023, 1, 1)
    months: int = 36
    stocking: float = 1.0              # head per ha of pasture (Amazon average ~1 AU/ha)
    capacity: float = 1.5              # head per ha the contract treats as the biological ceiling
    calving: tuple[float, float] = (0.62, 0.76)  # calves per breeding cow per year
    mortality_annual: float = 0.0      # documented deaths; 0 keeps the published v1 world unchanged
    n_external: int = 5                # suppliers outside the study window (status unknown)
    n_launderers: int = 10
    n_phantom: int = 3                 # taken from the launderers
    n_traders: int = 10                # honest fast traders: the realistic false-positive trap
    n_fronts: int = 4
    embargoes: bool = True             # regulator embargoes on large post-2020 clearers
    scenarios: frozenset = ALL_SCENARIOS
    two_hop: bool = False
    # ---- red-team knobs (defaults reproduce the published world draw for draw) ----------------
    launderer_hold: tuple[int, int] | None = None   # days launderers keep bought cattle; None = (2, 22), or (60, 120) with two_hop
    trader_hold: tuple[int, int] = (5, 40)          # honest fast traders
    launderer_split: tuple[int, int] = (40, 260)    # head per outgoing permit of a launderer (small = split lots)
    cover_buying: float = 0.0                       # weight of launderers among clean breeders' buyers (mixes clean cover in)
    conceal_phantom: bool = False                   # phantom ranches keep declared births inside the biology bound and
    phantom_declared_cows: int = 40                 # cover the rest with permits in the name of an outside supplier
    drop_gta_share: float = 0.0                     # share of ranch-to-ranch permits missing from the agency records
    landscape: str = "real"            # "real" | "synthetic"
    n_ranches: int | None = None       # synthetic landscape only
    generated_at: str = "2026-10-24T00:00:00Z"  # fixed so identical seeds give identical files

    def has(self, scenario: str) -> bool:
        return scenario in self.scenarios

    def with_(self, **kw) -> "SynthConfig":
        return replace(self, **kw)


@dataclass
class World:
    config: SynthConfig
    landscape: Landscape
    ranches: dict                      # id -> Ranch
    sinks: list[str]
    gtas: list[dict]
    births: list[dict]
    deaths: list[dict]
    smuggled: list[dict]
    lots: dict = field(default_factory=dict)          # lot_id -> lot record
    declared_cows: dict = field(default_factory=dict)  # ranch -> breeding cows declared, where it differs from the herd
    allocations: list[dict] = field(default_factory=list)

    def iso(self, day):
        return (self.config.start + timedelta(days=int(day))).isoformat()


class Ranch:
    def __init__(self, row):
        self.__dict__.update(row)
        self.lots = deque()  # FIFO of [head, arrival_day, origin_id, hold_target_days, lot_id]
        self.cows = 0
        self.embargo_day = None

    @property
    def stock(self):
        return self.cows + sum(l[0] for l in self.lots)

    def take(self, n, now, min_days=0):
        """Pop up to n head of lots that have been on the farm >= min_days (FIFO)."""
        out, need = [], n
        for lot in list(self.lots):
            if need == 0:
                break
            if now - lot[1] < min_days:
                continue
            k = min(need, lot[0])
            out.append([k, lot[1], lot[2], lot[4]])
            lot[0] -= k
            need -= k
        self.lots = deque(l for l in self.lots if l[0] > 0)
        return out


def simulate(cfg: SynthConfig, land: Landscape) -> World:
    rng = np.random.default_rng(cfg.seed)
    # Draws that the published world never made live on separate streams, so turning them on
    # in other presets never shifts the main stream.
    rng_mort = np.random.default_rng([cfg.seed, 3])
    rng_meta = np.random.default_rng([cfg.seed, 9])  # red-team only: which outside supplier a cold permit names
    phantom_declared = defaultdict(int)              # (ranch, year) -> births declared by a concealing phantom
    start = cfg.start
    dest = land.destinations
    sinks = [d["id"] for d in dest]
    sh_ids = [d["id"] for d in dest if d["kind"] == "slaughterhouse"]
    sh_w = np.array([1 / (5 + d["dist_km"]) for d in dest if d["kind"] == "slaughterhouse"])
    sh_w /= sh_w.sum()
    port = next(d["id"] for d in dest if d["kind"] == "port")
    laundering = cfg.has("laundering")
    phantom_on = laundering and cfg.has("phantom_births")
    lots_reg, allocs, lot_seq = {}, [], {}

    def new_lot(kind, ranch, day, head, origin, parent=None, gta=None, idx=None):
        if kind == "transfer":
            lid = f"LOT-{gta}-{idx}"
        else:
            key = (kind, ranch)
            lot_seq[key] = lot_seq.get(key, 0) + 1
            lid = f"LOT-{kind[0].upper()}-{ranch}-{lot_seq[key]:04d}"
        lots_reg[lid] = {"lot_id": lid, "kind": kind, "ranch_id": ranch, "created_day": int(day), "head": int(head),
                         "birth_origin_id": origin, "parent_lot_id": parent, "via_gta": gta}
        return lid

    def day_of(month, d=None):
        first = date(start.year + month // 12, month % 12 + 1, 1)
        return (first - start).days + (int(rng.integers(0, 28)) if d is None else d)

    R = {r["id"]: Ranch(r) for r in land.rows}
    ids = list(R)

    # ---- ground truth & roles -------------------------------------------------------------
    for r in R.values():
        r.dirty = bool(r.defor_post2020_ha >= 50 or r.ti_overlap_ha >= 1)
        r.truth = "dirty_source" if r.dirty else "honest"
    by_size = sorted(ids, key=lambda i: R[i].area_ha)
    small = [i for i in by_size[: len(ids) // 3] if not R[i].dirty]
    launderers = list(rng.choice(small, min(cfg.n_launderers, len(small)), replace=False))  # small worlds: clamp to the pool
    phantom = launderers[: cfg.n_phantom]
    pool = [i for i in small if i not in launderers]
    traders = list(rng.choice(pool, min(cfg.n_traders, len(pool)), replace=False))
    for i in launderers:
        R[i].role, R[i].truth = "intermediary", ("launderer" if laundering else "honest")
    if phantom_on:
        for i in phantom:
            R[i].truth = "phantom_births"
    for i in traders:
        R[i].role, R[i].truth = "intermediary", "honest"
    if not laundering:  # without the scenario these intermediaries are just more honest traders
        traders = traders + launderers
    rest = [i for i in ids if i not in launderers and i not in traders]
    for i in rest:
        r = R[i]
        if r.dirty:
            r.role = "breeder" if rng.random() < 0.75 else "rearer"  # frontier ranches are cow-calf
        else:
            r.role = rng.choice(["breeder", "rearer", "fattener"], p=[0.58, 0.22, 0.20])
    fatteners = [i for i in rest if R[i].role == "fattener"]
    fronts = list(rng.choice(fatteners, min(cfg.n_fronts, len(fatteners)), replace=False))
    if cfg.has("over_capacity"):
        for i in fronts:
            R[i].truth = "over_capacity"
    dirty_ids = [i for i in ids if R[i].dirty]
    big_clearers = [i for i in dirty_ids if R[i].defor_post2020_ha >= 100]
    if cfg.embargoes and big_clearers:
        for i in rng.choice(big_clearers, max(1, len(big_clearers) // 2), replace=False):
            R[i].embargo_day = day_of(int(rng.integers(3, min(20, cfg.months))))  # Ibama embargo after detection

    for k in range(cfg.n_external):
        x = Ranch({"id": f"X{k + 1:02d}", "role": "external", "area_ha": 0, "pasture_ha": 0,
                   "x": 0, "y": 0, "truth": "unknown", "defor_post2020_ha": 0, "ti_overlap_ha": 0})
        x.dirty = False
        R[x.id] = x

    # ---- initial herd (1 Jan of the start year) -------------------------------------------
    births_decl, deaths, gtas, smuggled = [], [], [], []
    for i in ids:
        r = R[i]
        target = r.pasture_ha * cfg.stocking * rng.uniform(0.75, 0.95)
        if r.truth == "over_capacity":
            target = r.pasture_ha * cfg.capacity * rng.uniform(1.7, 2.3)
        if r.role == "intermediary":
            target = r.pasture_ha * cfg.stocking * 0.3
        target = int(target)
        r.breeding_cows = int(target * 0.56) if r.role == "breeder" else (40 if r.truth == "phantom_births" else 0)
        r.cows = r.breeding_cows
        rest_head = target - r.cows
        for _ in range(4):
            hold = 0 if r.role == "breeder" else int(rng.integers(60, 360))
            arr = -int(rng.integers(30, 300))
            r.lots.append([rest_head // 4, arr, i, hold, new_lot("initial", i, arr, rest_head // 4, i)])
        r.initial_head = r.stock

    def capacity(i):
        return R[i].pasture_ha * cfg.capacity

    def pick(pool, near, k=0, exclude=(), respect_capacity=True):
        pool = [p for p in pool if p not in exclude and p != near]
        if respect_capacity:  # honest buyers don't buy more than their pasture holds
            pool = [p for p in pool if R[p].truth == "over_capacity" or R[p].stock + k <= capacity(p) * 1.05]
        if not pool:
            return None
        o = R[near]
        d = np.array([np.hypot(R[p].x - o.x, R[p].y - o.y) / 1000 for p in pool])
        w = np.exp(-d / 25)
        return pool[int(rng.choice(len(pool), p=w / w.sum()))]

    roles = {k: [i for i in ids if R[i].role == k] for k in ("breeder", "rearer", "fattener", "intermediary")}
    honest_traders, laund = traders, launderers
    seq = [0]

    def gta(frm, to, lots, purpose, day):
        head = sum(l[0] for l in lots)
        if head <= 0:
            return
        day = max(day, max(l[1] for l in lots) + 1)  # never ship before the animals arrived
        seq[0] += 1
        yr = (start + timedelta(days=int(day))).year
        gid = f"GTA-PA-{yr}-{seq[0]:06d}"
        gtas.append({"gta": gid, "from": frm, "to": to, "head": int(head), "day": int(day), "purpose": purpose,
                     "lots": [[int(l[0]), int(l[1]), l[2]] for l in lots]})
        if to in R:
            laund_hold = cfg.launderer_hold or ((60, 120) if cfg.two_hop else (2, 22))
            hold = {"intermediary": cfg.trader_hold if R[to].truth == "honest" else laund_hold,
                    "rearer": (290, 400), "fattener": (220, 330)}.get(R[to].role, (200, 300))
        for n, l in enumerate(lots):
            child = new_lot("transfer", to, day, l[0], l[2], parent=l[3], gta=gid, idx=n)
            allocs.append({"gta_id": gid, "from_lot_id": l[3], "to_lot_id": child, "head": int(l[0]), "day": int(day)})
            if to in R:
                R[to].lots.append([l[0], day, l[2], int(rng.integers(*hold)), child])

    def sell(i, n, day, min_days, buyers_spec, purpose):
        """buyers_spec: list of (pool or 'SH'/'PORT', prob)."""
        r = R[i]
        embargoed = r.embargo_day is not None and day >= r.embargo_day
        if embargoed and not phantom_on and not cfg.has("embargo_attempts"):
            return  # an embargoed ranch simply stops selling; its animals stay put
        lots = r.take(n, day, min_days)
        if not lots:
            return
        n = sum(l[0] for l in lots)
        pools, probs = zip(*buyers_spec)
        choice = pools[int(rng.choice(len(pools), p=np.array(probs) / sum(probs)))]
        if choice == "SH":
            to = sh_ids[int(rng.choice(len(sh_ids), p=sh_w))]
        elif choice == "PORT":
            to = port
        else:
            to = pick(choice, i, n)
            if to is None:
                to = sh_ids[int(rng.choice(len(sh_ids), p=sh_w))]
        if embargoed:
            # GTAs are refused. Mostly the animals walk to a phantom-births launderer without
            # paperwork; a few times the ranch still tries to issue a GTA.
            if rng.random() < 0.06 and cfg.has("embargo_attempts"):
                gtas.append({"gta": f"GTA-PA-ATTEMPT-{len(smuggled) + 1:04d}", "from": i, "to": to,
                             "head": int(sum(l[0] for l in lots)), "day": int(day), "purpose": purpose,
                             "lots": [[int(l[0]), int(l[1]), l[2]] for l in lots], "attempt_embargoed": True})
            if not phantom_on:
                for l in reversed(lots):  # nothing moved: the animals go back to the herd
                    r.lots.appendleft([l[0], l[1], l[2], 0, l[3]])
                return
            tgt = phantom[int(rng.integers(len(phantom)))]
            head = int(sum(l[0] for l in lots))
            for n_, l in enumerate(lots):
                child = new_lot("smuggled", tgt, day, l[0], l[2], parent=l[3])
                allocs.append({"gta_id": None, "from_lot_id": l[3], "to_lot_id": child, "head": int(l[0]), "day": int(day)})
                R[tgt].lots.append([l[0], day, l[2], int(rng.integers(3, 20)), child])
            year = (start + timedelta(days=int(day))).year
            if not cfg.conceal_phantom:
                smuggled.append({"from": i, "to": tgt, "head": head, "day": int(day)})
                births_decl.append({"ranch": tgt, "head": head, "day": int(day), "year": year, "phantom": True})
                return
            # Concealed: declare births only up to the biological bound of the (inflated) declared
            # herd, and cover the rest with a permit issued in the name of an outside supplier.
            room = max(0, int(cfg.phantom_declared_cows * 0.85) - phantom_declared[(tgt, year)])
            as_birth = min(head, room)
            entry = {"from": i, "to": tgt, "head": head, "day": int(day), "as_birth": as_birth, "cold_gta": None}
            if as_birth:
                phantom_declared[(tgt, year)] += as_birth
                births_decl.append({"ranch": tgt, "head": as_birth, "day": int(day), "year": year, "phantom": True})
            if head - as_birth:
                seq[0] += 1
                x = f"X{int(rng_meta.integers(cfg.n_external)) + 1:02d}"
                entry["cold_gta"] = f"GTA-PA-{year}-{seq[0]:06d}"
                gtas.append({"gta": entry["cold_gta"], "from": x, "to": tgt, "head": head - as_birth, "day": int(day),
                             "purpose": "fattening", "lots": [[head - as_birth, int(day), i]], "cold_permit": True})
            smuggled.append(entry)
            return
        gta(i, to, lots, purpose, day)

    for m in range(cfg.months):
        moy = m % 12
        for i in ids:
            r = R[i]
            day = day_of(m)
            if r.role == "breeder" and moy in (8, 9, 10, 11):
                b = int(r.breeding_cows * rng.uniform(*cfg.calving) / 4)
                if b:
                    r.lots.append([b, day, i, 0, new_lot("birth", i, day, b, i)])
                    births_decl.append({"ranch": i, "head": b, "day": int(day), "year": start.year + m // 12})
            if r.role == "breeder" and moy in (4, 5, 6, 7):
                calves = sum(l[0] for l in r.lots if day - l[1] >= 150)
                n = int(calves * rng.uniform(0.25, 0.4))
                while n > 0:
                    k = min(n, int(rng.integers(30, 160)))
                    if r.dirty and laundering:
                        spec = [(laund, 0.62), (honest_traders, 0.13), (roles["rearer"], 0.12), (roles["fattener"], 0.13)]
                    else:
                        spec = [(roles["rearer"], 0.45), (roles["fattener"], 0.33), (honest_traders, 0.22)]
                        if cfg.cover_buying and laundering:  # launderers also buy clean cattle as cover
                            spec = spec + [(laund, cfg.cover_buying)]
                    sell(i, k, day_of(m), 150, spec, "rearing")
                    n -= k
                if moy == 5:  # cull cows
                    cull = int(r.cows * rng.uniform(0.08, 0.12))
                    r.cows -= cull
                    r.lots.appendleft([cull, -1, i, 0, new_lot("cull", i, day, cull, i)])
                    spec = [(laund, 1.0)] if r.dirty and laundering else [("SH", 1.0)]
                    sell(i, cull, day_of(m), 0, spec, "slaughter" if not (r.dirty and laundering) else "fattening")
            if r.role in ("rearer", "fattener", "intermediary"):
                due = [l for l in r.lots if l[3] and day - l[1] >= l[3]]
                n = sum(l[0] for l in due)
                if r.role == "rearer":
                    spec = [(roles["fattener"], 0.85), (honest_traders, 0.15)]
                    purpose, mind = "fattening", 280
                elif r.role == "fattener":
                    spec = [("SH", 0.72), ("PORT", 0.28)]
                    purpose, mind = "slaughter", 210
                elif r.truth == "honest":
                    spec = [(roles["rearer"], 0.4), (roles["fattener"], 0.6)]
                    purpose, mind = "fattening", 3
                else:
                    spec = [(roles["fattener"], 0.5), (fronts, 0.18), ("SH", 0.17), ("PORT", 0.15)]
                    if cfg.two_hop:  # second laundering hop before reaching a fattener
                        spec = [([x for x in laund if x != i], 0.45), (roles["fattener"], 0.4), ("SH", 0.08), ("PORT", 0.07)]
                    purpose, mind = "fattening", 1
                while n > 0:
                    k = min(n, int(rng.integers(*(cfg.launderer_split if r.truth in ("launderer", "phantom_births") else (40, 260)))))
                    sell(i, k, day_of(m), mind, spec, purpose)
                    n -= k
            if cfg.mortality_annual > 0 and r.stock:
                dead = int(rng_mort.binomial(r.stock - r.cows, cfg.mortality_annual / 12)) if r.stock > r.cows else 0
                if dead:
                    dday = (date(start.year + m // 12, moy + 1, 1) - start).days + 27
                    taken = r.take(dead, dday)
                    head = sum(l[0] for l in taken)
                    if head:
                        deaths.append({"ranch": i, "head": int(head), "day": int(dday),
                                       "lots": [[int(l[0]), l[3]] for l in taken]})
        for k in range(cfg.n_external):
            xid = f"X{k + 1:02d}"
            for _ in range(int(rng.integers(1, 4))):
                head = int(rng.integers(40, 180))
                to = pick(roles["rearer"] + roles["fattener"], rng.choice(ids), head)
                if to:
                    arr = day_of(m) - 1
                    R[xid].lots.append([head, arr, xid, 0, new_lot("external", xid, arr, head, xid)])
                    gta(xid, to, R[xid].take(head, day_of(m)), "fattening", day_of(m))

    for x in [f"X{k + 1:02d}" for k in range(cfg.n_external)]:
        R[x].initial_head = sum(g_["head"] for g_ in gtas if g_["from"] == x)

    declared = {i: cfg.phantom_declared_cows for i in phantom} if phantom_on and cfg.conceal_phantom else {}
    return World(cfg, land, R, sinks, gtas, births_decl, deaths, smuggled, lots=lots_reg, allocations=allocs, declared_cows=declared)


def legacy_world_json(w: World) -> dict:
    """The world.json shape detect.py reads (unchanged since v1)."""
    out = {
        "start": w.config.start.isoformat(), "months": w.config.months,
        "ranches": [{k: (v.item() if hasattr(v, "item") else v) for k, v in vars(r).items()
                     if k not in ("lots", "geometry")} | {"head_end": r.stock} for r in w.ranches.values()],
        "gtas": w.gtas, "births": w.births, "smuggled": w.smuggled,
    }
    if w.deaths:
        out["deaths"] = [{k: v for k, v in d.items() if k != "lots"} for d in w.deaths]
    return out
