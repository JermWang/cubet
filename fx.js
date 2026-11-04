/* FX: cubet's hand-rolled visual effects. No libraries.
   - FX.cube(el, opts)   a glowing 3D wireframe cube (true perspective, depth-shaded edges, nested inner cube)
   - spotlight hovers    any .spot element gets a cursor-tracked glow (CSS reads --mx / --my)
   - mega menu           Framer-style nav panels that dim the page ([data-menu] triggers)
   - word reveal         [data-split] headings blur in word by word
   - count-up            [data-count] numbers tick up when they scroll into view
   Every animation pauses off-screen and respects prefers-reduced-motion. */
(() => {
'use strict';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const SVG = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
let uid = 0;

// Runs `frame(t)` on every animation frame while the element is on screen and the tab is visible.
function loop(node, frame) {
  let raf = 0, visible = true, start = performance.now();
  const tick = now => { frame((now - start) / 1000); raf = visible && !document.hidden ? requestAnimationFrame(tick) : 0; };
  const resume = () => { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(tick); };
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(([e]) => { visible = e.isIntersecting; resume(); }) : null;
  io?.observe(node);
  document.addEventListener('visibilitychange', resume);
  frame(0); // draw immediately, so nothing is blank before the first animation frame
  if (!reduced) resume();
  return () => { cancelAnimationFrame(raf); io?.disconnect(); document.removeEventListener('visibilitychange', resume); };
}

/* ---------- pointer (shared, normalised to -1..1) ---------- */
const pointer = { x: 0, y: 0 };
addEventListener('pointermove', e => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = (e.clientY / innerHeight) * 2 - 1;
}, { passive: true });

/* ---------- 3D wireframe cube ---------- */
const V = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const F = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 3, 7, 4]];
const ISO_X = -Math.atan(1 / Math.SQRT2); // the classic isometric tilt (-35.26°)

function rotate([x, y, z], rx, ry) {
  const cy = Math.cos(ry), sy = Math.sin(ry);
  [x, z] = [x * cy + z * sy, -x * sy + z * cy];
  const cx = Math.cos(rx), sx = Math.sin(rx);
  [y, z] = [y * cx - z * sx, y * sx + z * cx];
  return [x, y, z];
}

/**
 * Mount a glowing wireframe cube.
 * @param target  an HTML element (an <svg> is created inside) or an SVG <g> to draw into
 * @param o.unit  size of the cube's half-edge in the target's units (only for SVG <g> targets)
 * @param o.trails  corners shed soft glow particles that drift up like smoke and fade (o.trailRate per corner per second)
 */
function cube(target, o = {}) {
  // tumble: spin on two axes (the nav logo); otherwise turn around the vertical axis at an isometric tilt
  const opt = { speed: 0.35, inner: true, faces: true, dots: true, core: false, follow: true, tumble: false, trails: false, trailRate: 7, persp: 5, stroke: 1.6, unit: 1, ...o };
  const id = `c3-${++uid}`;
  let svg = target, g;
  if (target instanceof SVGElement) {
    g = el('g', { class: 'cube3d-g' }, target);
  } else {
    svg = el('svg', { viewBox: '-1.85 -1.85 3.7 3.7', class: 'cube3d', 'aria-hidden': 'true', focusable: 'false' });
    target.appendChild(svg);
    g = el('g', {}, svg);
  }
  const U = opt.unit;
  const defs = el('defs', {}, g);
  const grad = el('linearGradient', { id: `${id}-g`, gradientUnits: 'userSpaceOnUse', x1: -U, y1: -U, x2: U, y2: U }, defs);
  [['0', '#B9D4FF'], ['.45', '#4C8DFF'], ['1', '#7B61FF']].forEach(([offset, color]) => el('stop', { offset, 'stop-color': color }, grad));
  if (opt.core) {
    const rg = el('radialGradient', { id: `${id}-r` }, defs);
    [['0', 'rgba(140,190,255,.9)'], ['.35', 'rgba(70,120,255,.35)'], ['1', 'rgba(40,80,255,0)']].forEach(([offset, c]) => el('stop', { offset, 'stop-color': c }, rg));
    el('circle', { r: U * 1.25, fill: `url(#${id}-r)`, class: 'cube3d-core' }, g);
  }
  // smoke trails sit behind the edges
  const trailG = opt.trails ? el('g', { class: 'cube3d-trails' }, g) : null;
  if (opt.trails) {
    const pg = el('radialGradient', { id: `${id}-p` }, defs);
    [['0', 'rgba(220,232,255,.95)'], ['.38', 'rgba(120,160,255,.42)'], ['1', 'rgba(77,124,255,0)']].forEach(([offset, c]) => el('stop', { offset, 'stop-color': c }, pg));
  }
  const pool = [], puffs = [];
  const spawn = (x, y, z) => {
    if (puffs.length >= 80) return;
    const c = pool.pop() || el('circle', { fill: `url(#${id}-p)` }, trailG);
    puffs.push({ c, x, y, z, vx: (Math.random() - 0.5) * 0.18 * U, vy: -(0.6 + Math.random() * 0.4) * U, life: 0, max: 0.7 + Math.random() * 0.5 });
  };
  const stepTrails = (P, dt) => {
    dt = Math.min(dt, 0.25); // frame-rate independent; a long pause (hidden tab) never floods the scene
    if (dt > 0) P.forEach(p => { if (Math.random() < dt * opt.trailRate) spawn(p[0], p[1], p[2]); });
    for (let i = puffs.length - 1; i >= 0; i--) {
      const q = puffs[i];
      q.life += dt;
      const k = q.life / q.max;
      if (k >= 1) { q.c.setAttribute('opacity', 0); pool.push(q.c); puffs.splice(i, 1); continue; }
      q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.97; // rise, drift, slow down sideways
      q.c.setAttribute('cx', q.x.toFixed(4)); q.c.setAttribute('cy', q.y.toFixed(4));
      q.c.setAttribute('r', (U * (0.04 + k * 0.2)).toFixed(4));          // expand like smoke
      q.c.setAttribute('opacity', ((1 - k) ** 1.6 * 0.72 * (1 - (q.z + 1) * 0.2)).toFixed(3)); // fade fast, dimmer at the back
    }
  };
  const faceG = el('g', { class: 'cube3d-faces' }, g);
  const faces = opt.faces ? F.map(() => el('polygon', { fill: 'rgba(90,140,255,0.06)' }, faceG)) : [];
  const make = (cls, width) => {
    const lg = el('g', { class: cls, stroke: `url(#${id}-g)`, 'stroke-width': width, 'stroke-linecap': 'round', fill: 'none' }, g);
    return E.map(() => el('line', { 'vector-effect': 'non-scaling-stroke' }, lg));
  };
  const outer = make('cube3d-edges', opt.stroke);
  const inner = opt.inner ? make('cube3d-inner', opt.stroke * 0.75) : [];
  const dotG = el('g', { class: 'cube3d-dots', fill: '#DCE8FF' }, g);
  const dots = opt.dots ? V.map(() => el('circle', { r: U * 0.045 }, dotG)) : [];

  let tiltX = 0, tiltY = 0;
  const draw = (lines, scale, rx, ry, withFaces) => {
    const P = V.map(v => {
      const [x, y, z] = rotate(v, rx, ry);
      const s = opt.persp / (opt.persp + z);
      return [x * s * scale * U, y * s * scale * U, z];
    });
    E.forEach(([a, b], i) => {
      const L = lines[i], depth = (P[a][2] + P[b][2]) / 2; // -1 (front) … 1 (back)
      L.setAttribute('x1', P[a][0]); L.setAttribute('y1', P[a][1]);
      L.setAttribute('x2', P[b][0]); L.setAttribute('y2', P[b][1]);
      L.setAttribute('opacity', (0.95 - (depth + 1) * 0.32).toFixed(3));
    });
    if (withFaces) {
      F.forEach((f, i) => {
        const z = f.reduce((s, k) => s + P[k][2], 0) / 4;
        faces[i]?.setAttribute('points', f.map(k => `${P[k][0]},${P[k][1]}`).join(' '));
        faces[i]?.setAttribute('opacity', z < 0 ? 1 : 0.35);
      });
      dots.forEach((d, i) => { d.setAttribute('cx', P[i][0]); d.setAttribute('cy', P[i][1]); d.setAttribute('opacity', (1 - (P[i][2] + 1) * 0.35).toFixed(3)); });
    }
    return P;
  };

  let last = 0;
  const stop = loop(target instanceof SVGElement ? target.ownerSVGElement || target : svg, t => {
    if (opt.follow) { tiltX += (pointer.y * 0.25 - tiltX) * 0.06; tiltY += (pointer.x * 0.35 - tiltY) * 0.06; }
    const ry = Math.PI / 4 + t * opt.speed + tiltY;
    const rx = opt.tumble ? ISO_X + t * opt.speed * 0.62 + tiltX : ISO_X + tiltX + Math.sin(t * 0.4) * 0.06;
    const P = draw(outer, 1, rx, ry, true);
    if (opt.trails) { stepTrails(P, t - last); last = t; }
    if (opt.inner) draw(inner, 0.46, -rx * 0.8, -ry * 1.6 + 0.6, false);
  });
  return { destroy() { stop(); (target instanceof SVGElement ? g : svg).remove(); } };
}

/* ---------- spotlight hovers ---------- */
document.addEventListener('pointermove', e => {
  const card = e.target.closest?.('.spot');
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty('--mx', `${e.clientX - r.left}px`);
  card.style.setProperty('--my', `${e.clientY - r.top}px`);
}, { passive: true });

/* ---------- Framer-style mega menu ---------- */
function megaMenu() {
  const triggers = [...document.querySelectorAll('[data-menu]')];
  if (!triggers.length) return;
  let closeTimer, current = null;
  const header = document.querySelector('header.top');
  const open = btn => {
    clearTimeout(closeTimer);
    if (current === btn) return;
    if (current) close(true);
    current = btn;
    btn.setAttribute('aria-expanded', 'true');
    document.getElementById(btn.getAttribute('aria-controls')).hidden = false;
    document.body.classList.add('mm-open');
  };
  const close = now => {
    const run = () => {
      if (!current) return;
      current.setAttribute('aria-expanded', 'false');
      document.getElementById(current.getAttribute('aria-controls')).hidden = true;
      current = null;
      document.body.classList.remove('mm-open');
    };
    clearTimeout(closeTimer);
    now === true ? run() : (closeTimer = setTimeout(run, 140));
  };
  triggers.forEach(btn => {
    btn.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') open(btn); });
    btn.addEventListener('click', () => (current === btn ? close(true) : open(btn)));
  });
  header.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') close(); });
  header.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  document.querySelectorAll('.mm-panel').forEach(p => p.addEventListener('click', e => { if (e.target.closest('a')) close(true); }));
  document.querySelector('.links')?.addEventListener('pointerover', e => {
    if (e.target.closest('a:not(.mm-panel a)') && !e.target.closest('[data-menu]')) close();
  });
  addEventListener('keydown', e => { if (e.key === 'Escape' && current) { const b = current; close(true); b.focus(); } });
  document.addEventListener('pointerdown', e => { if (current && !e.target.closest('header.top')) close(true); });
}

/* ---------- word-by-word reveal ---------- */
function split(node) {
  let i = 0;
  const walk = parent => [...parent.childNodes].forEach(n => {
    if (n.nodeType === 3) {
      const frag = document.createDocumentFragment();
      n.textContent.split(/(\s+)/).forEach(part => {
        if (!part) return;
        if (/^\s+$/.test(part)) { frag.append(part); return; }
        const w = document.createElement('span');
        w.className = 'w'; w.style.setProperty('--i', i++); w.textContent = part;
        frag.append(w);
      });
      n.replaceWith(frag);
    } else if (n.nodeType === 1 && n.tagName !== 'BR') {
      n.classList.add('w'); n.style.setProperty('--i', i++);
    }
  });
  walk(node);
  node.classList.add('is-split');
}

/* ---------- count-up numbers ---------- */
function countUp(node, value, format = v => Math.round(v).toLocaleString('en-US')) {
  if (reduced || !Number.isFinite(value)) { node.textContent = format(value); return; }
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    io.disconnect();
    const t0 = performance.now(), dur = 1100;
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), ease = 1 - Math.pow(1 - k, 4);
      node.textContent = format(value * ease);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  io.observe(node);
}

/* ---------- chart hover: crosshair + tooltip for any svg.chart2d (see Art.chart) ---------- */
const chartCache = new WeakMap();
function chartData(svg) {
  if (!chartCache.has(svg)) {
    const nums = k => (svg.dataset[k] || '').split(',').map(Number);
    chartCache.set(svg, { xs: nums('xs'), ys: nums('ys'), vs: (svg.dataset.vs || '').split(','), ts: svg.dataset.ts ? nums('ts') : null, vb: svg.viewBox.baseVal });
  }
  return chartCache.get(svg);
}
const tFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
document.addEventListener('pointermove', e => {
  const svg = e.target.closest?.('svg.chart2d');
  if (!svg) return;
  const d = chartData(svg), rect = svg.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * d.vb.width;
  let i = 0;
  for (let k = 1; k < d.xs.length; k++) if (Math.abs(d.xs[k] - x) < Math.abs(d.xs[i] - x)) i = k;
  const hx = d.xs[i], hy = d.ys[i];
  svg.classList.add('hovering');
  svg.querySelector('.ch-cross').setAttribute('x1', hx); svg.querySelector('.ch-cross').setAttribute('x2', hx);
  const dot = svg.querySelector('.ch-dot'); dot.setAttribute('cx', hx); dot.setAttribute('cy', hy);
  svg.querySelector('.ch-tip-v').textContent = d.vs[i];
  svg.querySelector('.ch-tip-t').textContent = d.ts ? tFmt.format(new Date(d.ts[i] * 1000)) : '';
  const tx = hx > d.vb.width * 0.62 ? hx - 124 : hx + 12, ty = Math.max(4, Math.min(hy - 44, d.vb.height - 48));
  svg.querySelector('.ch-tip').setAttribute('transform', `translate(${tx} ${ty})`);
}, { passive: true });
document.addEventListener('pointerout', e => {
  const svg = e.target.closest?.('svg.chart2d');
  if (svg && !svg.contains(e.relatedTarget)) svg.classList.remove('hovering');
});

/* ---------- broken token logos fall back to the letter badge ---------- */
document.addEventListener('error', e => {
  const img = e.target;
  if (img?.tagName === 'IMG' && img.classList.contains('tk-img')) img.closest('.tk')?.classList.add('tk-broken');
}, true);

window.FX = { cube, split, countUp, megaMenu, reduced };
document.addEventListener('DOMContentLoaded', () => {
  megaMenu();
  document.querySelectorAll('[data-split]').forEach(split);
  document.querySelectorAll('[data-cube]').forEach(n => cube(n, JSON.parse(n.dataset.cube || '{}')));
});
})();
