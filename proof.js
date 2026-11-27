/* cubet proof page: runs the real integrations on demand and lists every settlement from the bet book.
   Nothing here is canned: each check calls the same server endpoints the terminal and settlement use. */
(() => {
'use strict';

const cfg = window.CUBET, D = window.CubetData, art = window.Art;
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = D.money;
const MINT = cfg.featured[0];
const utc = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

$$('[data-brand]').forEach(el => { el.textContent = cfg.brand.name; });
$$('[data-footer]').forEach(el => { el.textContent = cfg.brand.footer; });
$('[data-mint-short]').textContent = `"${MINT.slice(0, 6)}…${MINT.slice(-4)}"`;
$('[data-solscan]').href = D.explorer(MINT);

// The official token, from the same TOKEN_CA setting as the splash page's copy button.
const TOKEN_CA = String(cfg.token?.ca || '').trim();
if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(TOKEN_CA)) {
  $('#pfToken').innerHTML = `<b>The cubet token isn't used in betting yet.</b> The official token is <a href="${esc(D.explorer(TOKEN_CA))}" target="_blank" rel="noopener noreferrer"><code>${esc(TOKEN_CA)}</code></a>. Bets are staked in SOL, not in the token. Any other token claiming to be cubet's is not ours; the address is also posted on <a href="https://x.com/cubetmarket" target="_blank" rel="noopener noreferrer">@cubetmarket</a>.`;
}

// Raw fetch so the page shows exactly what the server returned, status and timing included.
async function raw(url) {
  const t0 = performance.now();
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ms: Math.round(performance.now() - t0), body };
}
const show = (key, url, r) => {
  $(`[data-out="${key}"]`).textContent = `GET ${url}\n→ ${r.status} in ${r.ms} ms\n\n${JSON.stringify(r.body, null, 2)}`;
};

const checks = {
  async token() {
    const url = `/api/token/${MINT}`;
    show('token', url, await raw(url));
  },
  async cap() {
    const t = Math.floor(Date.now() / 1000) - 3600;
    const url = `/api/cap-at/${MINT}?t=${t}`;
    const r = await raw(url);
    show('cap', url, r);
    if (r.body?.pair) { const a = $('[data-pool]'); a.href = `https://www.geckoterminal.com/solana/pools/${encodeURIComponent(r.body.pair)}`; a.hidden = false; }
  },
  async book() {
    const url = '/api/stats';
    show('book', url, await raw(url));
  },
};

document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-run]');
  if (!btn || btn.disabled) return;
  const key = btn.dataset.run;
  btn.disabled = true;
  $(`[data-out="${key}"]`).textContent = 'Running…';
  try { await checks[key](); }
  catch (err) { $(`[data-out="${key}"]`).textContent = `Request failed: ${err.message}`; }
  finally { btn.disabled = false; }
});

/* ---------- settlements ---------- */
async function settlements() {
  const host = $('#settlements');
  let bets;
  try { bets = await D.settlements(50); }
  catch (err) { host.innerHTML = `<p class="pf-empty">${esc(err.message)}</p>`; return; }
  if (!bets.length) { host.innerHTML = '<p class="pf-empty">No bets have settled yet. The first settlement appears here as soon as a taken bet ends.</p>'; return; }
  host.innerHTML = `<div class="pf-tr pf-th"><span>Ended</span><span>Coin</span><span>Call</span><span>Cap at expiry</span><span>Source</span><span>Result</span></div>` +
    bets.map(b => {
      const pool = b.settlePair ? `https://www.geckoterminal.com/solana/pools/${encodeURIComponent(b.settlePair)}` : null;
      const source = b.state === 'void'
        ? 'No market data at expiry'
        : b.settleSource === 'candle'
          ? `Price candle at ${esc(utc(b.settleCandle * 1000))}${pool ? ` · <a href="${pool}" target="_blank" rel="noopener noreferrer">pool ↗</a>` : ''}`
          : `Live DexScreener cap at settlement${pool ? ` · <a href="${pool}" target="_blank" rel="noopener noreferrer">pool ↗</a>` : ''}`;
      const result = b.state === 'void'
        ? 'Void · both refunded'
        : `${b.creatorWon ? esc(b.owner) : esc(b.taker)} won ${Number((b.stake * 2 - (b.fee || 0)).toFixed(6))} ${esc(cfg.currency)}`;
      return `<div class="pf-tr" id="s-${esc(b.id)}">
        <span data-l="Ended">${esc(utc(b.expiresAt))}</span>
        <span data-l="Coin" class="pf-coin">${art.token(b.token)}<a href="${D.explorer(b.token.ca)}" target="_blank" rel="noopener noreferrer">${esc(b.token.symbol)}</a></span>
        <span data-l="Call">${b.dir === 'above' ? 'Higher' : 'Lower'} than ${money(b.target)}</span>
        <span data-l="Cap at expiry"><b>${b.state === 'void' ? '—' : money(b.settledCap)}</b></span>
        <span data-l="Source">${source}</span>
        <span data-l="Result">${result}</span>
      </div>`;
    }).join('');
  if (location.hash.startsWith('#s-')) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
}

/* ---------- treasury: on-chain balance vs. what cubet owes, and every transfer ---------- */
const sol = n => `${Number(Number(n).toFixed(6))} ${cfg.currency}`;
async function treasury() {
  const host = $('#treasury'), list = $('#transfers');
  let st;
  try { st = await D.payStatus(); }
  catch (err) { host.innerHTML = `<p class="pf-empty">${esc(err.message)}</p>`; return; }
  if (!st.enabled) {
    host.innerHTML = '<p>Deposits and withdrawals are not switched on yet, so the treasury holds no player funds and no bets can be placed. This section shows the treasury wallet and its balance as soon as they are.</p>';
    return;
  }
  const acct = D.account(st.treasury, st.cluster);
  const badge = st.solvent == null ? '<span class="pf-badge">balance unavailable</span>' : st.solvent ? '<span class="pf-badge ok">fully covered</span>' : '<span class="pf-badge bad">short</span>';
  host.innerHTML = `<div class="pf-treasury">
      <div><span class="k">Treasury wallet</span><a href="${esc(acct)}" target="_blank" rel="noopener noreferrer"><code>${esc(st.treasury)}</code> ↗</a></div>
      <div><span class="k">On-chain balance</span><span><b>${st.treasuryBalance == null ? '—' : sol(st.treasuryBalance)}</b>${badge}</span></div>
      <div><span class="k">cubet owes</span><b>${sol(st.owed.total)}</b><span class="s">${sol(st.owed.balances)} in player balances · ${sol(st.owed.lockedInBets)} locked in bets · ${sol(st.owed.pendingWithdrawals)} withdrawals in flight · ${sol(st.owed.houseFees)} unswept fees</span></div>
      <div><span class="k">All time</span><span>${st.totals.deposits} deposits (${sol(st.totals.deposited)}) · ${st.totals.withdrawals} withdrawals (${sol(st.totals.withdrawn)})</span></div>
      <div><span class="k">Rules</span><span>Fee on settled pots: ${st.feeBps / 100}% · stakes ${st.minStake}–${st.maxStake} ${esc(cfg.currency)} · withdrawals up to ${st.maxWithdrawPerDay} ${esc(cfg.currency)} per 24 h, ${st.networkFee} ${esc(cfg.currency)} network fee</span></div>
    </div>`;
  let tx;
  try { tx = await D.transfers(50); } catch { return; }
  const rows = [...tx.deposits.map(d => ({ ...d, kind: 'Deposit', who: d.from, sign: '+' })), ...tx.withdrawals.map(w => ({ ...w, kind: w.kind === 'fee sweep' ? 'Fee sweep' : 'Withdrawal', who: w.to, sign: '−' }))]
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  list.innerHTML = rows.length
    ? `<div class="pf-tr pf-th pf-tx"><span>Time</span><span>Type</span><span>Wallet</span><span>Amount</span><span>Status</span><span>Transaction</span></div>` +
      rows.map(r => `<div class="pf-tr pf-tx">
        <span data-l="Time">${r.at ? esc(utc(r.at)) : '—'}</span><span data-l="Type">${r.kind}</span>
        <span data-l="Wallet"><a href="${esc(D.account(r.who, st.cluster))}" target="_blank" rel="noopener noreferrer">${esc(r.who.slice(0, 4))}…${esc(r.who.slice(-4))}</a></span>
        <span data-l="Amount"><b>${r.sign}${sol(r.amount)}</b></span><span data-l="Status">${esc(r.status)}</span>
        <span data-l="Transaction"><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.signature.slice(0, 8))}… ↗</a></span>
      </div>`).join('')
    : '<p class="pf-empty">No deposits or withdrawals yet. Each one appears here with its Solana transaction.</p>';
}

settlements();
treasury();
checks.token().catch(() => {});
})();
