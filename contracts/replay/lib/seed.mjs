// Loading, validating and slicing `chain_seed.json` (produced by the pipeline).
//
// Two replay modes:
//   full   - every ranch, sink, event and attestation; the demo certificates plus a sample of the rest
//   subset - a small slice for public testnets: the seed's own `subset` block when present, otherwise
//            the smallest conservation-feasible closure around the first N demo shipments.
import fs from "node:fs";

export const PURPOSES = ["breeding", "rearing", "fattening", "slaughter", "export"];
export const RISK_CLASSES = ["clean", "watch", "high"];
export const VERDICTS = ["clean", "flagged", "unknown", "review"];
export const SINK_KINDS = { 1: "slaughterhouse", 2: "export port" };

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const lc = (h) => String(h).toLowerCase();

export function loadSeed(path) {
  const seed = JSON.parse(fs.readFileSync(path, "utf8"));
  validateSeed(seed);
  return seed;
}

function fail(msg) {
  throw new Error(`chain_seed: ${msg}`);
}

function hex32(v, where) {
  if (!HEX32.test(String(v))) fail(`${where} is not a 0x-prefixed 32-byte hex value: ${v}`);
}

function validateWorld(w, where) {
  for (const k of ["ranches", "sinks", "events", "risk_attestations", "certificates"]) {
    if (!Array.isArray(w[k])) fail(`${where}.${k} must be an array`);
  }
  w.ranches.forEach((r, i) => {
    hex32(r.onchain_id, `${where}.ranches[${i}].onchain_id`);
    hex32(r.geom_hash, `${where}.ranches[${i}].geom_hash`);
  });
  w.sinks.forEach((s, i) => {
    hex32(s.onchain_id, `${where}.sinks[${i}].onchain_id`);
    if (s.kind !== 1 && s.kind !== 2) fail(`${where}.sinks[${i}].kind must be 1 or 2`);
  });
  w.events.forEach((e, i) => {
    const at = `${where}.events[${i}]`;
    if (e.type === "movement") {
      hex32(e.hash, `${at}.hash`);
      hex32(e.from, `${at}.from`);
      hex32(e.to, `${at}.to`);
    } else if (e.type === "births" || e.type === "deaths" || e.type === "embargo") {
      hex32(e.ranch, `${at}.ranch`);
    } else {
      fail(`${at}.type "${e.type}" is not births|deaths|movement|embargo`);
    }
  });
  w.certificates.forEach((c, i) => {
    hex32(c.lot_id, `${where}.certificates[${i}].lot_id`);
    hex32(c.sink, `${where}.certificates[${i}].sink`);
    if (!Array.isArray(c.gta_hashes) || c.gta_hashes.length === 0) fail(`${where}.certificates[${i}] has no GTAs`);
  });
}

export function validateSeed(seed) {
  if (seed.version !== 1) fail(`unsupported version ${seed.version}`);
  validateWorld(seed, "seed");
  if (seed.subset) validateWorld(seed.subset, "subset");
  const d = seed.demo;
  if (!d) fail("missing demo block");
  for (const k of ["consume_clean", "double_consume", "consume_flagged"]) hex32(d[k], `demo.${k}`);
  if (!d.embargoed_attempt) fail("missing demo.embargoed_attempt");
}

/** Human-readable label for any on-chain id (ranch, sink, GTA hash, lot id). */
export function makeLabeler(seed) {
  const map = new Map();
  const put = (k, v) => k && v && map.set(lc(k), v);
  for (const [k, v] of Object.entries(seed.id_map ?? {})) put(k, v);
  for (const w of [seed, seed.subset].filter(Boolean)) {
    w.ranches.forEach((r) => put(r.onchain_id, r.id));
    w.sinks.forEach((s) => put(s.onchain_id, s.id));
    w.events.forEach((e) => e.type === "movement" && put(e.hash, e.gta));
    w.certificates.forEach((c) => put(c.lot_id, c.shipment));
  }
  put(seed.demo.embargoed_attempt.hash, seed.demo.embargoed_attempt.gta);
  return (h) => map.get(lc(h)) ?? `${String(h).slice(0, 10)}…`;
}

/**
 * Pick the entities, events, attestations and certificates to replay.
 * @param {object} seed
 * @param {{subset: boolean, subsetN?: number, certs: number|"all"}} opts
 */
export function selectWorld(seed, opts) {
  const demoLots = new Set([seed.demo.consume_clean, seed.demo.double_consume, seed.demo.consume_flagged].map(lc));
  let world;
  let mode;
  if (!opts.subset) {
    mode = "full";
    world = {
      ranches: seed.ranches,
      sinks: seed.sinks,
      events: seed.events,
      risk_attestations: seed.risk_attestations,
      certificates: pickCertificates(seed.certificates, seed, demoLots, opts.certs),
    };
  } else if (seed.subset && opts.subsetN == null) {
    mode = "subset";
    world = { ...seed.subset };
  } else {
    mode = "subset-closure";
    world = closure(seed, opts.subsetN ?? (seed.demo.shipments ?? []).length, demoLots);
  }
  ensureDemoEntities(world, seed);
  dropUnbackedCertificates(world);
  return { mode, ...world };
}

function pickCertificates(all, seed, demoLots, certs) {
  const demoShipments = new Set(seed.demo.shipments ?? []);
  const isDemo = (c) => demoLots.has(lc(c.lot_id)) || demoShipments.has(c.shipment);
  const demo = all.filter(isDemo);
  const rest = all.filter((c) => !isDemo(c));
  return certs === "all" ? [...demo, ...rest] : [...demo, ...rest.slice(0, Number(certs))];
}

/** Make sure every entity the demo attempts touch is registered, and the embargo is in place. */
function ensureDemoEntities(world, seed) {
  const ranchById = new Map(seed.ranches.map((r) => [lc(r.onchain_id), r]));
  const sinkById = new Map(seed.sinks.map((s) => [lc(s.onchain_id), s]));
  const have = new Set([...world.ranches, ...world.sinks].map((x) => lc(x.onchain_id)));
  const extraRanches = [];
  const extraSinks = [];
  const want = (id) => {
    const k = lc(id);
    if (!id || have.has(k)) return;
    if (ranchById.has(k)) extraRanches.push(ranchById.get(k));
    else if (sinkById.has(k)) extraSinks.push(sinkById.get(k));
    else return;
    have.add(k);
  };
  const ea = seed.demo.embargoed_attempt;
  want(ea.from);
  want(ea.to);
  if (seed.demo.phantom_births_attempt) want(seed.demo.phantom_births_attempt.ranch);
  world.certificates.forEach((c) => want(c.sink));
  world.ranches = [...world.ranches, ...extraRanches];
  world.sinks = [...world.sinks, ...extraSinks];

  const embargoed = world.events.some((e) => e.type === "embargo" && lc(e.ranch) === lc(ea.from) && e.on !== false);
  if (!embargoed) {
    const src = seed.events.find((e) => e.type === "embargo" && lc(e.ranch) === lc(ea.from));
    world.events = [
      ...world.events,
      src ?? { type: "embargo", ranch: ea.from, reason_hash: "0x" + "00".repeat(31) + "01" },
    ];
  }
}

function dropUnbackedCertificates(world) {
  const delivered = new Map();
  for (const e of world.events) if (e.type === "movement") delivered.set(lc(e.hash), lc(e.to));
  world.dropped_certificates = [];
  world.certificates = world.certificates.filter((c) => {
    const ok = c.gta_hashes.every((h) => delivered.get(lc(h)) === lc(c.sink));
    if (!ok) world.dropped_certificates.push(c.shipment ?? c.lot_id);
    return ok;
  });
}

/**
 * Smallest replayable slice around the first `n` demo shipments (used only when the seed has no
 * `subset` block). Starts from the GTAs of the target certificates and adds earlier inflows to any
 * origin ranch that would otherwise ship more head than it holds, until every included movement is
 * backed. Dropping deaths and unrelated outflows can only raise balances, so the slice stays valid.
 */
function closure(seed, n, demoLots) {
  const targets = new Set((seed.demo.shipments ?? []).slice(0, n));
  const certificates = seed.certificates.filter((c) => targets.has(c.shipment) || demoLots.has(lc(c.lot_id)));
  const gtaWanted = new Set(certificates.flatMap((c) => c.gta_hashes.map(lc)));
  const events = seed.events;
  const include = new Set();
  events.forEach((e, i) => e.type === "movement" && gtaWanted.has(lc(e.hash)) && include.add(i));
  const initial = new Map(seed.ranches.map((r) => [lc(r.onchain_id), r.initial_head]));

  for (let guard = 0; guard < 100_000; guard++) {
    const origins = new Set([...include].map((i) => lc(events[i].from)));
    const bal = new Map(initial);
    let changed = false;
    for (let i = 0; i < events.length && !changed; i++) {
      const e = events[i];
      if (e.type === "births" && origins.has(lc(e.ranch))) {
        include.add(i);
        bal.set(lc(e.ranch), bal.get(lc(e.ranch)) + e.head);
      }
      if (e.type !== "movement" || !include.has(i)) continue;
      const from = lc(e.from);
      if (bal.get(from) < e.head) {
        // Pull in the latest earlier inflows into `from` until the deficit is covered.
        let deficit = e.head - bal.get(from);
        for (let j = i - 1; j >= 0 && deficit > 0; j--) {
          const p = events[j];
          if (p.type === "movement" && !include.has(j) && lc(p.to) === from) {
            include.add(j);
            deficit -= p.head;
          }
        }
        changed = true;
        break;
      }
      bal.set(from, bal.get(from) - e.head);
      if (bal.has(lc(e.to))) bal.set(lc(e.to), bal.get(lc(e.to)) + e.head);
    }
    if (!changed) break;
  }

  const picked = events.filter((e, i) => include.has(i));
  const ids = new Set();
  picked.forEach((e) => (e.type === "movement" ? [e.from, e.to] : [e.ranch]).forEach((x) => ids.add(lc(x))));
  const origins = new Set(picked.filter((e) => e.type === "movement").map((e) => lc(e.from)));
  const embargoes = events.filter((e) => e.type === "embargo" && origins.has(lc(e.ranch)));
  return {
    ranches: seed.ranches.filter((r) => ids.has(lc(r.onchain_id))),
    sinks: seed.sinks.filter((s) => ids.has(lc(s.onchain_id))),
    events: [...picked, ...embargoes.filter((e) => !picked.includes(e))],
    risk_attestations: seed.risk_attestations.filter((a) => ids.has(lc(a.ranch))),
    certificates,
  };
}

/**
 * Offline mirror of the HerdLedger rules. Returns the first violation (or null) so a bad seed is
 * reported with its event index before any transaction is sent.
 */
export function checkWorld(world) {
  const kind = new Map();
  const ranch = new Map();
  const births = new Map();
  const gtas = new Map();
  const where = (i, e) => `events[${i}] (${e.type}${e.gta ? " " + e.gta : ""})`;
  for (const s of world.sinks) {
    if (kind.has(lc(s.onchain_id))) return `duplicate entity ${s.id}`;
    kind.set(lc(s.onchain_id), "sink");
  }
  for (const r of world.ranches) {
    if (kind.has(lc(r.onchain_id))) return `duplicate entity ${r.id}`;
    kind.set(lc(r.onchain_id), "ranch");
    ranch.set(lc(r.onchain_id), { head: r.initial_head, cows: r.breeding_cows, embargoed: false });
  }
  for (let i = 0; i < world.events.length; i++) {
    const e = world.events[i];
    if (e.type === "movement") {
      const from = ranch.get(lc(e.from));
      if (!kind.has(lc(e.from)) || !kind.has(lc(e.to))) return `${where(i, e)}: UnknownEntity`;
      if (!from) return `${where(i, e)}: NotARanch(from)`;
      if (lc(e.from) === lc(e.to)) return `${where(i, e)}: SameOriginAndDestination`;
      if (gtas.has(lc(e.hash))) return `${where(i, e)}: DuplicateGta`;
      if (!(e.head > 0)) return `${where(i, e)}: ZeroHead`;
      if (!(e.purpose >= 0 && e.purpose <= 4)) return `${where(i, e)}: InvalidPurpose`;
      if (from.embargoed) return `${where(i, e)}: OriginEmbargoed`;
      if (from.head < e.head) return `${where(i, e)}: InsufficientHerd(have ${from.head}, need ${e.head})`;
      from.head -= e.head;
      const to = ranch.get(lc(e.to));
      if (to) to.head += e.head;
      gtas.set(lc(e.hash), { to: lc(e.to), head: e.head, lot: null });
    } else {
      const r = ranch.get(lc(e.ranch));
      if (!r) return `${where(i, e)}: ${kind.has(lc(e.ranch)) ? "NotARanch" : "UnknownEntity"}`;
      if (e.type === "births") {
        const key = `${lc(e.ranch)}:${e.year}`;
        const total = (births.get(key) ?? 0) + e.head;
        const max = Math.floor((r.cows * 8500) / 10000);
        if (!(e.head > 0)) return `${where(i, e)}: ZeroHead`;
        if (total > max) return `${where(i, e)}: BirthsExceedBiology(total ${total}, max ${max})`;
        births.set(key, total);
        r.head += e.head;
      } else if (e.type === "deaths") {
        if (r.head < e.head) return `${where(i, e)}: InsufficientHerd(have ${r.head}, need ${e.head})`;
        r.head -= e.head;
      } else if (e.type === "embargo") {
        r.embargoed = e.on !== false;
      }
    }
  }
  for (const c of world.certificates) {
    let sum = 0;
    for (const h of c.gta_hashes) {
      const g = gtas.get(lc(h));
      if (!g) return `certificate ${c.shipment}: UnknownGta ${h}`;
      if (g.to !== lc(c.sink)) return `certificate ${c.shipment}: GtaDestinationMismatch ${h}`;
      if (g.lot) return `certificate ${c.shipment}: GtaAlreadyCertified ${h} (in ${g.lot})`;
      g.lot = c.shipment ?? c.lot_id;
      sum += g.head;
    }
    if (c.head > sum) return `certificate ${c.shipment}: CertificateHeadExceedsGtas(${c.head} > ${sum})`;
  }
  return null;
}
