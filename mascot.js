/* cubet mascot: "Prime", a solid isometric cube with two pill eyes.
   Precise geometry, no hand jitter. Motion is timed by hand at 12 drawings a second: it breathes, blinks,
   glances left and right, and every so often hops (anticipation squash, stretch, landing squash, settle).
   Mascot.mount(el, { size: 'lg' | 'sm', play })     lg: splash, sm: 30px nav logo
   Mascot.markup(frame, opts) returns the SVG markup for one drawing (no DOM needed), and
   Mascot.icon() the app icon / favicon (the mark on a dark rounded tile). */
(() => {
'use strict';

const NS = 'http://www.w3.org/2000/svg';
const C = Math.cos(Math.PI / 6);
const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const f2 = v => Math.round(v * 100) / 100;

// The mark lives in a 256-unit box: cube edge 104, centred at (128, 128); lg adds room to hop and a shadow.
const SIZES = {
  lg: { cy: 150, hop: 0.32, shadow: true, view: [0, 0, 256, 290] },
  sm: { cy: 128, hop: 0.08, shadow: false, view: [10, 6, 236, 236] },
};
const S = 104;

/* ---------- geometry ---------- */
function projector(cx, cy, { q = 0, hop = 0, lean = 0 } = {}) {
  const sz = 1 - q, sx = 1 + q * 0.55;          // squash keeps the volume roughly constant
  return ([x, y, z]) => {
    const k = (z + 0.5) * sz, zz = -0.5 + k + hop;
    const xx = x * sx + lean * k, yy = y * sx - lean * k;
    return [cx + (xx - yy) * C * S, cy + (xx + yy) * 0.5 * S - zz * S];
  };
}
const poly = pts => 'M' + pts.map(p => `${f2(p[0])} ${f2(p[1])}`).join('L') + 'Z';
// rounded polygon, cubic corners close to a circular arc
function rounded(pts, r) {
  const n = pts.length; let d = '';
  const to = (a, c) => { const l = Math.hypot(a[0] - c[0], a[1] - c[1]) || 1, k = Math.min(r / l, 0.48); return [c[0] + (a[0] - c[0]) * k, c[1] + (a[1] - c[1]) * k]; };
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n], c = pts[i], q = pts[(i + 1) % n], a = to(p, c), b = to(q, c);
    const ca = [a[0] + (c[0] - a[0]) * 0.56, a[1] + (c[1] - a[1]) * 0.56], cb = [b[0] + (c[0] - b[0]) * 0.56, b[1] + (c[1] - b[1]) * 0.56];
    d += `${i ? 'L' : 'M'}${f2(a[0])} ${f2(a[1])}C${f2(ca[0])} ${f2(ca[1])} ${f2(cb[0])} ${f2(cb[1])} ${f2(b[0])} ${f2(b[1])}`;
  }
  return d + 'Z';
}
const lin = (id, a, b, c0, c1) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f2(a[0])}" y1="${f2(a[1])}" x2="${f2(b[0])}" y2="${f2(b[1])}"><stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/></linearGradient>`;

/* ---------- timing: a 96-drawing loop at 12fps (8 s) ---------- */
const LOOP = 96, HOP_AT = 34;
// the hop, one drawing at a time: [squash, share of the hop height]
const HOP = [
  [0.05, 0], [0.11, 0], [0.15, 0],                                  // anticipation
  [-0.12, 0.24], [-0.07, 0.64], [-0.02, 0.9], [0, 1], [0, 0.97],    // launch, hang
  [-0.02, 0.8], [-0.06, 0.5], [-0.1, 0.15],                         // fall
  [0.16, 0], [0.08, 0], [-0.03, 0], [0.015, 0], [0, 0],             // land, settle
];
const BLINK = { 11: 0.35, 12: 0.08, 13: 0.35, 69: 0.35, 70: 0.08, 71: 0.35, 73: 0.35, 74: 0.08, 75: 0.35 };
function poseAt(f) {
  const p = { q: Math.sin(f / LOOP * Math.PI * 6) * 0.012, hop: 0, lean: 0, lid: 1, look: 0 };
  const h = HOP[f - HOP_AT];
  if (h) { p.q = h[0]; p.hop = h[1]; }
  if (BLINK[f] !== undefined) p.lid = BLINK[f];
  if (f === 55 || f === 66) p.look = -0.5; else if (f > 55 && f < 66) p.look = -1;   // glance left, one in-between each way
  if (f === 79 || f === 90) p.look = 0.5; else if (f > 79 && f < 90) p.look = 1;     // and right
  p.lean = p.look * 0.02;
  return p;
}

/* ---------- one drawing ---------- */
let uid = 0;
function markup(f = 0, o = {}) {
  const opt = { ...SIZES[o.size || 'lg'], ...o }, id = o.id || 'm' + (++uid);
  const pose = poseAt(f), hop = pose.hop * opt.hop;
  const P = projector(128, opt.cy, { ...pose, hop }), V = (x, y, z) => P([x, y, z]);
  const top = [V(-.5, -.5, .5), V(.5, -.5, .5), V(.5, .5, .5), V(-.5, .5, .5)];
  const left = [V(-.5, .5, .5), V(.5, .5, .5), V(.5, .5, -.5), V(-.5, .5, -.5)];
  const right = [V(.5, .5, .5), V(.5, -.5, .5), V(.5, -.5, -.5), V(.5, .5, -.5)];
  const sil = [V(-.5, -.5, .5), V(.5, -.5, .5), V(.5, -.5, -.5), V(.5, .5, -.5), V(-.5, .5, -.5), V(-.5, .5, .5)];
  const O = V(.5, .5, .5), UL = V(-.5, .5, .5), UR = V(.5, -.5, .5), B = V(.5, .5, -.5);
  const defs = [
    lin(id + 't', V(-.5, -.5, .5), V(.5, .5, .5), '#DCE6FF', '#9DB5FF'),
    lin(id + 'l', V(-.5, .5, .5), V(.5, .5, -.5), '#7A9CFF', '#3F62F0'),
    lin(id + 'r', V(.5, .5, .5), V(.5, -.5, -.5), '#3653DE', '#4A33B9'),
    `<clipPath id="${id}c"><path d="${rounded(sil, 17)}"/></clipPath>`,
  ];
  let shadow = '';
  if (opt.shadow) {
    const k = 1 - hop * 1.6, gy = opt.cy + S + 10;
    defs.push(`<radialGradient id="${id}s"><stop offset="0" stop-color="#4D7CFF" stop-opacity="${f2(0.5 * k)}"/><stop offset="1" stop-color="#4D7CFF" stop-opacity="0"/></radialGradient>`);
    shadow = `<ellipse cx="128" cy="${gy}" rx="${f2(78 * k)}" ry="${f2(10 * k)}" fill="url(#${id}s)"/>`;
  }
  // eyes: pills drawn flat on the front-left face. They stretch with the body and close to a sliver on a blink.
  const sq = 1 - pose.q * 1.6, o0 = P([0, 0.5, 0]), p1 = P([1, 0.5, 0]), p2 = P([0, 0.5, 1]);
  const m = `matrix(${f2(p1[0] - o0[0])} ${f2(p1[1] - o0[1])} ${f2(p2[0] - o0[0])} ${f2(p2[1] - o0[1])} ${f2(o0[0])} ${f2(o0[1])})`;
  const ew = 0.12 / Math.max(0.8, sq) ** 0.5, eh = 0.29 * sq * pose.lid, ez = 0.08 - (0.29 - eh) * 0.35, lk = pose.look * 0.06;
  const eyes = [-0.2, 0.15].map(x => `<rect x="${f2(x + lk - ew / 2)}" y="${f2(ez - eh / 2)}" width="${f2(ew)}" height="${f2(Math.max(eh, 0.03))}" rx="${f2(Math.min(ew, eh) / 2)}" fill="#0A1033"/>`).join('');
  return `<defs>${defs.join('')}</defs>${shadow}<g clip-path="url(#${id}c)">`
    + `<path d="${poly(sil)}" fill="url(#${id}r)"/><path d="${poly(top)}" fill="url(#${id}t)"/><path d="${poly(left)}" fill="url(#${id}l)"/><path d="${poly(right)}" fill="url(#${id}r)"/>`
    + `<path d="M${f2(UL[0])} ${f2(UL[1])}L${f2(O[0])} ${f2(O[1])}L${f2(UR[0])} ${f2(UR[1])}" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1.6" stroke-linejoin="round"/>`
    + `<path d="M${f2(O[0])} ${f2(O[1])}L${f2(B[0])} ${f2(B[1])}" stroke="#fff" stroke-opacity=".14" stroke-width="1.2"/></g>`
    + `<g transform="${m}">${eyes}</g>`;
}

// The app icon / favicon: the still mark on a dark rounded tile with a soft blue light behind it.
function icon() {
  return `<svg xmlns="${NS}" viewBox="0 0 256 256"><defs><radialGradient id="ibg" cx="128" cy="118" r="150" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3B63FF" stop-opacity=".38"/><stop offset="1" stop-color="#3B63FF" stop-opacity="0"/></radialGradient></defs>`
    + `<rect width="256" height="256" rx="58" fill="#05060C"/><rect width="256" height="256" rx="58" fill="url(#ibg)"/>`
    + `<rect x=".75" y=".75" width="254.5" height="254.5" rx="57.5" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="1.5"/>`
    + `<g transform="translate(128 128) scale(.74) translate(-128 -128)">${markup(0, { size: 'sm', id: 'i' })}</g></svg>`;
}

/* ---------- mounting: 12fps, paused off-screen and in hidden tabs, one still drawing for reduced motion ---------- */
function mount(el, o = {}) {
  const opt = { size: 'lg', fps: 12, play: true, frame: 0, ...o, id: 'm' + (++uid) };
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', (SIZES[opt.size] || SIZES.lg).view.join(' '));
  svg.setAttribute('class', 'mascot');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  el.replaceChildren(svg);
  let f = opt.frame, last = 0, raf = 0, visible = true, stopped = false;
  const render = () => { svg.innerHTML = markup(f, opt); };
  render();
  if (!opt.play || reduced) return { svg, stop() {} };
  const tick = t => {
    raf = 0;
    if (t - last >= 1000 / opt.fps - 4) { last = t; f = (f + 1) % LOOP; render(); }
    schedule();
  };
  const schedule = () => { if (!raf && !stopped && visible && !document.hidden) raf = requestAnimationFrame(tick); };
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(([e]) => { visible = e.isIntersecting; schedule(); }) : null;
  io?.observe(el);
  document.addEventListener('visibilitychange', schedule);
  schedule();
  return { svg, stop() { stopped = true; cancelAnimationFrame(raf); io?.disconnect(); document.removeEventListener('visibilitychange', schedule); } };
}

const api = { mount, markup, icon, poseAt, LOOP, SIZES };
if (typeof window !== 'undefined') window.Mascot = api;
if (typeof module !== 'undefined') module.exports = api;
// <span data-mascot="sm"></span> mounts itself (the nav logo on every page)
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () =>
  document.querySelectorAll('[data-mascot]').forEach(n => mount(n, { size: n.dataset.mascot || 'lg' })));
})();
