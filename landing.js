/* cubet landing page.
   The live markets feed: one bet-first card per trending Solana coin, with its live market cap,
   a trend line from real price changes, an upside and downside target, and Higher / Lower
   buttons that open the terminal with that bet filled in. Every other section is live data too. */
(() => {
'use strict';

const cfg = window.CUBET;
const art = window.Art;
const D = window.CubetData;
const FX = window.FX;
const CUR = cfg.currency;
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = D.money;
const nice = n => { const p = 10 ** (Math.floor(Math.log10(n)) - 1); return Math.round(n / p) * p; };
const isCa = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const wait = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms, fallback) => Promise.race([p, wait(ms).then(() => fallback)]);
const terminalUrl = (t, dir, target, duration, stake = cfg.defaultStake) =>
  '/terminal?' + new URLSearchParams({ coin: t.ca, dir, target, duration, stake });

/* ---------- official contract address: one tap copies it ---------- */
(() => {
  const btn = $('#caCopy'), addr = $('#caAddr'), label = $('.ca-label', btn), status = $('#caStatus');
  const ca = String(cfg.token?.ca || '').trim();
  if (!ca) return;                        // not launched yet: stays "coming soon"
  if (!isCa(ca)) { console.warn('cubet: token.ca is not a valid Solana address; the copy button stays off.'); return; }
  const short = `${ca.slice(0, 6)}…${ca.slice(-6)}`;
  const fit = () => { addr.textContent = innerWidth < 560 ? short : ca; };
  fit(); addEventListener('resize', fit, { passive: true });
  btn.disabled = false;
  btn.title = ca;
  btn.setAttribute('aria-label', `Copy the official cubet contract address ${ca}`);
  let timer;
  btn.addEventListener('click', async () => {
    const legacyCopy = () => {
      const ta = Object.assign(document.createElement('textarea'), { value: ca, readOnly: true });
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.append(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); btn.focus();
      if (!ok) throw new Error('copy blocked');
    };
    try {
      try { await navigator.clipboard.writeText(ca); } catch { legacyCopy(); }
      label.textContent = 'Copied'; status.textContent = 'Contract address copied';
      btn.classList.add('copied');
    } catch {
      label.textContent = 'Press Ctrl+C'; status.textContent = 'Copy failed. The address is selected.';
      addr.textContent = ca; getSelection().selectAllChildren(addr);
    }
    clearTimeout(timer);
    timer = setTimeout(() => { label.textContent = 'Official CA'; status.textContent = ''; btn.classList.remove('copied'); }, 1800);
  });
})();

/* ---------- brand + things that need no data ---------- */
$$('[data-brand]').forEach(el => { el.textContent = cfg.brand.name; });
$$('[data-footer]').forEach(el => { el.textContent = cfg.brand.footer; });
document.title = cfg.brand.title;
// The cubet mascot (mascot.js): big in the splash and the final CTA, small in the mega-menu cards.
Mascot.mount($('#splashCube'));
Mascot.mount($('#finalCube'));
$$('.mm-cube').forEach(n => Mascot.mount(n, { size: 'sm' }));
$('#lpClock').innerHTML = art.clock();
$('#lpDurations').innerHTML = cfg.durations.map(d => `<span class="chip">${esc(d.label)}</span>`).join('');
$('#lpCall').innerHTML = `<div class="up">${art.trend('above')}<b>Higher</b><span>above your target</span></div><div class="down">${art.trend('below')}<b>Lower</b><span>below your target</span></div>`;
$('#mkGrid').innerHTML = Array.from({ length: 6 }, () => '<div class="mk skel" aria-hidden="true"></div>').join('');

// Open bets from the shared bet book (every one placed by a real player), loaded below.
let openBets = [];

/* ---------- markets ---------- */
const WINDOWS = {
  '1 h': { up: 1.15, down: 0.88, say: '1 hour' },
  '6 h': { up: 1.35, down: 0.75, say: '6 hours' },
  '1 day': { up: 1.6, down: 0.62, say: '24 hours' },
  '3 days': { up: 2, down: 0.5, say: '3 days' },
};
// Hot coins get short windows, big caps get long ones.
function windowFor(t) {
  const move = Math.abs(t.change ?? 0);
  if (move > 60) return '1 h';
  if (move > 20) return '6 h';
  if (t.cap > 50e6) return '3 days';
  return '1 day';
}
function makeMarket(t) {
  const win = windowFor(t), w = WINDOWS[win];
  return { token: t, win, hi: nice(t.cap * w.up), lo: nice(t.cap * w.down) };
}
// Real price points: market cap 24h, 6h, 1h and 5m ago, rebuilt from DexScreener's % changes.
function sparkValues(t) {
  const c = t.changes || { h24: t.change };
  return [c.h24, c.h6, c.h1, c.m5].map(p => (Number.isFinite(p) ? t.cap / (1 + p / 100) : NaN)).concat(t.cap);
}
const position = (m, cap) => Math.max(0, Math.min(1, (Math.log(cap) - Math.log(m.lo)) / (Math.log(m.hi) - Math.log(m.lo))));
const potFor = ca => {
  const bets = openBets.filter(b => b.token?.ca === ca);
  return bets.length ? `${bets.length} open bet${bets.length > 1 ? 's' : ''} · pot ${Number((bets.reduce((s, b) => s + b.stake * 2, 0)).toFixed(4))} ${CUR}` : 'No open bets yet · be first';
};

function card(m, i) {
  const t = m.token, chg = t.change;
  return `<article class="mk spot" style="--i:${i}" data-ca="${esc(t.ca)}">
    <header class="mk-head">${art.token(t)}<div class="mk-id"><b>${esc(t.symbol)}</b><span>${esc(t.name || '')}</span></div>
      <span class="mk-chg ${chg >= 0 ? 'up' : 'down'}" data-chg>${Number.isFinite(chg) ? D.pct(chg) : '—'}</span></header>
    <h3 class="mk-q">Where does ${esc(t.symbol)} close in ${WINDOWS[m.win].say}?</h3>
    <div class="mk-now"><div><span>Market cap</span><b data-cap>${money(t.cap)}</b></div><div class="mk-spark" data-spark>${art.sparkline(sparkValues(t), { w: 140, h: 44 })}</div></div>
    <div class="mk-range" style="--pos:${position(m, t.cap)}">
      <div class="mk-track"><i class="mk-fill"></i><i class="mk-marker"></i></div>
      <div class="mk-ends"><span class="down">↓ ${money(m.lo)}</span><span class="mk-nowtag">now</span><span class="up">↑ ${money(m.hi)}</span></div>
    </div>
    <div class="mk-meta"><span>Vol ${money(t.volume24h)}</span><span>Liq ${money(t.liquidity)}</span><span class="mk-pot">${esc(potFor(t.ca))}</span></div>
    <div class="mk-act">
      <a class="mk-btn up" href="${esc(terminalUrl(t, 'above', m.hi, m.win))}">${art.trend('above')}Higher <small>${money(m.hi)}</small></a>
      <a class="mk-btn down" href="${esc(terminalUrl(t, 'below', m.lo, m.win))}">${art.trend('below')}Lower <small>${money(m.lo)}</small></a>
    </div>
  </article>`;
}

let markets = [], sortBy = 'trending';
const SORTS = {
  trending: list => list,
  gainers: list => [...list].sort((a, b) => (b.token.change ?? -1e9) - (a.token.change ?? -1e9)),
  losers: list => [...list].sort((a, b) => (a.token.change ?? 1e9) - (b.token.change ?? 1e9)),
  largest: list => [...list].sort((a, b) => b.token.cap - a.token.cap),
};
function renderMarkets() {
  const list = SORTS[sortBy](markets).slice(0, 9);
  $('#mkGrid').innerHTML = list.length ? list.map(card).join('') : '<p class="mk-empty">Live market data is unavailable right now. Paste an address above, or open the terminal.</p>';
}
function stamp() {
  $('#mkStatus').textContent = `${markets.length} live markets · updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
}

// Refresh caps in place: numbers flash, the marker glides, trend lines redraw.
async function refreshMarkets() {
  if (!markets.length || document.hidden) return;
  let fresh;
  try { fresh = await D.tokens(markets.map(m => m.token.ca)); } catch { return; }
  for (const m of markets) {
    const t = fresh[m.token.ca];
    if (!t?.cap) continue;
    const before = m.token.cap;
    m.token = { ...m.token, ...t };
    const el = $(`.mk[data-ca="${CSS.escape(t.ca)}"]`);
    if (!el) continue;
    const capEl = $('[data-cap]', el);
    capEl.textContent = money(t.cap);
    if (t.cap !== before) { capEl.classList.remove('flash-up', 'flash-down'); void capEl.offsetWidth; capEl.classList.add(t.cap > before ? 'flash-up' : 'flash-down'); }
    const chg = $('[data-chg]', el);
    chg.textContent = D.pct(t.change); chg.className = `mk-chg ${t.change >= 0 ? 'up' : 'down'}`;
    $('.mk-range', el).style.setProperty('--pos', position(m, t.cap));
    $('[data-spark]', el).innerHTML = art.sparkline(sparkValues(m.token), { w: 140, h: 44 });
  }
  stamp();
}

$$('.mk-tabs [data-sort]').forEach(tab => tab.addEventListener('click', () => {
  sortBy = tab.dataset.sort;
  $$('.mk-tabs [data-sort]').forEach(b => { const on = b === tab; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
  renderMarkets();
}));
$('#mkSearch').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#mkCa').value.trim();
  if (isCa(v)) { location.href = '/terminal?' + new URLSearchParams({ coin: v }); return; }
  const box = $('#mkSearch');
  box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
  $('#mkCa').setCustomValidity('Paste a 32–44 character Solana address');
  $('#mkCa').reportValidity();
});
$('#mkCa').addEventListener('input', e => e.target.setCustomValidity(''));

/* ---------- load live data ---------- */
(async () => {
  const [trending, featuredMap] = await Promise.all([
    withTimeout(D.trending().catch(() => []), 7000, []),
    withTimeout(D.tokens(cfg.featured).catch(() => ({})), 7000, {}),
  ]);
  const featured = cfg.featured.map(m => featuredMap[m]).filter(Boolean);
  const coins = [...trending, ...featured].filter((t, i, a) => t.cap > 0 && a.findIndex(x => x.ca === t.ca) === i);

  try { openBets = (await withTimeout(D.book(), 5000, { bets: [] })).bets.filter(b => b.state === 'open'); } catch { openBets = []; }
  markets = coins.map(makeMarket);
  renderMarkets();
  stamp();
  setInterval(refreshMarkets, (cfg.refreshSeconds || 20) * 1000);

  megaMenus(trending, featured);
  features(coins);
  stats(trending.length ? trending : coins);
  ranks();
  chainCheck(featured[0] || coins[0]);
})();

/* ---------- mega menu: live trending + featured ---------- */
function megaMenus(trending, featured) {
  const link = t => { const m = makeMarket(t); return `<a href="${esc(terminalUrl(t, 'above', m.hi, m.win))}">${art.token(t)}${esc(t.symbol)}<small>${money(t.cap)}</small></a>`; };
  $('#mmTrendA').innerHTML = trending.slice(0, 4).map(link).join('') || '<a href="/terminal#create">Open the terminal</a>';
  $('#mmTrendB').innerHTML = trending.slice(4, 8).map(link).join('');
  $('#mmFeatured').innerHTML = featured.slice(0, 4).map(link).join('');
}

/* ---------- feature visuals, all real ---------- */
async function features(coins) {
  const lead = coins[0];
  if (!lead) return;
  // 01: a real address, verified on-chain, with real logos orbiting it
  const spots = [[6, 12], [84, 8], [88, 66], [8, 70], [48, 4], [50, 86]];
  const floaters = coins.filter(t => t.image).slice(1, 7).map((t, i) =>
    `<span class="f-logo" style="left:${spots[i][0]}%;top:${spots[i][1]}%;animation-delay:${i * -0.9}s">${art.token(t)}</span>`).join('');
  $('#featCoin').innerHTML = `<div class="f-coins">${floaters}<div class="f-verify"><div class="f-ca glowfield lit"><span>${esc(lead.ca)}</span><b>Next →</b></div><div class="ca-card" id="fVerify">${art.token(lead)}<div><b>${esc(lead.symbol)}</b><span>${esc(lead.name || '')}</span></div><div class="ca-cap"><b>${money(lead.cap)}</b><span class="chg ${lead.change >= 0 ? 'up' : 'down'}">${D.pct(lead.change)}</span></div><p class="verified"><span class="spinner" aria-hidden="true"></span>Checking on-chain…</p></div></div></div>`;
  D.token(lead.ca).then(tok => {
    const v = $('#fVerify .verified');
    if (v) v.innerHTML = `✓ Verified ${tok.onchain.program === 'token-2022' ? 'Token-2022' : 'SPL'} mint on Solana`;
  }).catch(() => { const v = $('#fVerify .verified'); if (v) v.textContent = 'Checked on-chain in the terminal'; });

  // 02: real market-cap history, target line and shaded winning zone
  const target = nice(lead.cap * 1.4);
  try {
    const { points } = await D.chart(lead.ca, '1w');
    $('#featTarget').innerHTML = `<div class="f-chart"><div class="f-chart-head">${art.token(lead)}<b>${esc(lead.symbol)}</b><span>Higher than ${money(target)} · 7 days</span></div>${art.chart(points.map(p => p[1]), { times: points.map(p => p[0]), target, dir: 'above', nowLabel: money(lead.cap), targetLabel: money(target), label: `${lead.symbol} market cap, last week` })}</div>`;
  } catch { $('#featTarget').innerHTML = ''; }

  // 03: two players, one pot
  $('#featPot').innerHTML = `<div class="f-pot">
    <div class="f-side">${art.avatar('You')}<b>You</b><span class="pos">0.5 ${CUR} · Higher</span></div>
    <div class="f-mid"><span class="f-vs">VS</span><span class="chip">Pot 1 ${CUR}</span></div>
    <div class="f-side">${art.avatar('Another player')}<b>Another player</b><span class="neg">0.5 ${CUR} · Lower</span></div></div>`;
}

/* ---------- bento ---------- */
async function stats(coins) {
  if (!coins.length) return;
  const total = coins.reduce((s, t) => s + (t.cap || 0), 0);
  const mover = coins.filter(t => Number.isFinite(t.change)).sort((a, b) => b.change - a.change)[0];
  FX.countUp($('[data-stat="count"]'), coins.length);
  FX.countUp($('[data-stat="cap"]'), total, v => money(v));
  if (mover) $('[data-stat="mover"]').innerHTML = `${esc(mover.symbol)}<small class="chg ${mover.change >= 0 ? 'up' : 'down'}">${D.pct(mover.change)}</small>`;
  try {
    const top = coins[0];
    const { points } = await D.chart(top.ca, '1d');
    $('#lpMiniChart').innerHTML = art.chart(points.map(p => p[1]), { times: points.map(p => p[0]), animate: false, label: `${top.symbol} market cap today` });
  } catch { /* the cell still reads fine without the chart */ }
}

// Top three real players from the shared leaderboard, ranked by demo P/L (then bets in play).
async function ranks() {
  let list = [];
  try { list = (await D.leaderboard()).slice(0, 3); } catch { /* shown as empty below */ }
  if (!list.length) {
    $('#lpRanks').innerHTML = '<p class="rk-empty">No settled bets yet. The first players to bet show up here.</p>';
    return;
  }
  const score = p => Math.max(0.0001, p.pl > 0 ? p.pl : p.inPlay);
  const max = Math.max(...list.map(score));
  $('#lpRanks').innerHTML = list.map((p, i) => `<div class="rk"><span class="rk-n">${i + 1}</span>${art.avatar(p.name)}<span class="rk-name">${esc(p.me ? 'You' : p.name)}</span><span class="rk-bar"><i style="--w:${score(p) / max}"></i></span></div>`).join('');
}

async function chainCheck(t) {
  const el = $('#lpChain');
  if (!t) return;
  try {
    const tok = await D.token(t.ca);
    const oc = tok.onchain;
    el.innerHTML =
      `<span class="c-key">getAccountInfo</span>(<span class="c-str">"${esc(tok.ca.slice(0, 6))}…${esc(tok.ca.slice(-4))}"</span>)\n` +
      `<span class="c-dim">→</span> owner   <span class="c-str">${oc.program === 'token-2022' ? 'Token-2022' : 'SPL Token'}</span>\n` +
      `<span class="c-dim">→</span> type    <span class="c-str">mint</span> <span class="c-ok">✓</span>\n` +
      `<span class="c-dim">→</span> symbol  <span class="c-str">${esc(tok.symbol)}</span>\n` +
      `<span class="c-dim">→</span> decimals ${esc(oc.decimals)}\n` +
      `<span class="c-dim">→</span> mint authority ${oc.mintAuthority ? '<span class="c-str">active</span>' : '<span class="c-ok">revoked ✓</span>'}\n` +
      `<span class="c-dim">→</span> market cap <span class="c-str">${money(tok.cap)}</span>`;
  } catch {
    el.textContent = 'Every address is checked against the Solana blockchain before you can bet on it.';
  }
}
})();
