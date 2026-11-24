// Minimal Solana primitives for cubet's payments, with no dependencies:
//   base58, ed25519 keys and signatures (node:crypto), legacy transfer transactions, and JSON-RPC.
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';

/* ---------- base58 ---------- */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = Object.fromEntries([...B58].map((c, i) => [c, i]));
export function b58encode(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}
export function b58decode(str) {
  let n = 0n;
  for (const c of String(str)) { const v = B58_MAP[c]; if (v === undefined) throw new Error('Invalid base58'); n = n * 58n + BigInt(v); }
  const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of String(str)) { if (c !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
}
export const isAddress = s => { try { return typeof s === 'string' && s.length >= 32 && s.length <= 44 && b58decode(s).length === 32; } catch { return false; } };

/* ---------- ed25519 ---------- */
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Verify a wallet's signature over a message (all raw bytes; address in base58). */
export function verifySignature(address, message, signature) {
  try {
    const pub = b58decode(address), sig = signature instanceof Uint8Array ? signature : b58decode(signature);
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI, pub]), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(message), key, Buffer.from(sig));
  } catch { return false; }
}

/** Load a keypair from a Phantom/Solflare base58 secret or a Solana CLI JSON array (64 bytes, or a 32-byte seed). */
export function loadKeypair(secret) {
  const s = String(secret || '').trim();
  if (!s) return null;
  const bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : b58decode(s);
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error('The secret key must be 64 bytes (or a 32-byte seed).');
  const seed = bytes.slice(0, 32);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  if (bytes.length === 64 && !Buffer.from(bytes.slice(32)).equals(pub)) throw new Error('The secret key does not match its public key.');
  return { publicKey: Uint8Array.from(pub), address: b58encode(pub), sign: msg => Uint8Array.from(edSign(null, Buffer.from(msg), privateKey)) };
}

/* ---------- transactions ---------- */
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
export const LAMPORTS = 1_000_000_000;

function shortvec(n) { const out = []; for (;;) { let b = n & 0x7f; n >>= 7; if (n) { out.push(b | 0x80); } else { out.push(b); return out; } } }
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return [...b]; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return [...b]; };

/**
 * A legacy transaction message that moves `lamports` from `from` to `to`, with a small priority fee.
 * Accounts: [from (signer, writable), to (writable), System Program, Compute Budget].
 */
export function transferMessage({ from, to, lamports, blockhash, cuPrice = 100_000, cuLimit = 2_000 }) {
  if (!(Number.isSafeInteger(lamports) && lamports > 0)) throw new Error('Bad lamports amount');
  const keys = [from, to, SYSTEM_PROGRAM, COMPUTE_BUDGET].map(b58decode);
  const ix = [
    [3, [], [2, ...u32(cuLimit)]],              // ComputeBudget: SetComputeUnitLimit
    [3, [], [3, ...u64(cuPrice)]],              // ComputeBudget: SetComputeUnitPrice (micro-lamports per CU)
    [2, [0, 1], [...u32(2), ...u64(lamports)]], // System: Transfer
  ];
  const bytes = [1, 0, 2, ...shortvec(keys.length), ...keys.flatMap(k => [...k]), ...b58decode(blockhash), ...shortvec(ix.length)];
  for (const [prog, accts, data] of ix) bytes.push(prog, ...shortvec(accts.length), ...accts, ...shortvec(data.length), ...data);
  return Uint8Array.from(bytes);
}
/** Wrap a message with its single signature into wire format. */
export const signedTransaction = (message, signature) => Uint8Array.from([...shortvec(1), ...signature, ...message]);

/* ---------- JSON-RPC ---------- */
export function rpcClient(url) {
  let id = 0;
  return async function rpc(method, params = []) {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message || JSON.stringify(body.error)}`);
    return body.result;
  };
}
