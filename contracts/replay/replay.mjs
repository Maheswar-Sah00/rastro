#!/usr/bin/env node
// Replays a pipeline `chain_seed.json` into a deployed HerdLedger and writes `out/onchain.json`
// (SPEC §6.8), then copies it and the ABI to `web/public/data/`.
//
//   node replay/replay.mjs [seed.json] [options]
//
// Options
//   --rpc <url>            JSON-RPC endpoint (env RPC_URL, default http://127.0.0.1:8545)
//   --address <0x..>       HerdLedger address (env HERDLEDGER_ADDRESS, default: latest forge broadcast)
//   --subset [N]           small replay for public testnets (env REPLAY_SUBSET). Uses the seed's
//                          `subset` block; with N, the closure around the first N demo shipments.
//   --certs <N|all>        full mode: certificates besides the demo lots (default 100)
//   --batch <N>            calls per multicall tx (default 250 on anvil, 1 elsewhere)
//   --records <all|key>    which txs to list in onchain.json (default: all if <= 1500 steps, else key)
//   --env-file <path>      load keys from this file (default .env if present)
//   --out <path>           output (default out/onchain.json)
//   --web-dir <path>       where to copy onchain.json + ABI (default ../web/public/data)
//   --no-web               do not copy into the web app
//   --force-web            let an anvil replay overwrite a public-testnet onchain.json in the web app
//   env REPLAY_DEBUG=1     print every JSON-RPC request
//
// Keys: on anvil the default accounts are used (#1 registrar+issuer, #2 regulator, #3 buyer,
// #4 relayer, #5 oracle). Elsewhere PRIVATE_KEY is used for every role unless REGISTRAR_PRIVATE_KEY,
// ISSUER_PRIVATE_KEY, REGULATOR_PRIVATE_KEY, BUYER_PRIVATE_KEY, RELAYER_PRIVATE_KEY or
// ORACLE_PRIVATE_KEY override it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

import {
  checkWorld,
  loadSeed,
  makeLabeler,
  selectWorld,
  PURPOSES,
  RISK_CLASSES,
  VERDICTS,
  SINK_KINDS,
} from "./lib/seed.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SEED = path.resolve(ROOT, "../pipeline/out/chain_seed.json");
const SAMPLE_SEED = path.resolve(ROOT, "test/fixtures/chain_seed.sample.json");
const ARTIFACT = path.resolve(ROOT, "out/forge/HerdLedger.sol/HerdLedger.json");

// Well-known anvil dev keys (mnemonic "test test ... junk"). Local only.
const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
];

const NETWORKS = {
  31337: { name: "anvil", explorer: null, rpc: "http://127.0.0.1:8545" },
  80002: { name: "polygon-amoy", explorer: "https://amoy.polygonscan.com", rpc: "https://rpc-amoy.polygon.technology" },
  84532: { name: "base-sepolia", explorer: "https://sepolia.basescan.org", rpc: "https://sepolia.base.org" },
};

// Rough gas per call, used only to size multicall batches (the real limit comes from estimateGas).
const GAS_WEIGHT = {
  registerRanch: 115_000,
  registerSink: 50_000,
  recordBirths: 60_000,
  recordDeaths: 40_000,
  recordMovement: 125_000,
  setEmbargo: 60_000,
  attestRisk: 95_000,
  issueCertificate: 80_000, // + per GTA below
  consumeCertificate: 110_000,
};
const GAS_PER_CERT_GTA = 50_000;
const CERT_VALIDITY_S = 365 * 24 * 3600; // signed certificate validity
const POLICY_VERSION = 1; // risk-policy version bound into every certificate
const BATCH_GAS_BUDGET = 24_000_000;

// ------------------------------------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { web: true, certs: "100" };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--rpc") o.rpc = next();
    else if (a === "--address") o.address = next();
    else if (a === "--subset") {
      o.subset = true;
      if (argv[i + 1] && /^\d+$/.test(argv[i + 1])) o.subsetN = Number(next());
    } else if (a === "--certs") o.certs = next();
    else if (a === "--batch") o.batch = Number(next());
    else if (a === "--records") o.records = next();
    else if (a === "--env-file") o.envFile = next();
    else if (a === "--out") o.out = next();
    else if (a === "--web-dir") o.webDir = next();
    else if (a === "--no-web") o.web = false;
    else if (a === "--force-web") o.forceWeb = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else rest.push(a);
  }
  o.seed = rest[0];
  return o;
}

function loadEnv(file) {
  const f = file ?? path.join(ROOT, ".env");
  if (fs.existsSync(f)) {
    process.loadEnvFile(f);
    return f;
  }
  if (file) throw new Error(`env file not found: ${file}`);
  return null;
}

// ------------------------------------------------------------------------------------------------
// Revert decoding
// ------------------------------------------------------------------------------------------------

function revertData(err) {
  const seen = new Set();
  const stack = [err];
  while (stack.length) {
    const e = stack.pop();
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    for (const k of ["data", "revert"]) {
      const v = e[k];
      if (typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) && v.length >= 10) return v;
      if (v && typeof v === "object" && typeof v.data === "string") return v.data;
    }
    stack.push(e.error, e.info, e.info?.error, e.cause, e.payload);
  }
  return null;
}

function formatError(iface, data) {
  if (!data) return null;
  try {
    const d = iface.parseError(data);
    const args = d.fragment.inputs.map((p, i) => {
      const v = d.args[i];
      return typeof v === "bigint" ? v.toString() : String(v);
    });
    return { name: d.name, text: `${d.name}(${args.join(", ")})` };
  } catch {
    return { name: "Unknown", text: `revert data ${data.slice(0, 74)}` };
  }
}

// ------------------------------------------------------------------------------------------------
// Main
// ------------------------------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
    console.log(src.slice(1, src.findIndex((l) => l.startsWith("import"))).join("\n").replace(/^\/\/ ?/gm, ""));
    return;
  }
  const envFile = loadEnv(opts.envFile);
  if (!opts.subset && process.env.REPLAY_SUBSET) {
    opts.subset = true;
    if (/^\d+$/.test(process.env.REPLAY_SUBSET)) opts.subsetN = Number(process.env.REPLAY_SUBSET);
  }

  const seedPath = path.resolve(opts.seed ?? (fs.existsSync(DEFAULT_SEED) ? DEFAULT_SEED : SAMPLE_SEED));
  const seed = loadSeed(seedPath);
  const label = makeLabeler(seed);
  const world = selectWorld(seed, { subset: !!opts.subset, subsetN: opts.subsetN, certs: opts.certs });
  const problem = checkWorld(world);
  if (problem) throw new Error(`seed violates a ledger rule before anything is sent: ${problem}`);

  const rpc = opts.rpc ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1, pollingInterval: 500 });
  const chainId = Number((await provider.getNetwork()).chainId);
  const net = NETWORKS[chainId] ?? { name: `chain-${chainId}`, explorer: null, rpc: null };
  const local = chainId === 31337;
  if (process.env.REPLAY_DEBUG) {
    provider.on("debug", (e) => {
      if (e.action === "sendRpcPayload") console.log("->", JSON.stringify(e.payload).slice(0, 160));
      if (e.action === "receiveRpcError") console.log("<!", JSON.stringify(e.error).slice(0, 240));
    });
  }
  if (local) provider.pollingInterval = 50;

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  const iface = new ethers.Interface(artifact.abi);
  const deployment = resolveDeployment(opts.address ?? process.env.HERDLEDGER_ADDRESS, chainId);
  const ledger = new ethers.Contract(deployment.address, artifact.abi, provider);
  if ((await provider.getCode(deployment.address)) === "0x") {
    throw new Error(`no contract at ${deployment.address} on chain ${chainId}; deploy first`);
  }

  const wallets = makeWallets(provider, local);
  await checkRoles(ledger, wallets);

  console.log(`Rastro replay -> ${net.name} (chain ${chainId}) HerdLedger ${deployment.address}`);
  console.log(`  seed     ${seedPath}${envFile ? `  (env ${path.basename(envFile)})` : ""}`);
  console.log(
    `  mode     ${world.mode}: ${world.ranches.length} ranches, ${world.sinks.length} sinks, ` +
      `${world.events.length} events, ${world.risk_attestations.length} attestations, ` +
      `${world.certificates.length} certificates`,
  );
  if (world.dropped_certificates.length) {
    console.log(`  skipped  ${world.dropped_certificates.length} certificates whose GTAs are not in this replay`);
  }

  // EIP-712 domain, cross-checked against the contract before signing anything.
  const domain = { name: "Rastro HerdLedger", version: "1", chainId, verifyingContract: deployment.address };
  const TYPES = {
    RiskAttestation: [
      { name: "ranch", type: "bytes32" },
      { name: "riskClass", type: "uint8" },
      { name: "scoreBps", type: "uint16" },
      { name: "evidenceHash", type: "bytes32" },
      { name: "asOf", type: "uint64" },
      { name: "nonce", type: "uint256" },
    ],
    Certificate: [
      { name: "lotId", type: "bytes32" },
      { name: "sink", type: "bytes32" },
      { name: "gtaHashes", type: "bytes32[]" },
      { name: "shipment", type: "bytes32" },
      { name: "head", type: "uint32" },
      { name: "verdict", type: "uint8" },
      { name: "evidenceHash", type: "bytes32" },
      { name: "issuedAt", type: "uint64" },
      { name: "expiresAt", type: "uint64" },
      { name: "policyVersion", type: "uint16" },
      { name: "nonce", type: "uint256" },
    ],
  };
  const signRisk = async (a) => wallets.oracle.signTypedData(domain, { RiskAttestation: TYPES.RiskAttestation }, a);
  const signCert = async (c) => wallets.oracle.signTypedData(domain, { Certificate: TYPES.Certificate }, c);

  // ---------------------------------------------------------------- plan
  const demo = seed.demo;
  const lc = (h) => String(h).toLowerCase();
  const demoCerts = world.certificates.filter((c) =>
    [demo.consume_clean, demo.consume_flagged].map(lc).includes(lc(c.lot_id)),
  );
  const keyRanches = new Set([demo.embargoed_attempt.from, demo.phantom_births_attempt?.ranch].filter(Boolean).map(lc));
  const keyGtas = new Set(demoCerts.flatMap((c) => c.gta_hashes.map(lc)));
  const moveById = new Map(world.events.filter((e) => e.type === "movement").map((e) => [lc(e.hash), e]));
  for (const h of keyGtas) if (moveById.has(h)) keyRanches.add(lc(moveById.get(h).from));

  // Certificate fields the web app matches evidence against ("On-chain" when the hash is here).
  const certByLot = new Map(seed.certificates.map((c) => [lc(c.lot_id), c]));
  const certExtra = (lotId) => ({ lot_id: lotId, evidence_hash: certByLot.get(lc(lotId))?.evidence_hash ?? null });

  const steps = [];
  const add = (s) => steps.push({ weight: GAS_WEIGHT[s.fn], ...s });
  for (const s of world.sinks) {
    add({ signer: "registrar", fn: "registerSink", args: [s.onchain_id, s.kind], ref: s.id, note: SINK_KINDS[s.kind] });
  }
  for (const r of world.ranches) {
    add({
      signer: "registrar",
      fn: "registerRanch",
      args: [r.onchain_id, r.capacity_head, r.initial_head, r.breeding_cows, r.geom_hash],
      ref: r.id,
      key: keyRanches.has(lc(r.onchain_id)),
      note: `capacity ${r.capacity_head}, opening herd ${r.initial_head}, breeding cows ${r.breeding_cows}`,
    });
  }
  for (const e of world.events) {
    if (e.type === "births") {
      add({ signer: "registrar", fn: "recordBirths", args: [e.ranch, e.head, e.year], ref: label(e.ranch), note: `${e.head} calves born in ${e.year}` });
    } else if (e.type === "deaths") {
      add({ signer: "registrar", fn: "recordDeaths", args: [e.ranch, e.head], ref: label(e.ranch), note: `${e.head} deaths` });
    } else if (e.type === "movement") {
      add({
        signer: "issuer",
        fn: "recordMovement",
        args: [e.hash, e.from, e.to, e.head, e.purpose, e.date_unix],
        ref: e.gta ?? label(e.hash),
        key: keyGtas.has(lc(e.hash)),
        note: `${label(e.from)} -> ${label(e.to)}, ${e.head} head, ${PURPOSES[e.purpose]}`,
      });
    } else if (e.type === "embargo") {
      const on = e.on !== false;
      add({
        signer: "regulator",
        fn: "setEmbargo",
        args: [e.ranch, on, e.reason_hash ?? ethers.ZeroHash],
        ref: label(e.ranch),
        key: true,
        note: on ? "embargo placed (Ibama)" : "embargo lifted",
      });
    }
  }
  let nonce = 0;
  for (const a of world.risk_attestations) {
    const msg = {
      ranch: a.ranch,
      riskClass: a.risk_class,
      scoreBps: a.score_bps,
      evidenceHash: a.evidence_hash,
      asOf: a.as_of,
      nonce: ++nonce,
    };
    add({
      signer: "relayer",
      fn: "attestRisk",
      args: [msg, null],
      sign: () => signRisk(msg),
      ref: label(a.ranch),
      key: true,
      extra: { evidence_hash: a.evidence_hash },
      note: `risk ${RISK_CLASSES[a.risk_class]}, score ${(a.score_bps / 10_000).toFixed(2)} (oracle-signed, relayed)`,
    });
  }
  nonce = 1_000_000;
  // Certificate terms the pipeline seed does not carry: issued "now" (chain time), valid one year,
  // risk policy 1. The shipment commitment uses the pipeline's salted SHA-256 id scheme.
  const issuedAt = Number((await provider.getBlock("latest")).timestamp);
  const shipmentCommitment = (c) => ethers.sha256(ethers.toUtf8Bytes(`rastro-demo-salt-v1|${c.shipment ?? c.lot_id}`));
  for (const c of world.certificates) {
    const msg = {
      lotId: c.lot_id,
      sink: c.sink,
      gtaHashes: c.gta_hashes,
      shipment: shipmentCommitment(c),
      head: c.head,
      verdict: c.verdict,
      evidenceHash: c.evidence_hash,
      issuedAt,
      expiresAt: issuedAt + CERT_VALIDITY_S,
      policyVersion: POLICY_VERSION,
      nonce: ++nonce,
    };
    add({
      signer: "relayer",
      fn: "issueCertificate",
      args: [msg, null],
      sign: () => signCert(msg),
      weight: GAS_WEIGHT.issueCertificate + GAS_PER_CERT_GTA * c.gta_hashes.length,
      ref: c.shipment ?? label(c.lot_id),
      key: true,
      extra: { lot_id: c.lot_id, evidence_hash: c.evidence_hash },
      note: `verdict ${VERDICTS[c.verdict]}, ${c.gta_hashes.length} GTAs, ${c.head} head into ${label(c.sink)}`,
    });
  }
  const cleanLabel = label(demo.consume_clean);
  const cleanUse = demo.labels?.eu && demo.labels.eu === cleanLabel ? 1 : 0;
  const useNames = ["export shipment", "EUDR due-diligence statement", "retail claim"];
  add({
    signer: "buyer",
    fn: "consumeCertificate",
    args: [demo.consume_clean, cleanUse, ethers.id(`rastro:${useNames[cleanUse]}:${cleanLabel}`)],
    ref: cleanLabel,
    key: true,
    extra: certExtra(demo.consume_clean),
    note: `clean certificate consumed once for an ${useNames[cleanUse]}`,
  });

  const recordAll = opts.records ? opts.records === "all" : steps.length <= 1500;
  for (const s of steps) s.record = recordAll || !!s.key || s.fn === "registerSink";

  // ---------------------------------------------------------------- execute
  const maxBatch = opts.batch ?? (local ? 250 : 1);
  const records = [];
  const nonces = new Map();
  const stats = { txs: 0, gasUsed: 0n, calls: {} };
  const t0 = Date.now();
  let done = 0;
  let i = 0;
  while (i < steps.length) {
    const signerAddr = wallets[steps[i].signer].address;
    const batch = [];
    let weight = 0;
    while (
      i < steps.length &&
      batch.length < maxBatch &&
      wallets[steps[i].signer].address === signerAddr &&
      (batch.length === 0 || weight + steps[i].weight <= BATCH_GAS_BUDGET)
    ) {
      weight += steps[i].weight;
      batch.push(steps[i++]);
    }
    for (const s of batch) if (s.sign) s.args[1] = await s.sign();
    await sendBatch(batch);
    done += batch.length;
    if (stats.txs % 10 === 0 || done === steps.length) {
      process.stdout.write(`\r  sent ${done}/${steps.length} calls in ${stats.txs} txs (${((Date.now() - t0) / 1000).toFixed(1)}s)   `);
    }
  }
  process.stdout.write("\n");

  async function sendBatch(batch) {
    const wallet = wallets[batch[0].signer];
    const data =
      batch.length === 1
        ? iface.encodeFunctionData(batch[0].fn, batch[0].args)
        : iface.encodeFunctionData("multicall", [batch.map((s) => iface.encodeFunctionData(s.fn, s.args))]);
    const tx = { to: deployment.address, data };
    let gas;
    try {
      gas = await provider.estimateGas({ ...tx, from: wallet.address });
    } catch (err) {
      if (batch.length > 1) {
        // Locate the failing call by replaying this batch one call per tx.
        for (const s of batch) await sendBatch([s]);
        return;
      }
      const s = batch[0];
      const why = formatError(iface, revertData(err));
      throw new Error(
        `unexpected revert in ${s.fn} ${s.ref} (${s.note}): ${why ? why.text : err.shortMessage ?? err.message}`,
      );
    }
    const fees = await feeOverrides(provider, chainId);
    // Explicit nonces: ethers briefly caches identical RPC reads, which can hand two fast
    // consecutive sends the same "pending" nonce on instant-mining chains.
    if (!nonces.has(wallet.address)) {
      nonces.set(wallet.address, Number(await provider.send("eth_getTransactionCount", [wallet.address, "pending"])));
    }
    const nonce = nonces.get(wallet.address);
    let resp;
    try {
      resp = await wallet.sendTransaction({ ...tx, nonce, gasLimit: (gas * 12n) / 10n + 20_000n, ...fees });
    } catch (err) {
      nonces.delete(wallet.address); // resync on the next send
      throw err;
    }
    nonces.set(wallet.address, nonce + 1);
    const rcpt = await waitReceipt(provider, resp.hash, local);
    if (rcpt.status !== 1) throw new Error(`tx ${rcpt.hash} reverted on-chain`);
    stats.txs++;
    stats.gasUsed += rcpt.gasUsed;
    batch.forEach((s, k) => {
      stats.calls[s.fn] = (stats.calls[s.fn] ?? 0) + 1;
      if (!s.record) return;
      records.push({
        kind: s.fn,
        ref: s.ref,
        tx: rcpt.hash,
        block: rcpt.blockNumber,
        status: "success",
        revert_reason: null,
        note: batch.length > 1 ? `${s.note} [batched ${k + 1}/${batch.length}]` : s.note,
        ...s.extra,
      });
    });
  }

  // ---------------------------------------------------------------- demo: expected failures (eth_call)
  const attempts = [
    {
      demo: "double_consume",
      extra: certExtra(demo.double_consume),
      expect: "CertificateAlreadyUsed",
      from: wallets.buyer.address,
      fn: "consumeCertificate",
      args: [demo.double_consume, cleanUse, ethers.id(`rastro:second-claim:${label(demo.double_consume)}`)],
      ref: label(demo.double_consume),
      note: "second claim on the same clean certificate (e.g. a second buyer or DDS) is refused",
    },
    {
      demo: "consume_flagged",
      extra: certExtra(demo.consume_flagged),
      expect: "CertificateNotClean",
      from: wallets.buyer.address,
      fn: "consumeCertificate",
      args: [demo.consume_flagged, 0, ethers.id(`rastro:export:${label(demo.consume_flagged)}`)],
      ref: label(demo.consume_flagged),
      note: "buyer tries to use a certificate the oracle flagged (laundered upstream supply)",
    },
    {
      demo: "embargoed_attempt",
      expect: "OriginEmbargoed",
      from: wallets.issuer.address,
      fn: "recordMovement",
      args: [
        demo.embargoed_attempt.hash,
        demo.embargoed_attempt.from,
        demo.embargoed_attempt.to,
        demo.embargoed_attempt.head,
        demo.embargoed_attempt.purpose,
        demo.embargoed_attempt.date_unix,
      ],
      ref: demo.embargoed_attempt.gta ?? label(demo.embargoed_attempt.hash),
      note: `GTA out of embargoed ${label(demo.embargoed_attempt.from)} to ${label(demo.embargoed_attempt.to)} (${demo.embargoed_attempt.head} head) is refused`,
    },
  ];
  if (demo.phantom_births_attempt) {
    const p = demo.phantom_births_attempt;
    attempts.push({
      demo: "phantom_births_attempt",
      expect: "BirthsExceedBiology",
      from: wallets.registrar.address,
      fn: "recordBirths",
      args: [p.ranch, p.head, p.year],
      ref: "PHANTOM_BIRTHS",
      note: `${label(p.ranch)} declares ${p.head} calves in ${p.year}, more than its breeding cows can produce`,
    });
  }
  let demoFailures = 0;
  const simBlock = Number(await provider.send("eth_blockNumber", []));
  for (const a of attempts) {
    let reason = null;
    try {
      const call = { to: deployment.address, from: a.from, data: iface.encodeFunctionData(a.fn, a.args) };
      await provider.send("eth_call", [call, ethers.toQuantity(simBlock)]);
    } catch (err) {
      reason = formatError(iface, revertData(err));
    }
    const ok = reason && reason.name === a.expect;
    if (!ok) demoFailures++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${a.demo.padEnd(22)} ${reason ? reason.text : "did not revert"}`);
    records.push({
      kind: "revertDemo",
      ref: a.ref,
      tx: null,
      block: simBlock,
      status: reason ? "reverted" : "success",
      revert_reason: reason ? reason.text : null,
      note: `${a.fn} simulated with eth_call: ${a.note}`,
      demo: a.demo,
      expected: a.expect,
      ...a.extra,
    });
  }

  // ---------------------------------------------------------------- summary + output
  const t = await ledger.totals();
  const totals = Object.fromEntries(Object.keys(t.toObject()).map((k) => [k, Number(t[k])]));
  const conserved = await ledger.isConserved();
  const statusClean = Number(await ledger.certificateStatus(demo.consume_clean));
  console.log(
    `  ledger   ${totals.ranches} ranches, ${totals.movements} GTAs, ${totals.certificates} certificates, ` +
      `${totals.headToSinks} head delivered to sinks, conserved=${conserved}`,
  );
  console.log(`  gas      ${stats.gasUsed} over ${stats.txs} txs`);

  const onchain = {
    network: net.name,
    chainId,
    address: deployment.address,
    explorer: net.explorer,
    rpc: process.env.PUBLIC_RPC_URL ?? net.rpc ?? null,
    deploy_tx: deployment.deployTx,
    records,
    abi_path: "data/HerdLedger.abi.json",
    // Additive fields (not in SPEC §6.8; safe to ignore).
    generated_at: new Date().toISOString(),
    deploy_block: deployment.deployBlock,
    mode: world.mode,
    seed: { file: path.basename(seedPath), version: seed.version },
    calls: stats.calls,
    txs: stats.txs,
    gas_used: stats.gasUsed.toString(),
    totals,
    conserved,
    demo: {
      labels: demo.labels ?? null,
      consume_clean: { lot_id: demo.consume_clean, ref: cleanLabel, status_after: ["none", "valid", "consumed", "revoked", "not_clean"][statusClean] },
      consume_flagged: { lot_id: demo.consume_flagged, ref: label(demo.consume_flagged) },
    },
    roles: Object.fromEntries(Object.entries(wallets).map(([k, w]) => [k, w.address])),
  };

  const outPath = path.resolve(opts.out ?? path.join(ROOT, "out/onchain.json"));
  const json = JSON.stringify(onchain, null, 2) + "\n";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json);
  // Per-network copy, so a later local run never loses the public-testnet record.
  fs.writeFileSync(path.join(path.dirname(outPath), `onchain.${net.name}.json`), json);
  console.log(`  wrote    ${outPath} (${records.length} records)`);

  if (opts.web) {
    const webDir = path.resolve(opts.webDir ?? path.join(ROOT, "../web/public/data"));
    const webFile = path.join(webDir, "onchain.json");
    let published = null;
    try {
      published = JSON.parse(fs.readFileSync(webFile, "utf8")).network;
    } catch {
      // no published file yet
    }
    if (local && published && published !== "anvil" && !opts.forceWeb) {
      console.log(`  kept     ${webFile}: it describes ${published}; pass --force-web to replace it`);
    } else {
      fs.mkdirSync(webDir, { recursive: true });
      fs.writeFileSync(webFile, json);
      fs.writeFileSync(path.join(webDir, "HerdLedger.abi.json"), JSON.stringify(artifact.abi, null, 2) + "\n");
      console.log(`  copied   onchain.json + HerdLedger.abi.json -> ${webDir}`);
    }
  }
  if (demoFailures) {
    console.error(`${demoFailures} demo attempt(s) did not revert as expected`);
    process.exitCode = 2;
  }
}

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------

/**
 * Polls eth_getTransactionReceipt directly. ethers' `wait()` counts confirmations against a briefly
 * cached block number, which on an instant-mining node with no further blocks can wait forever.
 */
async function waitReceipt(provider, hash, local) {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const r = await provider.send("eth_getTransactionReceipt", [hash]);
    if (r) {
      return { hash, status: Number(r.status), gasUsed: BigInt(r.gasUsed), blockNumber: Number(r.blockNumber) };
    }
    if (Date.now() > deadline) throw new Error(`no receipt for ${hash} after 10 minutes`);
    await new Promise((res) => setTimeout(res, local ? 20 : 1500));
  }
}

function resolveDeployment(address, chainId) {
  const file = path.join(ROOT, "broadcast/Deploy.s.sol", String(chainId), "run-latest.json");
  let fromBroadcast = null;
  if (fs.existsSync(file)) {
    const b = JSON.parse(fs.readFileSync(file, "utf8"));
    const create = b.transactions.find((t) => t.transactionType === "CREATE" && t.contractName === "HerdLedger");
    if (create) {
      const rcpt = (b.receipts ?? []).find((r) => r.transactionHash === create.hash);
      fromBroadcast = {
        address: ethers.getAddress(create.contractAddress),
        deployTx: create.hash,
        deployBlock: rcpt ? Number(rcpt.blockNumber) : null,
      };
    }
  }
  if (address) {
    const a = ethers.getAddress(address);
    const same = fromBroadcast && fromBroadcast.address === a;
    return { address: a, deployTx: same ? fromBroadcast.deployTx : null, deployBlock: same ? fromBroadcast.deployBlock : null };
  }
  if (!fromBroadcast) {
    throw new Error(`no HerdLedger address: pass --address or run script/Deploy.s.sol first (looked in ${file})`);
  }
  return fromBroadcast;
}

function makeWallets(provider, local) {
  const env = process.env;
  const base = env.PRIVATE_KEY;
  const pick = (name, anvilIndex) => {
    const k = env[`${name}_PRIVATE_KEY`] ?? (local ? ANVIL_KEYS[anvilIndex] : base);
    if (!k) throw new Error(`set PRIVATE_KEY (or ${name}_PRIVATE_KEY) for this network`);
    return new ethers.Wallet(k, provider);
  };
  const w = {
    registrar: pick("REGISTRAR", 1),
    regulator: pick("REGULATOR", 2),
    buyer: pick("BUYER", 3),
    relayer: pick("RELAYER", 4),
    oracle: pick("ORACLE", 5),
  };
  w.issuer = env.ISSUER_PRIVATE_KEY ? pick("ISSUER", 1) : w.registrar;
  // One wallet object per distinct key (txs are sent sequentially, so nonces never race).
  const byAddr = new Map();
  for (const k of Object.keys(w)) {
    const a = w[k].address;
    if (byAddr.has(a)) w[k] = byAddr.get(a);
    else byAddr.set(a, w[k]);
  }
  return w;
}

async function checkRoles(ledger, w) {
  const need = [
    ["REGISTRAR_ROLE", "registrar"],
    ["ISSUER_ROLE", "issuer"],
    ["REGULATOR_ROLE", "regulator"],
    ["BUYER_ROLE", "buyer"],
    ["ORACLE_ROLE", "oracle"],
  ];
  for (const [role, who] of need) {
    const id = await ledger[role]();
    if (!(await ledger.hasRole(id, w[who].address))) {
      throw new Error(`${who} ${w[who].address} lacks ${role}; deploy with matching *_ADDRESS env vars`);
    }
  }
}

async function feeOverrides(provider, chainId) {
  // Polygon PoS / Amoy reject tips below ~25 gwei; ethers' 1 gwei default would be "underpriced".
  if (chainId !== 80002 && chainId !== 137) return {};
  const minTip = ethers.parseUnits(process.env.MIN_PRIORITY_FEE_GWEI ?? "30", "gwei");
  const fd = await provider.getFeeData();
  const tip = fd.maxPriorityFeePerGas && fd.maxPriorityFeePerGas > minTip ? fd.maxPriorityFeePerGas : minTip;
  const block = await provider.getBlock("latest");
  const base = block?.baseFeePerGas ?? 0n;
  return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip };
}

main().catch((err) => {
  console.error(`\nreplay failed: ${err.message}`);
  process.exit(1);
});
