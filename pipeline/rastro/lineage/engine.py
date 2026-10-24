"""Lot lineage over dated, directed movement records.

Model
-----
Every quantity of cattle on a ranch is a *lot* with an id, an arrival date and an origin
composition {origin key: [head, min hops]}. Lots are created by the opening herd (`OPEN:<ranch>`),
by declared births (`BIRTH:<event>`) and by every applied GTA (`LOT-<gta>`). Origin keys are
`<ranch>#birth`, `<ranch>#opening`, `<supplier>#external`, `UNRESOLVED#<gta>` and `MISSING#<id>`.

Replay
------
Events are applied in (date, births < movements < deaths, reference) order, so input order never
matters. An outgoing movement takes head from the origin's lots under the allocation policy:

- `fifo`: oldest lots first (the documented default; a cohort assumption, not animal identity);
- `pro_rata`: an equal share of every lot on the ranch (a fully mixed herd).

Each allocation (source lot -> outgoing lot, head) is recorded once and removed from the source,
so the same head can never be allocated to two movements. A quantity the ranch does not hold is
not invented: it becomes `UNRESOLVED#<gta>` origin mass and travels downstream as unknown. Every
irregularity is recorded as an issue.

Conservation, checked by `conservation()`:
    opening + births + unresolved + missing == deaths + to sinks + to unknown destinations + on hand
"""
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import date

POLICIES = ("fifo", "pro_rata")
EPS = 1e-9
_KIND_ORDER = {"birth": 0, "movement": 1, "death": 2}


@dataclass
class Movement:
    gta_id: str
    origin: str
    destination: str
    date: date
    head: int
    lot_id: str | None = None
    issue_date: date | None = None

    def __post_init__(self):
        self.lot_id = self.lot_id or f"LOT-{self.gta_id}"


@dataclass
class Issue:
    code: str          # inventory_shortage, missing_upstream_record, unknown_destination, self_loop,
                       # duplicate_movement, impossible_chronology, movement_before_registration,
                       # ledger_refused, death_shortage
    ref: str
    ranch: str | None
    date: date | None
    head: float
    detail: str


@dataclass
class Lot:
    lot_id: str
    ranch: str
    arrival: date
    head: float
    comp: dict                       # origin key -> [head, min hops]
    order: int = 0


@dataclass
class MovedLot:
    lot_id: str
    gta_id: str
    origin: str
    destination: str
    date: date
    head: float                      # head on the permit
    comp: dict                       # origin key -> [head, min hops] (sums to head)
    sources: list = field(default_factory=list)   # [(source lot id, head)]
    order: int = 0


class LineageEngine:
    def __init__(self, ranches: dict[str, dict], sinks: set[str], policy: str = "fifo"):
        """ranches: id -> {"kind": "ranch"|"external_supplier", "opening_head": int, "registered_on": date|None}."""
        if policy not in POLICIES:
            raise ValueError(f"policy must be one of {POLICIES}")
        self.R, self.sinks, self.policy = ranches, set(sinks), policy
        self.inv: dict[str, deque] = {}
        self.moved: dict[str, MovedLot] = {}          # lot id -> moved lot (every applied GTA)
        self.created: dict[str, Lot] = {}             # opening and birth lots
        self.issues: list[Issue] = []
        self.totals = defaultdict(float)
        self._order = 0
        self._seen_gta = set()

    # ---- replay -----------------------------------------------------------------------------
    def run(self, movements: list[Movement], births=(), deaths=(), skip: dict[str, str] | None = None):
        """births/deaths: [{"ref", "ranch", "date", "head"}]; skip: event ref -> reason (e.g. ledger refusals)."""
        skip = skip or {}
        start = min([m.date for m in movements] + [b["date"] for b in births] + [date.max])
        for rid, r in sorted(self.R.items()):
            head = float(r.get("opening_head") or 0)
            kind = "external" if r.get("kind") == "external_supplier" else "opening"
            lot = Lot(f"OPEN:{rid}", rid, r.get("registered_on") or start, head, {f"{rid}#{kind}": [head, 0]} if head else {}, self._next())
            self.inv[rid] = deque([lot]) if head else deque()
            self.created[lot.lot_id] = lot
            self.totals["opening"] += head

        events = [(b["date"], "birth", b["ref"], b) for b in births]
        events += [(m.date, "movement", m.gta_id, m) for m in movements]
        events += [(d["date"], "death", d["ref"], d) for d in deaths]
        events.sort(key=lambda e: (e[0], _KIND_ORDER[e[1]], e[2]))
        for d, kind, ref, ev in events:
            if ref in skip:
                if kind == "movement":
                    self.issues.append(Issue("ledger_refused", ref, ev.origin, d, float(ev.head), skip[ref]))
                continue
            getattr(self, f"_{kind}")(ev)
        return self

    def _next(self):
        self._order += 1
        return self._order

    def _birth(self, b):
        rid = b["ranch"]
        if rid not in self.R:
            self.issues.append(Issue("missing_upstream_record", b["ref"], rid, b["date"], float(b["head"]), "birth at an unregistered ranch"))
            return
        lot = Lot(f"BIRTH:{b['ref']}", rid, b["date"], float(b["head"]), {f"{rid}#birth": [float(b["head"]), 0]}, self._next())
        self.inv[rid].append(lot)
        self.created[lot.lot_id] = lot
        self.totals["births"] += b["head"]

    def _death(self, d):
        rid = d["ranch"]
        if rid not in self.inv:
            self.issues.append(Issue("missing_upstream_record", d["ref"], rid, d["date"], float(d["head"]), "death at an unregistered ranch"))
            return
        taken, comp, short = self._take(rid, float(d["head"]))
        if short > EPS:
            self.issues.append(Issue("death_shortage", d["ref"], rid, d["date"], short, f"declared {d['head']} deaths, held {d['head'] - short:.0f}"))
        self.totals["deaths"] += float(d["head"]) - short

    def _movement(self, m: Movement):
        if m.gta_id in self._seen_gta:
            self.issues.append(Issue("duplicate_movement", m.gta_id, m.origin, m.date, float(m.head), "GTA id already applied; second record ignored"))
            return
        self._seen_gta.add(m.gta_id)
        if m.origin == m.destination:
            self.issues.append(Issue("self_loop", m.gta_id, m.origin, m.date, float(m.head), "origin equals destination; ignored"))
            return
        if m.issue_date and m.issue_date > m.date:
            self.issues.append(Issue("impossible_chronology", m.gta_id, m.origin, m.date, float(m.head),
                                     f"issued {m.issue_date} after the movement date {m.date}"))
        reg = (self.R.get(m.origin) or {}).get("registered_on")
        if reg and m.date < reg:
            self.issues.append(Issue("movement_before_registration", m.gta_id, m.origin, m.date, float(m.head),
                                     f"origin registered on {reg}"))

        head = float(m.head)
        if m.origin not in self.inv:
            comp = {f"MISSING#{m.origin}": [head, 0]}
            taken = []
            self.totals["missing"] += head
            self.issues.append(Issue("missing_upstream_record", m.gta_id, m.origin, m.date, head, "origin is not a registered ranch"))
        else:
            taken, comp, short = self._take(m.origin, head)
            if short > EPS:
                comp[f"UNRESOLVED#{m.gta_id}"] = [short, 0]
                self.totals["unresolved"] += short
                self.issues.append(Issue("inventory_shortage", m.gta_id, m.origin, m.date, short,
                                         f"permit for {m.head} head; the ranch held {head - short:.1f} under the replayed records"))
        comp = {k: [v[0], v[1] + 1] for k, v in comp.items()}
        lot = MovedLot(m.lot_id, m.gta_id, m.origin, m.destination, m.date, head, comp, taken, self._next())
        self.moved[lot.lot_id] = lot
        if m.destination in self.inv:
            self.inv[m.destination].append(Lot(lot.lot_id, m.destination, m.date, head, {k: list(v) for k, v in comp.items()}, lot.order))
        elif m.destination in self.sinks:
            self.totals["to_sinks"] += head
        else:
            self.totals["to_unknown"] += head
            self.issues.append(Issue("unknown_destination", m.gta_id, m.destination, m.date, head, "destination is neither a ranch nor a sink"))

    def _take(self, rid: str, n: float):
        """Remove n head from a ranch under the policy. Returns (allocations, composition, shortage)."""
        q = self.inv[rid]
        held = sum(l.head for l in q)
        want = min(n, held)
        comp, taken = defaultdict(lambda: [0.0, 10**6]), []

        def cut(lot, k):
            f = k / lot.head
            for o, (h, hops) in lot.comp.items():
                comp[o][0] += h * f
                comp[o][1] = min(comp[o][1], hops)
            for o in lot.comp:
                lot.comp[o][0] *= (1 - f)
            lot.head -= k
            taken.append((lot.lot_id, k))

        if self.policy == "fifo":
            need = want
            while need > EPS and q:
                lot = q[0]
                k = min(need, lot.head)
                cut(lot, k)
                need -= k
                if lot.head <= EPS:
                    q.popleft()
        elif held > EPS:
            share = want / held
            for lot in list(q):
                cut(lot, lot.head * share)
            self.inv[rid] = deque(l for l in q if l.head > EPS)
        return taken, {k: v for k, v in comp.items() if v[0] > EPS}, n - want

    # ---- queries ------------------------------------------------------------------------------
    def conservation(self) -> dict:
        on_hand = sum(l.head for q in self.inv.values() for l in q)
        t = self.totals
        inflow = t["opening"] + t["births"] + t["unresolved"] + t["missing"]
        outflow = t["deaths"] + t["to_sinks"] + t["to_unknown"] + on_hand
        return {"opening": t["opening"], "births": t["births"], "unresolved": t["unresolved"], "missing": t["missing"],
                "deaths": t["deaths"], "to_sinks": t["to_sinks"], "to_unknown": t["to_unknown"], "on_hand": on_hand,
                "balanced": abs(inflow - outflow) <= 1e-6 * max(1.0, inflow)}

    def composition(self, lot_ids: list[str]) -> dict:
        out = defaultdict(lambda: [0.0, 10**6])
        for lid in lot_ids:
            for o, (h, hops) in self.moved[lid].comp.items():
                out[o][0] += h
                out[o][1] = min(out[o][1], hops)
        return dict(out)

    def path(self, lot_ids: list[str]) -> list[dict]:
        """Every applied GTA upstream of the given lots, with the head attributable to them.

        Demand is pushed from the target lots back through the recorded allocations in reverse
        creation order, so each GTA is visited once however many paths lead through it.
        """
        reach, stack = set(), list(lot_ids)
        while stack:
            lid = stack.pop()
            if lid in reach:
                continue
            reach.add(lid)
            stack.extend(src for src, _ in self.moved[lid].sources if src in self.moved)
        demand = defaultdict(float)
        for lid in lot_ids:
            demand[lid] += self.moved[lid].head
        rows = []
        for lid in sorted(reach, key=lambda l: -self.moved[l].order):  # sources are always created earlier
            lot, d = self.moved[lid], demand[lid]
            rows.append({"gta_id": lot.gta_id, "lot_id": lid, "date": lot.date.isoformat(), "from": lot.origin, "to": lot.destination,
                         "permit_head": lot.head, "attributed_head": round(d, 3)})
            for src, h in lot.sources:
                if src in self.moved:
                    demand[src] += d * h / lot.head
        return sorted(rows, key=lambda r: (r["date"], r["gta_id"]))
