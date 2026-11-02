import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate, provisionFirstOwner } from '../src/db.js';

test('migrations apply in order, record a checksum, and run only once', async () => {
  const pg = new PGlite();
  const logged = [];
  const ran = await migrate(pg, { log: line => logged.push(line) });
  assert.deepEqual(ran, ['0001_foundation.sql', '0002_access_control.sql', '0003_full_hub.sql', '0004_execution_and_revocation.sql', '0005_portal_and_automation.sql']);
  assert.equal(logged.length, 5);
  assert.deepEqual(await migrate(pg), [], 'nothing to do the second time');
  await pg.close();
});

test('a migration edited after being applied stops the run', async () => {
  const pg = new PGlite();
  await migrate(pg);
  await pg.query(`update hub_meta.migrations set checksum = 'tampered' where name = '0002_access_control.sql'`);
  await assert.rejects(migrate(pg), /changed after it was applied/);
  await pg.close();
});

test('a failed migration rolls back completely and can be retried', async () => {
  const pg = new PGlite();
  await pg.exec(`create role hub_auth nologin; create schema hub; create table hub.staff_users (id int)`);
  await assert.rejects(migrate(pg));
  await pg.exec('rollback').catch(() => {});
  assert.equal((await pg.query(`select count(*)::int as n from hub_meta.migrations`)).rows[0].n, 0);
  assert.equal((await pg.query(`select to_regclass('hub.client_accounts') as t`)).rows[0].t, null);
  await pg.exec(`drop table hub.staff_users; drop schema hub`);
  assert.equal((await migrate(pg)).length, 5);
  await pg.close();
});

test('schema constraints protect referential integrity', async () => {
  const pg = new PGlite();
  await migrate(pg);
  const { rows } = await pg.query(`select count(*)::int as n from information_schema.table_constraints where table_schema = 'hub' and constraint_type = 'FOREIGN KEY'`);
  assert.ok(rows[0].n > 40);
  const unindexed = (await pg.query(`select tablename from pg_tables where schemaname = 'hub' and tablename not in (select tablename from pg_indexes where schemaname = 'hub')`)).rows;
  assert.deepEqual(unindexed, []);
  await pg.close();
});

test('the first owner can be provisioned once, with an audit entry', async () => {
  const pg = new PGlite();
  await migrate(pg);
  await provisionFirstOwner(pg, { email: ' Owner@Hub.Test ', displayName: 'First Owner' });
  assert.deepEqual((await pg.query(`select email, role from hub.staff_users`)).rows, [{ email: 'owner@hub.test', role: 'owner' }]);
  await assert.rejects(provisionFirstOwner(pg, { email: 'second@hub.test', displayName: 'Second' }), /already exists/);
  assert.equal((await pg.query(`select action from hub.audit_log`)).rows[0].action, 'staff.provision_owner');
  await pg.close();
});
