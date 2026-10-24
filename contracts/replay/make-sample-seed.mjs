#!/usr/bin/env node
// Derives the small, committed test fixture `test/fixtures/chain_seed.sample.json` from a full
// pipeline seed: the seed's demo subset, plus the births of those ranches and a few deaths, so the
// fixture exercises every event type and still satisfies every ledger rule.
//
//   node replay/make-sample-seed.mjs [../pipeline/out/chain_seed.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkWorld, loadSeed, selectWorld } from "./lib/seed.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(process.argv[2] ?? path.join(ROOT, "../pipeline/out/chain_seed.json"));
const dst = path.join(ROOT, "test/fixtures/chain_seed.sample.json");
const lc = (h) => String(h).toLowerCase();

const seed = loadSeed(src);
const sub = selectWorld(seed, { subset: true }); // subset block + entities the demo attempts need

const ranchIds = new Set(sub.ranches.map((r) => lc(r.onchain_id)));
const moves = new Set(sub.events.filter((e) => e.type === "movement").map((e) => lc(e.hash)));
const embargoes = new Set(sub.events.filter((e) => e.type === "embargo").map((e) => lc(e.ranch)));

// Keep the full seed's chronological order; add the subset ranches' own births.
const events = seed.events.filter(
  (e) =>
    (e.type === "movement" && moves.has(lc(e.hash))) ||
    (e.type === "embargo" && embargoes.has(lc(e.ranch))) ||
    (e.type === "births" && ranchIds.has(lc(e.ranch))),
);
// Anything the subset has that the full list does not (e.g. a demo-only embargo) goes last.
const key = (e) => (e.type === "movement" ? `m:${lc(e.hash)}` : `${e.type}:${lc(e.ranch)}`);
const have = new Set(events.map(key));
events.push(...sub.events.filter((e) => !have.has(key(e))));

// A few deaths at the end, on the ranches holding the most animals by then.
const bal = new Map(sub.ranches.map((r) => [lc(r.onchain_id), r.initial_head]));
for (const e of events) {
  if (e.type === "births") bal.set(lc(e.ranch), bal.get(lc(e.ranch)) + e.head);
  if (e.type === "movement") {
    bal.set(lc(e.from), bal.get(lc(e.from)) - e.head);
    if (bal.has(lc(e.to))) bal.set(lc(e.to), bal.get(lc(e.to)) + e.head);
  }
}
[...bal.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 3)
  .forEach(([ranch, head], i) => events.push({ type: "deaths", ranch, head: Math.min(head, 2 + i) }));

const world = { ranches: sub.ranches, sinks: sub.sinks, events, risk_attestations: sub.risk_attestations, certificates: sub.certificates };
const problem = checkWorld(world);
if (problem) throw new Error(`derived sample is inconsistent: ${problem}`);

const keep = new Set([...sub.ranches, ...sub.sinks].map((x) => lc(x.onchain_id)));
const sample = {
  version: 1,
  _note: "Small fixture derived from the pipeline chain_seed.json (synthetic ranches and GTAs). Regenerate with `npm run sample-seed`.",
  ...world,
  demo: seed.demo,
  subset: {
    ranches: sub.ranches,
    sinks: sub.sinks,
    events: sub.events,
    risk_attestations: sub.risk_attestations,
    certificates: sub.certificates,
  },
  id_map: Object.fromEntries(Object.entries(seed.id_map ?? {}).filter(([k]) => keep.has(lc(k)))),
};
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, JSON.stringify(sample, null, 2) + "\n");
const count = (t) => events.filter((e) => e.type === t).length;
console.log(
  `wrote ${path.relative(ROOT, dst)}: ${world.ranches.length} ranches, ${world.sinks.length} sinks, ` +
    `${events.length} events (${count("births")} births, ${count("movement")} movements, ${count("embargo")} embargoes, ` +
    `${count("deaths")} deaths), ${world.risk_attestations.length} attestations, ${world.certificates.length} certificates`,
);
