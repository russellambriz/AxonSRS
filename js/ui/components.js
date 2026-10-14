/**
 * Reusable UI components: toasts (with undo), sheets/dialogs, menus,
 * form controls and a virtualised list for large card collections.
 */

import { h, clear, labelControls } from './dom.js';
import { icon } from './icons.js';

/* ------------------------------------------------------------- toasts */

let toastHost = null;
function host() {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  return toastHost;
}

/**
 * toast('Deck deleted', { action: { label: 'Undo', run }, timeout })
 */
export function toast(message, { action = null, timeout = 5000, kind = '' } = {}) {
  const el = h('div', { class: ['toast', kind] }, h('span', { class: 'grow' }, message));
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    el.remove();
  };
  if (action) {
    el.append(h('button', {
      class: 'btn small',
      onclick: async () => {
        close();
        await action.run();
      },
    }, action.label));
  }
  el.append(h('button', { class: 'btn small icon', 'aria-label': 'Dismiss', onclick: close }, icon('x')));
  host().append(el);
  if (timeout) timer = setTimeout(close, timeout);
  return close;
}

export function errorToast(err, prefix = '') {
  console.error(err);
  return toast(`${prefix}${err?.message || err}`, { kind: 'error', timeout: 8000 });
}

/* ------------------------------------------------------------- sheets */

/**
 * Open a dialog. content: Node | (close) => Node. Returns { el, close, done }.
 * `done` resolves with the value passed to close().
 */
export function sheet({ title, content, footer = null, wide = false, onClose = null, labelledBy = null }) {
  let resolveDone;
  const done = new Promise((r) => {
    resolveDone = r;
  });
  const dialog = h('dialog', { class: ['sheet', wide && 'wide'], 'aria-label': title });
  const close = (value) => {
    if (!dialog.open) return;
    dialog.close();
    dialog.remove();
    if (onClose) onClose(value);
    resolveDone(value);
  };
  const body = h('div', { class: 'sheet-body' });
  const contentNode = typeof content === 'function' ? content(close) : content;
  body.append(contentNode);
  dialog.append(
    h('div', { class: 'sheet-head' }, h('h2', { id: labelledBy || undefined }, title), h('button', { class: 'btn ghost icon small', 'aria-label': 'Close', onclick: () => close(undefined) }, icon('x'))),
    body,
  );
  if (footer) dialog.append(h('div', { class: 'sheet-foot' }, typeof footer === 'function' ? footer(close) : footer));
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close(undefined);
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close(undefined);
  });
  document.body.append(dialog);
  dialog.showModal();
  return { el: dialog, close, done, body };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, cancelLabel = 'Cancel' }) {
  const s = sheet({
    title,
    content: h('p', { class: 'muted' }, message),
    footer: (close) => [
      h('button', { class: 'btn', onclick: () => close(false) }, cancelLabel),
      h('button', { class: ['btn', danger ? 'danger solid' : 'primary'], onclick: () => close(true), autofocus: true }, confirmLabel),
    ],
  });
  return s.done.then((v) => !!v);
}

export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'Save', multiline = false }) {
  let input;
  const s = sheet({
    title,
    content: (close) => {
      input = multiline
        ? h('textarea', { class: 'textarea', placeholder })
        : h('input', { class: 'input', placeholder, onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); close(input.value); } } });
      input.value = value;
      return h('div', { class: 'field' }, h('label', {}, label), input);
    },
    footer: (close) => [
      h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => close(input.value) }, confirmLabel),
    ],
  });
  setTimeout(() => {
    input.focus();
    input.select?.();
  }, 30);
  return s.done.then((v) => (v == null ? null : v));
}

/* -------------------------------------------------------------- menus */

let openMenu = null;
export function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

/**
 * items: [{ label, icon, run, danger, disabled } | 'separator']
 */
export function menu(anchor, items) {
  closeMenu();
  const el = h('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (item === 'separator') {
      el.append(h('hr'));
      continue;
    }
    if (!item) continue;
    el.append(h('button', {
      role: 'menuitem',
      class: item.danger ? 'danger' : '',
      disabled: !!item.disabled,
      onclick: (e) => {
        e.stopPropagation();
        closeMenu();
        item.run();
      },
    }, item.icon ? icon(item.icon) : null, item.label));
  }
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  openMenu = el;
  el.querySelector('button:not([disabled])')?.focus();
  el.addEventListener('keydown', (e) => {
    const buttons = [...el.querySelectorAll('button:not([disabled])')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    if (e.key === 'Escape') { closeMenu(); anchor.focus(); }
  });
  return el;
}

document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});

/* ------------------------------------------------------------- inputs */

export function switchControl({ checked, onchange, label = '', id = null }) {
  const input = h('input', { type: 'checkbox', role: 'switch', id: id || undefined });
  input.checked = !!checked;
  input.addEventListener('change', () => onchange(input.checked));
  return h('label', { class: 'switch' }, input, h('span', { class: 'track', 'aria-hidden': 'true' }), label ? h('span', {}, label) : null);
}

export function segmented({ options, value, onchange, label = '' }) {
  const wrap = h('div', { class: 'segmented', role: 'group', 'aria-label': label });
  const render = (v) => {
    clear(wrap);
    for (const opt of options) {
      wrap.append(h('button', {
        type: 'button',
        'aria-pressed': String(opt.value === v),
        onclick: () => {
          render(opt.value);
          onchange(opt.value);
        },
      }, opt.label));
    }
  };
  render(value);
  return wrap;
}

export function select({ options, value, onchange, label = '', id = null }) {
  const el = h('select', { class: 'select', 'aria-label': label || undefined, id: id || undefined });
  for (const opt of options) {
    const o = h('option', { value: opt.value }, opt.label);
    if (String(opt.value) === String(value)) o.selected = true;
    el.append(o);
  }
  el.addEventListener('change', () => onchange(el.value));
  return el;
}

export function settingRow({ title, desc = '', control }) {
  const titleEl = h('div', { class: 'title' }, title);
  const descEl = desc ? h('div', { class: 'desc' }, desc) : null;
  const controlEl = h('div', { class: 'control' }, control);
  labelControls(controlEl, titleEl, descEl);
  return h('div', { class: 'setting-row' }, h('div', { class: 'text' }, titleEl, descEl), controlEl);
}

export function emptyState({ iconName = 'sparkles', title, text, actions = [] }) {
  return h('div', { class: 'empty' }, h('div', { class: 'art' }, icon(iconName)), h('h2', {}, title), h('p', {}, text), actions.length ? h('div', { class: 'row', style: { justifyContent: 'center' } }, actions) : null);
}

export function callout(kind, text, iconName = kind === 'danger' || kind === 'warning' ? 'alert' : 'info') {
  return h('div', { class: ['callout', kind] }, icon(iconName), h('div', {}, text));
}

/* ------------------------------------------------------ virtual list */

/**
 * Virtualised list: renders only the visible rows (fixed height), so
 * browsing 10 000+ cards stays smooth.
 */
export class VirtualList {
  constructor({ rowHeight = 60, renderRow, className = 'virtual-list', overscan = 8 }) {
    this.rowHeight = rowHeight;
    this.renderRow = renderRow;
    this.overscan = overscan;
    this.items = [];
    this.el = h('div', { class: className, tabindex: '-1' });
    this.inner = h('div', { class: 'virtual-list-inner' });
    this.el.append(this.inner);
    this.rendered = new Map();
    this.raf = 0;
    this.el.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.resizeObs = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.schedule()) : null;
    this.resizeObs?.observe(this.el);
  }

  setItems(items) {
    this.items = items;
    this.inner.style.height = `${items.length * this.rowHeight}px`;
    for (const node of this.rendered.values()) node.remove();
    this.rendered.clear();
    this.update();
  }

  refresh() {
    for (const node of this.rendered.values()) node.remove();
    this.rendered.clear();
    this.update();
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.update();
    });
  }

  update() {
    const viewport = this.el.clientHeight || 600;
    const start = Math.max(0, Math.floor(this.el.scrollTop / this.rowHeight) - this.overscan);
    const end = Math.min(this.items.length, Math.ceil((this.el.scrollTop + viewport) / this.rowHeight) + this.overscan);
    for (const [i, node] of this.rendered) {
      if (i < start || i >= end) {
        node.remove();
        this.rendered.delete(i);
      }
    }
    for (let i = start; i < end; i++) {
      if (this.rendered.has(i)) continue;
      const node = this.renderRow(this.items[i], i);
      node.style.top = `${i * this.rowHeight}px`;
      this.inner.append(node);
      this.rendered.set(i, node);
    }
  }

  destroy() {
    this.resizeObs?.disconnect();
    cancelAnimationFrame(this.raf);
  }
}

/* ---------------------------------------------------- simple charts */

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const k of kids) if (k) el.append(k);
  return el;
}

let tooltipEl = null;
function tooltip() {
  if (!tooltipEl) {
    tooltipEl = h('div', { class: 'chart-tooltip', role: 'tooltip', hidden: true });
    document.body.append(tooltipEl);
  }
  return tooltipEl;
}

/** Attach a hover/focus tooltip to an SVG hit target. */
function hover(target, text) {
  target.setAttribute('tabindex', '0');
  target.setAttribute('aria-label', text);
  const show = (e) => {
    const t = tooltip();
    t.textContent = text;
    t.hidden = false;
    const r = target.getBoundingClientRect();
    const x = e && e.clientX != null ? e.clientX : r.left + r.width / 2;
    const y = e && e.clientY != null ? e.clientY : r.top;
    t.style.left = `${Math.min(window.innerWidth - t.offsetWidth - 8, Math.max(8, x - t.offsetWidth / 2))}px`;
    t.style.top = `${Math.max(8, y - t.offsetHeight - 12)}px`;
  };
  const hide = () => {
    tooltip().hidden = true;
  };
  target.addEventListener('pointermove', show);
  target.addEventListener('pointerenter', show);
  target.addEventListener('pointerleave', hide);
  target.addEventListener('focus', () => show(null));
  target.addEventListener('blur', hide);
}

/** Path for a bar with a 4px rounded data end and a square baseline. */
function barPath(x, y, w, hgt) {
  const r = Math.min(4, w / 2, hgt);
  if (hgt <= 0) return '';
  return `M${x},${y + hgt} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + hgt} Z`;
}

function niceMax(v) {
  if (v <= 5) return Math.max(1, Math.ceil(v));
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function compact(n) {
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(n);
}

/** Single-series column chart. data: [{ label, value, tick?, muted? }] */
export function barChart(data, { height = 150, label = 'Chart', format = (v) => String(v) } = {}) {
  const width = 560;
  const pad = { l: 30, r: 6, t: 10, b: 20 };
  const max = niceMax(Math.max(1, ...data.map((d) => d.value)));
  const band = (width - pad.l - pad.r) / Math.max(1, data.length);
  const bw = Math.max(1, Math.min(24, band - 2));
  const svgEl = s('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label });
  const plotH = height - pad.t - pad.b;
  const ticks = max <= 4 ? [0, 1] : [0, 0.5, 1];
  for (const t of ticks) {
    const y = pad.t + (1 - t) * plotH;
    svgEl.append(s('line', { class: t === 0 ? 'axis' : 'grid', x1: pad.l, x2: width - pad.r, y1: y, y2: y }));
    const txt = s('text', { x: pad.l - 6, y: y + 3, 'text-anchor': 'end' });
    txt.textContent = compact(Math.round(max * t));
    svgEl.append(txt);
  }
  data.forEach((d, i) => {
    const bh = (d.value / max) * plotH;
    const x = pad.l + i * band + (band - bw) / 2;
    const y = height - pad.b - bh;
    if (bh > 0) svgEl.append(s('path', { class: ['bar', d.muted ? 'muted' : ''].join(' '), d: barPath(x, y, bw, bh) }));
    const hit = s('rect', { class: 'hit', x: pad.l + i * band, y: pad.t, width: band, height: plotH });
    hover(hit, `${d.label}: ${format(d.value)}`);
    svgEl.append(hit);
    if (d.tick) {
      const t = s('text', { x: pad.l + i * band + band / 2, y: height - 5, 'text-anchor': 'middle' });
      t.textContent = d.tick;
      svgEl.append(t);
    }
  });
  return svgEl;
}

/** Single-series line with optional 95% interval band. points: [{ x, y, lo?, hi?, n? }] */
export function lineChart(points, { height = 160, label = 'Chart', yMax = 1, format = (v) => `${Math.round(v * 100)}%` } = {}) {
  const width = 560;
  const pad = { l: 38, r: 10, t: 10, b: 20 };
  const n = Math.max(1, points.length - 1);
  const x = (i) => pad.l + (points.length === 1 ? 0.5 : i / n) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / yMax) * (height - pad.t - pad.b);
  const svgEl = s('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label });
  for (const t of [0, 0.5, 1]) {
    svgEl.append(s('line', { class: t === 0 ? 'axis' : 'grid', x1: pad.l, x2: width - pad.r, y1: y(t * yMax), y2: y(t * yMax) }));
    const txt = s('text', { x: pad.l - 6, y: y(t * yMax) + 3, 'text-anchor': 'end' });
    txt.textContent = format(t * yMax);
    svgEl.append(txt);
  }
  const valid = points.map((p, i) => ({ ...p, i })).filter((p) => Number.isFinite(p.y));
  const banded = valid.filter((p) => Number.isFinite(p.lo) && Number.isFinite(p.hi));
  if (banded.length > 1) {
    const d = `${banded.map((p, k) => `${k ? 'L' : 'M'}${x(p.i)},${y(p.hi)}`).join(' ')} ${banded.slice().reverse().map((p) => `L${x(p.i)},${y(p.lo)}`).join(' ')} Z`;
    svgEl.append(s('path', { class: 'band', d }));
  }
  if (valid.length > 1) svgEl.append(s('path', { class: 'line', d: valid.map((p, k) => `${k ? 'L' : 'M'}${x(p.i)},${y(p.y)}`).join(' ') }));
  const last = valid[valid.length - 1];
  if (last) svgEl.append(s('circle', { class: 'dot', cx: x(last.i), cy: y(last.y), r: 4 }));
  const slot = (width - pad.l - pad.r) / Math.max(1, points.length);
  for (const p of valid) {
    const hit = s('rect', { class: 'hit', x: x(p.i) - slot / 2, y: pad.t, width: slot, height: height - pad.t - pad.b });
    hover(hit, `${p.x}: ${format(p.y)}${p.n != null ? ` (n=${p.n}${Number.isFinite(p.lo) ? `, 95% CI ${format(p.lo)}–${format(p.hi)}` : ''})` : ''}`);
    svgEl.append(hit);
  }
  if (points[0]) {
    const t1 = s('text', { x: pad.l, y: height - 5 });
    t1.textContent = points[0].x;
    svgEl.append(t1);
  }
  if (points.length > 1) {
    const t2 = s('text', { x: width - pad.r, y: height - 5, 'text-anchor': 'end' });
    t2.textContent = points[points.length - 1].x;
    svgEl.append(t2);
  }
  return svgEl;
}

/** Calibration plot: predicted vs observed, with the ideal diagonal. */
export function calibrationChart(bins, { size = 240 } = {}) {
  const pad = 30;
  const svgEl = s('svg', { class: 'chart', viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': 'Predicted retrievability versus observed recall', style: 'max-width:300px' });
  const sc = (v) => pad + v * (size - 2 * pad);
  const sy = (v) => size - pad - v * (size - 2 * pad);
  svgEl.append(s('line', { class: 'axis', x1: pad, y1: size - pad, x2: size - pad, y2: size - pad }));
  svgEl.append(s('line', { class: 'axis', x1: pad, y1: pad, x2: pad, y2: size - pad }));
  svgEl.append(s('line', { class: 'ideal', x1: sc(0), y1: sy(0), x2: sc(1), y2: sy(1) }));
  for (const b of bins) {
    if (!b.n) continue;
    const c = s('circle', { class: 'dot', cx: sc(b.predicted), cy: sy(b.observed), r: Math.min(10, 4 + Math.sqrt(b.n) / 3) });
    hover(c, `Predicted ${Math.round(b.predicted * 100)}% · observed ${Math.round(b.observed * 100)}% (n=${b.n}, 95% CI ${Math.round(b.ci.low * 100)}–${Math.round(b.ci.high * 100)}%)`);
    svgEl.append(c);
  }
  for (const [v, anchor] of [[0, 'start'], [1, 'end']]) {
    const t = s('text', { x: sc(v), y: size - pad + 14, 'text-anchor': anchor });
    t.textContent = `${v * 100}%`;
    svgEl.append(t);
  }
  const lx = s('text', { x: size / 2, y: size - 6, 'text-anchor': 'middle' });
  lx.textContent = 'predicted retrievability';
  const ly = s('text', { x: 12, y: size / 2, transform: `rotate(-90 12 ${size / 2})`, 'text-anchor': 'middle' });
  ly.textContent = 'observed recall';
  svgEl.append(lx, ly);
  return svgEl;
}

/** Accessible data table that accompanies a chart. rows: array of arrays */
export function dataTable(headers, rows, { caption = '' } = {}) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    caption ? h('caption', { class: 'visually-hidden' }, caption) : null,
    h('thead', {}, h('tr', {}, headers.map((x) => h('th', { scope: 'col' }, x)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', { class: 'num' }, c)))))));
}

/** Chart with a "Table" toggle so values are never chart-only. */
export function chartWithTable(chartEl, tableEl, { title = '' } = {}) {
  const wrap = h('div', { class: 'chart-block' });
  let showingTable = false;
  const area = h('div', {}, chartEl);
  const toggle = h('button', { class: 'btn ghost small', 'aria-pressed': 'false', onclick: () => {
    showingTable = !showingTable;
    toggle.setAttribute('aria-pressed', String(showingTable));
    toggle.textContent = showingTable ? 'Chart' : 'Table';
    area.replaceChildren(showingTable ? tableEl : chartEl);
  } }, 'Table');
  wrap.append(h('div', { class: 'row between' }, title ? h('h3', {}, title) : h('span'), toggle), area);
  return wrap;
}
