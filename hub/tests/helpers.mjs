import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { loadConfig } from '../src/config.js';
import { applyMigrations, createDb, pgliteDriver } from '../src/db.js';
import { buildApp } from '../src/runtime.js';

export const ISSUER = 'https://idp.hub.test';
export const ORIGIN = 'https://hub.hub.test';
export const TEST_KEK = `t1:${randomBytes(32).toString('base64')}`;

// All records in the tests are obviously synthetic and use reserved .test names.
export async function createHarness({ env = {}, http, logger } = {}) {
  const pg = new PGlite();
  await pg.waitReady;
  await applyMigrations(pg);
  const db = createDb(pgliteDriver(pg));
  const config = loadConfig({
    HUB_ENV: 'test', HUB_BASE_URL: ORIGIN, HUB_OIDC_ISSUER: ISSUER, HUB_OIDC_CLIENT_ID: 'hub-test', ...env
  });

  const keys = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const idp = { codes: new Map(), available: true, overrideClaims: {}, signKey: keys.privateKey };
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    if (!idp.available) throw new TypeError('network down');
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (href === `${ISSUER}/.well-known/openid-configuration`) {
      return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
    }
    if (href === `${ISSUER}/jwks`) return json({ keys: [jwk] });
    if (href === `${ISSUER}/token`) {
      const form = new URLSearchParams(options.body);
      const grant = idp.codes.get(form.get('code'));
      if (!grant) return json({ error: 'invalid_grant' }, 400);
      idp.lastTokenRequest = form;
      const claims = { email: grant.email, email_verified: true, nonce: grant.nonce, ...idp.overrideClaims };
      const { aud = 'hub-test', iss = ISSUER, sub = `sub-${grant.email}`, exp = '5m', ...rest } = claims;
      const idToken = await new SignJWT(rest).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(iss)
        .setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime(exp).sign(idp.signKey);
      return json({ access_token: 'opaque', id_token: idToken });
    }
    throw new Error(`Unexpected identity provider request: ${href}`);
  };

  const app = buildApp({ config, db, fetchImpl, http, logger: logger ?? { error() {} } });

  async function startLogin() {
    const res = await app.request('/auth/start');
    const location = new URL(res.headers.get('location'));
    const binding = res.headers.getSetCookie().find(item => item.startsWith('hub_login=')).split(';')[0];
    return { location, binding, state: location.searchParams.get('state'), nonce: location.searchParams.get('nonce') };
  }

  // Runs the real authorization-code flow against the fake identity provider.
  async function login(email) {
    const { binding, state, nonce } = await startLogin();
    const code = `code-${randomBytes(6).toString('hex')}`;
    idp.codes.set(code, { email, nonce });
    const res = await app.request(`/auth/callback?code=${code}&state=${encodeURIComponent(state)}`, { headers: { Cookie: binding } });
    const cookieHeader = res.headers.getSetCookie().find(item => item.startsWith('hub_session='));
    return { res, cookie: cookieHeader?.split(';')[0] ?? null, setCookie: cookieHeader };
  }

  async function sessionFor(email) {
    const { cookie, res } = await login(email);
    if (!cookie) throw new Error(`Login failed for ${email}: ${res.status}`);
    const me = await (await app.request('/api/v1/me', { headers: { Cookie: cookie } })).json();
    const headers = { Cookie: cookie, Origin: ORIGIN };
    return {
      id: me.staff.id, staff: me.staff, cookie, csrf: me.csrf_token,
      get: path => app.request(path, { headers: { Cookie: cookie } }),
      post: (path, form = {}) => app.request(path, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: me.csrf_token, ...form })
      }),
      postJson: (path, body) => app.request(path, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token },
        body: typeof body === 'string' ? body : JSON.stringify(body)
      })
    };
  }

  // Direct superuser seeding for arranging scenarios. Never used by the app.
  const addStaff = async (email, role, status = 'active') => (await pg.query(
    `insert into hub.staff_users (email, display_name, role, status) values ($1, $2, $3, $4) returning id`,
    [email, email.split('@')[0], role, status])).rows[0].id;
  const addClient = async (name, ownerId) => (await pg.query(
    `insert into hub.client_accounts (display_name, created_by) values ($1, $2) returning id`, [name, ownerId])).rows[0].id;
  const addWebsite = async (clientId, slug, createdBy, platform = 'wordpress') => (await pg.query(
    `insert into hub.managed_websites (client_account_id, display_name, primary_url, cms_platform, created_by)
     values ($1, $2, $3, $4, $5) returning id`, [clientId, slug, `https://${slug}.example.test`, platform, createdBy])).rows[0].id;
  const assign = (staffId, clientId, by) => pg.query(
    `insert into hub.staff_client_assignments (staff_id, client_account_id, assigned_by) values ($1, $2, $3)`, [staffId, clientId, by]);
  const auditActions = async () => (await pg.query(`select action, outcome, metadata, actor_staff_id, client_account_id from hub.audit_log order by seq`)).rows;

  return { pg, db, app, config, idp, startLogin, login, sessionFor, addStaff, addClient, addWebsite, assign, auditActions, close: () => pg.close() };
}

// A stand-in for the outbound client, so adapter tests contact nothing.
export function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    async request(options) {
      calls.push(options);
      const url = new URL(options.url);
      const handler = routes[`${options.method} ${url.pathname}`] ?? routes[url.pathname] ?? routes['*'];
      if (!handler) return { status: 404, headers: {}, body: '', elapsedMs: 1 };
      const result = typeof handler === 'function' ? await handler(options, url) : handler;
      return {
        status: result.status ?? 200, headers: result.headers ?? {}, elapsedMs: 5,
        body: typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? result.json ?? null)
      };
    },
    async tlsCertificate() { return routes.tls ?? { validTo: new Date(Date.now() + 40 * 86400000), issuer: 'Test CA', trusted: true }; }
  };
}
