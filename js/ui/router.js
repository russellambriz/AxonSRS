/**
 * Hash router. Hash routes (#/decks, #/study, …) mean a refresh or a PWA
 * launch on any screen under /AxonSRS/ always loads index.html, so GitHub
 * Pages never returns a 404.
 */

export class Router {
  constructor({ routes, outlet, onChange = null, notFound = null }) {
    this.routes = routes.map((r) => ({ ...r, regex: compile(r.path) }));
    this.outlet = outlet;
    this.onChange = onChange;
    this.notFound = notFound;
    this.current = null;
    this.currentPath = null;
    this.guard = null;
    this.handle = () => this.resolve();
  }

  start() {
    window.addEventListener('hashchange', this.handle);
    this.resolve();
  }

  /** Optional guard: () => boolean|Promise<boolean>; false keeps the current view. */
  setGuard(fn) {
    this.guard = fn;
  }

  navigate(path, { replace = false } = {}) {
    const target = path.startsWith('#') ? path : `#${path}`;
    if (location.hash === target) {
      this.resolve(true);
      return;
    }
    if (replace) {
      history.replaceState(null, '', target);
      this.resolve();
    } else {
      location.hash = target;
    }
  }

  parse() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [pathPart, queryPart = ''] = raw.split('?');
    const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
    const query = Object.fromEntries(new URLSearchParams(queryPart));
    return { path, query, raw };
  }

  async resolve(force = false) {
    const { path, query, raw } = this.parse();
    if (!force && raw === this.currentPath) return;
    if (this.guard && this.current && !(await this.guard(raw))) {
      history.replaceState(null, '', `#${this.currentPath}`);
      return;
    }
    let match = null;
    for (const r of this.routes) {
      const m = r.regex.exec(path);
      if (m) {
        match = { route: r, params: m.groups || {} };
        break;
      }
    }
    if (this.current?.destroy) {
      try {
        this.current.destroy();
      } catch (err) {
        console.error(err);
      }
    }
    this.current = null;
    this.currentPath = raw;
    this.outlet.replaceChildren();
    window.scrollTo(0, 0);
    if (!match) {
      if (this.notFound) this.current = await this.notFound(this.outlet, { path, query });
      return;
    }
    const decoded = Object.fromEntries(Object.entries(match.params).map(([k, v]) => [k, decodeURIComponent(v)]));
    if (this.onChange) this.onChange(match.route, decoded, query);
    try {
      this.current = await match.route.view(this.outlet, decoded, query);
    } catch (err) {
      console.error(err);
      this.outlet.textContent = `Something went wrong opening this screen: ${err.message}`;
    }
  }
}

function compile(pattern) {
  const src = pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, '(?<$1>[^/]+)');
  return new RegExp(`^${src}\\/?$`);
}
