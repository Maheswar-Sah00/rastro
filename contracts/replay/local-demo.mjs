#!/usr/bin/env node
// One-command local demo: start anvil, deploy HerdLedger with forge, replay the seed, stop anvil.
//
//   node replay/local-demo.mjs [seed.json] [--keep] [--port 8545] [any replay.mjs option]
//
// --keep leaves anvil running afterwards so the web app (or cast) can query it.
// If something already listens on the port, it is reused instead of starting a new anvil.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXE = process.platform === "win32" ? ".exe" : "";

function tool(name) {
  const env = process.env[`${name.toUpperCase()}_BIN`];
  if (env) return env;
  const local = path.join(ROOT, ".tools/bin", name + EXE);
  return fs.existsSync(local) ? local : name;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" }, () => {
      s.end();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

async function waitForPort(port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await portOpen(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`anvil did not open port ${port}`);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args[0]} failed (exit ${r.status})`);
}

async function main() {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep");
  const portIdx = argv.indexOf("--port");
  const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : 8545;
  const passthrough = argv.filter((a, i) => a !== "--keep" && i !== portIdx && i !== portIdx + 1);
  const rpc = `http://127.0.0.1:${port}`;

  let anvil = null;
  if (await portOpen(port)) {
    console.log(`reusing the node already listening on ${rpc}`);
  } else {
    // A high block gas limit lets the replay batch hundreds of GTAs per transaction.
    anvil = spawn(tool("anvil"), ["--port", String(port), "--gas-limit", "300000000", "--silent"], {
      cwd: ROOT,
      stdio: "ignore",
    });
    anvil.on("exit", (code) => code && console.error(`anvil exited with ${code}`));
    await waitForPort(port, 30_000);
    console.log(`anvil started on ${rpc}`);
  }

  try {
    run(tool("forge"), ["build"]);
    run(tool("forge"), ["script", "script/Deploy.s.sol", "--rpc-url", rpc, "--broadcast", "--slow"]);
    run(process.execPath, [path.join(ROOT, "replay/replay.mjs"), "--rpc", rpc, ...passthrough]);
  } finally {
    if (anvil && !keep) anvil.kill();
    if (anvil && keep) {
      console.log(`anvil left running on ${rpc} (pid ${anvil.pid})`);
      anvil.unref();
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
