// Local development only: an in-process PostgreSQL and a sign-in stub, both bound
// to localhost. Creates staff logins and nothing else, so client records in a dev
// database are only ever ones you typed in yourself.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { PGlite } from '@electric-sql/pglite';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { loadConfig } from '../src/config.js';
import { applyMigrations, createDb, pgliteDriver } from '../src/db.js';
import { buildApp } from '../src/runtime.js';

if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
  console.error('scripts/dev.mjs refuses to run on a hosted or production environment.');
  process.exit(1);
}

const HOST = '127.0.0.1';
const APP_PORT = Number(process.env.PORT || 4310);
const IDP_PORT = APP_PORT + 1;
const issuer = `http://${HOST}:${IDP_PORT}`;
const DEV_STAFF = [
  { email: 'owner@hub.test', display_name: 'Local Owner', role: 'owner' },
  { email: 'admin@hub.test', display_name: 'Local Admin', role: 'admin' },
  { email: 'tech@hub.test', display_name: 'Local Technician', role: 'technician' },
  { email: 'viewer@hub.test', display_name: 'Local Viewer', role: 'viewer' }
];

const pglite = new PGlite(process.env.HUB_DEV_DB || undefined);
await pglite.waitReady;
const migrated = (await pglite.query(`select to_regclass('hub.staff_users') as t`)).rows[0].t;
if (!migrated) await applyMigrations(pglite);
for (const member of DEV_STAFF) {
  await pglite.query(`insert into hub.staff_users (email, display_name, role) values ($1, $2, $3) on conflict (email) do nothing`,
    [member.email, member.display_name, member.role]);
}

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'dev', alg: 'RS256', use: 'sig' };
const codes = new Map();

createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  if (url.pathname === '/.well-known/openid-configuration') {
    return send(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
  }
  if (url.pathname === '/jwks') return send(200, { keys: [jwk] });
  if (url.pathname === '/authorize' && !url.searchParams.get('email')) {
    const links = DEV_STAFF.map(member => {
      const next = new URL(url);
      next.searchParams.set('email', member.email);
      return `<li><a href="${next.href.replaceAll('&', '&amp;')}">${member.display_name} (${member.role})</a></li>`;
    }).join('');
    return send(200, `<!doctype html><meta charset="utf-8"><title>Local sign-in</title><h1>Local development sign-in</h1><ul>${links}</ul>`, 'text/html; charset=utf-8');
  }
  if (url.pathname === '/authorize') {
    const code = randomUUID();
    codes.set(code, { email: url.searchParams.get('email'), nonce: url.searchParams.get('nonce') });
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { Location: back.href });
    return res.end();
  }
  if (url.pathname === '/token') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    const grant = codes.get(form.get('code'));
    codes.delete(form.get('code'));
    if (!grant) return send(400, { error: 'invalid_grant' });
    const idToken = await new SignJWT({ email: grant.email, email_verified: true, nonce: grant.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'dev' }).setIssuer(issuer).setAudience('hub-dev').setSubject(`dev-${grant.email}`)
      .setIssuedAt().setExpirationTime('5m').sign(privateKey);
    return send(200, { access_token: 'unused', token_type: 'Bearer', id_token: idToken });
  }
  send(404, { error: 'not_found' });
}).listen(IDP_PORT, HOST);

const config = loadConfig({
  HUB_ENV: 'development',
  HUB_BASE_URL: `http://localhost:${APP_PORT}`,
  HUB_OIDC_ISSUER: issuer,
  HUB_OIDC_CLIENT_ID: 'hub-dev'
});
const app = buildApp({ config, db: createDb(pgliteDriver(pglite)) });
serve({ fetch: app.fetch, port: APP_PORT, hostname: HOST }, () => {
  console.log(`Hub running at http://localhost:${APP_PORT}. Outbound connections, credentials and operations are off.`);
});
