import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, fakeHttp, TEST_KEK } from './helpers.mjs';
import { loadConfig } from '../src/config.js';

async function operationHarness(http) {
  const h = await createHarness({ http, env: { HUB_CREDENTIAL_STORAGE_ENABLED: 'true', HUB_CREDENTIAL_KEKS: TEST_KEK,
    HUB_CREDENTIAL_ACTIVE_KEY: 't1', HUB_OPERATIONS_ENABLED: 'true' } });
  const ownerId = await h.addStaff('owner@hub.test', 'owner');
  await h.addStaff('admin@hub.test', 'admin');
  const client = await h.addClient('Synthetic client', ownerId);
  const site = await h.addWebsite(client, 'atomic', ownerId);
  const owner = await h.sessionFor('owner@hub.test');
  const admin = await h.sessionFor('admin@hub.test');
  assert.equal((await owner.post(`/websites/${site}/connections`, { adapter_key: 'wordpress', auth_type: 'application_password', base_url: 'https://atomic.example.test' })).status, 303);
  const connection = (await h.pg.query('select id from hub.platform_connections')).rows[0].id;
  assert.equal((await owner.post(`/connections/${connection}/credential`, { username: 'synthetic', application_password: 'synthetic-only' })).status, 303);
  assert.equal((await owner.post('/operations', { connection_id: connection, operation_key: 'plugin.set_status', reason: 'Synthetic atomic operation', plugin: 'a/a', status: 'inactive' })).status, 303);
  const id = (await h.pg.query('select id from hub.operation_requests')).rows[0].id;
  assert.equal((await admin.post(`/operations/${id}/approve`)).status, 303);
  return { ...h, owner, admin, id };
}

test('concurrent execution requests dispatch an approved operation only once', async () => {
  let started, finish;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const http = fakeHttp({ '*': async () => { started(); await gate; return { status: 200, body: {} }; } });
  const h = await operationHarness(http);
  let first;
  try {
    first = h.admin.post(`/operations/${h.id}/execute`);
    await began;
    const duplicates = await Promise.all(Array.from({ length: 8 }, () => h.admin.post(`/operations/${h.id}/execute`)));
    assert.ok(duplicates.every(res => res.status === 409));
    assert.equal(http.calls.length, 1);
    assert.equal((await h.pg.query('select count(*)::int as n from hub.operation_execution_claims')).rows[0].n, 1);
    finish();
    assert.equal((await first).status, 303);
    assert.equal((await h.admin.post(`/operations/${h.id}/execute`)).status, 409);
    assert.equal(http.calls.length, 1);
  } finally { finish(); await first; await h.close(); }
});

test('an uncertain adapter failure retains the claim and never redispatches on retry', async () => {
  const http = fakeHttp({ '*': () => { throw new Error('synthetic connection lost after send'); } });
  const h = await operationHarness(http);
  try {
    assert.equal((await h.admin.post(`/operations/${h.id}/execute`)).status, 303);
    assert.equal((await h.pg.query('select status from hub.operation_requests')).rows[0].status, 'failed');
    assert.equal((await h.admin.post(`/operations/${h.id}/execute`)).status, 409);
    assert.equal(http.calls.length, 1);
    await assert.rejects(h.db.as('hub_app', h.admin.id, tx => tx.query('delete from hub.operation_execution_claims')), /permission denied/);
  } finally { await h.close(); }
});

test('a durable claim survives a simulated process crash before dispatch', async () => {
  const http = fakeHttp({ '*': { status: 200, body: {} } });
  const h = await operationHarness(http);
  try {
    await h.db.as('hub_app', h.admin.id, tx => tx.query('insert into hub.operation_execution_claims (operation_id, claim_token, claimed_by) values ($1, gen_random_uuid(), $2)', [h.id, h.admin.id]));
    assert.equal((await h.admin.post(`/operations/${h.id}/execute`)).status, 409);
    assert.equal(http.calls.length, 0);
    assert.match(await (await h.admin.get('/websites')).text(), /atomic/);
  } finally { await h.close(); }
});

test('disabling staff permanently revokes every session, while a new login after re-enable succeeds', async () => {
  const h = await createHarness();
  try {
    await h.addStaff('owner@hub.test', 'owner');
    const staffId = await h.addStaff('revoked@hub.test', 'technician');
    const owner = await h.sessionFor('owner@hub.test');
    const sessions = await Promise.all([h.sessionFor('revoked@hub.test'), h.sessionFor('revoked@hub.test')]);
    assert.equal((await owner.post(`/staff/${staffId}`, { role: 'technician', status: 'disabled' })).status, 303);
    assert.equal((await h.pg.query('select count(*)::int as n from hub.staff_sessions where staff_id=$1 and revoked_at is null', [staffId])).rows[0].n, 0);
    assert.equal((await owner.post(`/staff/${staffId}`, { role: 'technician', status: 'active' })).status, 303);
    for (const session of sessions) assert.equal((await session.get('/api/v1/me')).status, 401);
    assert.equal((await (await h.sessionFor('revoked@hub.test')).get('/api/v1/me')).status, 200);
    assert.ok((await h.auditActions()).some(row => row.action === 'staff.update'));
  } finally { await h.close(); }
});

test('staging rejects mismatched production-like bindings and every live integration flag', () => {
  const base = { HUB_ENV: 'staging', HUB_BASE_URL: 'https://hub-preview.crumbyte.com', DATABASE_URL: 'postgres://hub_runtime@staging.example.test/hub_staging',
    HUB_STAGING_DATABASE_HOST: 'staging.example.test', HUB_STAGING_DATABASE_NAME: 'hub_staging',
    HUB_OIDC_ISSUER: 'https://staging-id.example.test/', HUB_STAGING_OIDC_ISSUER: 'https://staging-id.example.test/',
    HUB_OIDC_CLIENT_ID: 'staging-client', HUB_STAGING_OIDC_CLIENT_ID: 'staging-client', HUB_OIDC_REQUIRED_AMR: 'mfa', HUB_TRUSTED_IP_HEADER: 'x-vercel-forwarded-for' };
  assert.equal(loadConfig(base).environment, 'staging');
  for (const change of [ { DATABASE_URL: 'postgres://hub_runtime@production.example.test/hub_staging' },
    { DATABASE_URL: 'postgres://hub_runtime@staging.example.test/production' }, { DATABASE_URL: 'postgres://owner@staging.example.test/hub_staging' },
    { HUB_OIDC_CLIENT_ID: 'production-client' }, { HUB_OIDC_ISSUER: 'https://production-id.example.test/' },
    { HUB_BASE_URL: 'https://hub.crumbyte.com' }, ...['HUB_OUTBOUND_ENABLED','HUB_OPERATIONS_ENABLED','HUB_CREDENTIAL_STORAGE_ENABLED','HUB_STACKLTR_ENABLED','HUB_EMAIL_ENABLED','HUB_R2_ENABLED'].map(name => ({ [name]: 'true' }))
  ]) assert.throws(() => loadConfig({ ...base, ...change }));
});

test('a completion-write failure cannot permit a second adapter dispatch', async () => {
  const http = fakeHttp({ '*': { status: 200, body: {} } });
  const h = await operationHarness(http);
  const original = h.db.as.bind(h.db);
  try {
    h.db.as = (role, staffId, fn) => original(role, staffId, tx => fn({ ...tx, query(sql, params) {
      if (role === 'hub_worker' && sql.includes('update hub.operation_requests set status')) throw new Error('Synthetic completion write failure');
      return tx.query(sql, params);
    } }));
    assert.equal((await h.admin.post(`/operations/${h.id}/execute`)).status, 500);
    assert.equal((await h.admin.post(`/operations/${h.id}/execute`)).status, 409);
    assert.equal(http.calls.length, 1);
    assert.equal((await h.pg.query('select status from hub.operation_requests')).rows[0].status, 'approved');
    assert.equal((await h.pg.query('select count(*)::int as n from hub.operation_execution_claims')).rows[0].n, 1);
  } finally { h.db.as = original; await h.close(); }
});
