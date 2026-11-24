/* cubet mascot: a little isometric die with a face.
   Animated like hand-rolled cel animation: one new drawing every 1/12 s ("on twos"), poses timed by hand,
   and a faint line boil (every shape shifts a hair between three takes) so it never looks tweened.
   Mascot.mount(el, { size: 'lg' | 'sm' | 'xs', play })     lg: splash, sm: 30px nav logo, xs: favicon
   Mascot.markup(frame, take, opts) returns the SVG markup for one drawing (no DOM needed). */
(() => {
'use strict';

const NS = 'http://www.w3.org/2000/svg';
const U = 60;                                   // one cube edge in SVG units
const C = Math.cos(Math.PI / 6), S = 0.5;
const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const COL = {
  top: '#8EADFF', left: '#4D7CFF', right: '#2F4FD6', seam: '#16226E',
  pip: '#0B1446', ink: '#0B1446', glint: '#FFFFFF', leg: '#2F4FD6', foot: '#6E95FF', shadow: 'rgba(77,124,255,.22)',
};

const SIZES = {
  lg: { boil: 0.7, hop: 0.42, legs: 0.74, face: 1, round: 9, detail: true, view: [-90, -112, 180, 196] },
  sm: { boil: 0.35, hop: 0.12, legs: 0.66, face: 1.25, round: 11, detail: false, view: [-62, -74, 124, 132] },
  xs: { boil: 0, hop: 0, legs: 0, face: 1.3, round: 11, detail: false, view: [-59, -63, 118, 124] },
};

/* ---------- seeded noise for the boil ---------- */
function rng(seed) { return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const n1 = v => (Math.round(v * 10) / 10).toString();

/* ---------- isometric projection with squash, hop and lean ---------- */
function projector({ q = 0, hop = 0, lean = 0 } = {}) {
  const sz = 1 - q, sx = 1 + q * 0.55;           // squash keeps the volume roughly constant
  return ([x, y, z]) => {
    const k = (z + 0.5) * sz, zz = -0.5 + k + hop;
    const xx = x * sx + lean * k, yy = y * sx - lean * k;
    return [(xx - yy) * C * U, ((xx + yy) * S - zz) * U];
  };
}

/* ---------- shapes ---------- */
// polygon with every corner rounded off
function rounded(pts, r) {
  const n = pts.length; let d = '';
  const to = (a, b) => { const l = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, k = Math.min(r / l, 0.45); return [b[0] + (a[0] - b[0]) * k, b[1] + (a[1] - b[1]) * k]; };
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n], c = pts[i], q = pts[(i + 1) % n];
    const a = to(p, c), b = to(q, c);
    d += `${i ? 'L' : 'M'}${n1(a[0])} ${n1(a[1])}Q${n1(c[0])} ${n1(c[1])} ${n1(b[0])} ${n1(b[1])}`;
  }
  return d + 'Z';
}
const inset = (pts, k) => {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
};
// features sit on a cube face in its own (u, v) coordinates, so circles become true isometric ellipses
const onFace = (face, u, v) => face === 'left' ? [u, 0.5, v] : face === 'right' ? [0.5, -u, v] : [u, v, 0.5];
const oval = (P, face, u, v, ru, rv, n = 22) => Array.from({ length: n }, (_, i) => { const a = i / n * Math.PI * 2; return P(onFace(face, u + ru * Math.cos(a), v + rv * Math.sin(a))); });
const arc = (P, cu, cv, w, bend, n = 8) => Array.from({ length: n + 1 }, (_, i) => { const t = i / n * 2 - 1; return P(onFace('left', cu + t * w, cv - bend * (1 - t * t))); });
const poly = pts => 'M' + pts.map(p => `${n1(p[0])} ${n1(p[1])}`).join('L') + 'Z';
const curve = pts => {
  let d = `M${n1(pts[0][0])} ${n1(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) d += `Q${n1(pts[i][0])} ${n1(pts[i][1])} ${n1((pts[i][0] + pts[i + 1][0]) / 2)} ${n1((pts[i][1] + pts[i + 1][1]) / 2)}`;
  const L = pts[pts.length - 1];
  return d + `L${n1(L[0])} ${n1(L[1])}`;
};

/* ---------- timing: a 96-drawing loop at 12fps (8 s) ---------- */
const LOOP = 96, HOP_AT = 34;
// the hop, one drawing at a time: [squash, share of the hop height, expression]
const HOP = [
  [0.06, 0, 'squint'], [0.13, 0, 'squint'], [0.17, 0, 'squint'],                               // anticipation
  [-0.14, 0.24, 'oh'], [-0.08, 0.64, 'oh'], [-0.03, 0.9, 'oh'], [0, 1, 'oh'], [0, 0.97, 'oh'], // launch, hang
  [-0.03, 0.8, 'oh'], [-0.07, 0.5, 'oh'], [-0.11, 0.15, 'oh'],                                  // fall
  [0.2, 0, 'squint'], [0.1, 0, 'squint'], [-0.04, 0, 'grin'], [0.02, 0, 'grin'], [0, 0, 'grin'], // land, settle
];
const BLINK = { 11: 0.45, 12: 0, 13: 0.45, 69: 0.45, 70: 0, 71: 0.45, 73: 0.45, 74: 0, 75: 0.45 };
function poseAt(f) {
  const p = { q: Math.sin(f / LOOP * Math.PI * 6) * 0.02, hop: 0, lean: 0, lid: 1, look: 0, face: 'idle' };
  const h = HOP[f - HOP_AT];
  if (h) { p.q = h[0]; p.hop = h[1]; p.face = h[2]; }
  if (BLINK[f] !== undefined) p.lid = BLINK[f];
  if (f === 55 || f === 66) p.look = -0.5; else if (f > 55 && f < 66) p.look = -1;   // glance left, one in-between each way
  if (f === 79 || f === 90) p.look = 0.5; else if (f > 79 && f < 90) p.look = 1;     // and right
  p.lean = p.look * 0.03;
  return p;
}

/* ---------- one drawing ---------- */
function markup(f = 0, take = 0, o = {}) {
  const opt = { ...SIZES[o.size || 'lg'], ...o };
  const pose = poseAt(f), hop = pose.hop * opt.hop;
  const P = projector({ ...pose, hop }), G = projector({});
  // the boil: each take nudges the corners of the body by a hair, and shifts round shapes as a whole (so they stay clean)
  const r = rng(take * 7919 + 13), amp = opt.boil, j = () => (r() - 0.5) * 2 * amp;
  const wob = pts => {
    if (pts.length > 8) { const dx = j() * 0.6, dy = j() * 0.6; return pts.map(([x, y]) => [x + dx, y + dy]); }
    return pts.map(([x, y]) => [x + j(), y + j()]);
  };
  const out = [];
  const fill = (d, col) => out.push(`<path d="${d}" fill="${col}"/>`);
  const line = (d, col, w) => out.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${n1(w)}" stroke-linecap="round" stroke-linejoin="round"/>`);

  // soft shadow on the ground, shrinking while airborne
  if (opt.detail) {
    const g = G([0.06, 0.06, -opt.legs]), k = 1 - hop * 0.8;
    out.push(`<ellipse cx="${n1(g[0])}" cy="${n1(g[1] + 4)}" rx="${n1(44 * k)}" ry="${n1(19 * k)}" fill="${COL.shadow}"/>`);
  }
  // stubby legs and round feet; the feet tuck up in the air
  if (opt.legs) [[-0.16, 0.5], [0.5, -0.16]].forEach(([x, y]) => {
    const [a, b] = wob([P([x, y, -0.45]), G([x, y, -opt.legs + hop * 0.75])]);
    line(`M${n1(a[0])} ${n1(a[1])}L${n1(b[0])} ${n1(b[1])}`, COL.leg, opt.detail ? 9 : 14);
    out.push(`<ellipse cx="${n1(b[0] + (x < 0 ? -3 : 3))}" cy="${n1(b[1] + 2)}" rx="${opt.detail ? 10 : 13}" ry="${opt.detail ? 5.5 : 7}" fill="${COL.foot}"/>`);
  });

  // body: a dark silhouette, then the three faces as rounded tiles, so the seams read as soft bevels
  const V = (x, y, z) => P([x, y, z]);
  fill(rounded(wob([V(-.5, -.5, .5), V(.5, -.5, .5), V(.5, -.5, -.5), V(.5, .5, -.5), V(-.5, .5, -.5), V(-.5, .5, .5)]), opt.round + 2), COL.seam);
  const k = opt.detail ? 0.93 : 0.9;
  const top = inset(wob([V(-.5, -.5, .5), V(.5, -.5, .5), V(.5, .5, .5), V(-.5, .5, .5)]), k);
  fill(rounded(top, opt.round), COL.top);
  fill(rounded(inset(wob([V(-.5, .5, .5), V(.5, .5, .5), V(.5, .5, -.5), V(-.5, .5, -.5)]), k), opt.round), COL.left);
  fill(rounded(inset(wob([V(.5, .5, .5), V(.5, -.5, .5), V(.5, -.5, -.5), V(.5, .5, -.5)]), k), opt.round), COL.right);

  // pips: a five on top
  const pr = opt.detail ? 0.075 : 0.1;
  [[-.24, -.24], [.24, -.24], [0, 0], [-.24, .24], [.24, .24]].forEach(([u, v]) => fill(poly(wob(oval(P, 'top', u, v, pr, pr))), COL.pip));

  // the face, on the front-left side. Eyes are drawn upright (not foreshortened), like a cartoon face on a box.
  const fs = opt.face, lk = pose.look * 0.07, ev = opt.detail ? 0.07 : 0.11, sq = 1 - pose.q;
  const eu = 0.19 + (fs - 1) * 0.06, ex = 5.6 * fs, ey = 8.8 * fs * sq, sw = opt.detail ? 4.6 : 8.5;
  [-eu, eu].forEach(u => {
    const [cx, cy] = wob([P(onFace('left', u + lk, ev))])[0];
    if (pose.face === 'squint') line(`M${n1(cx - ex * 1.2)} ${n1(cy + 2)}Q${n1(cx)} ${n1(cy - ey * 0.9)} ${n1(cx + ex * 1.2)} ${n1(cy + 2)}`, COL.ink, sw);
    else if (pose.lid === 0) line(`M${n1(cx - ex * 1.15)} ${n1(cy + 1)}Q${n1(cx)} ${n1(cy + ey * 0.55)} ${n1(cx + ex * 1.15)} ${n1(cy + 1)}`, COL.ink, sw);
    else {
      const big = pose.face === 'oh' ? 1.12 : 1, h = ey * big * pose.lid;
      out.push(`<ellipse cx="${n1(cx)}" cy="${n1(cy + (ey - h) * 0.6)}" rx="${n1(ex * big)}" ry="${n1(h)}" fill="${COL.ink}"/>`);
      if (opt.detail && pose.lid === 1) out.push(`<circle cx="${n1(cx + ex * 0.35 + pose.look * 1.5)}" cy="${n1(cy - ey * 0.4)}" r="2.2" fill="${COL.glint}"/>`);
    }
  });
  const mu = lk * 0.6, mv = opt.detail ? -0.15 : -0.2;
  if (pose.face === 'oh') fill(poly(wob(oval(P, 'left', mu, mv, 0.05 * fs, 0.06 * fs, 16))), COL.ink);
  else if (pose.face === 'grin') fill(curve(wob(arc(P, mu, mv + 0.03, 0.11 * fs, 0.1 * fs, 10))) + 'Z', COL.ink);
  else if (pose.face === 'squint') line(curve(wob(arc(P, mu, mv, 0.05 * fs, 0.02 * fs, 4))), COL.ink, sw * 0.9);
  else line(curve(wob(arc(P, mu, mv + 0.01, 0.085 * fs, 0.055 * fs, 8))), COL.ink, sw * 0.9);

  return out.join('');
}

/* ---------- mounting: 12fps, paused off-screen and in hidden tabs, one still drawing for reduced motion ---------- */
function mount(el, o = {}) {
  const opt = { size: 'lg', fps: 12, play: true, frame: 0, ...o };
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', (SIZES[opt.size] || SIZES.lg).view.join(' '));
  svg.setAttribute('class', 'mascot');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  el.replaceChildren(svg);
  let f = opt.frame, take = 0, last = 0, raf = 0, visible = true, stopped = false;
  const render = () => { svg.innerHTML = markup(f, take, opt); };
  render();
  if (!opt.play || reduced) return { svg, stop() {} };
  const tick = t => {
    raf = 0;
    if (t - last >= 1000 / opt.fps - 4) {
      last = t; f = (f + 1) % LOOP;
      if (f % 2 === 0) take = (take + 1) % 3;        // a fresh take of the drawing every other frame
      render();
    }
    schedule();
  };
  const schedule = () => { if (!raf && !stopped && visible && !document.hidden) raf = requestAnimationFrame(tick); };
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(([e]) => { visible = e.isIntersecting; schedule(); }) : null;
  io?.observe(el);
  document.addEventListener('visibilitychange', schedule);
  schedule();
  return { svg, stop() { stopped = true; cancelAnimationFrame(raf); io?.disconnect(); document.removeEventListener('visibilitychange', schedule); } };
}

const api = { mount, markup, poseAt, LOOP, SIZES };
if (typeof window !== 'undefined') window.Mascot = api;
// <span data-mascot="sm"></span> mounts itself (the nav logo on every page)
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () =>
  document.querySelectorAll('[data-mascot]').forEach(n => mount(n, { size: n.dataset.mascot || 'lg' })));
if (typeof module !== 'undefined') module.exports = api;
})();
