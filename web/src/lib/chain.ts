// Revert demos: replay the recorded results from onchain.json, or, when the file
// has a public `rpc` and the record carries raw `call` data, run a live eth_call.

import type { ChainRecord, OnChain } from './types';
import { loadAbi } from './data';

export interface DemoDef { key: string; error: string; ref?: string; title: string; verb: string; fn: string; explain: string }

export const DEMOS: DemoDef[] = [
  {
    key: 'double', error: 'CertificateAlreadyUsed', title: 'Use the same certificate twice', verb: 'Consume a lot certificate that was already used',
    fn: 'consumeCertificate(lotId, use = export, refHash)',
    explain: 'Each lot certificate can back exactly one export shipment or one EU due-diligence statement. A second claim on the same animals is refused, for every buyer, forever.',
  },
  {
    key: 'flagged', error: 'CertificateNotClean', title: 'Sell a flagged lot as clean', verb: 'Consume a certificate whose verdict is "flagged"',
    fn: 'consumeCertificate(lotId, use = export, refHash)',
    explain: 'The oracle signed this certificate with verdict "flagged" because its cattle trace back to tainted ranches. No buyer can redeem it as a clean lot, whatever their own paperwork says.',
  },
  {
    key: 'embargo', error: 'OriginEmbargoed', title: 'Ship cattle from an embargoed ranch', verb: 'Record a movement permit out of an embargoed ranch',
    fn: 'recordMovement(gtaHash, from, to, head, purpose, date)',
    explain: 'Once the regulator sets an embargo, the ledger refuses any new movement out of that ranch, so its animals cannot enter the chain on paper and be "washed" later.',
  },
  {
    key: 'births', error: 'BirthsExceedBiology', ref: 'PHANTOM_BIRTHS', title: 'Invent calves on paper', verb: 'Declare 500 births for an intermediary with 40 breeding cows',
    fn: 'recordBirths(ranch, head = 500, year)',
    explain: 'Births are capped by biology: at most 0.85 calves per breeding cow per year. Declaring more is the classic way to give smuggled animals a clean birth record. The ledger rejects it outright.',
  },
];

export function findDemo(records: ChainRecord[] | undefined, d: DemoDef): ChainRecord | null {
  if (!records) return null;
  return (
    records.find((r) => r.kind === 'revertDemo' && !!r.revert_reason && r.revert_reason.startsWith(d.error)) ??
    records.find((r) => r.kind === 'revertDemo' && !!d.ref && r.ref === d.ref) ??
    null
  );
}

export function parseReason(reason?: string | null): { name: string | null; args: string[] } {
  if (!reason) return { name: null, args: [] };
  const m = /^([A-Za-z_]\w*)\s*\((.*)\)\s*$/.exec(reason.trim());
  if (!m) return { name: reason, args: [] };
  return { name: m[1], args: m[2] ? m[2].split(',').map((s) => s.trim()).filter(Boolean) : [] };
}

export interface DemoResult {
  mode: 'live' | 'recorded' | 'missing';
  reverted: boolean;
  name: string | null;
  args: string[];
  block?: number | null;
  detail?: string;
}

export const hasRpc = (oc: OnChain | null) => !!oc?.rpc && /^https?:\/\//.test(oc.rpc);
export const isLocalRpc = (oc: OnChain | null) => !!oc?.rpc && /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)/.test(oc.rpc);

/** Raw call for a demo: from the record, or rebuilt from the ABI and the role addresses. */
async function buildCall(oc: OnChain, rec: ChainRecord, d: DemoDef, extra: { gtaTo?: string | null; gtaHead?: number | null }): Promise<{ from?: string; to?: string; data: string } | null> {
  if (rec.call?.data) return rec.call;
  const roles = oc.roles ?? {};
  const { name, args } = parseReason(rec.revert_reason);
  const abi = await loadAbi(oc.abi_path);
  if (!abi || !name) return null;
  const v = await import('viem');
  const salt = v.keccak256(v.toHex(`rastro-web-demo-${Date.now()}`));
  const enc = v.encodeFunctionData as unknown as (o: { abi: unknown; functionName: string; args: unknown[] }) => string;
  try {
    if (d.error === 'CertificateAlreadyUsed' || d.error === 'CertificateNotClean') {
      if (!args[0] || !roles.buyer) return null;
      return { from: roles.buyer, data: enc({ abi, functionName: 'consumeCertificate', args: [args[0], 0, salt] }) };
    }
    if (d.error === 'BirthsExceedBiology') {
      if (!args[0] || !(roles.registrar ?? roles.issuer)) return null;
      return { from: roles.registrar ?? roles.issuer, data: enc({ abi, functionName: 'recordBirths', args: [args[0], 500, Number(args[1] ?? 2025)] }) };
    }
    if (d.error === 'OriginEmbargoed') {
      if (!args[0] || !extra.gtaTo || !(roles.issuer ?? roles.registrar)) return null;
      const date = BigInt(Math.floor(Date.now() / 1000));
      return { from: roles.issuer ?? roles.registrar, data: enc({ abi, functionName: 'recordMovement', args: [salt, args[0], extra.gtaTo, extra.gtaHead ?? 5, 1, date] }) };
    }
  } catch {
    return null;
  }
  return null;
}

export async function runDemo(
  oc: OnChain | null,
  rec: ChainRecord | null,
  d: DemoDef,
  opts: { live: boolean; gtaTo?: string | null; gtaHead?: number | null } = { live: false },
): Promise<DemoResult> {
  if (!rec) return { mode: 'missing', reverted: false, name: null, args: [] };
  const recorded = (detail?: string): DemoResult => {
    const p = parseReason(rec.revert_reason);
    return { mode: 'recorded', reverted: rec.status === 'reverted', name: p.name, args: p.args, block: rec.block ?? null, detail };
  };
  if (!oc || !opts.live || !hasRpc(oc)) return recorded();
  const call = await buildCall(oc, rec, d, opts);
  if (!call) return recorded('Could not rebuild the call for a live run.');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(oc.rpc!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ from: call.from, to: call.to ?? oc.address, data: call.data }, 'latest'],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const j = (await res.json()) as { result?: string; error?: { message?: string; data?: unknown } };
    if (j.error) {
      const raw = typeof j.error.data === 'string' ? j.error.data : (j.error.data as { data?: string } | undefined)?.data;
      if (raw && /^0x[0-9a-fA-F]{8}/.test(raw)) {
        const abi = await loadAbi(oc.abi_path);
        if (abi) {
          try {
            const { decodeErrorResult } = await import('viem');
            const d = decodeErrorResult({ abi: abi as never, data: raw as `0x${string}` });
            return { mode: 'live', reverted: true, name: d.errorName, args: ((d.args ?? []) as unknown[]).map((a) => String(a)) };
          } catch {
            /* unknown selector */
          }
        }
        return { mode: 'live', reverted: true, name: `custom error ${raw.slice(0, 10)}`, args: [] };
      }
      return { mode: 'live', reverted: true, name: j.error.message ?? 'reverted', args: [] };
    }
    return { mode: 'live', reverted: false, name: null, args: [], detail: 'The call did not revert on the live network.' };
  } catch {
    return recorded('Live RPC unreachable, showing the recorded result.');
  }
}
