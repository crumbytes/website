// Runs in CI against a disposable PostgreSQL server, as a non-superuser owner and
// through the real pg driver, to catch what an in-process database would hide.
// Refuses anything except a local server, so it cannot touch a hosted database.
import assert from 'node:assert/strict';
import pg from 'pg';
import { createDb, migrate, pgDriver } from '../src/db.js';

const ownerUrl = process.env.HUB_PG_OWNER_URL;
if (!ownerUrl || !['localhost', '127.0.0.1'].includes(new URL(ownerUrl).hostname)) {
  console.error('HUB_PG_OWNER_URL must point at a local disposable server.');
  process.exit(1);
}

const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();
const { rows: [me] } = await owner.query(`select rolsuper from pg_roles where rolname = current_user`);
assert.equal(me.rolsuper, false, 'The migration owner must not be a superuser');

const executor = { exec: sql => owner.query(sql), query: (sql, params) => owner.query(sql, params) };
const ran = await migrate(executor);
assert.deepEqual(ran, ['0001_foundation.sql', '0002_access_control.sql', '0003_full_hub.sql', '0004_execution_and_revocation.sql']);
assert.deepEqual(await migrate(executor), []);

const runtimePassword = 'disposable-ci-password';
await owner.query(`alter role hub_runtime login password '${runtimePassword}'`);

const seed = async (sql, params) => (await owner.query(sql, params)).rows[0];
const staff = async (email, role) => (await seed(`insert into hub.staff_users (email, display_name, role) values ($1, $1, $2) returning id`, [email, role])).id;
const ownerId = await staff('owner@hub.test', 'owner');
const techA = await staff('a@hub.test', 'technician');
const client = async name => (await seed(`insert into hub.client_accounts (display_name, created_by) values ($1, $2) returning id`, [name, ownerId])).id;
const clientA = await client('Client A');
const clientB = await client('Client B');
const site = async (clientId, slug) => (await seed(
  `insert into hub.managed_websites (client_account_id, display_name, primary_url, cms_platform, created_by) values ($1, $2, $3, 'other', $4) returning id`,
  [clientId, slug, `https://${slug}.example.test`, ownerId])).id;
const siteA = await site(clientA, 'alpha');
await site(clientB, 'bravo');
await owner.query(`insert into hub.staff_client_assignments (staff_id, client_account_id, assigned_by) values ($1, $2, $3)`, [techA, clientA, ownerId]);

const url = new URL(ownerUrl);
url.username = 'hub_runtime';
url.password = runtimePassword;
const db = createDb(pgDriver(url.href, pg.Pool));
const direct = new pg.Client({ connectionString: url.href });
await direct.connect();

// The login role itself has no rights.
await assert.rejects(direct.query(`select * from hub.client_accounts`), /permission denied/);
await assert.rejects(direct.query(`set role postgres`), /permission denied/);

// RLS isolates clients under a real pool, and settings do not leak between transactions.
const seen = await db.as('hub_app', techA, tx => tx.query(`select id from hub.managed_websites`));
assert.deepEqual(seen.rows.map(row => row.id), [siteA]);
const anonymous = await db.as('hub_app', null, tx => tx.query(`select id from hub.managed_websites`));
assert.equal(anonymous.rows.length, 0, 'The staff setting must not carry over');
const results = await Promise.all(Array.from({ length: 20 }, (_, i) => db.as('hub_app', i % 2 ? techA : ownerId, tx => tx.query(`select count(*)::int as n from hub.managed_websites`))));
results.forEach((result, i) => assert.equal(result.rows[0].n, i % 2 ? 1 : 2));
const outside = await direct.query(`select current_setting('hub.staff_id', true) as staff, current_user as who`);
assert.equal(outside.rows[0].who, 'hub_runtime');

// Column grants and append-only rules hold for a non-superuser owner too.
await assert.rejects(db.as('hub_app', ownerId, tx => tx.query(`select ciphertext from hub.connection_credentials`)), /permission denied/);
await db.as('hub_app', ownerId, tx => tx.query(`insert into hub.audit_log (actor_type, actor_staff_id, action, prev_hash, entry_hash) values ('staff', $1, 'ci.test', '', '')`, [ownerId]));
await assert.rejects(db.as('hub_app', ownerId, tx => tx.query(`update hub.audit_log set action = 'forged'`)), /permission denied/);
await assert.rejects(owner.query(`update hub.audit_log set action = 'forged'`), /append-only/);
await assert.rejects(owner.query(`truncate hub.audit_log`), /append-only/);
const chain = await db.as('hub_app', ownerId, tx => tx.query(`select hub.verify_audit_chain() as broken`));
assert.equal(chain.rows[0].broken, null);

// A failed transaction leaves nothing behind.
await assert.rejects(db.as('hub_app', techA, async tx => {
  await tx.query(`insert into hub.maintenance_tasks (client_account_id, website_id, title, created_by) values ($1, $2, 'Rolled back', $3)`, [clientA, siteA, techA]);
  throw new Error('stop');
}), /stop/);
assert.equal((await owner.query(`select count(*)::int as n from hub.maintenance_tasks where title = 'Rolled back'`)).rows[0].n, 0);

await direct.end();
await db.close();
await owner.end();
console.log('PostgreSQL integration checks passed.');
