/* cubet wallet: connects Phantom, Solflare, Backpack and any other Wallet Standard wallet, with no SDK.
   - signIn(name)       connect, sign a one-time message, and open a cubet session for that wallet
   - deposit(lamports)  build a SOL transfer to cubet's treasury, have the wallet sign and send it
   The server verifies the signature and the on-chain transfer itself; nothing here is trusted. */
(() => {
'use strict';

/* ---------- base58 / base64 ---------- */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}
function b58decode(str) {
  let n = 0n;
  for (const c of str) { const v = B58.indexOf(c); if (v < 0) throw new Error('Invalid address'); n = n * 58n + BigInt(v); }
  const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of str) { if (c !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
}
const b64 = bytes => btoa(String.fromCharCode(...bytes));

/* ---------- a SOL transfer, serialized by hand (legacy transaction, one signer) ---------- */
const SYSTEM = '11111111111111111111111111111111', BUDGET = 'ComputeBudget111111111111111111111111111111';
const shortvec = n => { const o = []; for (;;) { let b = n & 0x7f; n >>= 7; if (n) o.push(b | 0x80); else { o.push(b); return o; } } };
const le = (n, size) => { const v = new DataView(new ArrayBuffer(size)); size === 4 ? v.setUint32(0, n, true) : v.setBigUint64(0, BigInt(n), true); return [...new Uint8Array(v.buffer)]; };
function transferTx(from, to, lamports, blockhash) {
  const keys = [from, to, SYSTEM, BUDGET].map(b58decode);
  const ix = [[3, [], [2, ...le(2000, 4)]], [3, [], [3, ...le(100000, 8)]], [2, [0, 1], [...le(2, 4), ...le(lamports, 8)]]];
  const msg = [1, 0, 2, ...shortvec(keys.length), ...keys.flatMap(k => [...k]), ...b58decode(blockhash), ...shortvec(ix.length)];
  for (const [p, a, d] of ix) msg.push(p, ...shortvec(a.length), ...a, ...shortvec(d.length), ...d);
  return Uint8Array.from([1, ...new Uint8Array(64), ...msg]);       // one empty signature slot, then the message
}

/* ---------- Wallet Standard discovery ---------- */
const wallets = new Map(), listeners = new Set();
const isSolana = w => w?.chains?.some(c => String(c).startsWith('solana:')) && w.features?.['standard:connect'] && w.features?.['solana:signMessage'];
const api = Object.freeze({ register(...ws) { ws.forEach(w => { if (isSolana(w)) wallets.set(w.name, w); }); listeners.forEach(f => f()); return () => {}; } });
window.addEventListener('wallet-standard:register-wallet', e => { try { e.detail(api); } catch { /* a broken wallet doesn't stop the rest */ } });
try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api })); } catch { /* old browser */ }

let current = null;                                               // { wallet, account }
const chainFor = cluster => cluster === 'mainnet-beta' ? 'solana:mainnet' : `solana:${cluster}`;

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.message || `Request failed (${res.status})`); err.code = data.error; throw err; }
  return data;
}
async function get(url) {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.message || `Request failed (${res.status})`); err.code = data.error; throw err; }
  return data;
}
// Wallets reject with all sorts of shapes; turn "user said no" into one clear message.
function walletError(err) {
  const m = String(err?.message || err || '');
  if (/reject|denied|cancel|declin|closed/i.test(m) || err?.code === 4001) return new Error('You cancelled in your wallet.');
  return new Error(m || 'Your wallet returned an error.');
}

async function connect(name, { silent = false } = {}) {
  const wallet = wallets.get(name);
  if (!wallet) throw new Error(`${name} is not available in this browser.`);
  let accounts;
  try { ({ accounts } = await wallet.features['standard:connect'].connect(silent ? { silent: true } : undefined)); }
  catch (err) { throw walletError(err); }
  const account = (accounts?.length ? accounts : wallet.accounts)?.[0];
  if (!account) throw new Error('Your wallet did not share an account.');
  current = { wallet, account };
  return account.address;
}

/** Connect `name`, sign cubet's one-time sign-in message, and open a session. Returns the player. */
async function signIn(name) {
  const address = await connect(name);
  const { nonce, message } = await post('/api/auth/nonce', { wallet: address });
  let out;
  try { [out] = await current.wallet.features['solana:signMessage'].signMessage({ account: current.account, message: new TextEncoder().encode(message) }); }
  catch (err) { throw walletError(err); }
  const { player } = await post('/api/auth/verify', { wallet: address, nonce, signature: b58encode(out.signature) });
  try { localStorage.setItem('cubet-wallet', name); } catch { /* fine */ }
  return player;
}

/** Make sure the wallet that's signed in to cubet is the one connected right now. */
async function ensure(address) {
  if (current?.account?.address === address) return current;
  const preferred = (() => { try { return localStorage.getItem('cubet-wallet'); } catch { return null; } })();
  const order = [...wallets.keys()].sort((a, b) => (b === preferred) - (a === preferred));
  for (const name of order) {
    const w = wallets.get(name), acc = w.accounts?.find(a => a.address === address);
    if (acc) { current = { wallet: w, account: acc }; return current; }
  }
  for (const name of order) {
    try { if (await connect(name, { silent: true }) === address) return current; } catch { /* try the next */ }
  }
  if (preferred && wallets.has(preferred)) { if (await connect(preferred) === address) return current; }
  throw new Error(`Open your wallet and switch to ${address.slice(0, 4)}…${address.slice(-4)}, the account you signed in with.`);
}

/** Send `lamports` from the signed-in wallet to the treasury. Returns the transaction signature. */
async function deposit({ address, treasury, lamports, cluster, onStage = () => {} }) {
  const { wallet, account } = await ensure(address);
  const { blockhash } = await get('/api/pay/blockhash');
  const transaction = transferTx(address, treasury, lamports, blockhash);
  const chain = chainFor(cluster), f = wallet.features;
  onStage('approve');
  try {
    if (f['solana:signAndSendTransaction']) {
      const [out] = await f['solana:signAndSendTransaction'].signAndSendTransaction({ account, chain, transaction });
      return b58encode(out.signature);
    }
    if (f['solana:signTransaction']) {
      const [out] = await f['solana:signTransaction'].signTransaction({ account, chain, transaction });
      onStage('relay');
      return (await post('/api/pay/relay', { tx: b64(out.signedTransaction) })).signature;
    }
  } catch (err) { throw walletError(err); }
  throw new Error(`${wallet.name} can't send transactions from this site.`);
}

async function disconnect() {
  try { await current?.wallet.features['standard:disconnect']?.disconnect(); } catch { /* fine */ }
  current = null;
  try { localStorage.removeItem('cubet-wallet'); } catch { /* fine */ }
  await post('/api/auth/logout', {});
}

// Open this page inside a mobile wallet's built-in browser (where the wallet can connect).
const here = () => encodeURIComponent(location.href), origin = () => encodeURIComponent(location.origin);
const mobileLinks = () => [
  { name: 'Phantom', url: `https://phantom.app/ul/browse/${here()}?ref=${origin()}` },
  { name: 'Solflare', url: `https://solflare.com/ul/v1/browse/${here()}?ref=${origin()}` },
  { name: 'Backpack', url: `https://backpack.app/ul/v1/browse/${here()}?ref=${origin()}` },
];

window.CubetWallet = {
  list: () => [...wallets.values()].map(w => ({ name: w.name, icon: w.icon })),
  onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  signIn, deposit, disconnect, mobileLinks, transferTx,
  isMobile: () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent),
};
})();
