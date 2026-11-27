/* Art: cubet's drawn UI pieces, hand-built as SVG/HTML strings. No libraries.
   token()     real logo in a glass ring, gradient-letter fallback
   avatar()    gradient orb with initials for players
   trend()     tiny rising / falling line glyph
   clock()     countdown glyph
   sparkline() smooth mini trend line from real price points
   chart()     interactive market-cap chart with target line and win zone (hover handled in fx.js)
   cubeMark()  the static brand cube (empty states)                                              */
(() => {
'use strict';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r = n => Math.round(n * 10) / 10;
const fmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const money = n => (Number.isFinite(n) ? '$' + fmt.format(n) : '—');
let uid = 0;

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const letterOf = t => String(t.symbol || '?').replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '?';

/* ---------- token logo ---------- */
function token(t, cls = '') {
  const h = 200 + (hash(t.ca || t.symbol) % 90);
  const img = t.image ? `<img class="tk-img" src="${esc(t.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '';
  return `<span class="tk ${cls}${img ? '' : ' tk-noimg'}" aria-hidden="true"><span class="tk-fb" style="--h:${h}">${esc(letterOf(t))}</span>${img}</span>`;
}

/* ---------- player avatar ---------- */
function avatar(name, cls = '') {
  const you = name === 'You', h = hash(name);
  const h1 = 205 + (h % 70), h2 = 240 + ((h >> 8) % 60);
  const label = you ? 'YOU' : String(name).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
  return `<span class="ava${you ? ' ava-you' : ''} ${cls}" style="--h1:${h1};--h2:${h2}" aria-hidden="true">${esc(label)}</span>`;
}

/* ---------- glyphs ---------- */
const trend = dir => {
  const up = dir !== 'below';
  return `<svg class="trend ${up ? 'up' : 'down'}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${up
    ? '<path d="M3 14l4.5-4.5 3 3L17 6"/><path d="M12.5 6H17v4.5"/>'
    : '<path d="M3 6l4.5 4.5 3-3L17 14"/><path d="M12.5 14H17V9.5"/>'}</svg>`;
};
const clock = () => `<svg class="clock" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7.2"/><path class="clock-hand" d="M10 10V5.8"/><path d="M10 10l2.6 1.6"/></svg>`;

/* ---------- smooth path through points (Catmull-Rom → Bézier) ---------- */
function smooth(pts) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [r(p1[0] + (p2[0] - p0[0]) / 6), r(p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [r(p2[0] - (p3[0] - p1[0]) / 6), r(p2[1] - (p3[1] - p1[1]) / 6)];
    d += ` C${c1} ${c2} ${p2}`;
  }
  return d;
}

/* ---------- sparkline ---------- */
function sparkline(values, { w = 120, h = 40, cls = '' } = {}) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return '';
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || hi * 0.01 || 1;
  const pts = v.map((y, i) => [r((i / (v.length - 1)) * (w - 4) + 2), r(h - 4 - ((y - lo) / span) * (h - 8))]);
  const up = v.at(-1) >= v[0], id = `sp${++uid}`, line = smooth(pts), last = pts.at(-1);
  return `<svg class="spark ${up ? 'up' : 'down'} ${cls}" viewBox="0 0 ${w} ${h}" aria-hidden="true">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".28"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>` +
    `<path d="${line} L${last[0]},${h} L${pts[0][0]},${h}Z" fill="url(#${id})"/>` +
    `<path d="${line}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>` +
    `<circle cx="${last[0]}" cy="${last[1]}" r="2.6" fill="currentColor"/><circle class="spark-pulse" cx="${last[0]}" cy="${last[1]}" r="2.6" fill="currentColor"/></svg>`;
}

/* ---------- market-cap chart ---------- */
function chart(values, { times = [], target = null, dir = 'above', animate = true, nowLabel = '', targetLabel = '', label = 'Market cap chart' } = {}) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return '';
  const W = 640, H = 250, L = 6, R = 70, T = 16, B = 18, iw = W - L - R, ih = H - T - B;
  const hasT = Number.isFinite(target) && target > 0;
  let lo = Math.min(...v, hasT ? target : Infinity), hi = Math.max(...v, hasT ? target : -Infinity);
  const pad = (hi - lo) * 0.1 || hi * 0.05 || 1;
  lo = Math.max(0, lo - pad); hi += pad;
  const X = i => r(L + (i / (v.length - 1)) * iw), Y = val => r(T + (1 - (val - lo) / (hi - lo)) * ih);
  const pts = v.map((val, i) => [X(i), Y(val)]);
  const id = `ch${++uid}`, line = smooth(pts), last = pts.at(-1);
  const up = dir !== 'below', tone = up ? 'var(--up)' : 'var(--down)';

  let grid = '';
  const pillY = hasT && targetLabel ? Y(target) : null;
  for (let k = 0; k <= 3; k++) {
    const val = lo + ((hi - lo) * k) / 3, y = Y(val);
    // an axis value the target pill would cover is left out instead of peeking out behind it
    const hidden = pillY !== null && Math.abs(y - pillY) < 22;
    grid += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="ch-grid"/>` + (hidden ? '' : `<text x="${W - R + 14}" y="${r(y + 4)}" class="ch-axis">${money(val)}</text>`);
  }
  let zone = '', tline = '';
  if (hasT) {
    const ty = Y(target);
    zone = up ? `<rect x="${L}" y="${T}" width="${iw}" height="${r(ty - T)}" fill="url(#${id}z)"/>` : `<rect x="${L}" y="${ty}" width="${iw}" height="${r(T + ih - ty)}" fill="url(#${id}z)"/>`;
    tline = `<line x1="${L}" x2="${W - R}" y1="${ty}" y2="${ty}" class="ch-target" style="stroke:${tone}"/>` +
      (targetLabel ? `<g transform="translate(${W - R + 4} ${r(ty - 11)})"><rect width="${R - 6}" height="22" rx="6" style="fill:${tone}"/><text x="${(R - 6) / 2}" y="15" class="ch-pill">${esc(targetLabel)}</text></g>` : '');
  }
  const data = `data-xs="${pts.map(p => p[0]).join(',')}" data-ys="${pts.map(p => p[1]).join(',')}" data-vs="${v.map(money).join(',')}"${times.length === v.length ? ` data-ts="${times.join(',')}"` : ''}`;
  return `<svg class="chart2d${animate ? ' anim' : ''}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" ${data}>` +
    `<defs>` +
    `<linearGradient id="${id}a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4D7CFF" stop-opacity=".32"/><stop offset="1" stop-color="#4D7CFF" stop-opacity="0"/></linearGradient>` +
    `<linearGradient id="${id}l" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5B7CFF"/><stop offset="1" stop-color="#A8C4FF"/></linearGradient>` +
    `<linearGradient id="${id}z" x1="0" y1="${up ? 1 : 0}" x2="0" y2="${up ? 0 : 1}"><stop offset="0" stop-color="${up ? '#3DDC97' : '#FF6B6B'}" stop-opacity=".14"/><stop offset="1" stop-color="${up ? '#3DDC97' : '#FF6B6B'}" stop-opacity="0"/></linearGradient>` +
    `</defs>${grid}${zone}${tline}` +
    `<path class="ch-area" d="${line} L${last[0]},${T + ih} L${pts[0][0]},${T + ih}Z" fill="url(#${id}a)"/>` +
    `<path class="ch-line" d="${line}" fill="none" stroke="url(#${id}l)" stroke-width="2" stroke-linecap="round" pathLength="1"/>` +
    `<circle class="ch-now-ring" cx="${last[0]}" cy="${last[1]}" r="4"/><circle class="ch-now" cx="${last[0]}" cy="${last[1]}" r="3.6"/>` +
    // "now" label sits above the dot, or below it when the dot is near the top edge or right on the target line
    (nowLabel ? (() => {
      const above = last[1] - 12, below = last[1] + 20;
      const nearT = hasT && Math.abs(above - 4 - Y(target)) < 10;
      const y = above < T + 10 || nearT ? Math.min(below, H - 4) : above;
      return `<text x="${r(last[0] - 8)}" y="${r(y)}" class="ch-nowlabel" text-anchor="end">now ${esc(nowLabel)}</text>`;
    })() : '') +
    `<g class="ch-hover"><line class="ch-cross" y1="${T}" y2="${T + ih}"/><circle class="ch-dot" r="4.5"/><g class="ch-tip"><rect rx="7" height="${times.length ? 38 : 24}" width="112"/><text class="ch-tip-v" x="10" y="16"></text><text class="ch-tip-t" x="10" y="31"></text></g></g>` +
    `<rect class="ch-hit" x="${L}" y="0" width="${iw}" height="${H}" fill="transparent"/></svg>`;
}

/* ---------- the brand mascot, static (empty states) ---------- */
function cubeMark(cls = '') {
  // the cubet mascot (Prime), one still drawing from mascot.js; the wireframe below only if mascot.js is missing
  if (window.Mascot) { const v = Mascot.SIZES.sm.view; return `<svg class="cubemark ${cls}" viewBox="${v.join(' ')}" aria-hidden="true">${Mascot.markup(0, { size: 'sm' })}</svg>`; }
  const id = `cm${++uid}`;
  return `<svg class="cubemark ${cls}" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="${id}" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#C6DAFF"/><stop offset=".5" stop-color="#4D7CFF"/><stop offset="1" stop-color="#7B61FF"/></linearGradient></defs>` +
    `<g fill="none" stroke="url(#${id})" stroke-linejoin="round" stroke-linecap="round"><g stroke-width="2.2"><path d="M32 8 53 20 53 44 32 56 11 44 11 20Z"/><path d="M11 20 32 32 53 20M32 32V56"/></g>` +
    `<g stroke-width="1.4" opacity=".7"><path d="M32 24 39.5 28.3 39.5 36.9 32 41.2 24.5 36.9 24.5 28.3Z"/><path d="M24.5 28.3 32 32.6 39.5 28.3M32 32.6V41.2"/></g></g></svg>`;
}

/* ---------- top three (leaderboard) ---------- */
function topThree(list, signed) {
  const order = [1, 0, 2];
  return `<div class="top3">${order.map(i => {
    const p = list[i];
    if (!p) return '<div class="t3 t3-empty"></div>';
    return `<div class="t3 t3-${i + 1}"><span class="t3-rank">${i + 1}</span>${avatar(p.name)}<b>${esc(p.name)}</b><span class="t3-pl ${p.pl > 0 ? 'pos' : p.pl < 0 ? 'neg' : ''}">${esc(signed(p.pl))}</span><span class="t3-rec">${p.w}W · ${p.l}L</span></div>`;
  }).join('')}</div>`;
}

window.Art = { token, avatar, trend, clock, sparkline, chart, cubeMark, topThree, hash, money };
})();
