/**
 * A DOM for running the real study screen in Node (jsdom + fake-indexeddb).
 *
 * This is not a browser: there is no layout, no real canvas and no real
 * pointer hardware. It runs the app's own modules against an in-memory
 * IndexedDB so draft persistence, hydration order and save ordering can be
 * tested where Chromium is unavailable. Layout, ink rendering and Pencil
 * behaviour still need tests/browser and a real device.
 */
import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="app"><main id="main"></main></div></body></html>', {
  url: 'http://localhost:8080/AxonSRS/',
  pretendToBeVisual: true,
});
const w = dom.window;

// A 2D context that accepts every call and draws nothing.
function fakeContext(canvas) {
  const noop = () => {};
  const target = { canvas, getImageData: () => ({ data: new Uint8ClampedArray(4) }), createImageData: () => ({ data: new Uint8ClampedArray(4) }), measureText: () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }), createLinearGradient: () => ({ addColorStop: noop }), createPattern: () => null, getTransform: () => ({ a: 1, d: 1 }), isPointInPath: () => false };
  return new Proxy(target, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
}
w.HTMLCanvasElement.prototype.getContext = function getContext() {
  this.__ctx ??= fakeContext(this);
  return this.__ctx;
};
w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
// The pad measures its canvas; give every element a stable box.
let box = { width: 600, height: 300 };
export function setPadBox(next) { box = next; }
w.HTMLElement.prototype.getBoundingClientRect = function rect() {
  return { x: 0, y: 0, left: 0, top: 0, right: box.width, bottom: box.height, width: box.width, height: box.height };
};
w.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
w.HTMLElement.prototype.scrollIntoView = function noop() {};
if (!w.PointerEvent) {
  w.PointerEvent = class PointerEvent extends w.MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
      this.pressure = init.pressure ?? 0.5;
      this.isPrimary = init.isPrimary ?? true;
      this.width = init.width ?? 1;
      this.height = init.height ?? 1;
      this.tiltX = 0;
      this.tiltY = 0;
    }
  };
}
w.HTMLElement.prototype.setPointerCapture = function noop() {};
w.HTMLElement.prototype.releasePointerCapture = function noop() {};
w.HTMLDialogElement && (w.HTMLDialogElement.prototype.showModal ??= function showModal() { this.open = true; });
w.HTMLDialogElement && (w.HTMLDialogElement.prototype.close ??= function close() { this.open = false; });

const keys = ['AbortController', 'AbortSignal', 'window', 'document', 'navigator', 'location', 'HTMLElement', 'HTMLInputElement', 'HTMLCanvasElement', 'HTMLDialogElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'InputEvent', 'FocusEvent', 'DOMParser', 'MutationObserver', 'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage', 'DocumentFragment', 'Text', 'SVGElement', 'Image', 'HTMLImageElement', 'NodeFilter', 'Range', 'Selection', 'getSelection', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'screen', 'history', 'HTMLAnchorElement', 'HTMLButtonElement'];
for (const k of keys) {
  if (k in globalThis && !['navigator', 'AbortController', 'AbortSignal'].includes(k)) continue;
  try {
    Object.defineProperty(globalThis, k, { value: typeof w[k] === 'function' && /^[a-z]/.test(k) ? w[k].bind(w) : w[k], configurable: true, writable: true });
  } catch { /* read-only global */ }
}
try { Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true }); } catch { /* keep node's */ }
w.indexedDB = globalThis.indexedDB;
w.IDBKeyRange = globalThis.IDBKeyRange;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
w.ResizeObserver = globalThis.ResizeObserver;
globalThis.speechSynthesis = undefined;
w.HTMLImageElement.prototype.decode = () => Promise.resolve();
globalThis.URL.createObjectURL ??= () => 'blob:x';
globalThis.URL.revokeObjectURL ??= () => {};

export { dom, w as window };
