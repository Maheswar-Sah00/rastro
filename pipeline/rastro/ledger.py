"""Replay declared events under HerdLedger's rules and derive the monthly herd inventory.

Same rules and ordering as HerdLedger.sol and the mirror in detect.py:
- births: cumulative per ranch-year <= breeding cows x 8500 / 10000, else BirthsExceedBiology
- movement: origin embargoed on that date -> OriginEmbargoed; origin balance < head -> InsufficientHerd
- death: balance < head -> InsufficientHerd
Refused events change no balance. Events on the same day apply as embargo, births, movements, deaths.
"""
from collections import defaultdict
from datetime import date, timedelta

from rastro.config import MAX_CALVING_RATE

MAX_CALVING_BPS = round(MAX_CALVING_RATE * 10000)


def birth_cap(breeding_cows: int) -> int:
    return breeding_cows * MAX_CALVING_BPS // 10000


def month_start(d: date) -> date:
    return d.replace(day=1)


def month_end(d: date) -> date:
    nxt = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    return nxt - timedelta(days=1)


def replay(ranches, births, deaths, gtas, embargoes, start: date):
    """All arguments are lists of canonical row dicts. Returns (inventory_rows, refusals)."""
    R = {r["ranch_id"]: r for r in ranches}
    emb_from = {}
    for e in embargoes:
        if e["status"] == "active":
            emb_from[e["ranch_id"]] = min(e["start_date"], emb_from.get(e["ranch_id"], e["start_date"]))
    events = [(e, -1, "embargo", {"ranch_id": r}) for r, e in emb_from.items()]
    events += [(b["date"], 0, "birth", b) for b in births]
    events += [(g["movement_date"], 1, "movement", g) for g in gtas]
    events += [(d["date"], 2, "death", d) for d in deaths]
    events.sort(key=lambda e: (str(e[0]), e[1], _seq(e)))

    bal = {i: R[i]["opening_head"] for i in R}
    by_year = defaultdict(int)
    embargoed = set()
    refusals = []
    flows = defaultdict(lambda: defaultdict(int))   # (ranch, month) -> column -> head
    ext_in = set()

    def refuse(kind, ref, ranch, d, head, why):
        refusals.append({"event_ref": ref, "event_type": kind, "ranch_id": ranch, "date": d, "head": head,
                         "reason": why, "declared_balance": bal.get(ranch, 0)})
        if ranch in R and R[ranch]["entity_type"] == "ranch":
            flows[(ranch, month_start(_d(d)))]["refused"] += 1

    for d, _, kind, ev in events:
        m = month_start(_d(d))
        if kind == "embargo":
            embargoed.add(ev["ranch_id"])
        elif kind == "birth":
            i = ev["ranch_id"]
            cap = birth_cap(R[i]["breeding_cows_declared"])
            if by_year[(i, ev["year"])] + ev["declared_head"] > cap:
                refuse("birth", ev["birth_event_id"], i, d, ev["declared_head"], "BirthsExceedBiology")
                continue
            by_year[(i, ev["year"])] += ev["declared_head"]
            bal[i] += ev["declared_head"]
            flows[(i, m)]["births"] += ev["declared_head"]
        elif kind == "movement":
            f, t, n = ev["origin_id"], ev["destination_id"], ev["head_count"]
            if f in embargoed:
                refuse("movement", ev["gta_id"], f, d, n, "OriginEmbargoed")
                continue
            if bal[f] < n:
                refuse("movement", ev["gta_id"], f, d, n, "InsufficientHerd")
                continue
            bal[f] -= n
            flows[(f, m)]["other_removals" if t not in bal else "departures"] += n
            if t in bal:
                bal[t] += n
                flows[(t, m)]["arrivals"] += n
                if f.startswith("X"):
                    ext_in.add((t, m))
        else:
            i, n = ev["ranch_id"], ev["declared_head"]
            if bal[i] < n:
                refuse("death", ev["death_event_id"], i, d, n, "InsufficientHerd")
                continue
            bal[i] -= n
            flows[(i, m)]["deaths"] += n

    last = max([_d(e[0]) for e in events], default=start)
    months, m = [], month_start(start)
    while m <= last:
        months.append(m)
        m = month_end(m) + timedelta(days=1)

    inventory = []
    for i in sorted(R):
        if R[i]["entity_type"] != "ranch":
            continue  # suppliers outside the window have no herd registry here
        opening = R[i]["opening_head"]
        for m in months:
            f = flows.get((i, m), {})
            closing = opening + f.get("births", 0) + f.get("arrivals", 0) - f.get("departures", 0) - f.get("deaths", 0) - f.get("other_removals", 0)
            refused = f.get("refused", 0)
            inventory.append({
                "ranch_id": i, "period_start": m.isoformat(), "observation_date": month_end(m).isoformat(),
                "opening_head": opening, "births": f.get("births", 0), "arrivals": f.get("arrivals", 0),
                "departures": f.get("departures", 0), "deaths": f.get("deaths", 0),
                "other_removals": f.get("other_removals", 0), "closing_head": closing, "refused_events": refused,
                "inventory_confidence": "low" if refused else ("medium" if (i, m) in ext_in else "high"),
            })
            opening = closing
    for r in refusals:
        r["date"] = str(r["date"])
    return inventory, refusals


def _d(x) -> date:
    return x if isinstance(x, date) else date.fromisoformat(x)


def _seq(e):
    ev = e[3]
    ref = ev.get("birth_event_id") or ev.get("gta_id") or ev.get("death_event_id") or ""
    if ref.startswith("GTA-PA-ATTEMPT"):
        return (1, ref)
    if ref.startswith("GTA-"):
        return (0, ref.rsplit("-", 1)[1])  # global creation sequence, independent of year
    return (0, ref)
