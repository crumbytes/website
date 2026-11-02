import { OutboundError } from '../safe-http.js';

// How a capability can actually be delivered on a platform.
export const SUPPORT = Object.freeze({
  API: 'api',                 // Official API, available with the connection's normal credential.
  API_PERMISSION: 'api_permission', // Official API, but needs an extra scope, role, plan or setting.
  MANUAL: 'manual',           // No suitable API. Staff do it and record the result.
  UNSUPPORTED: 'unsupported'  // Not available on this platform.
});

export const SUPPORT_LABELS = Object.freeze({
  api: 'Supported API',
  api_permission: 'API with added permission',
  manual: 'Manual workflow',
  unsupported: 'Not available'
});

// Every failure from any platform becomes one of these codes. Provider bodies and
// headers are dropped, because they can echo credentials or customer data.
export const ERROR_MESSAGES = Object.freeze({
  auth_failed: 'The platform rejected the stored credential.',
  permission_required: 'The credential is valid but lacks the permission this needs.',
  not_found: 'The platform endpoint was not found. The API may be disabled or the URL may be wrong.',
  rate_limited: 'The platform asked the hub to slow down. Try again later.',
  timeout: 'The platform did not respond in time.',
  tls_error: 'The platform certificate could not be verified.',
  network_error: 'The platform could not be reached.',
  blocked_target: 'That address is not allowed for outbound requests.',
  redirected: 'The platform redirected the request. Credentials are not sent to redirected addresses.',
  invalid_response: 'The platform returned a response the hub could not read.',
  upstream_error: 'The platform reported an internal error.',
  response_too_large: 'The platform response was larger than the hub accepts.',
  outbound_disabled: 'Outbound connections are turned off for this environment.',
  backing_off: 'The platform asked the hub to wait. The check was not sent.',
  no_credential: 'No credential is stored for this connection.',
  operation_rejected: 'The platform refused the requested change.',
  internal_error: 'The check failed before it could finish.'
});

export class AdapterError extends Error {
  constructor(code, status, retryAfterSeconds) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function codeForStatus(status) {
  if (status === 401) return 'auth_failed';
  if (status === 403) return 'permission_required';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 300 && status < 400) return 'redirected';
  if (status >= 500) return 'upstream_error';
  return 'operation_rejected';
}

// All adapter traffic goes through this client. It accepts paths only, so an
// adapter or a stored record cannot send the credential to a different origin.
export function createPlatformClient({ baseUrl, http, authHeaders = {}, timeoutMs }) {
  const base = new URL(baseUrl);
  return {
    async send(method, path, { query, json, form, headers = {} } = {}) {
      if (!path.startsWith('/') || path.startsWith('//')) throw new AdapterError('blocked_target');
      const target = new URL(path, base);
      if (target.origin !== base.origin) throw new AdapterError('blocked_target');
      for (const [key, value] of Object.entries(query ?? {})) {
        for (const item of [value].flat()) target.searchParams.append(key, item);
      }
      const merged = { Accept: 'application/json', 'User-Agent': 'CrumByte-Website-Hub/0.1', ...authHeaders, ...headers };
      let body;
      if (json !== undefined) {
        body = JSON.stringify(json);
        merged['Content-Type'] ??= 'application/json';
      } else if (form) {
        body = new URLSearchParams(form).toString();
        merged['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      let response;
      try {
        response = await http.request({ url: target.href, method, headers: merged, body, timeoutMs });
      } catch (error) {
        if (error instanceof OutboundError) throw new AdapterError(error.code);
        throw new AdapterError('network_error');
      }
      if (response.status < 200 || response.status >= 300) {
        const rawRetry=response.headers?.['retry-after'];
        const seconds=/^\d+$/.test(String(rawRetry))?Number(rawRetry):(Date.parse(rawRetry)-Date.now())/1000;
        const retryAfter=Number.isFinite(seconds)?Math.min(3600,Math.max(1,Math.ceil(seconds))):undefined;
        throw new AdapterError(codeForStatus(response.status), response.status, Number.isFinite(retryAfter) ? retryAfter : undefined);
      }
      if (!response.body) return null;
      try {
        return JSON.parse(response.body);
      } catch {
        throw new AdapterError('invalid_response', response.status);
      }
    },
    get(path, options) { return this.send('GET', path, options); },
    post(path, options) { return this.send('POST', path, options); }
  };
}

export const expectObject = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdapterError('invalid_response');
  return value;
};
export const expectArray = value => {
  if (!Array.isArray(value)) throw new AdapterError('invalid_response');
  return value;
};

// Runs one section of a check. One denied section does not hide the others, and
// a denied section is reported as needing permission, never as a clean result.
export async function section(fn) {
  try {
    return { status: 'ok', data: await fn() };
  } catch (error) {
    const code = error instanceof AdapterError ? error.code : 'internal_error';
    return { status: code === 'permission_required' ? 'permission_required' : 'error', code, ...(error?.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) };
  }
}

export function summarizeSections(sections) {
  const values = Object.values(sections);
  if (values.every(item => item.status === 'ok')) return { outcome: 'ok', code: null };
  if (values.some(item => item.status === 'ok')) {
    return { outcome: 'partial', code: values.find(item => item.status !== 'ok').code ?? 'permission_required' };
  }
  return { outcome: 'failed', code: values[0]?.code ?? 'internal_error' };
}

// Gives each adapter the same two entry points from its named sections. A
// connection test runs only the connection section, so it stays light on rate limits.
export function defineAdapter(definition) {
  const run = async (client, context, names) => {
    const sections = definition.sections(client, context);
    const results = {};
    for (const name of names ?? Object.keys(sections)) results[name] = await section(sections[name]);
    return results;
  };
  return {
    ...definition,
    check: (client, context = {}) => run(client, context),
    testConnection: (client, context = {}) => run(client, context, ['connection'])
  };
}

// Maps an arbitrary failure to a code that is safe to store and display.
export const safeCode = error =>
  error instanceof AdapterError || error instanceof OutboundError ? error.code : 'internal_error';
