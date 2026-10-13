/**
 * Minimal GitHub Gist API client.
 *
 * - The token is sent only to https://api.github.com.
 * - Truncated files (`truncated: true`) are fetched from their `raw_url`,
 *   which must be HTTPS on gist.githubusercontent.com; the token is NOT
 *   forwarded there (secret-gist raw URLs need no authentication).
 * - Errors carry a code and a plain-language explanation.
 */

export const API_BASE = 'https://api.github.com';
export const RAW_HOSTS = Object.freeze(['gist.githubusercontent.com']);

export class GistError extends Error {
  constructor(message, { code, status = 0, retryAfter = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function explainStatus(status, headers, bodyMessage = '') {
  const remaining = headers?.get?.('x-ratelimit-remaining');
  if (status === 401) return { code: 'auth', message: 'GitHub rejected the token. It may be mistyped, expired or revoked. Create a new token with Gist access and paste it again.' };
  if (status === 403 && remaining === '0') {
    const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
    return { code: 'rate-limit', message: `GitHub's rate limit was reached. Try again after ${new Date(reset).toLocaleTimeString()}.`, retryAfter: reset };
  }
  if (status === 403) return { code: 'forbidden', message: 'The token does not have permission to use Gists. A fine-grained token needs "Gists: Read and write"; a classic token needs the "gist" scope.' };
  if (status === 404) return { code: 'not-found', message: 'The Gist was not found. Check the Gist ID, and that the token belongs to the account that owns it.' };
  if (status === 409) return { code: 'conflict', message: 'GitHub reported a conflicting update. Axon will re-read and merge before trying again.' };
  if (status === 422) return { code: 'validation', message: `GitHub refused the data${bodyMessage ? `: ${bodyMessage}` : ''}. The sync payload may be too large.` };
  if (status === 429) return { code: 'rate-limit', message: 'Too many requests to GitHub. Wait a minute and try again.' };
  if (status >= 500) return { code: 'server', message: 'GitHub is having problems right now. Your data is safe on this device; try again later.' };
  return { code: 'http', message: `Unexpected response from GitHub (HTTP ${status}).` };
}

export function isAllowedRawUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && RAW_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

export class GistClient {
  constructor({ token, fetchImpl = globalThis.fetch?.bind(globalThis), apiBase = API_BASE, timeoutMs = 30000 } = {}) {
    if (!token) throw new GistError('A GitHub token is required', { code: 'auth' });
    this.token = token;
    this.fetch = fetchImpl;
    this.apiBase = apiBase;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body) {
    const url = `${this.apiBase}${path}`;
    if (!url.startsWith('https://api.github.com/') && this.apiBase === API_BASE) throw new GistError('Refusing to send the token to a non-GitHub host', { code: 'security' });
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: controller?.signal,
      });
    } catch (err) {
      throw new GistError(err?.name === 'AbortError' ? 'GitHub did not respond in time. Check your connection and try again.' : 'Could not reach GitHub. You may be offline; your data is safe on this device.', { code: 'network' });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) {
      let msg = '';
      try {
        msg = (await res.json())?.message || '';
      } catch {
        /* ignore */
      }
      const info = explainStatus(res.status, res.headers, msg);
      throw new GistError(info.message, { code: info.code, status: res.status, retryAfter: info.retryAfter });
    }
    if (res.status === 204) return null;
    return res.json();
  }

  getUser() {
    return this.request('GET', '/user');
  }

  getGist(id) {
    return this.request('GET', `/gists/${encodeURIComponent(id)}`);
  }

  getGistRevision(id, sha) {
    return this.request('GET', `/gists/${encodeURIComponent(id)}/${encodeURIComponent(sha)}`);
  }

  createGist(files, description = 'Axon SRS sync data (do not edit by hand)') {
    return this.request('POST', '/gists', { description, public: false, files });
  }

  updateGist(id, files) {
    return this.request('PATCH', `/gists/${encodeURIComponent(id)}`, { files });
  }

  /** File content, following raw_url when the API truncated it. */
  async fileContent(gist, name) {
    const f = gist.files?.[name];
    if (!f) return null;
    if (!f.truncated && typeof f.content === 'string') return f.content;
    if (!isAllowedRawUrl(f.raw_url)) throw new GistError('Unexpected raw file location; refusing to fetch it', { code: 'security' });
    let res;
    try {
      res = await this.fetch(f.raw_url, { method: 'GET', cache: 'no-store', credentials: 'omit' });
    } catch {
      throw new GistError('Could not download a large sync file from GitHub.', { code: 'network' });
    }
    if (!res.ok) {
      const info = explainStatus(res.status, res.headers);
      throw new GistError(info.message, { code: info.code, status: res.status });
    }
    return res.text();
  }
}

/** Accept a Gist ID or any github.com Gist URL. */
export function parseGistId(input) {
  const s = String(input || '').trim();
  const m = /([0-9a-f]{20,40})\/?$/i.exec(s);
  return m ? m[1] : null;
}
