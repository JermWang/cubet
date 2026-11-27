/* cubet terminal.
   Tokens, logos, market caps and charts are live (see data.js / market.mjs). Every bet lives in the
   shared bet book on the server (book.mjs): every other player is a real visitor, nothing is simulated,
   and the server settles each bet on the real market cap at its exact expiry. Stakes are real SOL:
   players sign in with their Solana wallet, deposit to cubet's treasury and withdraw to their own wallet
   (wallet.js in the browser, payments.mjs on the server).

   How clicks work: any element with data-action="name" runs actions[name](element).
   Settings: config.js · Drawings: art.js · Effects: fx.js · Looks: styles.css */
(() => {
'use strict';

const cfg = window.CUBET;
const art = window.Art;
const D = window.CubetData;
const W = window.CubetWallet;
const LAMPORTS = 1e9;
const CUR = cfg.currency;

/* ---------- helpers ---------- */
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = D.money;
const amt = n => Number(Number(n).toFixed(n !== 0 && Math.abs(n) < 0.001 ? 6 : 4)).toString();
const coins = n => `${amt(n)} ${CUR}`;
const signed = n => (n > 0 ? '+' : '') + coins(n);
const shortCa = ca => `${ca.slice(0, 4)}…${ca.slice(-4)}`;
const isCa = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const nice = n => { const p = 10 ** (Math.floor(Math.log10(n)) - 1); return Math.round(n / p) * p; };
const slim = t => ({ ca: t.ca, symbol: t.symbol, name: t.name, image: t.image });
const chevron = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const outIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>';
const check = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function timeLeft(ms) {
  if (ms <= 0) return 'Ended';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

/* ---------- state ----------
   The bet book, balances and settlement live on the server. Only the theme is kept in this browser. */
const THEME_KEY = `${cfg.storageKey}-theme`;
const savedTheme = (() => { try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch { return 'dark'; } })();
const state = { me: null, balance: 0, bets: [], stats: null, theme: savedTheme, pay: null };
const ui = { tab: 'open', step: 1, draft: {}, chartTf: '1d', loading: true, dataError: null, busy: false };
const live = {};             // mint → latest market data
let toastTimer, returnFocus;

function saveTheme() { try { localStorage.setItem(THEME_KEY, state.theme); } catch { /* theme just won't persist */ } }
const nameOf = (b, side) => side === 'owner' ? (b.ownerIsMe ? 'You' : b.owner) : (b.takerIsMe ? 'You' : b.taker);
const tokenView = t => ({ ...t, ...(live[t.ca] || {}) });

/* ---------- page chrome ---------- */
function applyBrand() {
  document.title = `Terminal · ${cfg.brand.name}`;
  $$('[data-brand]').forEach(el => { el.textContent = cfg.brand.name; });
  $$('[data-footer]').forEach(el => { el.textContent = cfg.brand.footer; });
}
function applyTheme() { document.documentElement.dataset.theme = state.theme || 'dark'; }
function renderBalance() {
  const signedIn = Boolean(state.me);
  $('#balpill b').textContent = signedIn ? coins(state.balance) : 'Connect wallet';
  $('#balpill').setAttribute('aria-label', signedIn ? `Your wallet, ${coins(state.balance)}` : 'Connect your Solana wallet');
  $('#balpill2 b').textContent = signedIn ? coins(state.balance) : 'not connected';
  $$('[data-signed-in]').forEach(el => { el.hidden = !signedIn; });
  const note = $('#payNote');
  if (note && state.pay) note.hidden = state.pay.enabled;
}
function renderStats() {
  const s = state.stats || { open: 0, openPot: 0, inPlay: 0, players: 0 };
  const stat = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  $('#termStats').innerHTML =
    stat('Open bets', s.open) +
    stat('In open pots', coins(s.openPot)) +
    stat('In play', s.inPlay) +
    stat('Players', s.players);
}

/* ---------- bet list ---------- */
const inTab = (b, tab) => tab === 'mine' ? b.mine : tab === 'settled' ? (b.state === 'settled' || b.state === 'void' || (b.state === 'expired' && b.mine)) : b.state === 'open';

function progress(b, cap) {
  if (!Number.isFinite(cap) || !b.from || b.from === b.target) return null;
  return Math.max(0, Math.min(1, (cap - b.from) / (b.target - b.from)));
}

function actionFor(b) {
  if (b.state === 'settled') {
    if (b.won === true) return `<span class="pill win">Won ${coins(b.stake * 2 - (b.fee || 0))}</span>`;
    if (b.won === false) return '<span class="pill lose">Lost</span>';
    return `<span class="pill neutral">${b.creatorWon ? 'Creator won' : 'Taker won'}</span>`;
  }
  if (b.state === 'void') return '<span class="pill neutral">Void · refunded</span>';
  if (b.state === 'expired') return '<span class="pill neutral">No taker · refunded</span>';
  if (b.state === 'active') return `<span class="pill live"><i></i>${Date.now() >= b.expiresAt ? 'Settling…' : 'In play'}</span>`;
  if (b.ownerIsMe) return `<button class="btn ghost" type="button" data-action="cancel" data-id="${esc(b.id)}">Cancel</button>`;
  if (b.takeUntil && Date.now() > b.takeUntil) return '<span class="pill neutral">Closed to takers</span>';
  return `<button class="btn" type="button" data-action="take" data-id="${esc(b.id)}">Take bet</button>`;
}

function row(b, i) {
  const t = tokenView(b.token), up = b.dir === 'above', id = esc(b.id), sym = esc(t.symbol);
  const cap = b.state === 'settled' ? b.settledCap : live[t.ca]?.cap;
  const prog = progress(b, cap);
  const versus = b.taker ? `${esc(nameOf(b, 'owner'))} vs ${esc(nameOf(b, 'taker'))}` : esc(nameOf(b, 'owner'));
  const timeCell = b.state === 'settled' || b.state === 'expired'
    ? `<span class="days">${new Date(b.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>`
    : `<span class="days" data-ends="${b.expiresAt}">${timeLeft(b.expiresAt - Date.now())}</span>`;
  const rule = b.state === 'settled'
    ? `Settled at <b>${money(b.settledCap)}</b> market cap at expiry. ${b.creatorWon ? 'The creator' : 'The taker'} took the pot.`
    : `The taker wins if ${sym} finishes ${up ? 'at or below' : 'at or above'} ${money(b.target)}. Settled with the real market cap at expiry.`;
  return `<article class="row spot${b.state === 'active' ? ' is-live' : ''}" style="--i:${i}" data-id="${id}" aria-label="${sym} ${b.dir} ${money(b.target)} market cap">
    <div class="cell">
      <button class="tokbtn" type="button" data-action="chart" data-id="${id}" aria-label="Open the chart for ${sym}">${art.token(t)}</button>
      <div class="stack">
        <button class="t linkbtn" type="button" data-action="chart" data-id="${id}">${sym}</button>
        <span class="s ca"><button class="cabtn" type="button" data-action="copy" data-copy="${esc(t.ca)}" aria-label="Copy contract address">${esc(shortCa(t.ca))}</button><a href="${D.dexscreener(t.ca)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${sym} on DexScreener">${outIcon}</a></span>
      </div>
    </div>
    <div class="cell">${art.trend(b.dir)}<div class="stack">
      <span class="t big">${money(b.target)}</span>
      <span class="s">${up ? 'Higher' : 'Lower'} · from ${money(b.from)}</span>
      <span class="nowcap" data-cap="${esc(t.ca)}">${b.state === 'settled' ? 'final' : 'now'} <b>${money(cap)}</b></span>
      <span class="prog ${up ? 'up' : 'down'}"${prog == null ? ' hidden' : ''}><i style="--p:${prog ?? 0}"></i></span>
    </div></div>
    <div class="cell time">${art.clock()}${timeCell}</div>
    <div class="vs" aria-hidden="true"><span>VS</span></div>
    <div class="cell who">${art.avatar(b.taker && b.ownerIsMe ? b.taker : b.owner)}<div class="stack"><span class="t">${coins(b.stake)}</span><span class="s">${versus}</span></div></div>
    <div class="act">${actionFor(b)}<button class="rowx" type="button" data-action="expand" data-id="${id}" aria-expanded="false" aria-controls="p_${id}" aria-label="Show what this bet means">${chevron}</button></div>
    <div class="rowp-wrap" id="p_${id}" hidden>
      <div class="rowp">
        <div class="rowp-say">
          <p class="rowp-head">${sym} must finish <b>${b.dir} ${money(b.target)}</b> at ${new Date(b.expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} for the creator to win.</p>
          <p class="rowp-rule">${rule} Both sides are real wallets staking real ${CUR}.${b.state === 'settled' ? ` <a href="/proof#s-${id}">How it settled</a>` : ''}</p>
        </div>
        <div class="rowp-stat"><span class="k">Prize pool</span><span class="v">${coins(b.stake * 2)}</span>${feeLine(b.stake * 2)}</div>
      </div>
    </div>
  </article>`;
}

const skeleton = n => Array.from({ length: n }, (_, i) => `<div class="row skel" style="--i:${i}" aria-hidden="true"><i></i><i></i><i></i><i></i></div>`).join('');

function emptyState(filtered) {
  const title = ui.tab === 'mine' ? 'No bets yet' : ui.tab === 'settled' ? 'Nothing settled yet' : 'No open bets';
  const hint = filtered ? 'Try another coin filter.' : ui.tab === 'mine' ? 'Create or take a bet to see it here.' : ui.tab === 'settled' ? 'Finished bets appear here.' : 'Every bet here is from a real player. Make the first call.';
  return `<div class="empty"><span class="empty-art">${art.cubeMark()}</span><b>${title}</b>${hint}</div>`;
}

function renderFilter() {
  const sel = $('#coinFilter'), keep = sel.value;
  const unique = [...new Map(state.bets.map(b => [b.token.ca, b.token])).values()];
  sel.innerHTML = '<option value="">All coins</option>' + unique.map(t => `<option value="${esc(t.ca)}">${esc(t.symbol)}</option>`).join('');
  sel.value = unique.some(t => t.ca === keep) ? keep : '';
}

function renderList() {
  renderFilter();
  const filter = $('#coinFilter').value;
  const bets = state.bets.filter(b => inTab(b, ui.tab) && (!filter || b.token.ca === filter))
    .sort((a, b) => ui.tab === 'settled' ? b.expiresAt - a.expiresAt : a.expiresAt - b.expiresAt);
  const list = $('#list');
  // The list sits above the bet wizard. When it grows or shrinks (another player's bet arrives), keep
  // whatever the visitor is looking at in place. Chrome and Firefox do this natively (scroll anchoring);
  // Safari doesn't, so pin the wizard by hand there.
  const pin = !CSS.supports('overflow-anchor', 'auto') && $('#createForm');
  const pinTop = pin && pin.getBoundingClientRect().top < innerHeight ? pin.getBoundingClientRect().top : null;
  if (ui.loading && !bets.length && ui.tab === 'open') list.innerHTML = skeleton(4);
  else list.innerHTML = bets.length ? bets.map(row).join('') : emptyState(Boolean(filter));
  if (pinTop !== null) window.scrollBy(0, pin.getBoundingClientRect().top - pinTop);
  $$('[data-tab]').forEach(btn => {
    const on = btn.dataset.tab === ui.tab;
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
  });
  for (const tab of ['open', 'mine', 'settled']) $(`[data-count="${tab}"]`).textContent = state.bets.filter(b => inTab(b, tab)).length;
  $('#dataNote').hidden = !ui.dataError;
  renderBalance();
  renderStats();
}

// Live caps refresh in place, so rows don't re-animate every few seconds.
function paintLive() {
  $$('#list .row[data-id]').forEach(rowEl => {
    const b = state.bets.find(x => x.id === rowEl.dataset.id);
    if (!b || b.state === 'settled') return;
    const cap = live[b.token.ca]?.cap;
    const capEl = $('.nowcap b', rowEl);
    if (capEl && Number.isFinite(cap)) {
      const before = capEl.textContent, after = money(cap);
      if (before !== after) { capEl.textContent = after; capEl.classList.remove('tick'); void capEl.offsetWidth; capEl.classList.add('tick'); }
    }
    const p = progress(b, cap), bar = $('.prog', rowEl);
    if (bar) { bar.hidden = p == null; $('i', bar).style.setProperty('--p', p ?? 0); }
  });
}

/* ---------- live data + the shared bet book ---------- */
async function refreshLive() {
  const mints = new Set(cfg.featured);
  state.bets.forEach(b => { if (b.state === 'open' || b.state === 'active') mints.add(b.token.ca); });
  try {
    Object.assign(live, await D.tokens([...mints]));
    ui.dataError = null;
  } catch (err) {
    ui.dataError = err.message;
  }
  $('#dataNote').hidden = !ui.dataError;
  paintLive();
}

// Tell the player when something happens to one of their bets (taken, settled, refunded).
function announce(before, after) {
  for (const b of after) {
    const old = before.get(b.id);
    if (!old || !b.mine || old.state === b.state) continue;
    if (b.state === 'active' && b.ownerIsMe) toast(`${b.taker} took your ${b.token.symbol} bet.`);
    else if (b.state === 'settled') { toast(b.won ? `You won ${coins(b.stake * 2 - (b.fee || 0))} on ${b.token.symbol}!` : `${b.token.symbol} settled at ${money(b.settledCap)}. You lost this one.`); if (b.won) burst(); }
    else if (b.state === 'expired') toast(`No one took your ${b.token.symbol} bet. Stake refunded.`);
    else if (b.state === 'void') toast(`${b.token.symbol}: no market data at expiry, so the bet is void and both stakes were refunded.`);
  }
}

let loadingBook = false;
async function loadBook({ quiet = false } = {}) {
  if (loadingBook) return;
  loadingBook = true;
  try {
    const [snap, me] = await Promise.all([D.book(), D.session()]);
    const before = new Map(state.bets.map(b => [b.id, b]));
    const isNew = snap.bets.some(b => !before.has(b.id)) || snap.bets.length !== before.size || snap.bets.some(b => before.get(b.id)?.state !== b.state);
    if (!quiet && before.size) announce(before, snap.bets);
    Object.assign(state, { bets: snap.bets, stats: snap.stats, me, balance: me?.balance ?? 0 }); // me is null until a wallet signs in
    ui.bookError = null;
    if (isNew || ui.loading) renderList(); else { renderBalance(); renderStats(); }
    if (!$('#leaderView').hidden) renderLeader();
  } catch (err) {
    ui.bookError = err.message;
    if (ui.loading) toast(`Could not load bets: ${err.message}`);
  } finally { loadingBook = false; }
}

// Run a server action, show its error if it fails, then reload the book.
async function act(fn, done) {
  if (ui.busy) return;
  ui.busy = true;
  try {
    const out = await fn();
    if (out?.player) Object.assign(state, { me: out.player, balance: out.player.balance });
    await loadBook({ quiet: true });
    done?.(out);
  } catch (err) {
    toast(err.message);
  } finally { ui.busy = false; }
}

/* ---------- leaderboard ---------- */
async function renderLeader() {
  const plClass = n => n > 0 ? 'pos' : n < 0 ? 'neg' : '';
  let list;
  try { list = (await D.leaderboard()).map(p => ({ ...p, name: p.me ? 'You' : p.name })); }
  catch (err) { $('#lb').innerHTML = `<p class="chart-msg">${esc(err.message)}</p>`; return; }
  if (!list.length) {
    $('#podium').innerHTML = '';
    $('#lb').innerHTML = `<div class="empty"><span class="empty-art">${art.cubeMark()}</span><b>No players yet</b>Create or take a bet and you're on the board.</div>`;
    return;
  }
  $('#podium').innerHTML = list.length >= 3 ? art.topThree(list.slice(0, 3), signed) : '';
  $('#lb').innerHTML = '<div class="lr head"><span>#</span><span>Player</span><span>Record</span><span class="hide-s">In play</span><span class="hide-s num">P/L</span></div>' +
    list.map((p, i) => `<div class="lr${p.me ? ' me' : ''}"><span class="rank">${i + 1}</span><span class="player">${art.avatar(p.name)}<span>${esc(p.name)}</span></span><span>${p.w}W · ${p.l}L</span><span class="hide-s">${coins(p.inPlay)}</span><span class="hide-s num ${plClass(p.pl)}">${signed(p.pl)}</span></div>`).join('');
}

function navigate(where) {
  const leader = where === 'leader';
  $('#betView').hidden = leader;
  $('#leaderView').hidden = !leader;
  $$('.links button').forEach(b => b.dataset.go === where ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  if (leader) { renderLeader(); window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' }); return; }
  ui.tab = where === 'mine' ? 'mine' : 'open';
  renderList();
  if (where === 'mine') $('#betView').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
}

/* ---------- modals, toasts, confetti ---------- */
function openModal(title, content, cls = '') {
  returnFocus = document.activeElement;
  $('#modalRoot').innerHTML = `<div class="scrim"><section class="modal ${cls}" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><button class="modal-close" type="button" data-action="close" aria-label="Close dialog">×</button><h3 id="modalTitle">${esc(title)}</h3>${content}</section></div>`;
  document.body.style.overflow = 'hidden';
  ($('#modalRoot input:not([type=hidden])') || $('#modalRoot button')).focus();
}
function closeModal() {
  $('#modalRoot').replaceChildren();
  document.body.style.overflow = '';
  ui.modalBet = null;
  if (returnFocus?.isConnected) returnFocus.focus();
}
function toast(message) {
  clearTimeout(toastTimer);
  $('#toastRoot').innerHTML = `<div class="toast" role="status"><span class="toast-dot" aria-hidden="true"></span>${esc(message)}</div>`;
  toastTimer = setTimeout(() => $('#toastRoot').replaceChildren(), 4000);
}
function burst(count = 18) {
  if (reduceMotion()) return;
  const colors = ['#5B8CFF', '#9DBBFF', '#7B61FF', '#3DDC97', '#DCE8FF'];
  const root = $('#fxRoot');
  root.innerHTML = Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.4, d = 110 + Math.random() * 170;
    return `<span class="spark-p" style="--c:${colors[i % colors.length]};--s:${4 + Math.random() * 6}px;--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d - 60}px"></span>`;
  }).join('');
  setTimeout(() => root.replaceChildren(), 1300);
}

/* ---------- charts ---------- */
const TFS = [['1h', '1H'], ['1d', '1D'], ['1w', '1W'], ['1m', '1M']];
const tfTabs = (active, scope) => `<div class="tf" role="group" aria-label="Chart range">${TFS.map(([v, l]) => `<button type="button" data-action="tf" data-scope="${scope}" data-tf="${v}" aria-pressed="${v === active}">${l}</button>`).join('')}</div>`;

async function drawChart(host, t, { target, dir, tf, animate = true }) {
  if (!host) return;
  if (!host.querySelector('svg')) host.innerHTML = '<div class="chart-skel" aria-hidden="true"></div>';
  try {
    const { points } = await D.chart(t.ca, tf);
    if (!host.isConnected) return;
    const valid = Number.isFinite(target) && target > 0;
    host.innerHTML = points.length
      ? art.chart(points.map(p => p[1]), { times: points.map(p => p[0]), target: valid ? target : null, dir, animate, nowLabel: money(live[t.ca]?.cap ?? points.at(-1)[1]), targetLabel: valid ? money(target) : '', label: `${t.symbol} market cap, ${tf}` })
      : '<p class="chart-msg">No trades in this range yet.</p>';
  } catch (err) {
    if (host.isConnected) host.innerHTML = `<p class="chart-msg">${esc(err.message)}</p>`;
  }
}

function onchainFacts(tok) {
  const oc = tok.onchain || {};
  const fact = (k, v, good) => `<div><span>${k}</span><b class="${good === true ? 'pos' : good === false ? 'warn' : ''}">${v}</b></div>`;
  let supply = '—';
  try { if (oc.supply && Number.isFinite(oc.decimals)) supply = Number(BigInt(oc.supply) / 10n ** BigInt(oc.decimals)).toLocaleString('en-US'); } catch { /* keep the dash */ }
  return `<div class="facts">
    ${fact('Program', oc.program === 'token-2022' ? 'Token-2022' : 'SPL Token')}
    ${fact('Supply', supply)}
    ${fact('Mint authority', oc.mintAuthority ? 'Active' : 'Revoked', !oc.mintAuthority)}
    ${fact('Freeze authority', oc.freezeAuthority ? 'Active' : 'Revoked', !oc.freezeAuthority)}
    ${fact('Liquidity', money(tok.liquidity))}
    ${fact('24h volume', money(tok.volume24h))}
  </div>`;
}

async function chartModal(b) {
  const t = tokenView(b.token);
  openModal(t.symbol, `<section class="coincard">
      <div class="cc-head">${art.token(t)}<div class="cc-names"><b>${esc(t.symbol)}<span>/${CUR}</span></b><span>${esc(t.name || '')}</span></div>
        <div class="cc-mcap"><span>Market cap</span><b data-cc-cap>${money(t.cap)}</b><span class="chg ${t.change >= 0 ? 'up' : 'down'}">${D.pct(t.change)} 24h</span></div></div>
      <div class="cc-bar">${tfTabs(ui.chartTf, 'modal')}<span class="cc-live"><i></i>Live</span></div>
      <div class="cc-plot" id="modalChart"></div>
      <div id="modalFacts"><div class="facts skel-facts"></div></div>
      <div class="cc-links"><a href="${D.dexscreener(t.ca)}" target="_blank" rel="noopener noreferrer">DexScreener ${outIcon}</a><a href="${D.explorer(t.ca)}" target="_blank" rel="noopener noreferrer">Solscan ${outIcon}</a></div>
    </section><div class="mact"><button class="btn" type="button" data-action="close">Done</button></div>`, 'wide');
  ui.modalBet = b;
  drawChart($('#modalChart'), t, { target: b.target, dir: b.dir, tf: ui.chartTf });
  try {
    const tok = await D.token(t.ca);
    live[t.ca] = { ...live[t.ca], ...tok };
    if ($('#modalFacts')) {
      $('#modalFacts').innerHTML = `<p class="verified">${check} Verified on-chain mint</p>` + onchainFacts(tok);
      $('[data-cc-cap]').textContent = money(tok.cap);
    }
  } catch (err) {
    if ($('#modalFacts')) $('#modalFacts').innerHTML = `<p class="chart-msg">${esc(err.message)}</p>`;
  }
}

/* ---------- wallet + money modals ---------- */
const feePct = () => (state.pay?.feeBps || 0) / 100;
const feeLine = pot => feePct() ? `<span class="s">${feePct()}% fee on the pot · winner gets ${coins(pot * (1 - feePct() / 100))}</span>` : '';
const shortW = w => `${w.slice(0, 4)}…${w.slice(-4)}`;
const acctLink = w => `<a href="${D.account(w, state.pay?.cluster)}" target="_blank" rel="noopener noreferrer">${esc(shortW(w))} ${outIcon}</a>`;
const txLink = (url, label = 'View on Solscan') => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label} ${outIcon}</a>`;
const payOff = () => state.pay && !state.pay.enabled;

function connectModal(next) {
  ui.afterConnect = next || null;
  const list = W.list();
  const body = list.length
    ? `<div class="wlist">${list.map(w => `<button class="wbtn" type="button" data-action="connect-wallet" data-name="${esc(w.name)}">${w.icon ? `<img src="${esc(w.icon)}" alt="" width="28" height="28">` : ''}<span>${esc(w.name)}</span></button>`).join('')}</div>
       <p class="note">You'll sign a one-time message to prove you own the wallet. Signing is free and is not a transaction.</p>`
    : W.isMobile()
      ? `<p>Open cubet inside your wallet app to connect:</p><div class="wlist">${W.mobileLinks().map(l => `<a class="wbtn" href="${esc(l.url)}">${esc(l.name)}</a>`).join('')}</div>`
      : `<p>No Solana wallet was found in this browser. Install one, then reload this page:</p>
         <div class="wlist"><a class="wbtn" href="https://phantom.com/download" target="_blank" rel="noopener noreferrer">Phantom</a><a class="wbtn" href="https://solflare.com/download" target="_blank" rel="noopener noreferrer">Solflare</a><a class="wbtn" href="https://backpack.app/download" target="_blank" rel="noopener noreferrer">Backpack</a></div>`;
  openModal('Connect a Solana wallet', `${body}<p id="connectError" class="err" role="alert"></p>`);
}
// Only signed-in wallets can bet; this runs `fn` now, or after the player connects.
const withWallet = fn => (state.me ? fn() : connectModal(fn));

async function walletModal() {
  if (!state.me) return connectModal();
  const w = state.me.wallet;
  openModal('Your wallet', `<p>Signed in as <b>${acctLink(w)}</b></p>
    <div class="summary"><div class="hl"><span>cubet balance</span><b>${coins(state.balance)}</b></div></div>
    ${payOff() ? '<p class="note">Deposits and withdrawals are not switched on yet.</p>' : ''}
    <div class="mact"><button class="btn" type="button" data-action="deposit">Deposit</button><button class="btn ghost" type="button" data-action="withdraw">Withdraw</button></div>
    <h4 class="mh">Recent transfers</h4><div class="txlist" id="txList"><p class="note"><span class="spinner" aria-hidden="true"></span>Loading…</p></div>
    <label class="field-label" for="theme">Appearance</label>
    <div class="selwrap"><select id="theme" class="sel full">${['dark', 'light', 'auto'].map(t => `<option value="${t}" ${state.theme === t ? 'selected' : ''}>${t === 'auto' ? 'System' : t === 'dark' ? 'Dark' : 'Light'}</option>`).join('')}</select>${chevron}</div>
    <div class="mact"><button class="btn ghost" type="button" data-action="disconnect">Disconnect</button></div>`);
  try {
    const mine = await D.myTransfers();
    const rows = [...mine.deposits.map(d => ({ ...d, kind: 'Deposit', sign: '+' })), ...mine.withdrawals.map(x => ({ ...x, kind: 'Withdrawal', sign: '−' }))]
      .sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 8);
    if ($('#txList')) $('#txList').innerHTML = rows.length
      ? rows.map(r => `<div class="txr"><span>${r.kind}</span><b>${r.sign}${coins(r.amount)}</b><span class="txs ${esc(r.status)}">${esc(r.status)}</span>${txLink(r.url, 'tx')}</div>`).join('')
      : '<p class="note">No deposits or withdrawals yet.</p>';
  } catch (err) { if ($('#txList')) $('#txList').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
}

function fundsModal(mode) {
  if (!state.me) return connectModal(() => fundsModal(mode));
  if (payOff()) return toast('Deposits and withdrawals are not switched on yet.');
  const dep = mode === 'deposit', p = state.pay || {};
  const max = dep ? '' : `max="${state.balance}"`;
  openModal(dep ? `Deposit ${CUR}` : `Withdraw ${CUR}`, `${dep
      ? `<p>Send ${CUR} from your connected wallet ${acctLink(state.me.wallet)} to cubet's treasury ${p.treasury ? acctLink(p.treasury) : ''}. It's added to your balance once Solana finalizes it, usually within 30 seconds.</p>`
      : `<p>${CUR} goes from cubet's treasury to your wallet ${acctLink(state.me.wallet)}. Withdrawals only ever go to the wallet you signed in with.</p>`}
    <form id="fundForm" data-mode="${mode}" novalidate>
      <label class="field-label" for="fundAmount">Amount (${CUR})</label>
      <input id="fundAmount" class="field-input" type="number" min="${dep ? p.minDeposit : p.minWithdraw}" ${max} step="0.001" value="${dep ? Math.max(p.minDeposit || 0.1, 0.1) : amt(state.balance)}" required>
      <p class="note">${dep ? `Minimum ${p.minDeposit} ${CUR}. Your wallet shows the exact amount and network fee before you approve.` : `Minimum ${p.minWithdraw} ${CUR}. A ${p.networkFee} ${CUR} network fee is taken from the amount. Up to ${p.maxWithdrawPerDay} ${CUR} per 24 hours.`}</p>
      <p id="fundError" class="err" role="alert"></p>
      <div id="fundStatus" class="fundstatus" aria-live="polite"></div>
      <div class="mact"><button class="btn ghost" type="button" data-action="close">Cancel</button><button class="btn" type="submit" id="fundGo">${dep ? `Deposit from wallet` : `Withdraw to wallet`}</button></div>
    </form>`);
}

const fundStatus = html => { if ($('#fundStatus')) $('#fundStatus').innerHTML = html; };
async function runDeposit(amount) {
  const lamports = Math.round(amount * LAMPORTS);
  let signature;
  try {
    signature = await W.deposit({ address: state.me.wallet, treasury: state.pay.treasury, lamports, cluster: state.pay.cluster,
      onStage: s => fundStatus(`<p><span class="spinner" aria-hidden="true"></span>${s === 'approve' ? 'Approve the transfer in your wallet…' : 'Sending…'}</p>`) });
  } catch (err) { fundStatus(''); throw err; }
  const url = `https://solscan.io/tx/${signature}${state.pay.cluster === 'mainnet-beta' ? '' : `?cluster=${state.pay.cluster}`}`;
  fundStatus(`<p><span class="spinner" aria-hidden="true"></span>Sent. Waiting for Solana to finalize it… ${txLink(url)}</p>`);
  // The server credits it once finalized; a background scanner also picks it up if this tab closes.
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, i < 5 ? 3000 : 5000));
    try {
      const out = await D.reportDeposit(signature);
      if (out.status === 'credited') { Object.assign(state, { me: out.player, balance: out.player.balance }); return { url }; }
    } catch { /* keep waiting */ }
  }
  throw Object.assign(new Error('Still waiting for the network. Your deposit will be credited automatically once it finalizes.'), { url });
}

function takeModal(id) {
  const b = state.bets.find(x => x.id === id);
  if (!b || b.state !== 'open' || b.ownerIsMe) return;
  if (!state.me) return connectModal(() => takeModal(id));
  const t = tokenView(b.token), short = state.balance < b.stake;
  openModal('Take the other side', `<div class="take-head">${art.token(t)}<div><b>${esc(t.symbol)}</b><span>now ${money(t.cap)} · ends in ${timeLeft(b.expiresAt - Date.now())}</span></div></div>
    <p>You win if ${esc(t.symbol)} finishes <b>${b.dir === 'above' ? 'at or below' : 'at or above'} ${money(b.target)}</b> when the bet ends.</p>
    <div class="summary"><div><span>Your stake</span><b>${coins(b.stake)}</b></div><div><span>Their stake</span><b>${coins(b.stake)}</b></div><div class="hl"><span>Prize pool</span><b>${coins(b.stake * 2)}</b></div></div>
    <p class="${short ? 'err' : 'note'}">${short ? `Deposit ${CUR} first to cover this stake.` : `You're betting against ${esc(b.owner)}, a real wallet. Settles automatically with the real market cap, and the winner is paid in ${CUR}.${feePct() ? ` cubet keeps ${feePct()}% of the pot.` : ''}`}</p>
    <div class="mact"><button class="btn ghost" type="button" data-action="close">Cancel</button>${short ? `<button class="btn" type="button" data-action="deposit">Deposit</button>` : `<button class="btn" type="button" data-action="take-confirm" data-id="${esc(id)}">Confirm bet</button>`}</div>`, 'wide');
}

/* ---------- create-a-bet wizard ---------- */
const popCard = t => `<button class="popc spot" type="button" data-action="pick" data-ca="${esc(t.ca)}" title="${esc(t.name || t.symbol)}">${art.token(t)}<div><b>${esc(t.symbol)}</b><span>${money(t.cap)}${Number.isFinite(t.change) ? `<span class="chg ${t.change >= 0 ? 'up' : 'down'}">${D.pct(t.change)}</span>` : ''}</span></div></button>`;

function stepCoin() {
  return `<div class="wiz-in">
    <h2 id="wTitle">Which coin?</h2>
    <p class="sub">Paste any Solana token address. We check it on-chain.</p>
    <div class="cabox glowfield" id="caBox">
      <span class="cabox-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/></svg></span>
      <label class="sr" for="wCa">Token contract address</label>
      <input id="wCa" placeholder="Paste token contract address (CA)" autocomplete="off" spellcheck="false">
      <button type="button" class="btn lg" id="wNext1" data-action="ca-next" disabled>Next →</button>
    </div>
    <div class="ca-result" id="caResult" aria-live="polite"></div>
    <div class="orline" aria-hidden="true">or</div>
    <div class="pophead"><p class="poplbl">Trending on Solana</p><span class="asof"><span class="live-dot" aria-hidden="true"></span>live</span></div>
    <div class="pop" id="popGrid">${Array.from({ length: 8 }, () => '<div class="popc skel" aria-hidden="true"></div>').join('')}</div>
  </div>`;
}

async function fillTrending() {
  if (!$('#popGrid')) return;
  let list = [];
  try { list = await D.trending(); } catch { /* fall back to featured coins */ }
  if (list.length < 4) list = list.concat(Object.values(await D.tokens(cfg.featured).catch(() => ({}))));
  list.forEach(t => { live[t.ca] = { ...live[t.ca], ...t }; });
  if ($('#popGrid')) $('#popGrid').innerHTML = list.length ? list.slice(0, 8).map(popCard).join('') : '<p class="chart-msg">Live data is unavailable. Paste an address instead.</p>';
}

function stepBet() {
  const t = tokenView(ui.draft.token), d = ui.draft;
  const target = d.target || nice(t.cap * (d.dir === 'below' ? 0.6 : 1.5));
  return `<div class="wiz-in">
    <h2 id="wTitle">What's your call?</h2>
    <div class="coinhead">${art.token(t)}<b>$${esc(t.symbol)}</b><span>now <b data-cap-head>${money(t.cap)}</b></span><span class="chg ${t.change >= 0 ? 'up' : 'down'}">${D.pct(t.change)}</span></div>
    <div class="chartcard spot"><div class="cc-bar">${tfTabs(ui.chartTf, 'wiz')}<span class="cc-live"><i></i>Live</span></div><div id="betChart"></div></div>
    <p class="callq">Where's it going?</p>
    <div class="callseg" role="group" aria-label="Your call">
      <button class="up" type="button" data-action="dir" data-dir="above" aria-pressed="${d.dir === 'above'}">${art.trend('above')}<span>Higher</span></button>
      <button class="down" type="button" data-action="dir" data-dir="below" aria-pressed="${d.dir === 'below'}">${art.trend('below')}<span>Lower</span></button>
    </div>
    <form id="betForm" novalidate>
      <div class="details">
        <div class="bx"><label for="target">Target market cap</label><div class="bigin"><span class="u">$</span><input id="target" type="number" min="1" step="any" value="${Math.round(target)}" required></div><span class="hint" id="targetHint"></span></div>
        <div class="bx"><label for="stake">Your stake</label><div class="bigin"><input id="stake" type="number" min="${cfg.minStake}" max="${cfg.maxStake}" step="0.01" value="${d.stake || cfg.defaultStake}" required><span class="u">${CUR}</span></div></div>
        <div class="bx"><label for="duration">Time to target</label><div class="selwrap"><select class="sel full" id="duration">${cfg.durations.map(x => `<option ${d.duration === x.label ? 'selected' : ''}>${x.label}</option>`).join('')}</select>${chevron}</div></div>
        <div class="bx"><span class="lbl">Available balance</span><div class="bigin" id="balBox">${state.me ? `${amt(state.balance)} <span class="u">${CUR}</span>` : '<button class="btn sm" type="button" data-action="wallet">Connect wallet</button>'}</div></div>
      </div>
      <p class="whint err" id="betError" role="alert"></p>
      <div class="wnav"><button type="button" class="btn lg ghost" data-action="wstep" data-step="1">← Back</button><button class="btn lg" type="submit">Next →</button></div>
    </form>
  </div>`;
}

function targetHint() {
  const t = tokenView(ui.draft.token || {}), el = $('#targetHint'), v = Number($('#target')?.value);
  if (!el || !t.cap || !v) return;
  const pct = ((v - t.cap) / t.cap) * 100;
  el.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(pct > -10 && pct < 10 ? 1 : 0)}% from now`;
}

function stepConfirm() {
  const d = ui.draft, t = tokenView(d.token);
  return `<div class="wiz-in narrow">
    <h2 id="wTitle">Confirm your bet.</h2>
    <p class="sub">It goes live as soon as you confirm.</p>
    <div class="recap">
      <div><span>Coin</span><span class="recap-coin">${art.token(t)}${esc(t.symbol)}</span></div>
      <div><span>Your call</span><span class="${d.dir === 'above' ? 'pos' : 'neg'}">${d.dir === 'above' ? 'Higher' : 'Lower'} than ${money(d.target)}</span></div>
      <div><span>Market cap now</span><span>${money(t.cap)}</span></div>
      <div><span>Ends</span><span>in ${esc(d.duration)}</span></div>
      <div><span>Your stake</span><span>${coins(d.stake)}</span></div>
      <div class="hl"><span>Prize pool</span><span>${coins(d.stake * 2)}</span></div>
      ${feePct() ? `<div><span>If you win</span><span>${coins(d.stake * 2 * (1 - feePct() / 100))} after the ${feePct()}% fee</span></div>` : ''}
    </div>
    <p class="whint">Settles automatically with the real market cap at expiry · real ${CUR}</p>
    <div class="wnav"><button class="btn lg ghost" type="button" data-action="wstep" data-step="2">← Back</button><button class="btn lg" type="button" data-action="create">Create bet →</button></div>
  </div>`;
}

function wizard(step) {
  ui.step = step;
  const body = $('#wizBody');
  body.dataset.step = String(step);
  $$('#stepper li').forEach((li, i) => {
    const n = i + 1;
    li.className = n === step ? 'cur' : n < step ? 'done' : '';
    if (n === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    $('button', li).disabled = n >= step;
  });
  $('#wizBack').hidden = step === 1;
  $('#wizBack').setAttribute('aria-label', `Back to ${step === 2 ? 'Coin' : 'Bet'}`);
  body.innerHTML = step === 1 ? stepCoin() : step === 2 ? stepBet() : stepConfirm();
  if (step === 1) fillTrending();
  if (step === 2) { refreshBetChart(true); targetHint(); }
}

function refreshBetChart(animate = false) {
  if (!$('#betChart') || !ui.draft.token) return;
  const target = Number($('#target')?.value);
  drawChart($('#betChart'), tokenView(ui.draft.token), { target: ui.draft.dir ? target : null, dir: ui.draft.dir, tf: ui.chartTf, animate });
}

// Verify a pasted address on-chain (debounced while typing).
let caTimer, caSeq = 0;
function checkCa(value) {
  clearTimeout(caTimer);
  const out = $('#caResult'), next = $('#wNext1');
  ui.draft = {};
  next.disabled = true;
  $('#caBox').classList.remove('bad', 'good');
  if (!value) { out.innerHTML = ''; return; }
  if (!isCa(value)) { $('#caBox').classList.add('bad'); out.innerHTML = '<p class="ca-msg err">Enter a 32–44 character Solana address.</p>'; return; }
  out.innerHTML = '<p class="ca-msg"><span class="spinner" aria-hidden="true"></span>Checking on-chain…</p>';
  const seq = ++caSeq;
  caTimer = setTimeout(async () => {
    try {
      const tok = await D.token(value);
      if (seq !== caSeq) return;
      live[tok.ca] = { ...live[tok.ca], ...tok };
      if (!tok.tradable) {
        $('#caBox').classList.add('bad');
        out.innerHTML = `<div class="ca-card">${art.token(tok)}<div><b>${esc(tok.symbol)}</b><span>${esc(tok.name)}</span></div><p class="ca-msg err">Real token, but it has no DEX market cap to bet on.</p></div>`;
        return;
      }
      ui.draft = { token: slim(tok) };
      $('#caBox').classList.add('good');
      next.disabled = false;
      out.innerHTML = `<div class="ca-card">${art.token(tok)}<div><b>${esc(tok.symbol)}</b><span>${esc(tok.name)}</span></div><div class="ca-cap"><b>${money(tok.cap)}</b><span class="chg ${tok.change >= 0 ? 'up' : 'down'}">${D.pct(tok.change)}</span></div><p class="verified">${check} Verified ${tok.onchain.program === 'token-2022' ? 'Token-2022' : 'SPL'} mint on Solana</p></div>`;
    } catch (err) {
      if (seq !== caSeq) return;
      $('#caBox').classList.add('bad');
      out.innerHTML = `<p class="ca-msg err">${esc(err.message)}</p>`;
    }
  }, 350);
}

/* ---------- actions (data-action="…") ---------- */
const scrollBehavior = () => (reduceMotion() ? 'auto' : 'smooth');
const findBet = id => state.bets.find(b => b.id === id);

const actions = {
  go: el => navigate(el.dataset.go),
  'start-create': () => {
    navigate('bet');
    $('#createForm').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    $('#wCa')?.focus({ preventScroll: true });
  },
  tab: el => { ui.tab = el.dataset.tab; renderList(); },
  close: () => closeModal(),

  wallet: () => walletModal(),
  deposit: () => fundsModal('deposit'),
  withdraw: () => fundsModal('withdraw'),
  'connect-wallet': async el => {
    if (ui.busy) return;
    ui.busy = true;
    el.disabled = true;
    $('#connectError').textContent = '';
    try {
      const player = await W.signIn(el.dataset.name);
      Object.assign(state, { me: player, balance: player.balance });
      const next = ui.afterConnect;
      closeModal();
      toast(`Connected ${shortW(player.wallet)}.`);
      ui.busy = false;
      await loadBook({ quiet: true });
      renderList();
      if (ui.step === 2) wizard(2);
      next?.();
    } catch (err) {
      if ($('#connectError')) $('#connectError').textContent = err.message;
      el.disabled = false;
    } finally { ui.busy = false; }
  },
  disconnect: async () => {
    try { await W.disconnect(); } catch { /* the cookie is cleared server-side anyway */ }
    Object.assign(state, { me: null, balance: 0 });
    closeModal(); renderList(); toast('Disconnected.');
    loadBook({ quiet: true });
  },

  copy: async el => {
    try { await navigator.clipboard.writeText(el.dataset.copy); toast('Contract address copied.'); }
    catch { toast('Copy is unavailable in this browser.'); }
  },
  chart: el => { const b = findBet(el.dataset.id); if (b) chartModal(b); },
  tf: el => {
    ui.chartTf = el.dataset.tf;
    $$(`[data-action="tf"][data-scope="${el.dataset.scope}"]`).forEach(b => b.setAttribute('aria-pressed', String(b === el)));
    if (el.dataset.scope === 'modal' && ui.modalBet) drawChart($('#modalChart'), tokenView(ui.modalBet.token), { target: ui.modalBet.target, dir: ui.modalBet.dir, tf: ui.chartTf });
    else refreshBetChart(true);
  },
  expand: el => {
    const panel = document.getElementById('p_' + el.dataset.id);
    panel.hidden = !panel.hidden;
    el.setAttribute('aria-expanded', String(!panel.hidden));
    el.closest('.row').classList.toggle('expanded', !panel.hidden);
  },

  pick: el => {
    const t = live[el.dataset.ca];
    if (!t?.cap) return toast('No live market cap for this coin right now.');
    ui.draft = { token: slim(t) };
    wizard(2);
  },
  'ca-next': () => { if (ui.draft.token) wizard(2); },
  wstep: el => wizard(Number(el.dataset.step)),
  'wiz-back': () => wizard(ui.step - 1),
  dir: el => {
    const d = ui.draft, input = $('#target'), cap = tokenView(d.token).cap;
    d.dir = el.dataset.dir;
    $$('[data-action="dir"]').forEach(b => b.setAttribute('aria-pressed', String(b === el)));
    const target = Number(input.value);
    if (d.dir === 'above' && !(target > cap)) input.value = Math.round(nice(cap * 1.5));
    if (d.dir === 'below' && !(target < cap)) input.value = Math.round(nice(cap * 0.6));
    $('#betError').textContent = '';
    targetHint();
    refreshBetChart();
  },
  create: () => {
    const d = ui.draft;
    if (!state.me) return connectModal();
    if (state.balance < d.stake) return fundsModal('deposit');
    act(() => D.createBet({ mint: d.token.ca, dir: d.dir, target: d.target, duration: d.duration, stake: d.stake }), () => {
      $('#coinFilter').value = '';
      ui.tab = 'mine'; ui.draft = {};
      renderList(); wizard(1);
      $('#tabs').scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
      burst(12);
      toast('Your bet is live in the book. Any player can take the other side.');
    });
  },

  take: el => withWallet(() => takeModal(el.dataset.id)),
  'take-confirm': el => {
    const b = findBet(el.dataset.id);
    if (!b || b.state !== 'open' || b.ownerIsMe) return;
    act(() => D.takeBet(b.id), () => { closeModal(); toast('Bet taken. It settles automatically when time runs out.'); });
  },
  cancel: el => {
    const b = findBet(el.dataset.id);
    if (!b?.ownerIsMe || b.state !== 'open') return;
    act(() => D.cancelBet(b.id), () => toast('Bet cancelled. Stake returned.'));
  },
};

/* ---------- event wiring ---------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) { if (e.target.classList.contains('scrim')) closeModal(); return; }
  if (el.disabled) return;
  actions[el.dataset.action]?.(el, e);
});

let chartTimer;
document.addEventListener('input', e => {
  if (e.target.id === 'wCa') checkCa(e.target.value.trim());
  if (e.target.id === 'target') { targetHint(); clearTimeout(chartTimer); chartTimer = setTimeout(() => refreshBetChart(), 120); }
});

document.addEventListener('change', e => {
  if (e.target.id === 'coinFilter') renderList();
  if (e.target.id === 'theme') { state.theme = e.target.value; applyTheme(); saveTheme(); }
});

document.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.id === 'fundForm') {
    if (ui.busy) return;
    const amount = Number($('#fundAmount').value), dep = e.target.dataset.mode === 'deposit', p = state.pay;
    const min = dep ? p.minDeposit : p.minWithdraw;
    if (!Number.isFinite(amount) || amount < min || (!dep && amount > state.balance)) {
      $('#fundError').textContent = dep ? `Enter at least ${min} ${CUR}.` : `Enter between ${min} and ${amt(state.balance)} ${CUR}.`;
      return;
    }
    $('#fundError').textContent = '';
    $('#fundGo').disabled = true;
    ui.busy = true;
    try {
      if (dep) {
        await runDeposit(amount);
        fundStatus(`<p class="ok">${check} Deposit credited. Balance: <b>${coins(state.balance)}</b></p>`);
        toast(`Deposit credited: ${coins(amount)}.`);
      } else {
        const out = await D.withdraw(amount);
        Object.assign(state, { me: out.player, balance: out.player.balance });
        fundStatus(`<p class="ok">${check} Sent ${coins(out.amount)} to your wallet. ${txLink(out.url)}</p>`);
        toast(`Withdrawal sent: ${coins(out.amount)}.`);
      }
      $('#fundGo').hidden = true;
      $('[data-action="close"]', e.target).textContent = 'Done';
      renderBalance();
      loadBook({ quiet: true });
    } catch (err) {
      $('#fundError').innerHTML = `${esc(err.message)}${err.url ? ` ${txLink(err.url)}` : ''}`;
      $('#fundGo').disabled = false;
    } finally { ui.busy = false; }
  }
  if (e.target.id === 'betForm') {
    const d = ui.draft, target = Number($('#target').value), stake = Number($('#stake').value), err = $('#betError');
    if (!d.dir) { err.textContent = 'Choose Higher or Lower.'; return; }
    // validate against the freshest market cap
    try { const tok = await D.token(d.token.ca); live[tok.ca] = { ...live[tok.ca], ...tok }; } catch { /* use the last known cap */ }
    const cap = tokenView(d.token).cap;
    if (!Number.isFinite(target) || (d.dir === 'above' && target <= cap) || (d.dir === 'below' && target >= cap)) {
      err.textContent = `Choose a target ${d.dir} the current market cap (${money(cap)}).`; return;
    }
    if (!Number.isFinite(stake) || stake < cfg.minStake || stake > cfg.maxStake) { err.textContent = `Stakes are ${cfg.minStake} to ${cfg.maxStake} ${CUR}.`; return; }
    if (state.me && stake > state.balance) { err.innerHTML = `Deposit enough ${CUR} to cover your stake. <button class="linkbtn" type="button" data-action="deposit">Deposit</button>`; return; }
    Object.assign(d, { target, stake, duration: $('#duration').value });
    wizard(3);
  }
});

// Modal focus trap, Escape to close, arrow keys between tabs, Enter in the CA field.
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'wCa' && !$('#wNext1').disabled) { e.preventDefault(); actions['ca-next'](); return; }
  if ($('#modalRoot').children.length) {
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Tab') {
      const f = $$('button:not(:disabled),input,select,a[href]', $('#modalRoot'));
      const first = f[0], last = f.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  } else if (e.target.matches('[data-tab]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    const tabs = $$('[data-tab]');
    let i = tabs.indexOf(e.target);
    i = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    ui.tab = tabs[i].dataset.tab;
    renderList();
    tabs[i].focus();
  }
});

/* ---------- deep links ----------
   /terminal#create · #mine · #leaderboard
   /terminal?coin=<mint>&dir=above&target=8000000&duration=7%20days&stake=0.5   (prefilled step 2) */
async function openFromUrl() {
  const q = new URLSearchParams(location.search), hash = location.hash.slice(1), coin = q.get('coin');
  if (coin && isCa(coin)) {
    history.replaceState(null, '', location.pathname + '#create');
    setTimeout(() => $('#createForm').scrollIntoView({ block: 'start' }), 0);
    try {
      const tok = await D.token(coin);
      if (!tok.tradable) throw new Error('No market for that token yet.');
      live[tok.ca] = { ...live[tok.ca], ...tok };
      const target = Number(q.get('target')), stake = Number(q.get('stake'));
      ui.draft = {
        token: slim(tok),
        dir: ['above', 'below'].includes(q.get('dir')) ? q.get('dir') : undefined,
        target: target > 0 ? target : undefined,
        stake: stake > 0 ? stake : undefined,
        duration: cfg.durations.some(d => d.label === q.get('duration')) ? q.get('duration') : undefined,
      };
      wizard(2);
    } catch (err) { toast(err.message); }
    return;
  }
  if (hash === 'leaderboard') navigate('leader');
  else if (hash === 'mine') navigate('mine');
  else if (hash === 'create') setTimeout(() => { $('#createForm').scrollIntoView({ block: 'start' }); $('#wCa')?.focus({ preventScroll: true }); }, 0);
}

/* ---------- live ticking ---------- */
setInterval(() => {
  $$('[data-ends]').forEach(el => { el.textContent = timeLeft(Number(el.dataset.ends) - Date.now()); });
}, 1000);

/* ---------- boot ---------- */
applyBrand();
applyTheme();
renderList();
wizard(1);
openFromUrl();
W.onChange(() => { if ($('.wlist') && !state.me) connectModal(ui.afterConnect); });
(async () => {
  try { state.pay = await D.payConfig(); } catch { state.pay = null; }
  await loadBook({ quiet: true });
  ui.loading = false;
  renderList();
  await refreshLive();
  setInterval(() => { if (!document.hidden) loadBook(); }, 5000);
  setInterval(refreshLive, (cfg.refreshSeconds || 20) * 1000);
})();
})();
