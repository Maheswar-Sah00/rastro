// Evidence verification: SHA-256 of the exact bytes of the evidence bundle,
// compared with the hash anchored on-chain (or published in the data file).

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    if (globalThis.crypto?.subtle) {
      const d = await globalThis.crypto.subtle.digest('SHA-256', buf as unknown as ArrayBuffer);
      return '0x' + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* fall through to JS implementation (insecure context) */
  }
  const { sha256 } = await import('viem');
  return sha256(buf);
}

export interface Tamper { text: string; key: string; before: string; after: string }

const PREFERRED = ['flagged_pct', 'births_declared', 'head_now', 'head', 'head_equiv', 'score'];

/** Change one number in the raw JSON text (the bytes, not a re-serialisation). */
export function tamperText(text: string): Tamper | null {
  const re = /"([A-Za-z_][\w]*)"\s*:\s*(-?\d+(?:\.\d+)?)/g;
  const hits: { key: string; value: string; index: number; len: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) hits.push({ key: m[1], value: m[2], index: m.index + m[0].length - m[2].length, len: m[2].length });
  if (!hits.length) return null;
  const pick = PREFERRED.map((k) => hits.find((h) => h.key === k)).find(Boolean) ?? hits[0];
  const n = Number(pick.value);
  const dec = pick.value.includes('.') ? pick.value.split('.')[1].length : 0;
  const changed = n >= 1 ? n - 1 : n > 0 ? n / 2 : 1;
  const after = changed.toFixed(dec);
  return { text: text.slice(0, pick.index) + after + text.slice(pick.index + pick.len), key: pick.key, before: pick.value, after };
}
