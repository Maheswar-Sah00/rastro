// End-to-end browser test of the analyst console against a running API (headless Chrome over CDP).
//
//   (cd backend && .venv/Scripts/python -m uvicorn app.main:app --port 8000)
//   npm run build && npx vite preview --port 4173 --strictPort
//   npm run e2e                     # CONSOLE_URL / API_URL / CHROME override the defaults
//
// Every assertion compares what the page shows with what the API itself returns.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const CONSOLE = process.env.CONSOLE_URL || 'http://localhost:4173/console.html';
const API = (process.env.API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => fs.existsSync(p));
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, init) => {
  const r = await fetch(API + p, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};

async function browser() {
  if (!CHROME) throw new Error('no Chrome/Edge found; set CHROME');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rastro-e2e-'));
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9333', `--user-data-dir=${dir}`,
    '--window-size=1366,900', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      const tabs = await (await fetch('http://127.0.0.1:9333/json')).json();
      const page = tabs.find((t) => t.type === 'page');
      if (page) return { proc, url: page.webSocketDebuggerUrl, dir };
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome did not open its debugging port');
}

function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return new Promise((res) => ws.on('open', () => res({ send, errors, close: () => ws.close() })));
}

async function evaluate(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
}

async function waitFor(c, expr, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evaluate(c, expr)) return true;
    await sleep(250);
  }
  return false;
}

const text = (c) => evaluate(c, 'document.body.innerText');
const go = async (c, hash) => { await evaluate(c, `location.hash = ${JSON.stringify(hash)}`); await sleep(400); };
const clickText = (c, label) => evaluate(c, `(() => { const b = [...document.querySelectorAll('button, a')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, detail: String(e.message || e) });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const health = await api('/api/v1/ready');
  assert(health.status === 200, `API not ready at ${API}`);
  const { proc, url, dir } = await browser();
  const c = await cdp(url);
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Page.navigate', { url: CONSOLE });
  try {
    await check('console loads and shows the environment banner', async () => {
      assert(await waitFor(c, `document.body.innerText.includes('Overview')`), 'overview did not render');
      const chain = (await api('/api/v1/chain/status')).body.data.chain;
      const expected = chain.verified_public ? 'Public test blockchain' : chain.mode === 'rpc' ? 'Test blockchain (this computer)' : 'Test blockchain (replayed)';
      assert(await waitFor(c, `document.body.innerText.includes(${JSON.stringify(expected)})`), `banner should read "${expected}"`);
      const t = await text(c);
      assert(chain.verified_public || !t.includes('Public testnet'), 'claims a public testnet for local data');
      return expected;
    });

    await check('overview KPIs equal the API summary', async () => {
      const s = (await api('/api/v1/summary')).body.data;
      const n = s.counts.ranches;
      const t = await text(c);
      assert(t.includes(n.toLocaleString('en-US')) || t.includes(String(n)), `ranch count ${n} not shown`);
      return `${n} ranches`;
    });

    const sid = 'SHP-D-001677';
    await check(`investigation ${sid}: decision and declared head match the API`, async () => {
      const risk = (await api(`/api/v1/shipments/${sid}/risk`)).body.data;
      const ship = (await api(`/api/v1/shipments/${sid}`)).body.data;
      await go(c, `#/shipments/${sid}`);
      const outcome = risk.decision?.outcome || risk.outcome;
      assert(await waitFor(c, `document.body.innerText.includes(${JSON.stringify(outcome)})`), `decision ${outcome} not shown`);
      const head = ship.shipment?.declared_head_count ?? ship.declared_head_count;
      assert((await text(c)).includes(String(head)), `declared head ${head} not shown`);
      return `${outcome}, ${head} head`;
    });

    await check(`investigation ${sid}: graph source totals equal the declared head`, async () => {
      const g = (await api(`/api/v1/shipments/${sid}/lineage/graph`)).body.data;
      // every head enters the graph at a source or an explicit unknown-origin node, exactly once
      const sum = g.nodes.filter((n) => (n.roles || []).includes('source') || n.kind === 'unknown_origin').reduce((a, n) => a + n.head_fifo, 0);
      assert(Math.abs(sum - g.declared_head) < 0.01, `graph source + unknown head ${sum} != declared ${g.declared_head}`);
      assert(await waitFor(c, `!!document.querySelector('svg')`), 'lineage graph did not render');
      return `sources ${sum.toFixed(1)} head`;
    });

    await check('global search routes a GTA id to its page', async () => {
      const gta = (await api('/api/v1/gtas?limit=1')).body.data[0].movement.gta_id;
      const ok = await evaluate(c, `(() => { const i = document.querySelector('input[type=search], header input'); if (!i) return false;
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(gta)});
        i.dispatchEvent(new Event('input', { bubbles: true })); i.form ? i.form.requestSubmit() : i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
      assert(ok, 'search box not found');
      assert(await waitFor(c, `location.hash.includes(${JSON.stringify(gta)})`), 'search did not navigate');
      return gta;
    });

    const issued = (await api('/api/v1/certificates?event=issue')).body?.data || [];
    const lot = issued.find((e) => e.receipt_status === 1)?.lot_id;
    await check('certificate verify in the UI agrees with the API', async () => {
      assert(lot, 'no issued certificate (run: python -m rastro.certificates.issue demo ../data/synthetic/evaluation)');
      const v = (await api(`/api/v1/certificates/${lot}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).body.data;
      await go(c, `#/certificates/${lot}`);
      assert(await waitFor(c, `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Verify this certificate'))`), 'verify button missing');
      await clickText(c, 'Verify this certificate');
      await sleep(300);
      await clickText(c, 'Verify');
      // The UI shows the outcome as a plain word (CERT_STATUS in pages/Other.tsx).
      const shown = { valid: 'Valid', consumed: 'Already used', revoked: 'Cancelled', not_on_ledger: 'Not on the ledger', unknown: 'Unknown' }[v.outcome] || v.outcome.replace(/_/g, ' ').replace(/\b[a-z]/g, (m) => m.toUpperCase());
      assert(await waitFor(c, `document.body.innerText.includes(${JSON.stringify(shown)})`, 30000), `UI does not show outcome ${shown}`);
      return `outcome ${v.outcome}`;
    });

    await check('certificate report link serves the HTML report', async () => {
      assert(lot, 'no issued certificate');
      const r = await fetch(`${API}/api/v1/certificates/${lot}/report?format=html`);
      const h = await r.text();
      assert(r.status === 200 && h.includes('Rastro certificate report'), 'report not served');
      assert(await waitFor(c, `[...document.querySelectorAll('a')].some((a) => a.textContent.includes('View report'))`), 'report link missing');
      return 'report ok';
    });

    await check('evaluation page shows the red-team artifacts', async () => {
      const e = (await api('/api/v1/evaluation/summary')).body.data;
      await go(c, '#/evaluation');
      const n = e.redteam?.headline?.filter((h) => h.role === 'heldout').length;  // the page lists held-out scenarios only
      assert(n, 'no red-team summary from the API');
      const heading = `Across ${n} test scenarios`;
      if (!(await waitFor(c, `document.body.innerText.includes(${JSON.stringify(heading)})`))) {
        throw new Error(`"${heading}" not shown; page reads: ${(await text(c)).slice(-500).replace(/\s+/g, ' ')}`);
      }
      return `${e.redteam.headline.length} scenarios`;
    });

    await check('no uncaught page errors', async () => {
      assert(c.errors.length === 0, c.errors.join('; '));
      return 'none';
    });
  } finally {
    c.close();
    proc.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* chrome may hold files briefly */ }
  }
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
