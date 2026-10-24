// Trusted certificate signer and submitter for HerdLedger (the only place an oracle key is used).
//
//   node replay/certify.mjs issue   --request req.json            sign (EIP-712) + issueCertificate, wait for the receipt
//   node replay/certify.mjs resubmit --signed signed.json         replay an already-signed certificate (must revert)
//   node replay/certify.mjs consume --lot 0x.. --shipment 0x.. [--use 0]
//   node replay/certify.mjs status  --lot 0x..
//   common: [--rpc URL] [--address 0x..] [--env-file .env.testnet]
//
// Keys: ORACLE_PRIVATE_KEY, RELAYER_PRIVATE_KEY, BUYER_PRIVATE_KEY (or PRIVATE_KEY). On a local anvil
// chain (id 31337) only, the well-known anvil development keys are used when none are set. Keys are
// never printed. Every call is simulated with eth_call first, so a revert is reported with its
// decoded error and no failing transaction is mined. Output: one JSON object on stdout; nothing is
// reported as successful without a mined receipt with status 1.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = path.resolve(ROOT, "out/forge/HerdLedger.sol/HerdLedger.json");
const WEB_ABI = path.resolve(ROOT, "../web/public/data/HerdLedger.abi.json");
const ANVIL_KEYS = { oracle: 5, relayer: 4, buyer: 3 };
const ANVIL_PK = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
];
export const CERT_TYPES = {
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

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}

function loadEnv(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

function deployment(chainId, explicit) {
  if (explicit) return ethers.getAddress(explicit);
  const f = path.join(ROOT, "broadcast/Deploy.s.sol", String(chainId), "run-latest.json");
  if (!fs.existsSync(f)) throw new Error(`no deployment for chain ${chainId}; pass --address`);
  const b = JSON.parse(fs.readFileSync(f, "utf8"));
  return ethers.getAddress(b.transactions.find((t) => t.transactionType === "CREATE" && t.contractName === "HerdLedger").contractAddress);
}

function wallet(role, provider, local) {
  const k = process.env[`${role.toUpperCase()}_PRIVATE_KEY`] ?? process.env.PRIVATE_KEY ?? (local ? ANVIL_PK[ANVIL_KEYS[role]] : null);
  if (!k) throw new Error(`set ${role.toUpperCase()}_PRIVATE_KEY for this network`);
  return new ethers.Wallet(k, provider);
}

const big = (_, v) => (typeof v === "bigint" ? v.toString() : v);
const out = (o) => process.stdout.write(JSON.stringify(o, big) + "\n");

async function send(ctx, signer, fn, params) {
  const data = ctx.iface.encodeFunctionData(fn, params);
  try {
    await ctx.provider.call({ to: ctx.address, from: signer.address, data });
  } catch (e) {
    const raw = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
    let err = null;
    try {
      const p = ctx.iface.parseError(typeof raw === "string" ? raw : raw?.data);
      err = { name: p.name, args: Object.fromEntries(p.fragment.inputs.map((inp, i) => [inp.name || `arg${i}`, p.args[i]])) };
    } catch {
      err = { name: "UnknownRevert", args: { message: String(e?.shortMessage ?? e?.message ?? e) } };
    }
    return { submitted: false, reverted: true, error: err, simulated_with: "eth_call" };
  }
  const tx = await signer.sendTransaction({ to: ctx.address, data });
  for (;;) {
    const r = await ctx.provider.send("eth_getTransactionReceipt", [tx.hash]);
    if (r) {
      return { submitted: true, reverted: Number(r.status) !== 1, tx_hash: tx.hash, block_number: Number(r.blockNumber),
               gas_used: BigInt(r.gasUsed).toString(), receipt_status: Number(r.status) };
    }
    await new Promise((res) => setTimeout(res, ctx.local ? 25 : 1500));
  }
}

async function status(ctx, lot) {
  const st = Number(await ctx.ledger.certificateStatus(lot));
  const names = ["none", "valid", "consumed", "revoked", "not_clean", "expired"];
  return names[st] ?? `status_${st}`;
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  loadEnv(a["env-file"]);
  const rpc = a.rpc ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1, staticNetwork: true });
  const chainId = Number((await provider.getNetwork()).chainId);
  const local = chainId === 31337;
  const address = deployment(chainId, a.address ?? process.env.HERDLEDGER_ADDRESS);
  const abi = fs.existsSync(ARTIFACT) ? JSON.parse(fs.readFileSync(ARTIFACT, "utf8")).abi : JSON.parse(fs.readFileSync(WEB_ABI, "utf8"));
  const iface = new ethers.Interface(abi);
  const ledger = new ethers.Contract(address, abi, provider);
  const ctx = { provider, iface, ledger, address, local };
  const domain = { name: "Rastro HerdLedger", version: "1", chainId, verifyingContract: address };
  const base = { chain_id: chainId, contract: address, network: local ? "anvil (local chain)" : `chain-${chainId}`, rpc };

  if (cmd === "status") return out({ ...base, lot_id: a.lot, status: await status(ctx, a.lot) });

  if (cmd === "issue" || cmd === "resubmit") {
    let cert, signature;
    const oracle = wallet("oracle", provider, local);
    if (cmd === "issue") {
      const req = JSON.parse(fs.readFileSync(a.request, "utf8"));
      const now = Number((await provider.getBlock("latest")).timestamp);
      cert = {
        lotId: req.lot_id, sink: req.sink, gtaHashes: req.gta_hashes, shipment: req.shipment, head: req.head,
        verdict: req.verdict, evidenceHash: req.evidence_hash, issuedAt: now,
        expiresAt: now + Math.round((req.expires_in_days ?? 365) * 86400), policyVersion: req.policy_version ?? 1,
        nonce: BigInt(ethers.hexlify(ethers.randomBytes(16))),
      };
      signature = await oracle.signTypedData(domain, CERT_TYPES, cert);
    } else {
      const s = JSON.parse(fs.readFileSync(a.signed, "utf8"));
      cert = { ...s.certificate, nonce: BigInt(s.certificate.nonce) };
      signature = s.signature;
    }
    const digest = ethers.TypedDataEncoder.hash(domain, CERT_TYPES, cert);
    const onchainDigest = await ledger.hashCertificate(cert);
    if (onchainDigest !== digest) throw new Error(`EIP-712 digest mismatch with the contract: ${digest} vs ${onchainDigest}`);
    const relayer = wallet("relayer", provider, local);
    const res = await send(ctx, relayer, "issueCertificate", [cert, signature]);
    return out({ ...base, command: cmd, domain, certificate: cert, signature, signer: ethers.verifyTypedData(domain, CERT_TYPES, cert, signature),
                 digest, relayer: relayer.address, ...res, status_after: await status(ctx, cert.lotId) });
  }

  if (cmd === "consume") {
    const buyer = wallet("buyer", provider, local);
    const res = await send(ctx, buyer, "consumeCertificate", [a.lot, Number(a.use ?? 0), a.shipment]);
    return out({ ...base, command: cmd, lot_id: a.lot, consuming_shipment: a.shipment, buyer: buyer.address, ...res,
                 status_after: await status(ctx, a.lot) });
  }
  throw new Error("usage: certify.mjs issue|resubmit|consume|status ...");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    out({ fatal: true, error: String(e?.shortMessage ?? e?.message ?? e) });
    process.exit(1);
  });
}
