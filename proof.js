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
  $('#pfToken').innerHTML = `<b>The cubet token isn't used in betting yet.</b> The official token is <a href="${esc(D.explorer(TOKEN_CA))}" target="_blank" rel="noopener noreferrer"><code>${esc(TOKEN_CA)}</code></a>. Stakes are still demo SOL. Any other token claiming to be cubet's is not ours; the address is also posted on <a href="https://x.com/cubetsol_" target="_blank" rel="noopener noreferrer">@cubetsol_</a>.`;
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
        : `${b.creatorWon ? esc(b.owner) : esc(b.taker)} won ${Number((b.stake * 2).toFixed(4))} ${esc(cfg.currency)}`;
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

settlements();
checks.token().catch(() => {});
})();
