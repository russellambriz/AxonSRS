/** Theme, font scale, dyslexia-friendly font and motion preferences. */

export function applyAppearance(device) {
  const root = document.documentElement;
  if (device.theme === 'light' || device.theme === 'dark') root.setAttribute('data-theme', device.theme);
  else root.removeAttribute('data-theme');
  root.classList.toggle('dyslexic', !!device.dyslexiaFont);
  root.style.setProperty('--font-scale', String(device.fontScale || 1));
  root.classList.toggle('reduce-motion', device.reduceMotion === 'reduce');
  const meta = document.querySelectorAll('meta[name="theme-color"]');
  if (device.theme === 'dark') meta.forEach((m) => m.setAttribute('content', '#0e0e11'));
  else if (device.theme === 'light') meta.forEach((m) => m.setAttribute('content', '#f7f7f9'));
  try {
    localStorage.setItem('axon-theme', device.theme || 'system');
    localStorage.setItem('axon-dyslexic', device.dyslexiaFont ? '1' : '0');
    localStorage.setItem('axon-font-scale', String(device.fontScale || 1));
  } catch {
    /* storage may be unavailable (private mode); appearance still applies */
  }
}

/** Announce text to screen readers via the live regions in index.html. */
export function announce(text, { assertive = false } = {}) {
  const el = document.getElementById(assertive ? 'sr-alert' : 'sr-live');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => {
    el.textContent = text;
  }, 30);
}
