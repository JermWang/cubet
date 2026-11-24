/* CubetData: the browser side of the live data API (see market.mjs).
   Every call goes to our own server, which verifies tokens on-chain and caches market data.
   Calls are cached briefly and de-duplicated, so components can ask freely. */
(() => {
'use strict';

const memo = new Map();
function cachedFetch(url, ttl) {
  const hit = memo.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = fetch(url, { headers: { accept: 'application/json' } }).then(async res => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.message || `Request failed (${res.status})`);
      err.code = body.error || 'error';
      err.status = res.status;
      throw err;
    }
    return body;
  });
  promise.catch(() => memo.delete(url));
  memo.set(url, { at: Date.now(), promise });
  return promise;
}

// The shared bet book: always fresh, never cached.
async function call(url, body) {
  const res = await fetch(url, body === undefined
    ? { headers: { accept: 'application/json' }, credentials: 'same-origin' }
    : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Request failed (${res.status})`);
    err.code = data.error || 'error';
    err.status = res.status;
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;
const fmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

window.CubetData = {
  /** One token, verified on-chain: { ca, symbol, name, image, cap, change, onchain:{…}, tradable, url, … } */
  token: mint => cachedFetch(`/api/token/${enc(mint)}`, 15e3),
  /** Live market data for many mints: { [mint]: token } */
  tokens: async mints => {
    const list = [...new Set(mints)].filter(Boolean).sort();
    if (!list.length) return {};
    return (await cachedFetch(`/api/tokens?mints=${list.map(enc).join(',')}`, 15e3)).tokens;
  },
  /** Trending Solana tokens right now. */
  trending: async () => (await cachedFetch('/api/trending', 30e3)).tokens,
  /** Market-cap history: { points: [[unixSeconds, cap], …] } for tf = 1h | 1d | 1w | 1m */
  chart: (mint, tf = '1d') => cachedFetch(`/api/chart/${enc(mint)}?tf=${enc(tf)}`, 30e3),
  /** Market cap at a past moment (used to settle bets at their exact expiry). */
  capAt: (mint, unix) => cachedFetch(`/api/cap-at/${enc(mint)}?t=${Math.floor(unix)}`, 60e3),

  /* Shared bet book (book.mjs on the server). Every player is a signed-in Solana wallet. */
  /** The signed-in player, or null: { id, wallet, handle, balance } */
  session: async () => (await call('/api/me')).player,
  book: () => call('/api/book'),
  leaderboard: async () => (await call('/api/leaderboard')).players,
  settlements: async (limit = 25) => (await call(`/api/settlements?limit=${limit}`)).bets,
  stats: () => call('/api/stats'),
  /** Payments: treasury config, the player's transfers, deposits and withdrawals (payments.mjs). */
  payConfig: () => call('/api/pay/config'),
  payStatus: () => call('/api/pay/status'),
  transfers: (limit = 25) => call(`/api/pay/transfers?limit=${limit}`),
  myTransfers: () => call('/api/pay/mine'),
  reportDeposit: signature => call('/api/pay/deposit', { signature }),
  withdraw: amount => call('/api/pay/withdraw', { amount }),
  createBet: bet => call('/api/bets', bet),
  takeBet: id => call(`/api/bets/${enc(id)}/take`, {}),
  cancelBet: id => call(`/api/bets/${enc(id)}/cancel`, {}),

  money: n => (Number.isFinite(n) ? '$' + fmt.format(n) : '—'),
  pct: n => (Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(Math.abs(n) < 10 ? 1 : 0)}%` : ''),
  explorer: mint => `https://solscan.io/token/${enc(mint)}`,
  account: (address, cluster = 'mainnet-beta') => `https://solscan.io/account/${enc(address)}${cluster === 'mainnet-beta' ? '' : `?cluster=${enc(cluster)}`}`,
  dexscreener: mint => `https://dexscreener.com/solana/${enc(mint)}`,
};
})();
