// cubet server: dependency-free, works locally and on Railway.
//   Local:   node server.mjs        (reads .env if present, binds 127.0.0.1:4174)
//   Railway: PORT is injected and the server binds 0.0.0.0. See .env.example for every setting.
//
//   Pages     /  (landing)   /terminal   /proof
//   Data      /api/token/:mint   /api/tokens?mints=a,b   /api/trending
//             /api/chart/:mint?tf=1h|1d|1w|1m   /api/cap-at/:mint?t=<unix seconds>
//   Book      GET  /api/me  /api/book  /api/leaderboard  /api/settlements  /api/stats
//             POST /api/bets  /api/bets/:id/take  /api/bets/:id/cancel
//   Wallet    POST /api/auth/nonce  /api/auth/verify  /api/auth/logout
//   Payments  GET  /api/pay/status  /api/pay/config  /api/pay/transfers  /api/pay/mine  /api/pay/blockhash
//             POST /api/pay/deposit  /api/pay/withdraw  /api/pay/relay
//   Ops       /healthz   /runtime-config.js
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createMarket, HttpError } from './market.mjs';
import { createBook, BookError } from './book.mjs';
import { createPayments } from './payments.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env file: use the real environment */ }

/* ---------- settings from the environment ---------- */
const env = process.env;
// Railway's dashboard hides variables with empty values, so settings waiting to be filled in are created
// as REPLACE_ME. That placeholder counts exactly as blank (unset) everywhere.
const PLACEHOLDER = 'REPLACE_ME';
const raw = k => { const v = String(env[k] ?? '').trim(); return v === PLACEHOLDER ? '' : v; };
const str = (k, d = '') => raw(k) || d;
const num = (k, d) => { const v = raw(k), n = Number(v); return v !== '' && Number.isFinite(n) ? n : d; };
const bool = (k, d) => { const v = raw(k); return v === '' ? d : /^(1|true|yes|on)$/i.test(v); };

const PROD = str('NODE_ENV') === 'production';
const PORT = num('PORT', 4174);
const HOST = str('HOST', PROD || env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '127.0.0.1');
const CACHE_MAX_AGE = num('CACHE_MAX_AGE', PROD ? 3600 : 0);
const PUBLIC_URL = str('PUBLIC_URL', env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '').replace(/\/+$/, '');
const API_RATE_LIMIT = num('API_RATE_LIMIT', 120); // requests per minute per visitor
// Every deploy gets a new build id; pages reference assets as /app.js?v=<id>, so browsers never mix
// a new page with a cached old script, and versioned assets can be cached for a year.
const BUILD = str('RAILWAY_DEPLOYMENT_ID', '').slice(0, 12) || Date.now().toString(36);
// Link-preview card: og.png (1200x630) at the project root. The og:image tags appear only when the file exists,
// so a preview never points at a missing image.
const HAS_OG = await fs.access(path.join(root, 'og.png')).then(() => true, () => false);

const market = createMarket({
  rpcUrl: str('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
  coingeckoKey: str('COINGECKO_API_KEY'),
  ttlSeconds: num('DATA_CACHE_SECONDS', 20),
});

// The shared bet book (SQLite). On Railway, DB_PATH points at the persistent volume.
const book = createBook({
  dbPath: str('DB_PATH', path.join(root, 'data', 'cubet.db')),
  market,
  minStake: num('MIN_STAKE', 0.01),
  maxStake: num('MAX_STAKE', 10),
  feeBps: Math.max(0, Math.min(1000, num('FEE_BPS', 0))),
  minLiquidityUsd: num('MIN_LIQUIDITY_USD', 20000),
});
// Real SOL in and out of the treasury wallet. Off (no deposits, withdrawals or new bets) until TREASURY_SECRET_KEY is set.
const payments = createPayments({
  book,
  rpcUrl: str('PAYMENTS_RPC_URL') || str('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
  cluster: str('SOLANA_CLUSTER', 'mainnet-beta'),
  treasurySecret: str('TREASURY_SECRET_KEY'),
  feeWallet: str('FEE_WALLET'),
  minDeposit: num('MIN_DEPOSIT', 0.01),
  minWithdraw: num('MIN_WITHDRAW', 0.02),
  maxWithdrawPerDay: num('MAX_WITHDRAW_PER_DAY', 25),
  withdrawalsPaused: bool('WITHDRAWALS_PAUSED', false),
  feeSweepMin: num('FEE_SWEEP_MIN', 0.1),
  domain: (str('PUBLIC_URL', env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')) || `localhost:${num('PORT', 4174)}`,
});
const SESSION = 'cubet_sid';

// Public, browser-safe overrides for config.js. Only variables that are set reach the page; never put secrets here.
const brand = Object.fromEntries(Object.entries({
  name: str('APP_NAME'), title: str('APP_TITLE'), tagline: str('APP_TAGLINE'), footer: str('APP_FOOTER'),
}).filter(([, v]) => v));
const publicConfig = Object.fromEntries(Object.entries({
  brand: Object.keys(brand).length ? brand : undefined,
  token: str('TOKEN_CA') ? { ca: str('TOKEN_CA') } : undefined,
  currency: str('CURRENCY') || undefined,
  storageKey: str('STORAGE_KEY') || undefined,
  defaultStake: num('DEFAULT_STAKE', undefined),
  minStake: num('MIN_STAKE', undefined),
  maxStake: num('MAX_STAKE', undefined),
  motion: env.ART_BOIL ? { boil: bool('ART_BOIL', true) } : undefined,
}).filter(([, v]) => v !== undefined));

const runtimeConfigJs =
  `/* Generated by server.mjs from environment variables. */\n` +
  `(function (o) { var c = window.CUBET; if (!c) return;\n` +
  `  Object.keys(o).forEach(function (k) { c[k] = (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) ? Object.assign({}, c[k], o[k]) : o[k]; });\n` +
  `})(${JSON.stringify(publicConfig).replace(/</g, '\\u003c')});\n`;

/* ---------- static files ---------- */
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};
const compressible = /^(text\/|application\/json|image\/svg)/;
// Only files the site needs are served; server code, .env and docs never are.
const PUBLIC_FILES = new Set([
  'index.html', 'terminal.html', 'styles.css', 'landing.css', 'fonts.css',
  'config.js', 'data.js', 'fx.js', 'mascot.js', 'art.js', 'app.js', 'landing.js', 'favicon.svg', 'robots.txt', 'og.png',
  'proof.html', 'proof.js', 'wallet.js',
]);
const isPublic = rel => PUBLIC_FILES.has(rel) || /^fonts\/[\w.-]+\.woff2$/.test(rel);
const ROUTES = { '/': 'index.html', '/terminal': 'terminal.html', '/terminal/': 'terminal.html', '/proof': 'proof.html', '/proof/': 'proof.html' };

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // Token logos come from DexScreener / GeckoTerminal / IPFS CDNs, so images may load from any https host.
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  ...(PROD ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};

const escAttr = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function renderPage(html, rel) {
  const name = brand.name || 'cubet';
  const title = rel === 'terminal.html' ? `Terminal · ${name}` : rel === 'proof.html' ? `Proof · ${name}` : brand.title || 'cubet — stack your call';
  const desc = brand.tagline || 'A market-cap betting terminal for any Solana token. Connect a wallet, stake real SOL, and the winner takes the pot.';
  const url = PUBLIC_URL && (rel === 'terminal.html' ? `${PUBLIC_URL}/terminal` : rel === 'proof.html' ? `${PUBLIC_URL}/proof` : `${PUBLIC_URL}/`);
  const meta = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escAttr(title)}">`,
    `<meta property="og:description" content="${escAttr(desc)}">`,
    `<meta name="twitter:card" content="${HAS_OG ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:site" content="@cubetsol_">`,
    `<meta name="theme-color" content="#000000">`,
    ...(url ? [`<meta property="og:url" content="${escAttr(url)}">`, `<link rel="canonical" href="${escAttr(url)}">`] : []),
    ...(HAS_OG && PUBLIC_URL ? [`<meta property="og:image" content="${escAttr(PUBLIC_URL)}/og.png">`, `<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`, `<meta name="twitter:image" content="${escAttr(PUBLIC_URL)}/og.png">`] : []),
  ].join('\n');
  return html
    .replace('<!--server-meta-->', meta)
    .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(title)}</title>`)
    .replace(/(src|href)="\/([\w.-]+\.(?:js|css|svg))"/g, `$1="/$2?v=${BUILD}"`);
}

function send(req, res, status, body, type, extra = {}) {
  const headers = { ...securityHeaders, 'Content-Type': type, Vary: 'Accept-Encoding', ...extra };
  if (compressible.test(type) && body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}
const sendJson = (req, res, status, data, maxAge = 0, extra = {}) =>
  send(req, res, status, Buffer.from(JSON.stringify(data)), 'application/json; charset=utf-8', { 'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store', ...extra });
const notFound = (req, res) => send(req, res, 404, Buffer.from('Not found'), 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });

const fileCache = new Map();
async function read(rel) {
  if (PROD && fileCache.has(rel)) return fileCache.get(rel);
  const data = await fs.readFile(path.join(root, rel));
  if (PROD) fileCache.set(rel, data);
  return data;
}

/* ---------- data API ---------- */
// A small per-visitor limiter keeps the free upstream rate limits safe.
const buckets = new Map();
function allow(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'local';
  const now = Date.now(), b = buckets.get(ip) || { tokens: API_RATE_LIMIT, at: now };
  b.tokens = Math.min(API_RATE_LIMIT, b.tokens + ((now - b.at) / 60000) * API_RATE_LIMIT);
  b.at = now;
  if (b.tokens < 1) { buckets.set(ip, b); return false; }
  b.tokens -= 1; buckets.set(ip, b);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.at > 120000) buckets.delete(k);
  return true;
}

const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(([k, v]) => k && v));
const sessionCookie = s => `${SESSION}=${s}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${PROD ? '; Secure' : ''}`;
const clearCookie = `${SESSION}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${PROD ? '; Secure' : ''}`;

// POSTs only from our own pages: JSON body, same origin, small.
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(new BookError(415, 'json_only', 'Send JSON.'));
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* bad origin */ }
      if (host !== req.headers.host) return reject(new BookError(403, 'bad_origin', 'Cross-site requests are not allowed.'));
    }
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 4096) { reject(new BookError(413, 'too_large', 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new BookError(400, 'bad_json', 'Invalid JSON.')); } });
    req.on('error', reject);
  });
}

async function bookApi(req, res, route, arg, action, query) {
  const viewer = book.player(cookies(req)[SESSION]);
  if (req.method === 'GET' || req.method === 'HEAD') {
    switch (route) {
      case 'me': return sendJson(req, res, 200, { player: viewer ? book.me(viewer) : null });
      case 'book': return sendJson(req, res, 200, book.snapshot(viewer?.id));
      case 'leaderboard': return sendJson(req, res, 200, { players: book.leaderboard(viewer?.id) });
      case 'settlements': return sendJson(req, res, 200, { bets: book.settlements(Number(query.get('limit')) || 25) });
      case 'stats': return sendJson(req, res, 200, book.stats());
    }
    return null;
  }
  if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'method', message: 'Method not allowed.' });
  const body = await readJson(req);
  if (!viewer) throw new BookError(401, 'no_session', 'Connect your wallet first.');
  const fresh = () => book.me(book.refresh(viewer));
  // Creating and taking bets moves real SOL, so both need payments switched on.
  if (route === 'bets' && action !== 'cancel' && !payments.enabled) throw new BookError(503, 'payments_off', 'Betting opens when deposits are switched on.');
  if (route === 'bets' && !arg) { const id = await book.create(viewer, body); return sendJson(req, res, 201, { id, player: fresh() }); }
  if (route === 'bets' && arg && action === 'take') { book.take(viewer, arg); return sendJson(req, res, 200, { ok: true, player: fresh() }); }
  if (route === 'bets' && arg && action === 'cancel') { book.cancel(viewer, arg); return sendJson(req, res, 200, { ok: true, player: fresh() }); }
  return null;
}

// Wallet sign-in and real-SOL payments.
async function payApi(req, res, route, arg, query) {
  const session = cookies(req)[SESSION], viewer = book.player(session);
  const need = () => { if (!viewer) throw new BookError(401, 'no_session', 'Connect your wallet first.'); return viewer; };
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (route === 'pay' && arg === 'status') return sendJson(req, res, 200, await payments.status());
    if (route === 'pay' && arg === 'config') return sendJson(req, res, 200, payments.publicConfig());
    if (route === 'pay' && arg === 'transfers') return sendJson(req, res, 200, payments.transfers(Number(query.get('limit')) || 25));
    if (route === 'pay' && arg === 'mine') return sendJson(req, res, 200, { ...payments.mine(need()), ledger: book.history(viewer, 30) });
    if (route === 'pay' && arg === 'blockhash') { need(); return sendJson(req, res, 200, await payments.blockhash()); }
    return null;
  }
  if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'method', message: 'Method not allowed.' });
  const body = await readJson(req);
  if (route === 'auth' && arg === 'nonce') return sendJson(req, res, 200, payments.challenge(String(body.wallet || ''), req.headers.host));
  if (route === 'auth' && arg === 'verify') {
    const out = payments.verifySignIn(String(body.wallet || ''), body.nonce, String(body.signature || ''));
    book.signOut(session);
    return sendJson(req, res, 200, { player: book.me(out.player), isNew: out.isNew }, 0, { 'Set-Cookie': sessionCookie(out.session) });
  }
  if (route === 'auth' && arg === 'logout') { book.signOut(session); return sendJson(req, res, 200, { ok: true }, 0, { 'Set-Cookie': clearCookie }); }
  if (route === 'pay' && arg === 'deposit') return sendJson(req, res, 200, await payments.reportDeposit(need(), String(body.signature || '')));
  if (route === 'pay' && arg === 'withdraw') { const w = await payments.withdraw(need(), Number(body.amount)); return sendJson(req, res, 200, { ...w, url: payments.explorer(w.signature), player: book.me(book.refresh(viewer)) }); }
  if (route === 'pay' && arg === 'relay') { need(); return sendJson(req, res, 200, await payments.relay(body.tx)); }
  return null;
}

async function api(req, res, pathname, query) {
  if (!allow(req)) return sendJson(req, res, 429, { error: 'rate_limited', message: 'Slow down a little and try again.' });
  const [, , route, arg, action] = pathname.split('/'); // ['', 'api', route, arg, action]
  try {
    if (route === 'auth' || route === 'pay') {
      const handled = await payApi(req, res, route, arg, query);
      if (handled !== null) return handled;
      return sendJson(req, res, 404, { error: 'not_found', message: 'Unknown API route.' });
    }
    if (['me', 'book', 'leaderboard', 'settlements', 'stats', 'bets'].includes(route)) {
      const handled = await bookApi(req, res, route, arg, action, query);
      if (handled !== null) return handled;
      return sendJson(req, res, 404, { error: 'not_found', message: 'Unknown API route.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(req, res, 405, { error: 'method', message: 'Method not allowed.' });
    switch (route) {
      case 'token': return sendJson(req, res, 200, await market.token(arg), 15);
      case 'tokens': {
        const mints = (query.get('mints') || '').split(',').filter(Boolean).slice(0, 60);
        return sendJson(req, res, 200, { tokens: await market.tokens(mints) }, 15);
      }
      case 'trending': return sendJson(req, res, 200, { tokens: await market.trending() }, 30);
      case 'chart': return sendJson(req, res, 200, await market.chart(arg, query.get('tf') || '1d'), 30);
      case 'cap-at': {
        const out = await market.capAt(arg, query.get('t'));
        return sendJson(req, res, 200, out, out.source === 'candle' ? 3600 : 10);
      }
      default: return sendJson(req, res, 404, { error: 'not_found', message: 'Unknown API route.' });
    }
  } catch (err) {
    if (err instanceof HttpError || err instanceof BookError) return sendJson(req, res, err.status, { error: err.code, message: err.message });
    console.error('api error', pathname, err);
    const rpcFail = /^RPC |fetch failed|aborted|timeout/i.test(err?.message || '');
    return sendJson(req, res, rpcFail ? 502 : 500, { error: rpcFail ? 'rpc_error' : 'server_error', message: rpcFail ? 'The Solana network did not answer. Try again in a moment.' : 'Something went wrong. Try again.' });
  }
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { return send(req, res, 400, Buffer.from('Bad request'), 'text/plain; charset=utf-8'); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return send(req, res, 400, Buffer.from('Bad request'), 'text/plain; charset=utf-8'); }

  if (pathname === '/healthz') return send(req, res, 200, Buffer.from('ok'), 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });
  if (pathname === '/runtime-config.js') return send(req, res, 200, Buffer.from(runtimeConfigJs), mime['.js'], { 'Cache-Control': 'no-cache' });
  if (pathname.startsWith('/api/')) return api(req, res, pathname, url.searchParams);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, Buffer.from('Method not allowed'), 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });

  const rel = ROUTES[pathname] || pathname.replace(/^\/+/, '');
  if (!isPublic(rel)) return notFound(req, res);
  try {
    let data = await read(rel);
    const html = rel.endsWith('.html');
    if (html) data = Buffer.from(renderPage(data.toString('utf8'), rel));
    const versioned = url.searchParams.get('v') === BUILD;
    const cache = html ? 'no-cache'
      : rel.startsWith('fonts/') || (versioned && PROD) ? 'public, max-age=31536000, immutable'
      : CACHE_MAX_AGE ? `public, max-age=${CACHE_MAX_AGE}` : 'no-cache';
    send(req, res, 200, data, mime[path.extname(rel)] || 'application/octet-stream', { 'Cache-Control': cache });
  } catch {
    notFound(req, res);
  }
});

server.listen(PORT, HOST, () => {
  const where = HOST === '0.0.0.0' ? `0.0.0.0:${PORT}` : `http://localhost:${server.address().port}`;
  console.log(`cubet listening on ${where}${PUBLIC_URL ? ` · public URL ${PUBLIC_URL}` : ''}${PROD ? ' · production' : ''}`);
  if (!str('SOLANA_RPC_URL')) console.log('Using the public Solana RPC. Set SOLANA_RPC_URL (Helius, QuickNode, Triton…) for production reliability.');
});
server.on('error', err => { console.error(err.message); process.exitCode = 1; });

// Settle every expired bet on the real market cap at its expiry, every 15 seconds.
const settleTimer = setInterval(() => book.settleDue().catch(err => console.error('settle loop', err)), 15_000);
book.settleDue().catch(err => console.error('settle loop', err));
// Credit finalized deposits to the treasury, and confirm / re-send / refund pending withdrawals.
const scanTimer = setInterval(() => payments.scan(), 20_000);
const reconcileTimer = setInterval(() => payments.reconcile(), 6_000);
payments.scan(); payments.reconcile();

// Railway sends SIGTERM on redeploy: finish in-flight requests, then exit.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { clearInterval(settleTimer); clearInterval(scanTimer); clearInterval(reconcileTimer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
}
