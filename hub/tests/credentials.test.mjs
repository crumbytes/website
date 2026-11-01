import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createVault, Secret } from '../src/vault.js';
import { createHarness, fakeHttp, TEST_KEK } from './helpers.mjs';

const CANARY = 'CANARY-do-not-leak-7f3a91';
const USER_CANARY = 'CANARY-user-2bd4';

let h, http, logs, ownerId, owner, tech, viewer, clientId, siteId, connectionId;
before(async () => {
  logs = [];
  http = fakeHttp({ '*': { status: 200, body: {} } });
  h = await createHarness({
    http, logger: { error: (...args) => logs.push(JSON.stringify(args)) },
    env: { HUB_CREDENTIAL_STORAGE_ENABLED: 'true', HUB_CREDENTIAL_KEKS: TEST_KEK, HUB_CREDENTIAL_ACTIVE_KEY: 't1' }
  });
  ownerId = await h.addStaff('owner@hub.test', 'owner');
  const techId = await h.addStaff('tech@hub.test', 'technician');
  const viewerId = await h.addStaff('viewer@hub.test', 'viewer');
  clientId = await h.addClient('Client', ownerId);
  siteId = await h.addWebsite(clientId, 'site', ownerId);
  await h.assign(techId, clientId, ownerId);
  await h.assign(viewerId, clientId, ownerId);
  [owner, tech, viewer] = await Promise.all(['owner', 'tech', 'viewer'].map(name => h.sessionFor(`${name}@hub.test`)));
  const res = await owner.post(`/websites/${siteId}/connections`, { adapter_key: 'wordpress', auth_type: 'application_password', base_url: 'https://site.example.test' });
  assert.equal(res.status, 303);
  connectionId = (await h.pg.query(`select id from hub.platform_connections`)).rows[0].id;
  const stored = await owner.post(`/connections/${connectionId}/credential`, { username: USER_CANARY, application_password: CANARY });
  assert.equal(stored.status, 303);
});
after(() => h.close());

const leaks = text => text.includes(CANARY) || text.includes(USER_CANARY) || text.includes(Buffer.from(`${USER_CANARY}:${CANARY}`).toString('base64'));

test('the database holds only ciphertext', async () => {
  const { rows } = await h.pg.query(`select * from hub.connection_credentials`);
  assert.equal(rows.length, 1);
  assert.equal(leaks(JSON.stringify(rows)), false);
  assert.equal(rows[0].key_id, 't1');
  const everything = await h.pg.query(`select metadata from hub.audit_log`);
  assert.equal(leaks(JSON.stringify(everything.rows)), false);
  const connection = await h.pg.query(`select * from hub.platform_connections`);
  assert.equal(leaks(JSON.stringify(connection.rows)), false);
});

test('no page, API response or log contains the credential or its ciphertext', async () => {
  const { ciphertext, wrapped_dek: wrapped } = (await h.pg.query(`select ciphertext, wrapped_dek from hub.connection_credentials`)).rows[0];
  await owner.post(`/connections/${connectionId}/check`);
  for (const session of [owner, tech, viewer]) {
    for (const url of [`/websites/${siteId}`, `/api/v1/websites/${siteId}`, `/api/v1/websites/${siteId}/connections`, '/api/v1/websites', '/integrations', '/']) {
      const body = await (await session.get(url)).text();
      assert.equal(leaks(body), false, url);
      assert.equal(body.includes(ciphertext) || body.includes(wrapped), false, url);
      assert.doesNotMatch(body, /wrapped_dek|auth_tag|ciphertext/, url);
    }
  }
  assert.equal(leaks(await (await owner.get('/audit')).text()), false);
  assert.equal(leaks(logs.join('\n')), false);
});

test('the browser never receives a credential value in a failed submission', async () => {
  const res = await owner.post(`/connections/${connectionId}/credential`, { username: USER_CANARY, application_password: '' });
  assert.equal(res.status, 422);
  assert.equal(leaks(await res.text()), false);
});

test('credentials can only be written by owners and admins', async () => {
  for (const session of [tech, viewer]) {
    const res = await session.post(`/connections/${connectionId}/credential`, { username: 'x', application_password: 'y' });
    assert.equal(res.status, 403);
  }
  assert.equal((await h.pg.query(`select count(*)::int as n from hub.connection_credentials`)).rows[0].n, 1);
});

test('the application database role cannot read encrypted columns, even as owner', async () => {
  for (const column of ['ciphertext', 'wrapped_dek', 'nonce', 'auth_tag', 'dek_nonce', 'dek_tag']) {
    await assert.rejects(h.db.as('hub_app', ownerId, tx => tx.query(`select ${column} from hub.connection_credentials`)), /permission denied/, column);
  }
  await assert.rejects(h.db.as('hub_app', ownerId, tx => tx.query(`select * from hub.connection_credentials`)), /permission denied/);
});

test('the stored credential decrypts server-side and reaches only the configured origin', async () => {
  http.calls.length = 0;
  const res = await tech.post(`/connections/${connectionId}/check`);
  assert.equal(res.status, 303);
  assert.ok(http.calls.length > 0);
  for (const call of http.calls) {
    assert.equal(new URL(call.url).origin, 'https://site.example.test');
    assert.equal(call.headers.Authorization, `Basic ${Buffer.from(`${USER_CANARY}:${CANARY}`).toString('base64')}`);
  }
});

test('each decryption is audited without the value', async () => {
  const audit = await h.auditActions();
  const uses = audit.filter(item => item.action === 'credential.use');
  assert.ok(uses.length >= 1);
  assert.equal(uses[0].metadata.purpose, 'connection_check');
  assert.equal(uses[0].client_account_id, clientId);
  assert.ok(audit.some(item => item.action === 'credential.store'));
});

test('revoking stops further use, and a check reports it plainly', async () => {
  assert.equal((await owner.post(`/connections/${connectionId}/credential/revoke`)).status, 303);
  http.calls.length = 0;
  await tech.post(`/connections/${connectionId}/check`);
  assert.equal(http.calls.length, 0);
  const row = (await h.pg.query(`select status, last_error_code from hub.platform_connections where id = $1`, [connectionId])).rows[0];
  assert.deepEqual(row, { status: 'failed', last_error_code: 'no_credential' });
  await owner.post(`/connections/${connectionId}/credential`, { username: USER_CANARY, application_password: CANARY });
  assert.equal((await h.pg.query(`select count(*)::int as n from hub.connection_credentials where revoked_at is null`)).rows[0].n, 1);
});

test('with storage turned off, no credential can be stored and no form is offered', async () => {
  const off = await createHarness();
  const id = await off.addStaff('owner@hub.test', 'owner');
  const client = await off.addClient('Client', id);
  const site = await off.addWebsite(client, 'off', id);
  const session = await off.sessionFor('owner@hub.test');
  await session.post(`/websites/${site}/connections`, { adapter_key: 'wordpress', auth_type: 'application_password', base_url: 'https://off.example.test' });
  const connection = (await off.pg.query(`select id from hub.platform_connections`)).rows[0].id;
  const page = await (await session.get(`/websites/${site}`)).text();
  assert.match(page, /Credential storage is turned off/);
  assert.doesNotMatch(page, /type="password"/);
  const res = await session.post(`/connections/${connection}/credential`, { username: USER_CANARY, application_password: CANARY });
  assert.equal(res.status, 503);
  assert.equal((await off.pg.query(`select count(*)::int as n from hub.connection_credentials`)).rows[0].n, 0);
  await off.close();
});

test('vault: tampering, the wrong key and a moved row all fail to decrypt', () => {
  const vault = createVault({ storageEnabled: true, keks: TEST_KEK, activeKey: 't1' });
  const sealed = { id: 'cred', connection_id: 'conn', ...vault.encrypt('conn', 'cred', { token: CANARY }) };
  assert.equal(vault.decrypt(sealed).reveal().token, CANARY);
  assert.throws(() => vault.decrypt({ ...sealed, connection_id: 'other-connection' }));
  assert.throws(() => vault.decrypt({ ...sealed, id: 'other-credential' }));
  const flipped = Buffer.from(sealed.ciphertext, 'base64');
  flipped[0] ^= 1;
  assert.throws(() => vault.decrypt({ ...sealed, ciphertext: flipped.toString('base64') }));
  const other = createVault({ storageEnabled: true, keks: `t1:${randomBytes(32).toString('base64')}`, activeKey: 't1' });
  assert.throws(() => other.decrypt(sealed));
});

test('vault: every encryption uses fresh key material, and old keys still decrypt after rotation', () => {
  const next = `t2:${randomBytes(32).toString('base64')}`;
  const before = createVault({ storageEnabled: true, keks: TEST_KEK, activeKey: 't1' });
  const first = before.encrypt('c', 'i', { a: 1 });
  assert.notEqual(first.wrapped_dek, before.encrypt('c', 'i', { a: 1 }).wrapped_dek);
  const rotated = createVault({ storageEnabled: true, keks: `${TEST_KEK},${next}`, activeKey: 't2' });
  assert.equal(rotated.encrypt('c', 'i', { a: 1 }).key_id, 't2');
  assert.deepEqual(rotated.decrypt({ id: 'i', connection_id: 'c', ...first }).reveal(), { a: 1 });
});

test('vault: refuses weak keys and refuses to run when turned off', () => {
  assert.throws(() => createVault({ storageEnabled: true, keks: 'k:c2hvcnQ=', activeKey: 'k' }));
  assert.throws(() => createVault({ storageEnabled: true, keks: TEST_KEK, activeKey: 'missing' }));
  const off = createVault({ storageEnabled: false, keks: '', activeKey: '' });
  assert.throws(() => off.encrypt('c', 'i', {}));
});

test('a decrypted secret does not print or serialize', () => {
  const secret = new Secret({ token: CANARY });
  for (const text of [JSON.stringify({ secret }), `${secret}`, inspect(secret), inspect({ nested: { secret } })]) {
    assert.equal(text.includes(CANARY), false);
  }
});

test('browser-delivered code contains no credential handling', async () => {
  const { HUB_CSS } = await import('../src/ui/styles.js');
  assert.doesNotMatch(HUB_CSS, /url\(/);
  const uiDir = new URL('../src/ui/', import.meta.url);
  for (const file of await readdir(uiDir)) {
    const source = await readFile(path.join(uiDir.pathname.replace(/^\/([A-Za-z]:)/, '$1'), file), 'utf8');
    assert.doesNotMatch(source, /\.reveal\(|vault\.|ciphertext/, file);
    assert.doesNotMatch(source, /<script/i, file);
  }
});
