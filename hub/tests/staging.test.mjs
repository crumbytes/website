import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConfig, ConfigError } from '../src/config.js';
import { createHarness } from './helpers.mjs';

const base = { HUB_ENV: 'staging', HUB_BASE_URL: 'https://hub-preview.crumbyte.com',
  HUB_OIDC_ISSUER: 'https://identity.example.test/', HUB_OIDC_CLIENT_ID: 'staging',
  DATABASE_URL: 'postgres://hub_runtime@localhost/hub', HUB_TRUSTED_IP_HEADER: 'x-vercel-forwarded-for',
  HUB_OIDC_REQUIRED_AMR: 'mfa' };

test('hosted configuration rejects missing client identity, missing MFA, and unsafe origins', () => {
  assert.equal(loadConfig(base).oidc.redirectUri, 'https://hub-preview.crumbyte.com/auth/callback');
  for (const change of [
    { HUB_OIDC_CLIENT_ID: '' }, { HUB_OIDC_REQUIRED_AMR: '' },
    { HUB_BASE_URL: 'https://user:password@hub-preview.crumbyte.com' },
    { HUB_BASE_URL: 'https://hub-preview.crumbyte.com/nested' },
    { HUB_BASE_URL: 'https://hub-preview.crumbyte.com/?query=1' },
    { HUB_BASE_URL: 'https://hub-preview.crumbyte.com/#fragment' },
    { HUB_OIDC_ISSUER: 'https://not a host' },
    { HUB_OIDC_ISSUER: 'https://user:password@identity.example.test/' },
    { HUB_ENV: 'development', VERCEL_ENV: 'preview' },
    { HUB_ENV: 'test', VERCEL: '1' }
  ]) assert.throws(() => loadConfig({ ...base, ...change }), ConfigError, JSON.stringify(Object.keys(change)));
});

test('internal application files are never served by the Hub router', async () => {
  const h = await createHarness();
  try {
    await h.addStaff('owner@hub.test', 'owner');
    const owner = await h.sessionFor('owner@hub.test');
    for (const path of ['/src/auth.js', '/db/migrations/0001_foundation.sql', '/.env.example',
      '/package-lock.json', '/docs/original-dashboard.html', '/tests/helpers.mjs', '/api/index.js']) {
      const anonymous = await h.app.request(path);
      assert.ok([302, 401].includes(anonymous.status), path);
      const authenticated = await owner.get(path);
      assert.equal(authenticated.status, 404, path);
      assert.doesNotMatch(await authenticated.text(), /create schema|createAuth|HUB_OIDC_CLIENT_SECRET|lockfileVersion/, path);
    }
  } finally { await h.close(); }
});

test('deployment configuration sends every Hub request to the function and excludes internal public-site files', async () => {
  const read = async path => readFile(new URL(path, import.meta.url), 'utf8');
  const config = JSON.parse(await read('../vercel.json'));
  assert.equal(config.git.deploymentEnabled, false);
  assert.deepEqual(config.builds, [{ src: 'api/index.js', use: '@vercel/node' }]);
  assert.deepEqual(config.routes, [{ src: '/(.*)', dest: '/api/index.js' }]);
  const excluded = await read('../../.vercelignore');
  for (const dir of ['hub/', '.github/', 'infra/', 'scripts/', 'tests/']) assert.ok(excluded.split('\n').includes(dir), dir);
  await assert.rejects(read('../../website-management.html'), { code: 'ENOENT' });
});

test('OIDC rejects an ID token issued to multiple clients without this authorized party', async () => {
  const h = await createHarness();
  try {
    await h.addStaff('owner@hub.test', 'owner');
    for (const claims of [ { aud: ['hub-test', 'other'] }, { azp: 'other' }, { aud: ['hub-test', 'other'], azp: 'other' } ]) {
      h.idp.overrideClaims = claims;
      const { res, cookie } = await h.login('owner@hub.test');
      assert.equal(res.status, 403);
      assert.equal(cookie, null);
    }
    h.idp.overrideClaims = { aud: ['hub-test', 'other'], azp: 'hub-test' };
    assert.equal((await h.login('owner@hub.test')).res.status, 302);
  } finally { await h.close(); }
});
