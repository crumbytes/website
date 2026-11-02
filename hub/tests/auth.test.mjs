import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair } from 'jose';
import { ConfigError, loadConfig } from '../src/config.js';
import { sha256 } from '../src/auth.js';
import { createHarness, ISSUER, ORIGIN } from './helpers.mjs';

let h;
before(async () => {
  h = await createHarness();
  await h.addStaff('owner@hub.test', 'owner');
  await h.addStaff('tech@hub.test', 'technician');
  await h.addStaff('gone@hub.test', 'technician', 'disabled');
});
after(() => h.close());

const callbackWith = async (overrides, email = 'tech@hub.test') => {
  const start = await h.startLogin();
  h.idp.overrideClaims = overrides;
  h.idp.codes.set('c', { email, nonce: start.nonce });
  const res = await h.app.request(`/auth/callback?code=c&state=${encodeURIComponent(start.state)}`, { headers: { Cookie: start.binding } });
  h.idp.overrideClaims = {};
  return res;
};
const hasSession = res => res.headers.getSetCookie().some(item => item.startsWith('hub_session=') && !item.includes('Max-Age=0'));

test('every staff page and API path refuses an anonymous request', async () => {
  for (const path of ['/', '/websites', '/websites/new', '/clients', '/maintenance', '/monitoring', '/security', '/backups', '/integrations', '/staff', '/audit']) {
    const res = await h.app.request(path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get('location'), '/login', path);
  }
  for (const path of ['/api/v1/me', '/api/v1/websites', '/api/v1/adapters']) {
    assert.equal((await h.app.request(path)).status, 401, path);
  }
  assert.equal((await h.app.request('/websites', { method: 'POST' })).status, 401);
});

test('the sign-in request uses PKCE, a nonce, and exact parameters', async () => {
  const { location } = await h.startLogin();
  assert.equal(location.origin + location.pathname, `${ISSUER}/authorize`);
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(location.searchParams.get('code_challenge'));
  assert.ok(location.searchParams.get('nonce'));
  assert.equal(location.searchParams.get('redirect_uri'), `${ORIGIN}/auth/callback`);
});

test('a provisioned staff member signs in and the identity is bound', async () => {
  const { res, cookie, setCookie } = await h.login('tech@hub.test');
  assert.equal(res.status, 302);
  assert.ok(cookie);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.equal(h.idp.lastTokenRequest.get('code_verifier').length > 40, true);
  const { rows } = await h.pg.query(`select oidc_issuer, oidc_subject from hub.staff_users where email = 'tech@hub.test'`);
  assert.deepEqual(rows[0], { oidc_issuer: ISSUER, oidc_subject: 'sub-tech@hub.test' });
});

test('the session token is stored only as a hash', async () => {
  const { cookie } = await h.login('owner@hub.test');
  const raw = cookie.split('=')[1];
  assert.equal((await h.pg.query(`select 1 from hub.staff_sessions where token_hash = $1`, [raw])).rows.length, 0);
  assert.equal((await h.pg.query(`select 1 from hub.staff_sessions where token_hash = $1`, [sha256(raw)])).rows.length, 1);
});

test('someone who was never provisioned cannot sign in, and the denial is audited', async () => {
  const { res, cookie } = await h.login('stranger@hub.test');
  assert.equal(res.status, 403);
  assert.equal(cookie, null);
  const audit = await h.auditActions();
  assert.ok(audit.some(item => item.action === 'auth.login' && item.outcome === 'denied' && item.metadata.reason === 'not_provisioned'));
});

test('a disabled staff member cannot sign in', async () => {
  const { res, cookie } = await h.login('gone@hub.test');
  assert.equal(res.status, 403);
  assert.equal(cookie, null);
});

test('an unverified email cannot claim a provisioned account', async () => {
  await h.addStaff('claim@hub.test', 'technician');
  const res = await callbackWith({ email_verified: false }, 'claim@hub.test');
  assert.equal(res.status, 403);
  assert.equal(hasSession(res), false);
});

test('tokens are rejected for wrong audience, issuer, nonce, expiry or signature', async () => {
  const attacker = await generateKeyPair('RS256');
  const honest = h.idp.signKey;
  for (const [label, claims] of [
    ['audience', { aud: 'another-app' }], ['issuer', { iss: 'https://evil.hub.test' }],
    ['nonce', { nonce: 'not-the-nonce' }], ['expiry', { exp: Math.floor(Date.now() / 1000) - 3600 }]
  ]) {
    const res = await callbackWith(claims);
    assert.equal(res.status, 403, label);
    assert.equal(hasSession(res), false, label);
  }
  h.idp.signKey = attacker.privateKey;
  const forged = await callbackWith({});
  h.idp.signKey = honest;
  assert.equal(forged.status, 403);
  assert.equal(hasSession(forged), false);
});

test('state is single use and tied to the browser that started the login', async () => {
  const start = await h.startLogin();
  h.idp.codes.set('x', { email: 'tech@hub.test', nonce: start.nonce });
  const url = `/auth/callback?code=x&state=${encodeURIComponent(start.state)}`;
  assert.equal((await h.app.request(url, { headers: { Cookie: 'hub_login=someone-else' } })).status, 403);
  assert.equal((await h.app.request(url)).status, 403);
  const first = await h.app.request(url, { headers: { Cookie: start.binding } });
  assert.equal(first.status, 302);
  assert.equal((await h.app.request(url, { headers: { Cookie: start.binding } })).status, 403);
});

test('an identity provider outage fails closed with no session', async () => {
  h.idp.available = false;
  const res = await h.app.request('/auth/start');
  h.idp.available = true;
  assert.equal(res.status, 503);
  assert.equal(hasSession(res), false);
});

test('disabling staff, expiring or revoking a session ends access immediately', async () => {
  const id = await h.addStaff('short@hub.test', 'technician');
  const session = await h.sessionFor('short@hub.test');
  assert.equal((await session.get('/')).status, 200);
  await h.pg.query(`update hub.staff_users set status = 'disabled' where id = $1`, [id]);
  assert.equal((await session.get('/')).status, 302);
  await h.pg.query(`update hub.staff_users set status = 'active' where id = $1`, [id]);
  assert.equal((await session.get('/')).status, 302, 're-enabling must not restore a revoked session');
  const fresh = await h.sessionFor('short@hub.test');
  assert.equal((await fresh.get('/')).status, 200);
  await h.pg.query(`update hub.staff_sessions set idle_expires_at = now() - interval '1 minute' where staff_id = $1`, [id]);
  assert.equal((await fresh.get('/')).status, 302);
  await h.pg.query(`update hub.staff_sessions set idle_expires_at = now() + interval '1 hour', absolute_expires_at = now() - interval '1 minute' where staff_id = $1`, [id]);
  assert.equal((await fresh.get('/')).status, 302);
});

test('signing out revokes the session on the server', async () => {
  await h.addStaff('leave@hub.test', 'viewer');
  const session = await h.sessionFor('leave@hub.test');
  const res = await session.post('/logout');
  assert.equal(res.status, 303);
  assert.equal((await session.get('/')).status, 302);
  assert.ok((await h.auditActions()).some(item => item.action === 'auth.logout'));
});

test('state-changing requests need a matching CSRF token and origin', async () => {
  const session = await h.sessionFor('owner@hub.test');
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const post = headers => h.app.request('/clients', { method: 'POST', headers: { Cookie: session.cookie, ...form, ...headers }, body: new URLSearchParams({ display_name: 'CSRF Test Client', _csrf: session.csrf }) });
  assert.equal((await h.app.request('/clients', { method: 'POST', headers: { Cookie: session.cookie, Origin: ORIGIN, ...form }, body: 'display_name=NoToken' })).status, 403);
  assert.equal((await h.app.request('/clients', { method: 'POST', headers: { Cookie: session.cookie, Origin: ORIGIN, ...form }, body: 'display_name=Wrong&_csrf=wrong' })).status, 403);
  assert.equal((await post({ Origin: 'https://evil.example.test' })).status, 403);
  assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await h.pg.query(`select 1 from hub.client_accounts where display_name in ('CSRF Test Client', 'NoToken', 'Wrong')`)).rows.length, 0);
  const denied = (await h.auditActions()).filter(item => item.action === 'request.denied');
  assert.ok(denied.some(item => item.metadata.reason === 'csrf.origin'));
  assert.ok(denied.some(item => item.metadata.reason === 'csrf.token'));
});

// Found in browser testing: Referrer-Policy: no-referrer makes browsers send
// Origin: null on same-origin form posts, so every real submission was refused.
test('the referrer policy lets browsers send a real Origin on form posts', async () => {
  const session = await h.sessionFor('owner@hub.test');
  const policy = (await session.get('/')).headers.get('referrer-policy');
  assert.equal(policy, 'same-origin');
  const nullOrigin = await h.app.request('/clients', {
    method: 'POST', headers: { Cookie: session.cookie, Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ display_name: 'Null Origin', _csrf: session.csrf })
  });
  assert.equal(nullOrigin.status, 403);
  const browserLike = await h.app.request('/clients', {
    method: 'POST', headers: { Cookie: session.cookie, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ display_name: 'Same Origin Post', _csrf: session.csrf })
  });
  assert.equal(browserLike.status, 303);
});

test('responses carry a strict policy and the pages run no scripts', async () => {
  const session = await h.sessionFor('owner@hub.test');
  const res = await session.get('/');
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.doesNotMatch(res.headers.get('content-security-policy'), /unsafe/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  for (const path of ['/', '/websites', '/clients', '/staff', '/integrations']) {
    assert.doesNotMatch(await (await session.get(path)).text(), /<script/i, path);
  }
});

test('the stylesheet URL carries a content hash, so releases cannot show stale styles', async () => {
  const page = await (await h.app.request('/login')).text();
  const [, href] = /href="(\/assets\/hub\.css\?v=[0-9a-f]{12})"/.exec(page) ?? [];
  assert.ok(href);
  const res = await h.app.request(href);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/css/);
});

test('configuration fails closed', () => {
  const base = { HUB_BASE_URL: 'https://hub.hub.test', HUB_OIDC_ISSUER: ISSUER, HUB_OIDC_CLIENT_ID: 'x', DATABASE_URL: 'postgres://u@db.test/x', HUB_TRUSTED_IP_HEADER: 'x-vercel-forwarded-for', HUB_OIDC_REQUIRED_AMR: 'mfa' };
  assert.equal(loadConfig(base).environment, 'production');
  assert.throws(() => loadConfig({ ...base, HUB_TRUSTED_IP_HEADER: '' }), ConfigError);
  assert.equal(loadConfig(base).session.cookieName, '__Host-hub_session');
  assert.equal(loadConfig(base).session.secure, true);
  assert.equal(loadConfig(base).outboundEnabled, false);
  assert.equal(loadConfig(base).credentials.storageEnabled, false);
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ ...base, DATABASE_URL: '' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, HUB_BASE_URL: 'http://hub.hub.test' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, HUB_ENV: 'development', VERCEL_ENV: 'production' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, HUB_CREDENTIAL_STORAGE_ENABLED: 'true' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, HUB_JOB_SECRET: 'short' }), ConfigError);
});
