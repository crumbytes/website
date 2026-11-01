import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers.mjs';
import { can, PERMISSIONS } from '../src/authz.js';

let h, ownerId, techAId, techBId, viewerId, billingId, clientA, clientB, siteA, siteB, owner, techA, techB, viewer, billing;

before(async () => {
  h = await createHarness();
  ownerId = await h.addStaff('owner@hub.test', 'owner');
  await h.addStaff('admin@hub.test', 'admin');
  techAId = await h.addStaff('a@hub.test', 'technician');
  techBId = await h.addStaff('b@hub.test', 'technician');
  viewerId = await h.addStaff('viewer@hub.test', 'viewer');
  billingId = await h.addStaff('billing@hub.test', 'billing');
  clientA = await h.addClient('Client A', ownerId);
  clientB = await h.addClient('Client B', ownerId);
  siteA = await h.addWebsite(clientA, 'site-a', ownerId);
  siteB = await h.addWebsite(clientB, 'site-b', ownerId);
  await h.assign(techAId, clientA, ownerId);
  await h.assign(techBId, clientB, ownerId);
  await h.assign(viewerId, clientA, ownerId);
  await h.assign(billingId, clientA, ownerId);
  [owner, techA, techB, viewer, billing] = await Promise.all(['owner', 'a', 'b', 'viewer', 'billing'].map(name => h.sessionFor(`${name}@hub.test`)));
});
after(() => h.close());

// Runs SQL exactly as the app does, with RLS applying to that staff member.
const asStaff = (staffId, sql, params) => h.db.as('hub_app', staffId, tx => tx.query(sql, params));

test('a technician sees only assigned clients in pages and the API', async () => {
  const page = await (await techA.get('/websites')).text();
  assert.match(page, /site-a/);
  assert.doesNotMatch(page, /site-b/);
  const { websites } = await (await techA.get('/api/v1/websites')).json();
  assert.deepEqual(websites.map(site => site.id), [siteA]);
  assert.doesNotMatch(await (await techA.get('/clients')).text(), /Client B/);
});

test('owners see every client', async () => {
  const { websites } = await (await owner.get('/api/v1/websites')).json();
  assert.deepEqual(new Set(websites.map(site => site.id)), new Set([siteA, siteB]));
});

test('another client\'s record looks exactly like a missing one', async () => {
  for (const path of [`/websites/${siteB}`, `/websites/${siteB}/edit`, `/clients/${clientB}`]) {
    assert.equal((await techA.get(path)).status, 404, path);
  }
  const foreign = await techA.get(`/api/v1/websites/${siteB}`);
  const missing = await techA.get('/api/v1/websites/00000000-0000-4000-8000-000000000000');
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  const strip = body => ({ ...body, error: { ...body.error, request_id: null } });
  assert.deepEqual(strip(await foreign.json()), strip(await missing.json()));
  assert.equal((await techA.get(`/api/v1/websites/${siteB}/connections`)).status, 404);
  assert.equal((await techA.get('/api/v1/websites/not-a-uuid')).status, 404);
});

test('writes cannot target another client', async () => {
  const task = await techA.postJson('/api/v1/tasks', { website_id: siteB, title: 'Cross-client task' });
  assert.equal(task.status, 404);
  const history = await techA.post('/history', { website_id: siteB, kind: 'other', summary: 'Cross client', performed_at: new Date().toISOString() });
  assert.equal(history.status, 404);
  const site = await techA.postJson('/api/v1/websites', { client_account_id: clientB, display_name: 'Planted', primary_url: 'https://planted.example.test', cms_platform: 'other' });
  assert.equal(site.status, 422);
  assert.equal((await h.pg.query(`select 1 from hub.maintenance_tasks where title = 'Cross-client task'`)).rows.length, 0);
  assert.equal((await h.pg.query(`select 1 from hub.managed_websites where display_name = 'Planted'`)).rows.length, 0);
});

test('a website cannot be moved to another client', async () => {
  const res = await owner.post(`/websites/${siteA}`, { client_account_id: clientB, display_name: 'site-a', primary_url: 'https://site-a.example.test', cms_platform: 'wordpress', lifecycle: 'active' });
  assert.equal(res.status, 422);
  assert.equal((await h.pg.query(`select client_account_id from hub.managed_websites where id = $1`, [siteA])).rows[0].client_account_id, clientA);
});

test('RLS alone isolates clients when SQL bypasses the application layer', async () => {
  const seen = await asStaff(techAId, `select id from hub.managed_websites`);
  assert.deepEqual(seen.rows.map(row => row.id), [siteA]);
  assert.equal((await asStaff(techAId, `select id from hub.client_accounts`)).rows.length, 1);
  await assert.rejects(asStaff(techAId,
    `insert into hub.maintenance_tasks (client_account_id, website_id, title, created_by) values ($1, $2, 'x', $3)`, [clientB, siteB, techAId]), /row-level security/);
  const updated = await asStaff(techAId, `update hub.managed_websites set notes = 'tampered' where id = $1`, [siteB]);
  assert.equal(updated.affectedRows, 0);
});

test('composite keys stop a row from naming a website of another client', async () => {
  await assert.rejects(h.pg.query(
    `insert into hub.maintenance_tasks (client_account_id, website_id, title, created_by) values ($1, $2, 'x', $3)`, [clientA, siteB, ownerId]), /foreign key/);
});

test('no staff identity means no rows', async () => {
  assert.equal((await h.db.as('hub_app', null, tx => tx.query(`select id from hub.managed_websites`))).rows.length, 0);
  assert.equal((await h.db.as('hub_app', '00000000-0000-4000-8000-000000000000', tx => tx.query(`select id from hub.client_accounts`))).rows.length, 0);
});

test('a disabled owner has no database access even with a live identity', async () => {
  const id = await h.addStaff('old-owner@hub.test', 'owner', 'disabled');
  assert.equal((await asStaff(id, `select id from hub.client_accounts`)).rows.length, 0);
});

test('application roles cannot escalate or delete', async () => {
  await assert.rejects(asStaff(techAId, `update hub.staff_client_assignments set staff_id = staff_id`), /permission denied/);
  await assert.rejects(asStaff(techAId, `delete from hub.managed_websites where id = $1`, [siteA]), /permission denied/);
  await assert.rejects(asStaff(ownerId, `delete from hub.managed_websites where id = $1`, [siteA]), /permission denied/);
  await assert.rejects(asStaff(techAId, `insert into hub.staff_client_assignments (staff_id, client_account_id, assigned_by) values ($1, $2, $1)`, [techAId, clientB]), /row-level security/);
  await assert.rejects(asStaff(techAId, `select oidc_subject from hub.staff_users`), /permission denied/);
  await assert.rejects(asStaff(techAId, `select * from hub.staff_sessions`), /permission denied/);
  const updated = await asStaff(techAId, `update hub.staff_users set role = 'owner' where id = $1`, [techAId]).catch(error => error);
  assert.ok(updated instanceof Error || updated.affectedRows === 0);
  assert.equal((await h.pg.query(`select role from hub.staff_users where id = $1`, [techAId])).rows[0].role, 'technician');
});

// Uses a real non-superuser session, since the harness connection itself is a superuser.
test('the runtime login role has no rights of its own and cannot become an admin', async () => {
  // Its own database, because this changes the session's identity.
  const local = await createHarness();
  const owner2 = await local.addStaff('owner@hub.test', 'owner');
  const tech2 = await local.addStaff('tech@hub.test', 'technician');
  const assigned = await local.addClient('Assigned', owner2);
  const other = await local.addClient('Other', owner2);
  const visible = await local.addWebsite(assigned, 'visible', owner2);
  await local.addWebsite(other, 'hidden', owner2);
  await local.assign(tech2, assigned, owner2);
  for (const role of ['hub_auth', 'hub_app', 'hub_worker', 'hub_runtime']) {
    const { rows: [attributes] } = await local.pg.query(`select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = $1`, [role]);
    assert.deepEqual(attributes, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false }, role);
  }
  const { rows: [runtime] } = await local.pg.query(`select rolinherit, rolcanlogin from pg_roles where rolname = 'hub_runtime'`);
  assert.deepEqual(runtime, { rolinherit: false, rolcanlogin: false });

  await local.pg.exec(`set session authorization hub_runtime`);
  await assert.rejects(local.pg.query(`select id from hub.managed_websites`), /permission denied/);
  await assert.rejects(local.pg.query(`select set_config('role', 'postgres', true)`), /permission denied/);
  await assert.rejects(local.pg.query(`set role postgres`), /permission denied/);
  const scoped = await local.db.as('hub_app', tech2, tx => tx.query(`select id from hub.managed_websites`));
  assert.deepEqual(scoped.rows.map(row => row.id), [visible]);
  await local.close();
});

test('every hub table has row level security turned on', async () => {
  const { rows } = await h.pg.query(`select tablename from pg_tables where schemaname = 'hub' and not rowsecurity`);
  assert.deepEqual(rows, []);
});

test('the role matrix is enforced on server routes', async () => {
  const expectations = [
    [viewer, '/clients', { display_name: 'V' }], [techA, '/clients', { display_name: 'T' }], [billing, '/clients', { display_name: 'B' }],
    [viewer, '/maintenance/tasks', { website_id: siteA, title: 'V' }], [billing, '/maintenance/tasks', { website_id: siteA, title: 'B' }],
    [viewer, '/websites', { client_account_id: clientA, display_name: 'V', primary_url: 'https://v.example.test', cms_platform: 'other' }],
    [viewer, '/security/reviews', { website_id: siteA, scope: 'Scope', outcome: 'incomplete', summary: 'Summary', reviewed_at: new Date().toISOString() }],
    [viewer, '/backups/sources', { website_id: siteA, provider: 'P', label: 'L' }],
    [techA, '/staff', { email: 'x@hub.test', display_name: 'X', role: 'admin' }],
    [techA, '/staff/assign', { staff_id: techAId, client_account_id: clientB }],
    [techA, `/websites/${siteA}/connections`, { adapter_key: 'wordpress', auth_type: 'application_password', base_url: 'https://site-a.example.test' }]
  ];
  for (const [session, path, form] of expectations) {
    assert.equal((await session.post(path, form)).status, 403, `${session.staff.email} ${path}`);
  }
  for (const session of [techA, viewer, billing]) {
    assert.equal((await session.get('/audit')).status, 403);
    assert.equal((await session.get('/staff')).status, 403);
  }
  assert.ok((await h.auditActions()).some(item => item.action === 'request.denied' && item.metadata.reason === 'forbidden'));
});

test('read-only roles are offered no write controls', async () => {
  const page = await (await viewer.get(`/websites/${siteA}`)).text();
  for (const action of ['/maintenance/tasks', '/backups/sources', '/security/reviews', '/history', '/connections']) {
    assert.doesNotMatch(page, new RegExp(`action="${action}`), action);
  }
  assert.doesNotMatch(await (await viewer.get('/')).text(), /href="\/audit"/);
});

test('only an owner can create or change an owner', async () => {
  const admin = await h.sessionFor('admin@hub.test');
  assert.equal((await admin.post('/staff', { email: 'second-owner@hub.test', display_name: 'Second', role: 'owner' })).status, 422);
  assert.equal((await admin.post(`/staff/${ownerId}`, { role: 'viewer', status: 'disabled' })).status, 404);
  assert.equal((await h.pg.query(`select status from hub.staff_users where id = $1`, [ownerId])).rows[0].status, 'active');
});

test('nobody can change their own role or disable themselves', async () => {
  assert.equal((await owner.post(`/staff/${ownerId}`, { role: 'owner', status: 'disabled' })).status, 422);
});

test('removing an assignment removes access at once', async () => {
  const id = await h.addStaff('temp@hub.test', 'technician');
  await h.assign(id, clientA, ownerId);
  const session = await h.sessionFor('temp@hub.test');
  assert.equal((await session.get(`/websites/${siteA}`)).status, 200);
  assert.equal((await owner.post('/staff/unassign', { staff_id: id, client_account_id: clientA })).status, 303);
  assert.equal((await session.get(`/websites/${siteA}`)).status, 404);
});

test('work cannot be assigned to someone without access to that client', async () => {
  const blocked = await owner.postJson('/api/v1/tasks', { website_id: siteA, title: 'Wrong person', assignee_id: techBId });
  assert.equal(blocked.status, 422);
  const allowed = await owner.postJson('/api/v1/tasks', { website_id: siteA, title: 'Right person', assignee_id: techAId });
  assert.equal(allowed.status, 201);
  const readonly = await owner.postJson('/api/v1/tasks', { website_id: siteA, title: 'Viewer', assignee_id: viewerId });
  assert.equal(readonly.status, 422);
});

test('every permission names only valid roles, and unknown permissions are denied', () => {
  const roles = new Set(['owner', 'admin', 'technician', 'billing', 'viewer']);
  for (const list of Object.values(PERMISSIONS)) for (const role of list) assert.ok(roles.has(role));
  assert.equal(can({ role: 'owner' }, 'not.a.permission'), false);
  assert.equal(can(null, 'client.read'), false);
});
