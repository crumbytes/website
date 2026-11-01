import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, fakeHttp, TEST_KEK } from './helpers.mjs';
import { runDueMonitoring, runJobs } from '../src/services/jobs.js';
import { deliverOutbox } from '../src/stackltr.js';
import { recoverabilityOf, RESTORE_EVIDENCE_DAYS } from '../src/services/records.js';

const nowIso = () => new Date().toISOString();

let h, http, ownerId, owner, admin, tech, clientId, siteId;
before(async () => {
  http = fakeHttp({ '*': { status: 200, body: {} } });
  h = await createHarness({ http, env: {
    HUB_CREDENTIAL_STORAGE_ENABLED: 'true', HUB_CREDENTIAL_KEKS: TEST_KEK, HUB_CREDENTIAL_ACTIVE_KEY: 't1', HUB_OPERATIONS_ENABLED: 'true', HUB_JOB_SECRET: 'j'.repeat(40)
  } });
  ownerId = await h.addStaff('owner@hub.test', 'owner');
  await h.addStaff('admin@hub.test', 'admin');
  const techId = await h.addStaff('tech@hub.test', 'technician');
  clientId = await h.addClient('Client', ownerId);
  siteId = await h.addWebsite(clientId, 'site', ownerId);
  await h.assign(techId, clientId, ownerId);
  [owner, admin, tech] = await Promise.all(['owner', 'admin', 'tech'].map(name => h.sessionFor(`${name}@hub.test`)));
});
after(() => h.close());

// Website management ---------------------------------------------------------

test('staff add and edit a client and website through the interface', async () => {
  const created = await owner.post('/clients', { display_name: 'Harbor Test Client', status: 'active' });
  assert.equal(created.status, 303);
  const client = (await h.pg.query(`select id from hub.client_accounts where display_name = 'Harbor Test Client'`)).rows[0].id;
  const plan = await owner.post('/plans', { name: 'Care Test Plan', maintenance_interval_days: '30' });
  assert.equal(plan.status, 303);
  const planId = (await h.pg.query(`select id from hub.service_plans`)).rows[0].id;
  const added = await owner.post('/websites', { client_account_id: client, display_name: 'Harbor', primary_url: 'HTTPS://Harbor.Example.test/', cms_platform: 'shopify', hosting_provider: 'Shopify', service_plan_id: planId, lifecycle: 'active' });
  assert.equal(added.status, 303);
  const site = (await h.pg.query(`select * from hub.managed_websites where display_name = 'Harbor'`)).rows[0];
  assert.equal(site.primary_url, 'https://harbor.example.test');
  assert.equal(site.service_plan_id, planId);
  assert.match(await (await owner.get(`/websites/${site.id}`)).text(), /Care Test Plan/);
  const edited = await owner.post(`/websites/${site.id}`, { client_account_id: client, display_name: 'Harbor Store', primary_url: site.primary_url, cms_platform: 'shopify', hosting_provider: 'Shopify', lifecycle: 'paused' });
  assert.equal(edited.status, 303);
  assert.match(await (await owner.get('/websites?q=Harbor')).text(), /Harbor Store/);
  assert.doesNotMatch(await (await owner.get('/websites?q=nomatch')).text(), /Harbor Store/);
});

test('invalid input is refused with field errors and the form stays filled in', async () => {
  const res = await owner.post('/websites', { client_account_id: clientId, display_name: 'Keep me', primary_url: 'javascript:alert(1)', cms_platform: 'wordpress' });
  assert.equal(res.status, 422);
  const page = await res.text();
  assert.match(page, /Enter a full web address/);
  assert.match(page, /value="Keep me"/);
  assert.match(page, /aria-invalid="true"/);
});

test('the API validates types, sizes, enums and JSON', async () => {
  const post = body => owner.postJson('/api/v1/websites', body);
  const base = { client_account_id: clientId, display_name: 'API', primary_url: 'https://api-site.example.test', cms_platform: 'wordpress' };
  for (const [field, value] of [
    ['client_account_id', 'not-a-uuid'], ['display_name', ''], ['display_name', 'x'.repeat(200)], ['display_name', 42],
    ['primary_url', 'ftp://x.example.test'], ['primary_url', 'https://user:pw@x.example.test'], ['primary_url', 'https://localhost'], ['primary_url', 'nope'],
    ['cms_platform', 'drupal'], ['lifecycle', 'gone'], ['notes', 'x'.repeat(5000)]
  ]) {
    const res = await post({ ...base, [field]: value });
    assert.equal(res.status, 422, `${field}=${String(value).slice(0, 20)}`);
    const { error } = await res.json();
    assert.equal(error.code, 'validation_failed');
    assert.ok(error.fields[field], field);
  }
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post('[1,2]')).status, 400);
  assert.equal((await h.pg.query(`select 1 from hub.managed_websites where display_name = 'API'`)).rows.length, 0);
  const ok = await post(base);
  assert.equal(ok.status, 201);
  const duplicate = await post(base);
  assert.equal(duplicate.status, 409);
  const task = await owner.postJson('/api/v1/tasks', { website_id: siteId, title: 'x', due_on: '2026-13-45', priority: 'whenever' });
  assert.equal(task.status, 422);
  const oversized = await h.app.request('/api/v1/tasks', { method: 'POST', headers: { Cookie: owner.cookie, Origin: 'https://hub.hub.test', 'X-CSRF-Token': owner.csrf, 'Content-Length': String(200 * 1024) }, body: 'x'.repeat(200 * 1024) });
  assert.equal(oversized.status, 413);
});

test('stored text is escaped on every page', async () => {
  const xss = '<script>alert(1)</script>';
  const res = await owner.post('/clients', { display_name: `Escape ${xss}` });
  assert.equal(res.status, 303);
  const client = (await h.pg.query(`select id from hub.client_accounts where display_name like 'Escape%'`)).rows[0].id;
  const site = await h.addWebsite(client, 'escape', ownerId);
  await owner.post('/maintenance/tasks', { website_id: site, title: xss, details: xss });
  await owner.post('/history', { website_id: site, kind: 'other', summary: xss, performed_at: nowIso() });
  for (const path of ['/clients', `/clients/${client}`, `/websites/${site}`, '/websites', '/maintenance', '/audit']) {
    const page = await (await owner.get(path)).text();
    assert.doesNotMatch(page, /<script>alert/, path);
  }
  assert.match(await (await owner.get(`/websites/${site}`)).text(), /&lt;script&gt;alert/);
});

test('a crafted return path cannot redirect staff off the site', async () => {
  for (const target of ['https://evil.example.test', '//evil.example.test', '/\\evil.example.test']) {
    const res = await owner.post('/maintenance/tasks', { website_id: siteId, title: 'Redirect check', _return: target });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /^\/maintenance\?/, target);
  }
});

// Fabrication ----------------------------------------------------------------

test('a new installation shows no invented records or results', async () => {
  const fresh = await createHarness();
  await fresh.addStaff('owner@hub.test', 'owner');
  const session = await fresh.sessionFor('owner@hub.test');
  assert.equal((await fresh.pg.query(`select count(*)::int as n from hub.client_accounts`)).rows[0].n, 0);
  assert.equal((await fresh.pg.query(`select count(*)::int as n from hub.service_plans`)).rows[0].n, 0);
  const home = await (await session.get('/')).text();
  assert.match(home, /This is not a clean result/);
  assert.match(home, /Backup coverage is unknown/);
  assert.match(home, /Not set up/);
  assert.doesNotMatch(await (await session.get('/monitoring')).text(), /Reachable/);
  assert.match(await (await session.get('/security')).text(), /not a clean result/);
  assert.match(await (await session.get('/integrations')).text(), /Not yet verified against live platforms/);
  await fresh.close();
});

test('an enabled check with no result stays unknown', async () => {
  const site = await h.addWebsite(clientId, 'unknown-state', ownerId);
  assert.equal((await tech.post('/monitoring/checks', { website_id: site, kind: 'uptime', interval_minutes: '60' })).status, 303);
  const page = await (await tech.get(`/websites/${site}`)).text();
  assert.match(page, /Unknown: not checked/);
  assert.doesNotMatch(page, /Reachable/);
  assert.equal((await tech.post('/monitoring/checks', { website_id: site, kind: 'uptime' })).status, 409);
});

// Maintenance ----------------------------------------------------------------

test('tasks can be assigned and completed, and completion writes the service record', async () => {
  await owner.post('/maintenance/tasks', { website_id: siteId, title: 'Update plugins', priority: 'high', due_on: '2020-01-01' });
  const task = (await h.pg.query(`select id from hub.maintenance_tasks where title = 'Update plugins'`)).rows[0].id;
  const assignee = tech.id;
  assert.equal((await owner.post(`/maintenance/tasks/${task}/update`, { status: 'in_progress', assignee_id: assignee })).status, 303);
  assert.match(await (await tech.get('/maintenance')).text(), /Overdue/);
  assert.equal((await tech.post(`/maintenance/tasks/${task}/complete`, { completion_notes: '' })).status, 422);
  assert.equal((await tech.post(`/maintenance/tasks/${task}/complete`, { completion_notes: 'Updated all plugins.' })).status, 303);
  const row = (await h.pg.query(`select status, completed_by from hub.maintenance_tasks where id = $1`, [task])).rows[0];
  assert.deepEqual(row, { status: 'completed', completed_by: tech.id });
  assert.match(await (await tech.get(`/websites/${siteId}`)).text(), /Update plugins: Updated all plugins\./);
  const outbox = (await h.pg.query(`select event_type, status from hub.stackltr_outbox where idempotency_key = $1`, [`maintenance.completed:${task}`])).rows;
  assert.deepEqual(outbox, [{ event_type: 'maintenance.completed', status: 'pending' }]);
  assert.equal((await tech.post(`/maintenance/tasks/${task}/complete`, { completion_notes: 'Again here.' })).status, 409);
  assert.equal((await tech.post(`/maintenance/tasks/${task}/update`, { status: 'open' })).status, 409);
});

test('the database itself refuses a completed task with no notes', async () => {
  await assert.rejects(h.pg.query(
    `insert into hub.maintenance_tasks (client_account_id, website_id, title, status, completed_at, completed_by, created_by)
     values ($1, $2, 'No notes', 'completed', now(), $3, $3)`, [clientId, siteId, ownerId]), /check constraint/);
});

test('schedules create one open task at a time and advance on completion', async () => {
  const res = await tech.post('/maintenance/schedules', { website_id: siteId, title: 'Monthly check', interval_days: '30', next_due_on: '2030-01-01' });
  assert.equal(res.status, 303);
  const schedule = (await h.pg.query(`select id from hub.maintenance_schedules where title = 'Monthly check'`)).rows[0].id;
  assert.equal((await tech.post(`/maintenance/schedules/${schedule}/task`)).status, 303);
  assert.equal((await tech.post(`/maintenance/schedules/${schedule}/task`)).status, 409);
  const task = (await h.pg.query(`select id, due_on::text as due from hub.maintenance_tasks where schedule_id = $1`, [schedule])).rows[0];
  assert.equal(task.due, '2030-01-01');
  await tech.post(`/maintenance/tasks/${task.id}/complete`, { completion_notes: 'Checked it.' });
  const next = (await h.pg.query(`select next_due_on::text as due from hub.maintenance_schedules where id = $1`, [schedule])).rows[0].due;
  assert.equal(next, '2030-01-31');
});

// Monitoring -----------------------------------------------------------------

test('monitoring records results only when a probe actually ran', async () => {
  const site = await h.addWebsite(clientId, 'probed', ownerId);
  await tech.post('/monitoring/checks', { website_id: site, kind: 'uptime' });
  await tech.post('/monitoring/checks', { website_id: site, kind: 'ssl' });
  const count = async () => (await h.pg.query(`select count(*)::int as n from hub.monitoring_results`)).rows[0].n;
  const before = await count();
  assert.deepEqual(await runDueMonitoring({ db: h.db, http, outboundEnabled: false }), { ran: 0, skipped: 'outbound_disabled' });
  assert.equal(await count(), before);
  const result = await runDueMonitoring({ db: h.db, http, outboundEnabled: true });
  assert.ok(result.ran >= 2);
  const page = await (await tech.get(`/websites/${site}`)).text();
  assert.match(page, /Reachable/);
  assert.match(page, /Expires /);
  assert.equal((await runDueMonitoring({ db: h.db, http, outboundEnabled: true })).ran, 0, 'not due again yet');
});

test('failures are recorded honestly and a refused target is not called down', async () => {
  const site = await h.addWebsite(clientId, 'failing', ownerId);
  await tech.post('/monitoring/checks', { website_id: site, kind: 'uptime' });
  const { OutboundError } = await import('../src/safe-http.js');
  const failing = (code) => ({ request: async () => { throw new OutboundError(code); }, tlsCertificate: async () => { throw new OutboundError(code); } });
  const latest = async () => (await h.pg.query(
    `select r.outcome, r.error_code from hub.monitoring_results r join hub.monitoring_checks m on m.id = r.check_id where m.website_id = $1 order by r.checked_at desc limit 1`, [site])).rows[0];
  await runDueMonitoring({ db: h.db, http: failing('timeout'), outboundEnabled: true });
  assert.deepEqual(await latest(), { outcome: 'down', error_code: 'timeout' });
  await h.pg.query(`update hub.monitoring_checks set next_run_at = now() where website_id = $1`, [site]);
  await runDueMonitoring({ db: h.db, http: failing('blocked_target'), outboundEnabled: true });
  assert.deepEqual(await latest(), { outcome: 'error', error_code: 'blocked_target' });
  await h.pg.query(`update hub.monitoring_checks set next_run_at = now() where website_id = $1`, [site]);
  await runDueMonitoring({ db: h.db, http: fakeHttp({ '*': { status: 503, body: 'x' } }), outboundEnabled: true });
  assert.equal((await latest()).outcome, 'down');
});

test('an untrusted certificate is flagged and expiring certificates become reminders', async () => {
  const site = await h.addWebsite(clientId, 'expiring', ownerId);
  await tech.post('/monitoring/checks', { website_id: site, kind: 'ssl' });
  const soon = new Date(Date.now() + 5 * 86400000);
  await runDueMonitoring({ db: h.db, http: fakeHttp({ tls: { validTo: soon, issuer: 'Test CA', trusted: false } }), outboundEnabled: true });
  const row = (await h.pg.query(`select r.outcome, r.error_code from hub.monitoring_results r join hub.monitoring_checks m on m.id = r.check_id where m.website_id = $1`, [site])).rows[0];
  assert.deepEqual(row, { outcome: 'error', error_code: 'tls_untrusted' });
  assert.match(await (await tech.get('/')).text(), /expiring<\/a>/);
});

test('the jobs endpoint needs its secret and is absent without one', async () => {
  assert.equal((await h.app.request('/internal/jobs/run', { method: 'POST' })).status, 401);
  assert.equal((await h.app.request('/internal/jobs/run', { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const ok = await h.app.request('/internal/jobs/run', { method: 'POST', headers: { Authorization: `Bearer ${'j'.repeat(40)}` } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).result.monitoring, { ran: 0, skipped: 'outbound_disabled' });
  const fresh = await createHarness();
  assert.equal((await fresh.app.request('/internal/jobs/run', { method: 'POST' })).status, 404);
  await fresh.close();
});

// Connections and failure handling --------------------------------------------

test('a connection failure is stored as a safe code, never as a site health claim', async () => {
  const site = await h.addWebsite(clientId, 'connfail', ownerId);
  await owner.post(`/websites/${site}/connections`, { adapter_key: 'wordpress', auth_type: 'application_password', base_url: 'https://connfail.example.test' });
  const id = (await h.pg.query(`select id from hub.platform_connections where website_id = $1`, [site])).rows[0].id;
  await owner.post(`/connections/${id}/credential`, { username: 'u', application_password: 'p' });

  const failures = [[401, 'auth_failed'], [429, 'rate_limited'], [500, 'upstream_error']];
  for (const [status, code] of failures) {
    http.calls.length = 0;
    const saved = http.request;
    http.request = async () => ({ status, headers: {}, body: 'provider said secret-detail', elapsedMs: 1 });
    assert.equal((await tech.post(`/connections/${id}/check`)).status, 303);
    http.request = saved;
    const row = (await h.pg.query(`select status, last_error_code from hub.platform_connections where id = $1`, [id])).rows[0];
    assert.deepEqual(row, { status: 'failed', last_error_code: code });
    const stored = await h.pg.query(`select data::text from hub.platform_snapshots where connection_id = $1 order by captured_at desc limit 1`, [id]);
    assert.doesNotMatch(stored.rows[0].data, /secret-detail/);
    assert.doesNotMatch(await (await tech.get(`/websites/${site}`)).text(), /secret-detail/);
  }
  assert.ok((await h.auditActions()).some(item => item.action === 'connection.check' && item.outcome === 'failure' && item.metadata.code === 'upstream_error'));
});

test('connection settings are validated per platform', async () => {
  const site = await h.addWebsite(clientId, 'connval', ownerId, 'shopify');
  const bad = await owner.post(`/websites/${site}/connections`, { adapter_key: 'shopify', auth_type: 'admin_access_token', base_url: 'https://evil.example.test' });
  assert.equal(bad.status, 422);
  const http2 = await owner.post(`/websites/${site}/connections`, { adapter_key: 'shopify', auth_type: 'admin_access_token', base_url: 'http://store.myshopify.com' });
  assert.equal(http2.status, 422);
  const auth = await owner.post(`/websites/${site}/connections`, { adapter_key: 'shopify', auth_type: 'password', base_url: 'https://store.myshopify.com' });
  assert.equal(auth.status, 422);
  const wix = await owner.post(`/websites/${site}/connections`, { adapter_key: 'wix', auth_type: 'api_key', site_id: 'nope' });
  assert.equal(wix.status, 422);
  assert.equal((await h.pg.query(`select 1 from hub.platform_connections where website_id = $1`, [site])).rows.length, 0);
});

test('operations need a second person, and run only when approved', async () => {
  const site = await h.addWebsite(clientId, 'ops', ownerId);
  await owner.post(`/websites/${site}/connections`, { adapter_key: 'wordpress', auth_type: 'application_password', base_url: 'https://ops.example.test' });
  const connection = (await h.pg.query(`select id from hub.platform_connections where website_id = $1`, [site])).rows[0].id;
  await owner.post(`/connections/${connection}/credential`, { username: 'u', application_password: 'p' });
  const request = form => tech.post('/operations', { connection_id: connection, operation_key: 'plugin.set_status', reason: 'Conflict with checkout', ...form });
  assert.equal((await request({ plugin: '../../x', status: 'active' })).status, 422);
  assert.equal((await request({ operation_key: 'core.delete_everything', plugin: 'a/a', status: 'active' })).status, 422);
  assert.equal((await request({ plugin: 'akismet/akismet', status: 'inactive' })).status, 303);
  const op = (await h.pg.query(`select id from hub.operation_requests where connection_id = $1`, [connection])).rows[0].id;
  http.calls.length = 0;
  assert.equal((await tech.post(`/operations/${op}/approve`)).status, 403);
  assert.equal((await tech.post(`/operations/${op}/execute`)).status, 403);
  assert.equal((await owner.post(`/operations/${op}/execute`)).status, 409);
  assert.equal(http.calls.length, 0);
  assert.equal((await owner.post(`/operations/${op}/approve`)).status, 303);
  assert.equal((await owner.post(`/operations/${op}/approve`)).status, 409);
  assert.equal((await owner.post(`/operations/${op}/execute`)).status, 303);
  assert.equal(new URL(http.calls.at(-1).url).pathname, '/wp-json/wp/v2/plugins/akismet/akismet');
  assert.equal((await h.pg.query(`select status from hub.operation_requests where id = $1`, [op])).rows[0].status, 'executed');
  assert.match(await (await tech.get(`/websites/${site}`)).text(), /completed through the WordPress API/);
  assert.equal((await owner.post(`/operations/${op}/execute`)).status, 409);
});

test('someone cannot approve their own request, at the route or in the database', async () => {
  const site = await h.addWebsite(clientId, 'selfapprove', ownerId);
  await owner.post(`/websites/${site}/connections`, { adapter_key: 'wordpress', auth_type: 'application_password', base_url: 'https://self.example.test' });
  const connection = (await h.pg.query(`select id from hub.platform_connections where website_id = $1`, [site])).rows[0].id;
  await owner.post('/operations', { connection_id: connection, operation_key: 'plugin.set_status', reason: 'My own change', plugin: 'a/a', status: 'inactive' });
  const op = (await h.pg.query(`select id from hub.operation_requests where connection_id = $1`, [connection])).rows[0].id;
  assert.equal((await owner.post(`/operations/${op}/approve`)).status, 403);
  await assert.rejects(h.db.as('hub_app', ownerId, tx => tx.query(`update hub.operation_requests set status = 'approved', decided_by = $1 where id = $2`, [ownerId, op])), /check constraint/);
  assert.equal((await admin.post(`/operations/${op}/approve`)).status, 303);
});

test('live operations stay blocked unless the environment turns them on', async () => {
  const off = await createHarness({ http: fakeHttp({}) });
  const a = await off.addStaff('owner@hub.test', 'owner');
  await off.addStaff('admin@hub.test', 'admin');
  const client = await off.addClient('C', a);
  const site = await off.addWebsite(client, 's', a);
  const [o, ad] = await Promise.all(['owner', 'admin'].map(n => off.sessionFor(`${n}@hub.test`)));
  await o.post(`/websites/${site}/connections`, { adapter_key: 'wordpress', auth_type: 'application_password', base_url: 'https://s.example.test' });
  const connection = (await off.pg.query(`select id from hub.platform_connections`)).rows[0].id;
  await o.post('/operations', { connection_id: connection, operation_key: 'plugin.set_status', reason: 'Testing gate', plugin: 'a/a', status: 'inactive' });
  const op = (await off.pg.query(`select id from hub.operation_requests`)).rows[0].id;
  await ad.post(`/operations/${op}/approve`);
  assert.equal((await ad.post(`/operations/${op}/execute`)).status, 503);
  await off.close();
});

// Backups --------------------------------------------------------------------

test('recoverability is verified only by recent, passed restore evidence', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const daysAgo = days => new Date(now.getTime() - days * 86400000);
  const state = input => recoverabilityOf(input, now);
  assert.equal(state({}).state, 'no_backups');
  assert.equal(state({ latestRunStatus: 'succeeded' }).state, 'unverified');
  assert.equal(state({ latestRunStatus: 'succeeded' }).verified, false);
  assert.equal(state({ latestRunStatus: 'succeeded', latestPassedAt: daysAgo(RESTORE_EVIDENCE_DAYS - 1) }).verified, true);
  assert.equal(state({ latestRunStatus: 'succeeded', latestPassedAt: daysAgo(RESTORE_EVIDENCE_DAYS + 1) }).state, 'evidence_stale');
  assert.equal(state({ latestRunStatus: 'succeeded', latestPassedAt: daysAgo(10), latestFailedAt: daysAgo(1) }).state, 'restore_failed');
  assert.equal(state({ latestRunStatus: 'succeeded', latestPassedAt: daysAgo(1), latestFailedAt: daysAgo(10) }).verified, true);
});

test('a successful backup alone never claims it can be restored', async () => {
  const site = await h.addWebsite(clientId, 'backup', ownerId);
  await tech.post('/backups/sources', { website_id: site, provider: 'Test Provider', label: 'Nightly', expected_interval_hours: '24' });
  const source = (await h.pg.query(`select id from hub.backup_sources where website_id = $1`, [site])).rows[0].id;
  assert.match(await (await tech.get('/backups')).text(), /No backups recorded/);
  await tech.post('/backups/runs', { source_id: source, status: 'succeeded', finished_at: nowIso() });
  const run = (await h.pg.query(`select id from hub.backup_runs where source_id = $1`, [source])).rows[0].id;
  const page = await (await tech.get('/backups')).text();
  assert.match(page, /Not verified: no restore test on record/);
  assert.doesNotMatch(page, /Restore verified with evidence/);

  const restore = form => tech.post('/backups/restores', { backup_run_id: run, target_environment: 'isolated', checks_performed: 'Loaded the home page and logged in.', performed_at: nowIso(), ...form });
  assert.equal((await restore({ outcome: 'passed', evidence_ref: '' })).status, 422);
  assert.equal((await restore({ outcome: 'passed', evidence_ref: 'DOC-1', checks_performed: 'short' })).status, 422);
  assert.equal((await restore({ outcome: 'passed', evidence_ref: 'DOC-1', performed_at: '2099-01-01T00:00' })).status, 422);
  assert.doesNotMatch(await (await tech.get('/backups')).text(), /Restore verified with evidence/);
  assert.equal((await restore({ outcome: 'passed', evidence_ref: 'DOC-1' })).status, 303);
  assert.match(await (await tech.get('/backups')).text(), /Restore verified with evidence/);
  assert.equal((await restore({ outcome: 'failed' })).status, 303);
  assert.match(await (await tech.get('/backups')).text(), /Latest restore test did not pass/);
});

test('a failed backup cannot receive a passed restore, including through direct SQL', async () => {
  const site = await h.addWebsite(clientId, 'badbackup', ownerId);
  await tech.post('/backups/sources', { website_id: site, provider: 'P', label: 'Failing' });
  const source = (await h.pg.query(`select id from hub.backup_sources where website_id = $1`, [site])).rows[0].id;
  await tech.post('/backups/runs', { source_id: source, status: 'failed', finished_at: nowIso() });
  const run = (await h.pg.query(`select id from hub.backup_runs where source_id = $1`, [source])).rows[0].id;
  const res = await tech.post('/backups/restores', { backup_run_id: run, target_environment: 'isolated', outcome: 'passed', evidence_ref: 'DOC-2', checks_performed: 'Tried to restore it anyway.', performed_at: nowIso() });
  assert.equal(res.status, 422);
  await assert.rejects(h.pg.query(
    `insert into hub.restore_verifications (client_account_id, backup_run_id, target_environment, outcome, checks_performed, evidence_ref, performed_by, performed_at)
     values ($1, $2, 'isolated', 'passed', 'Inserted directly here', 'DOC', $3, now())`, [clientId, run, ownerId]), /succeeded/);
  // A successful run still cannot get a passed restore without evidence.
  await tech.post('/backups/runs', { source_id: source, status: 'succeeded', finished_at: nowIso() });
  const good = (await h.pg.query(`select id from hub.backup_runs where source_id = $1 and status = 'succeeded'`, [source])).rows[0].id;
  await assert.rejects(h.pg.query(
    `insert into hub.restore_verifications (client_account_id, backup_run_id, target_environment, outcome, checks_performed, performed_by, performed_at)
     values ($1, $2, 'isolated', 'passed', 'No evidence given here', $3, now())`, [clientId, good, ownerId]), /check constraint/);
});

// Audit ----------------------------------------------------------------------

test('changes write an audit entry in the same transaction, attributed to the actor', async () => {
  const before = (await h.auditActions()).length;
  await owner.post('/clients', { display_name: 'Audited Client' });
  const entry = (await h.auditActions()).slice(before).find(item => item.action === 'client.create');
  assert.equal(entry.actor_staff_id, owner.id);
  assert.equal(entry.outcome, 'success');
  assert.ok(entry.client_account_id);

  const count = (await h.auditActions()).length;
  const failed = await owner.postJson('/api/v1/websites', { client_account_id: entry.client_account_id, display_name: 'Dup', primary_url: 'https://site.example.test', cms_platform: 'other' });
  assert.equal(failed.status, 409);
  assert.equal((await h.auditActions()).length, count, 'a rolled-back change leaves no success entry');
});

test('the audit log cannot be changed by anyone', async () => {
  const { rows: [{ seq }] } = await h.pg.query(`select max(seq) as seq from hub.audit_log`);
  for (const [role, id] of [['hub_app', ownerId], ['hub_worker', null], ['hub_auth', null]]) {
    await assert.rejects(h.db.as(role, id, tx => tx.query(`update hub.audit_log set action = 'forged' where seq = $1`, [seq])), /permission denied/, role);
    await assert.rejects(h.db.as(role, id, tx => tx.query(`delete from hub.audit_log where seq = $1`, [seq])), /permission denied/, role);
  }
  await assert.rejects(h.pg.query(`update hub.audit_log set action = 'forged' where seq = $1`, [seq]), /append-only/);
  await assert.rejects(h.pg.query(`delete from hub.audit_log where seq = $1`, [seq]), /append-only/);
  await assert.rejects(h.pg.query(`truncate hub.audit_log`), /append-only/);
});

test('staff cannot write audit entries in someone else\'s name', async () => {
  await assert.rejects(h.db.as('hub_app', tech.id, tx => tx.query(
    `insert into hub.audit_log (actor_type, actor_staff_id, action, prev_hash, entry_hash) values ('staff', $1, 'forged.entry', '', '')`, [ownerId])), /row-level security/);
  await assert.rejects(h.db.as('hub_app', tech.id, tx => tx.query(
    `insert into hub.audit_log (actor_type, action, prev_hash, entry_hash) values ('system', 'forged.entry', '', '')`)), /row-level security/);
});

test('the hash chain verifies, and detects tampering that gets past the triggers', async () => {
  assert.match(await (await owner.get('/audit')).text(), /Hash chain verified/);
  const { rows: [{ seq }] } = await h.pg.query(`select min(seq) + 1 as seq from hub.audit_log`);
  await h.pg.exec(`alter table hub.audit_log disable trigger audit_log_append_only`);
  await h.pg.query(`update hub.audit_log set metadata = '{"forged":true}' where seq = $1`, [seq]);
  await h.pg.exec(`alter table hub.audit_log enable trigger audit_log_append_only`);
  const broken = (await h.pg.query(`select hub.verify_audit_chain() as seq`)).rows[0].seq;
  assert.equal(String(broken), String(seq));
  assert.match(await (await owner.get('/audit')).text(), /The audit chain failed verification/);
});

test('secrets passed to the audit writer are redacted', async () => {
  const { redact } = await import('../src/audit.js');
  const clean = redact({ password: 'p', api_key: 'k', nested: { access_token: 't', Authorization: 'a', keep: 'visible' }, list: [{ client_secret: 's' }] });
  assert.deepEqual(clean, { password: '[redacted]', api_key: '[redacted]', nested: { access_token: '[redacted]', Authorization: '[redacted]', keep: 'visible' }, list: [{ client_secret: '[redacted]' }] });
});

// StackLTR -------------------------------------------------------------------

test('StackLTR delivery is off by default and hub work does not depend on it', async () => {
  assert.deepEqual(await deliverOutbox({ db: h.db, stackltr: { enabled: false } }), { sent: 0, failed: 0, skipped: 'stackltr_disabled' });
  const result = await runJobs({ db: h.db, http, stackltr: { enabled: false }, outboundEnabled: false });
  assert.equal(result.stackltr.skipped, 'stackltr_disabled');
  assert.match(await (await owner.get('/integrations')).text(), /Not connected/);
});

test('StackLTR delivery is idempotent, holds unlinked clients, retries outages and stops on rejection', async () => {
  const fresh = await createHarness();
  const owner2 = await fresh.addStaff('owner@hub.test', 'owner');
  const linked = await fresh.addClient('Linked', owner2);
  const unlinked = await fresh.addClient('Unlinked', owner2);
  await fresh.pg.query(`update hub.client_accounts set stackltr_workspace_id = gen_random_uuid(), stackltr_company_id = gen_random_uuid() where id = $1`, [linked]);
  const enqueue = (client, key) => fresh.pg.query(`insert into hub.stackltr_outbox (client_account_id, event_type, idempotency_key, payload) values ($1, 'maintenance.completed', $2, '{"task_id":"t"}')`, [client, key]);
  await enqueue(linked, 'k1');
  await enqueue(unlinked, 'k2');

  const statusOf = async key => (await fresh.pg.query(`select status, attempts, last_error_code from hub.stackltr_outbox where idempotency_key = $1`, [key])).rows[0];
  const { AdapterError } = await import('../src/adapters/framework.js');
  const sent = [];
  let failure = new AdapterError('upstream_error');
  const stackltr = { enabled: true, sendEvent: async (path, event) => { sent.push(event); if (failure) throw failure; } };

  assert.deepEqual(await deliverOutbox({ db: fresh.db, stackltr }), { sent: 0, failed: 1 });
  assert.deepEqual(await statusOf('k1'), { status: 'pending', attempts: 1, last_error_code: 'upstream_error' });
  assert.deepEqual(await statusOf('k2'), { status: 'pending', attempts: 0, last_error_code: null });

  failure = null;
  assert.deepEqual(await deliverOutbox({ db: fresh.db, stackltr }), { sent: 1, failed: 0 });
  assert.equal((await statusOf('k1')).status, 'sent');
  assert.equal(sent.at(-1).idempotency_key, 'k1');
  assert.equal(sent.at(-1).data.task_id, 't');
  assert.ok(sent.at(-1).company_id);
  assert.deepEqual(await deliverOutbox({ db: fresh.db, stackltr }), { sent: 0, failed: 0 });

  await enqueue(linked, 'k3');
  failure = new AdapterError('auth_failed');
  await deliverOutbox({ db: fresh.db, stackltr });
  assert.deepEqual(await statusOf('k3'), { status: 'failed', attempts: 1, last_error_code: 'auth_failed' });

  const audit = await fresh.auditActions();
  assert.ok(audit.some(item => item.action === 'stackltr.deliver' && item.outcome === 'failure'));
  await fresh.close();
});

test('the hub stores no contact, invoice or ticket copies of StackLTR records', async () => {
  const columns = (await h.pg.query(`select table_name, column_name from information_schema.columns where table_schema = 'hub'`)).rows;
  const tables = new Set(columns.map(item => item.table_name));
  for (const banned of ['contacts', 'invoices', 'tickets', 'customers', 'companies', 'payments']) {
    assert.ok(![...tables].some(name => name.includes(banned)), banned);
  }
  const clientColumns = columns.filter(item => item.table_name === 'client_accounts').map(item => item.column_name);
  for (const banned of ['email', 'phone', 'address', 'contact_name']) {
    assert.ok(!clientColumns.includes(banned), banned);
  }
});
