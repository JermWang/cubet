// Real Solana token data for cubet, fetched server-side and cached.
//   On-chain   Solana JSON-RPC (SOLANA_RPC_URL)       is this address a real SPL mint? decimals, supply
//   Markets    DexScreener                            name, symbol, logo, price, market cap, 24h change, pair
//   History    GeckoTerminal (or CoinGecko on-chain)  trending pools, OHLCV candles for charts + settlement
// Nothing here needs a key; SOLANA_RPC_URL and COINGECKO_API_KEY only raise reliability and rate limits.

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_PROGRAMS = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'token-2022',
};
// Quote assets never show up as "trending tokens".
const QUOTES = new Set([
  'So11111111111111111111111111111111111111112',  // wrapped SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY7NXcCdJ5EvZrNz', // USDT
]);
// Chart timeframes → GeckoTerminal candle settings.
const TIMEFRAMES = {
  '1h': { unit: 'minute', aggregate: 1, limit: 60, ttl: 60 },
  '1d': { unit: 'minute', aggregate: 15, limit: 96, ttl: 180 },
  '1w': { unit: 'hour', aggregate: 4, limit: 42, ttl: 900 },
  '1m': { unit: 'day', aggregate: 1, limit: 30, ttl: 3600 },
};

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function createMarket({ rpcUrl, coingeckoKey, ttlSeconds = 20 }) {
  const gtBase = coingeckoKey ? 'https://pro-api.coingecko.com/api/v3/onchain' : 'https://api.geckoterminal.com/api/v2';
  const gtHeaders = coingeckoKey ? { 'x-cg-pro-api-key': coingeckoKey } : {};
  const TTL = ttlSeconds * 1000;

  /* ---------- tiny promise cache ----------
     Dedupes concurrent requests, and if a refresh fails (rate limit, outage) it keeps serving the
     last good value for up to an hour instead of an error. */
  const cache = new Map(), lastGood = new Map();
  function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.promise;
    const promise = fn().then(value => { lastGood.set(key, { at: Date.now(), value }); return value; }, err => {
      cache.delete(key);
      const stale = lastGood.get(key);
      if (stale && Date.now() - stale.at < 3600_000) {
        // back off for 30s: keep answering with the last good value instead of hammering the provider
        cache.set(key, { at: Date.now(), ttl: 30_000, promise: Promise.resolve(stale.value) });
        return stale.value;
      }
      throw err;
    });
    cache.set(key, { at: Date.now(), ttl, promise });
    if (cache.size > 3000) for (const [k, v] of cache) if (Date.now() - v.at > v.ttl) cache.delete(k);
    if (lastGood.size > 3000) for (const [k, v] of lastGood) if (Date.now() - v.at > 3600_000) lastGood.delete(k);
    return promise;
  }

  async function getJson(url, init = {}, retry = true) {
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(9000), headers: { accept: 'application/json', 'user-agent': 'cubet/1.0', ...init.headers } });
    } catch {
      throw new HttpError(504, 'upstream_timeout', 'A market data provider did not respond. Try again in a moment.');
    }
    if (res.status === 429 && retry) { await new Promise(r => setTimeout(r, 1500)); return getJson(url, init, false); }
    if (res.status === 429) throw new HttpError(503, 'rate_limited', 'Market data is busy right now. Try again in a few seconds.');
    if (res.status === 404) return null;
    if (!res.ok) throw new HttpError(502, 'upstream_error', `Market data provider returned ${res.status}.`);
    return res.json();
  }
  const gt = path => getJson(gtBase + path, { headers: gtHeaders });

  async function rpc(method, params) {
    const body = await getJson(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!body || body.error) throw new HttpError(502, 'rpc_error', body?.error?.message || 'Solana RPC error.');
    return body.result;
  }

  const assertMint = mint => { if (!MINT_RE.test(mint || '')) throw new HttpError(400, 'bad_address', 'That is not a valid Solana address.'); };

  /* ---------- on-chain: is it a token mint? ---------- */
  function onchain(mint) {
    return cached('mint:' + mint, 10 * 60_000, async () => {
      const result = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      const v = result?.value;
      if (!v) return { exists: false };
      const parsed = v.data?.parsed;
      const program = TOKEN_PROGRAMS[v.owner];
      return {
        exists: true,
        isMint: Boolean(program) && parsed?.type === 'mint',
        program: program || v.owner,
        decimals: parsed?.info?.decimals ?? null,
        supply: parsed?.info?.supply ?? null,
        mintAuthority: parsed?.info?.mintAuthority ?? null,
        freezeAuthority: parsed?.info?.freezeAuthority ?? null,
      };
    });
  }

  /* ---------- markets: DexScreener, up to 30 mints per call ---------- */
  function fromPair(p) {
    return {
      ca: p.baseToken.address,
      symbol: p.baseToken.symbol,
      name: p.baseToken.name,
      image: p.info?.imageUrl || null,
      priceUsd: Number(p.priceUsd) || null,
      cap: p.marketCap || p.fdv || null,
      change: p.priceChange?.h24 ?? null,
      changes: { m5: p.priceChange?.m5 ?? null, h1: p.priceChange?.h1 ?? null, h6: p.priceChange?.h6 ?? null, h24: p.priceChange?.h24 ?? null },
      liquidity: p.liquidity?.usd ?? null,
      volume24h: p.volume?.h24 ?? null,
      pair: p.pairAddress,
      dex: p.dexId,
      url: p.url,
      links: { website: p.info?.websites?.[0]?.url || null, x: p.info?.socials?.find(s => s.type === 'twitter')?.url || null },
    };
  }
  function markets(mints) {
    const list = [...new Set(mints)].filter(m => MINT_RE.test(m)).sort();
    if (!list.length) return Promise.resolve({});
    return cached('ds:' + list.join(','), TTL, async () => {
      const out = {};
      for (let i = 0; i < list.length; i += 30) {
        const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${list.slice(i, i + 30).join(',')}`) || [];
        for (const p of pairs) {
          const mint = p.baseToken?.address;
          if (!list.includes(mint)) continue;
          const best = out[mint];
          if (!best || (p.liquidity?.usd || 0) > (best.liquidity || 0)) out[mint] = fromPair(p);
        }
      }
      return out;
    });
  }

  // Fallback name/symbol/logo for brand-new tokens DexScreener hasn't indexed yet.
  function gtToken(mint) {
    return cached('gttok:' + mint, 10 * 60_000, async () => {
      const body = await gt(`/networks/solana/tokens/${mint}`);
      const a = body?.data?.attributes;
      return a ? { symbol: a.symbol, name: a.name, image: cleanImage(a.image_url) } : null;
    });
  }
  const cleanImage = url => (!url || /missing\.png/.test(url) ? null : url);

  /* ---------- public API ---------- */
  async function token(mint) {
    assertMint(mint);
    const [chain, mk] = await Promise.all([onchain(mint), markets([mint])]);
    if (!chain.exists) throw new HttpError(404, 'not_found', 'No account exists at this address on Solana.');
    if (!chain.isMint) throw new HttpError(422, 'not_a_token', 'This address is not a token mint.');
    let market = mk[mint] || null;
    if (!market) {
      const meta = await gtToken(mint).catch(() => null);
      market = { ca: mint, symbol: meta?.symbol || mint.slice(0, 4), name: meta?.name || 'Unknown token', image: meta?.image || null, cap: null };
    }
    return { ...market, onchain: chain, tradable: Boolean(market.cap) };
  }

  async function tokens(mints) {
    mints.forEach(assertMint);
    return markets(mints);
  }

  function trending() {
    return cached('trending', Math.max(TTL, 120_000), async () => {
      const body = await gt('/networks/solana/trending_pools?include=base_token&page=1');
      const included = new Map((body?.included || []).map(t => [t.id, t.attributes]));
      const seen = new Set(), picks = [];
      for (const pool of body?.data || []) {
        const base = included.get(pool.relationships?.base_token?.data?.id);
        const mint = base?.address;
        if (!mint || QUOTES.has(mint) || seen.has(mint)) continue;
        seen.add(mint);
        picks.push({ ca: mint, symbol: base.symbol, name: base.name, image: cleanImage(base.image_url), cap: Number(pool.attributes.market_cap_usd || pool.attributes.fdv_usd) || null, change: Number(pool.attributes.price_change_percentage?.h24) || null });
      }
      // DexScreener's market caps and logos match what the rest of the app shows.
      const ds = await markets(picks.map(p => p.ca)).catch(() => ({}));
      return picks.map(p => ({ ...p, ...(ds[p.ca] || {}), image: ds[p.ca]?.image || p.image })).filter(p => p.cap > 0).slice(0, 12);
    });
  }

  async function chart(mint, tf = '1d') {
    assertMint(mint);
    const frame = TIMEFRAMES[tf] || TIMEFRAMES['1d'];
    const m = (await markets([mint]))[mint];
    if (!m?.pair || !m.priceUsd || !m.cap) throw new HttpError(404, 'no_market', 'No trading pair found for this token yet.');
    return cached(`chart:${mint}:${tf}`, frame.ttl * 1000, async () => {
      const body = await gt(`/networks/solana/pools/${m.pair}/ohlcv/${frame.unit}?aggregate=${frame.aggregate}&limit=${frame.limit}&currency=usd&token=base`);
      const supplyFactor = m.cap / m.priceUsd; // price → market cap
      const points = (body?.data?.attributes?.ohlcv_list || []).map(c => [c[0], c[4] * supplyFactor]).reverse();
      return { ca: mint, tf, cap: m.cap, points };
    });
  }

  // Market cap at a moment in the past: what settles a bet when it expires.
  async function capAt(mint, unix) {
    assertMint(mint);
    const t = Math.floor(Number(unix));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(t) || t > now + 60) throw new HttpError(400, 'bad_time', 'That time has not happened yet.');
    const m = (await markets([mint]))[mint];
    if (!m?.cap || !m.priceUsd) throw new HttpError(404, 'no_market', 'No trading pair found for this token.');
    if (now - t < 120) return { ca: mint, t, cap: m.cap, source: 'live', pair: m.pair };
    return cached(`capAt:${mint}:${t}`, 24 * 3600_000, async () => {
      const unit = now - t < 2 * 86400 ? 'minute' : 'hour';
      const body = await gt(`/networks/solana/pools/${m.pair}/ohlcv/${unit}?aggregate=1&limit=1&before_timestamp=${t + 1}&currency=usd&token=base`);
      const candle = body?.data?.attributes?.ohlcv_list?.[0];
      if (!candle) throw new HttpError(404, 'no_history', 'No price history for that time.');
      return { ca: mint, t, cap: candle[4] * (m.cap / m.priceUsd), candleTime: candle[0], close: candle[4], source: 'candle', pair: m.pair };
    });
  }

  return { token, tokens, trending, chart, capAt, TIMEFRAMES: Object.keys(TIMEFRAMES) };
}
