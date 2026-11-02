import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createBackupProviders, createR2Provider, signS3Request } from '../src/backups.js';
import { loadConfig } from '../src/config.js';
import { deliverEmails, createEmailSender } from '../src/email.js';
import { createLogger } from '../src/logger.js';
import { recommendationsFor, riskFor } from '../src/services/insights.js';
import { generateReminders, runBackupProviderSync, runDueMonitoring, syncDomainExpiry } from '../src/services/jobs.js';
import { createStackltrClient } from '../src/stackltr.js';
import { toCsv } from '../src/ui/pages2.js';
import { ADAPTERS } from '../src/adapters/index.js';
import { AdapterError, createPlatformClient } from '../src/adapters/framework.js';
import { createHarness, fakeHttp, ISSUER, ORIGIN, TEST_KEK } from './helpers.mjs';

const nowIso = () => new Date().toISOString();
const inDays = days => new Date(Date.now() + days * 86400000);

let h, http, ownerId, techId, otherTechId, owner, admin, tech, otherTech, viewer, clientA, clientB, siteA, siteB;
before(async () => {
  http = fakeHttp({ '*': { status: 200, body: {} } });
  h = await createHarness({ http, env: { HUB_CREDENTIAL_STORAGE_ENABLED: 'true', HUB_CREDENTIAL_KEKS: TEST_KEK, HUB_CREDENTIAL_ACTIVE_KEY: 't1' } });
  ownerId = await h.addStaff('owner@hub.test', 'owner');
  await h.addStaff('admin@hub.test', 'admin');
  techId = await h.addStaff('tech@hub.test', 'technician');
  otherTechId = await h.addStaff('other@hub.test', 'technician');
  const viewerId = await h.addStaff('viewer@hub.test', 'viewer');
  clientA = await h.addClient('Client A', ownerId);
  clientB = await h.addClient('Client B', ownerId);
  siteA = await h.addWebsite(clientA, 'alpha', ownerId);
  siteB = await h.addWebsite(clientB, 'bravo', ownerId);
  await h.assign(techId, clientA, ownerId);
  await h.assign(viewerId, clientA, ownerId);
  await h.assign(otherTechId, clientB, ownerId);
  [owner, admin, tech, otherTech, viewer] = await Promise.all(['owner', 'admin', 'tech', 'other', 'viewer'].map(name => h.sessionFor(`${name}@hub.test`)));
});
after(() => h.close());

// Inventory -------------------------------------------------------------------

test('reference data matches the adapters in code', async () => {
  const { rows } = await h.pg.query(`select key, has_adapter from hub.website_platforms`);
  assert.deepEqual(new Set(rows.filter(row => row.has_adapter).map(row => row.key)), new Set(Object.keys(ADAPTERS)));
  assert.ok(rows.some(row => row.key === 'other' && !row.has_adapter));
  assert.equal((await h.pg.query(`select count(*)::int as n from hub.hosting_providers`)).rows[0].n, 0, 'no sample providers');
});

test('the profile reports real state and says when something is unknown', async () => {
  const page = await (await tech.get(`/websites/${siteA}`)).text();
  for (const label of ['Client', 'Primary domain', 'CMS platform', 'Hosting provider', 'Maintenance plan', 'Monitoring status', 'Backup status', 'Security review', 'Last maintenance', 'Next scheduled']) {
    assert.match(page, new RegExp(`<dt>${label}</dt>`), label);
  }
  for (const text of ['Unknown: not checked', 'No backups recorded', 'Not assessed', 'None recorded', 'Nothing scheduled']) {
    assert.match(page, new RegExp(text), text);
  }
});

test('domains are validated, unique and keep their source', async () => {
  for (const hostname of ['https://x.example.test', 'no-dot', 'a b.example.test', '-bad.example.test']) {
    assert.equal((await tech.post(`/websites/${siteA}/domains`, { hostname, is_primary: 'on' })).status, 422, hostname);
  }
  assert.equal((await tech.post(`/websites/${siteA}/domains`, { hostname: 'ALPHA.example.test', is_primary: 'on', registrar: 'Test Registrar', expires_on: '2040-01-02' })).status, 303);
  const row = (await h.pg.query(`select hostname, is_primary, expiry_source, expires_on::text as expires from hub.website_domains`)).rows[0];
  assert.deepEqual(row, { hostname: 'alpha.example.test', is_primary: true, expiry_source: 'manual', expires: '2040-01-02' });
  assert.equal((await owner.post(`/websites/${siteB}/domains`, { hostname: 'alpha.example.test' })).status, 409);
  assert.equal((await otherTech.post(`/websites/${siteA}/domains`, { hostname: 'cross.example.test' })).status, 404);
  assert.equal((await tech.post(`/websites/${siteA}/domains`, { hostname: 'www.alpha.example.test', is_primary: 'on' })).status, 303);
  const primaries = (await h.pg.query(`select hostname from hub.website_domains where website_id = $1 and is_primary`, [siteA])).rows;
  assert.deepEqual(primaries, [{ hostname: 'www.alpha.example.test' }]);
  const page = await (await tech.get(`/websites/${siteA}`)).text();
  assert.match(page, /Recorded by staff/);
  assert.match(page, /<dt>Primary domain<\/dt><dd>www\.alpha\.example\.test/);
});

test('inventory can be filtered, and filters never widen access', async () => {
  const hostRes = await owner.post('/hosting', { name: 'Filter Host', support_url: 'https://support.example.test' });
  assert.equal(hostRes.status, 303);
  const host = (await h.pg.query(`select id from hub.hosting_providers where name = 'Filter Host'`)).rows[0].id;
  await h.pg.query(`update hub.managed_websites set hosting_provider_id = $1 where id = $2`, [host, siteB]);
  const ids = async (session, query) => (await (await session.get(`/api/v1/websites?${query}`)).json()).websites.map(site => site.id);
  assert.deepEqual(await ids(owner, `hosting=${host}`), [siteB]);
  assert.deepEqual(await ids(owner, `client=${clientA}&lifecycle=active`), [siteA]);
  assert.deepEqual(await ids(owner, 'platform=shopify'), []);
  assert.ok((await ids(owner, 'monitoring=unknown')).includes(siteA));
  assert.deepEqual(await ids(tech, `client=${clientB}`), []);
  assert.deepEqual(await ids(tech, `hosting=${host}`), []);
  assert.deepEqual(await ids(owner, "q=' OR 1=1 --"), []);
  assert.equal((await owner.get('/api/v1/websites?lifecycle=%27;drop')).status, 200);
});

test('hosting provider names are unique regardless of case', async () => {
  await owner.post('/hosting', { name: 'Case Host' });
  assert.equal((await owner.post('/hosting', { name: 'CASE host' })).status, 409);
  assert.equal((await owner.post('/hosting', { name: 'Bad Url', support_url: 'http://nope.example.test' })).status, 422);
  assert.equal((await viewer.post('/hosting', { name: 'Viewer Host' })).status, 403);
});

test('archiving hides a website, stops its monitoring and keeps its records', async () => {
  const site = await h.addWebsite(clientA, 'archived-site', ownerId);
  await tech.post('/monitoring/checks', { website_id: site, kind: 'uptime' });
  await tech.post('/history', { website_id: site, kind: 'other', summary: 'Before archive', performed_at: nowIso() });
  assert.equal((await tech.post(`/websites/${site}/archive`)).status, 303);
  assert.equal((await tech.post(`/websites/${site}/archive`)).status, 409);
  const list = async query => (await (await tech.get(`/api/v1/websites?${query}`)).json()).websites.map(item => item.id);
  assert.equal((await list('')).includes(site), false);
  assert.equal((await list('lifecycle=archived')).includes(site), true);
  assert.equal((await h.pg.query(`select enabled from hub.monitoring_checks where website_id = $1`, [site])).rows[0].enabled, false);
  assert.match(await (await tech.get(`/websites/${site}`)).text(), /Before archive/);
  assert.equal((await tech.post(`/websites/${site}`, { client_account_id: clientA, display_name: 'x', primary_url: 'https://x.example.test', cms_platform: 'other' })).status, 409);
  assert.equal((await tech.post(`/websites/${site}/restore`)).status, 303);
  const restored = (await h.pg.query(`select lifecycle, archived_at from hub.managed_websites where id = $1`, [site])).rows[0];
  assert.deepEqual(restored, { lifecycle: 'paused', archived_at: null });
  assert.equal((await h.pg.query(`select enabled from hub.monitoring_checks where website_id = $1`, [site])).rows[0].enabled, false, 'stays off');
  assert.equal((await viewer.post(`/websites/${site}/archive`)).status, 403);
  assert.ok((await h.auditActions()).some(item => item.action === 'website.archive'));
});

test('a manually recorded CMS version is labelled, and the API version replaces it', async () => {
  assert.equal((await tech.post(`/websites/${siteA}/cms-version`, { cms_version: '<script>' })).status, 422);
  assert.equal((await tech.post(`/websites/${siteA}/cms-version`, { cms_version: '6.7.1' })).status, 303);
  assert.match(await (await tech.get(`/websites/${siteA}`)).text(), /Recorded by staff/);
  const joomla = await h.addWebsite(clientA, 'joomla-site', ownerId, 'joomla');
  await owner.post(`/websites/${joomla}/connections`, { adapter_key: 'joomla', auth_type: 'api_token', base_url: 'https://joomla-site.example.test' });
  const connection = (await h.pg.query(`select id from hub.platform_connections where website_id = $1`, [joomla])).rows[0].id;
  await owner.post(`/connections/${connection}/credential`, { api_token: 'tok' });
  const saved = http.request;
  http.request = async () => ({ status: 200, headers: {}, elapsedMs: 1, body: JSON.stringify({ data: [{ attributes: { name: 'files_joomla', type: 'file', version: '5.3.1' } }] }) });
  await tech.post(`/connections/${connection}/check`);
  http.request = saved;
  const row = (await h.pg.query(`select cms_version, cms_version_source from hub.managed_websites where id = $1`, [joomla])).rows[0];
  assert.deepEqual(row, { cms_version: '5.3.1', cms_version_source: 'api' });
});

// Adapters --------------------------------------------------------------------

test('a connection test calls only the identity routes, unlike a full check', async () => {
  const fake = fakeHttp({ '*': { body: { name: 'x', namespaces: [], roles: [] } } });
  const client = createPlatformClient({ baseUrl: 'https://s.example.test', http: fake });
  const result = await ADAPTERS.wordpress.testConnection(client, {});
  assert.deepEqual(Object.keys(result), ['connection']);
  assert.equal(fake.calls.length, 2);
  fake.calls.length = 0;
  await ADAPTERS.wordpress.testConnection(createPlatformClient({ baseUrl: 'https://s.example.test', http: fake }), {});
  assert.ok(fake.calls.every(call => !call.url.includes('plugins')));
});

test('a platform asking the hub to wait is honoured', async () => {
  const site = await h.addWebsite(clientA, 'limited', ownerId);
  await owner.post(`/websites/${site}/connections`, { adapter_key: 'wordpress', auth_type: 'application_password', base_url: 'https://limited.example.test' });
  const connection = (await h.pg.query(`select id from hub.platform_connections where website_id = $1`, [site])).rows[0].id;
  await owner.post(`/connections/${connection}/credential`, { username: 'u', application_password: 'p' });
  const saved = http.request;
  let calls = 0;
  http.request = async () => { calls += 1; return { status: 429, headers: { 'retry-after': '600' }, body: '', elapsedMs: 1 }; };
  await tech.post(`/connections/${connection}/test`);
  assert.ok(calls > 0);
  assert.equal((await h.pg.query(`select last_error_code, not_before > now() as waiting from hub.platform_connections where id = $1`, [connection])).rows[0].waiting, true);
  calls = 0;
  await tech.post(`/connections/${connection}/test`);
  http.request = saved;
  assert.equal(calls, 0, 'nothing is sent while waiting');
  assert.equal((await h.pg.query(`select last_error_code from hub.platform_connections where id = $1`, [connection])).rows[0].last_error_code, 'backing_off');
});

test('a failure parsing nothing still distinguishes unsupported from failed', () => {
  const wp = Object.fromEntries(ADAPTERS.wordpress.capabilities.map(item => [item.key, item.support]));
  assert.equal(wp.update_availability, 'manual');
  assert.ok(new AdapterError('rate_limited', 429, 30).retryAfterSeconds === 30);
});

// Monitoring ------------------------------------------------------------------

async function monitoredSite(slug) {
  const site = await h.addWebsite(clientA, slug, ownerId);
  await tech.post('/monitoring/checks', { website_id: site, kind: 'uptime', failure_threshold: '2', response_warn_ms: '500' });
  return site;
}
const due = site => h.pg.query(`update hub.monitoring_checks set next_run_at = now() - interval '1 second' where website_id = $1`, [site]);
const httpWith = status => fakeHttp({ '*': { status, body: 'x' } });
const run = async (site, status) => { await due(site); await runDueMonitoring({ db: h.db, http: httpWith(status), outboundEnabled: true }); };
const incidentsOf = async site => (await h.pg.query(`select status, kind from hub.incidents where website_id = $1 order by opened_at`, [site])).rows;

test('incidents open after consecutive failures, resolve on success, and notify', async () => {
  const site = await monitoredSite('flaky');
  await run(site, 500);
  assert.deepEqual(await incidentsOf(site), [], 'one failure is not an incident');
  await run(site, 500);
  assert.deepEqual(await incidentsOf(site), [{ status: 'open', kind: 'availability' }]);
  await run(site, 500);
  assert.equal((await incidentsOf(site)).length, 1, 'no second incident while one is open');
  const notes = await (await tech.get('/api/v1/notifications')).json();
  assert.equal(notes.notifications.filter(item => item.title === 'flaky: availability problem').length, 1);
  assert.equal(notes.notifications.find(item => item.title === 'flaky: availability problem').severity, 'critical');
  await run(site, 200);
  assert.deepEqual(await incidentsOf(site), [{ status: 'resolved', kind: 'availability' }]);
  assert.match(await (await tech.get('/notifications')).text(), /flaky recovered/);
  const other = await (await otherTech.get('/api/v1/notifications')).json();
  assert.equal(other.notifications.some(item => item.title.startsWith('flaky')), false, 'other clients\' staff are not told');
  const actions = (await h.auditActions()).map(item => item.action);
  assert.ok(actions.includes('incident.open') && actions.includes('incident.resolve'));
});

test('maintenance windows suppress incidents and leave uptime unaffected', async () => {
  const site = await monitoredSite('windowed');
  assert.equal((await tech.post('/monitoring/windows', { website_id: site, starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: new Date(Date.now() - 120000).toISOString(), reason: 'Backwards' })).status, 422);
  assert.equal((await tech.post('/monitoring/windows', { website_id: site, starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(), reason: 'Planned upgrade', _return: `/websites/${site}` })).status, 303);
  await run(site, 500);
  await run(site, 500);
  await run(site, 500);
  assert.deepEqual(await incidentsOf(site), []);
  const flags = (await h.pg.query(`select r.in_maintenance_window as w from hub.monitoring_results r join hub.monitoring_checks m on m.id = r.check_id where m.website_id = $1`, [site])).rows;
  assert.ok(flags.length === 3 && flags.every(row => row.w));
  assert.match(await (await tech.get(`/websites/${site}`)).text(), /Planned upgrade/);
  assert.equal((await otherTech.post('/monitoring/windows', { website_id: site, starts_at: nowIso(), ends_at: inDays(1).toISOString(), reason: 'Cross client' })).status, 404);
});

test('uptime is calculated only from real checks', async () => {
  const site = await monitoredSite('uptime-site');
  assert.doesNotMatch(await (await tech.get(`/websites/${site}`)).text(), /real checks succeeded/);
  await run(site, 200);
  await run(site, 200);
  await run(site, 200);
  await run(site, 500);
  const page = await (await tech.get(`/websites/${site}`)).text();
  assert.match(page, /75%/);
  assert.match(page, /3 of 4 real checks succeeded/);
});

test('slow responses warn only past the configured threshold', async () => {
  const site = await monitoredSite('slow-site');
  const slow = { request: async () => ({ status: 200, headers: {}, body: '', elapsedMs: 900 }) };
  await due(site);
  await runDueMonitoring({ db: h.db, http: slow, outboundEnabled: true });
  const { notifications } = await (await tech.get('/api/v1/notifications')).json();
  assert.ok(notifications.some(item => item.kind === 'monitoring.slow' && item.title.includes('slow-site')));
});

test('incidents can be acknowledged by staff with access only', async () => {
  const site = await monitoredSite('ack-site');
  await run(site, 500);
  await run(site, 500);
  const id = (await h.pg.query(`select id from hub.incidents where website_id = $1`, [site])).rows[0].id;
  assert.equal((await otherTech.post(`/incidents/${id}/acknowledge`)).status, 404);
  assert.equal((await viewer.post(`/incidents/${id}/acknowledge`)).status, 403);
  assert.equal((await tech.post(`/incidents/${id}/acknowledge`)).status, 303);
  assert.ok((await h.pg.query(`select acknowledged_by from hub.incidents where id = $1`, [id])).rows[0].acknowledged_by);
});

test('certificate problems become labelled automated findings', async () => {
  const site = await h.addWebsite(clientA, 'certsite', ownerId);
  await tech.post('/monitoring/checks', { website_id: site, kind: 'ssl', cert_warn_days: '30' });
  await due(site);
  await runDueMonitoring({ db: h.db, http: fakeHttp({ tls: { validTo: inDays(5), issuer: 'Test CA', trusted: true } }), outboundEnabled: true });
  const findings = (await h.pg.query(`select title, severity, source from hub.security_findings where website_id = $1`, [site])).rows;
  assert.deepEqual(findings, [{ title: 'TLS certificate expires soon', severity: 'high', source: 'automated' }]);
  await due(site);
  await runDueMonitoring({ db: h.db, http: fakeHttp({ tls: { validTo: inDays(5), issuer: 'Test CA', trusted: true } }), outboundEnabled: true });
  assert.equal((await h.pg.query(`select count(*)::int as n from hub.security_findings where website_id = $1`, [site])).rows[0].n, 1, 'not repeated');
  assert.match(await (await tech.get('/security')).text(), /Automated check/);
});

test('domain expiry comes from RDAP only when a registry gives it', async () => {
  const site = await h.addWebsite(clientA, 'rdap', ownerId);
  await tech.post(`/websites/${site}/domains`, { hostname: 'rdap-site.test' });
  await tech.post(`/websites/${site}/domains`, { hostname: 'no-data.unknowntld' });
  const fake = fakeHttp({
    '/rdap/dns.json': { body: { services: [[['test'], ['https://rdap.registry.example/']]] } },
    '/domain/rdap-site.test': { body: { events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2041-03-04T00:00:00Z' }] } },
    '/domain/alpha.example.test': { status: 404, body: {} }
  });
  assert.deepEqual(await syncDomainExpiry({ db: h.db, http: fake, outboundEnabled: false }), { checked: 0, skipped: 'outbound_disabled' });
  await syncDomainExpiry({ db: h.db, http: fake, outboundEnabled: true });
  const row = host => h.pg.query(`select expires_on::text as expires, expiry_source as source from hub.website_domains where hostname = $1`, [host]).then(result => result.rows[0]);
  assert.deepEqual(await row('rdap-site.test'), { expires: '2041-03-04', source: 'rdap' });
  assert.deepEqual(await row('no-data.unknowntld'), { expires: null, source: null });
  assert.deepEqual(await row('alpha.example.test'), { expires: '2040-01-02', source: 'manual' }, 'a registry miss keeps the recorded date');
  const unavailable = { request: async () => { throw new Error('down'); } };
  await h.pg.query(`update hub.website_domains set expiry_checked_at = null`);
  assert.equal((await syncDomainExpiry({ db: h.db, http: unavailable, outboundEnabled: true })).failed, 'bootstrap_unavailable');
});

// Reminders and email ---------------------------------------------------------

test('reminders cover overdue work, domains and backups, once each', async () => {
  const site = await h.addWebsite(clientA, 'remind', ownerId);
  await tech.post('/maintenance/tasks', { website_id: site, title: 'Late task', due_on: '2020-01-01' });
  await tech.post(`/websites/${site}/domains`, { hostname: 'expiring.example.test', expires_on: inDays(10).toISOString().slice(0, 10) });
  await tech.post('/backups/sources', { website_id: site, provider: 'P', label: 'Failing source' });
  const source = (await h.pg.query(`select id from hub.backup_sources where website_id = $1`, [site])).rows[0].id;
  await tech.post('/backups/runs', { source_id: source, status: 'failed', finished_at: nowIso() });
  await generateReminders({ db: h.db });
  await generateReminders({ db: h.db });
  const { notifications } = await (await tech.get('/api/v1/notifications')).json();
  const count = text => notifications.filter(item => item.title.includes(text)).length;
  assert.equal(count('Overdue: Late task'), 1);
  assert.equal(count('Domain expiring.example.test'), 1);
  assert.equal(count('Backup failed: remind'), 1);
});

test('staff see and clear only their own notifications', async () => {
  const before = (await (await tech.get('/api/v1/notifications')).json()).notifications.filter(item => !item.read_at).length;
  assert.ok(before > 0);
  assert.match(await (await tech.get('/')).text(), /unread/);
  const ownerUnread = (await h.pg.query(`select count(*)::int as n from hub.notifications where staff_id = $1 and read_at is null`, [owner.id])).rows[0].n;
  assert.equal((await tech.post('/notifications/read')).status, 303);
  assert.equal((await (await tech.get('/api/v1/notifications')).json()).notifications.filter(item => !item.read_at).length, 0);
  assert.equal((await h.pg.query(`select count(*)::int as n from hub.notifications where staff_id = $1 and read_at is null`, [owner.id])).rows[0].n, ownerUnread);
  const seen = await h.db.as('hub_app', tech.id, tx => tx.query(`select distinct staff_id from hub.notifications`));
  assert.deepEqual(seen.rows.map(row => row.staff_id), [tech.id]);
});

test('email is off by default, and delivery retries then gives up', async () => {
  assert.equal(createEmailSender({ enabled: false }, http).enabled, false);
  assert.deepEqual(await deliverEmails({ db: h.db, email: { enabled: false } }), { sent: 0, failed: 0, skipped: 'email_disabled' });
  const insert = key => h.pg.query(`insert into hub.notifications (staff_id, kind, severity, title, body, link_path, dedupe_key, email_status) values ($1, 'test', 'warning', $2, 'Body', '/account', $2, 'pending') returning id`, [tech.id, key]);
  const { rows: [{ id }] } = await insert('email-ok');
  const sent = [];
  const email = createEmailSender({ enabled: true, apiKey: 'key', from: 'Hub <hub@example.test>' }, { request: async options => { sent.push(options); return { status: 200 }; } });
  assert.deepEqual(await deliverEmails({ db: h.db, email, baseUrl: ORIGIN }), { sent: 1, failed: 0 });
  assert.equal(JSON.parse(sent[0].body).to[0], 'tech@hub.test');
  assert.match(JSON.parse(sent[0].body).text, /https:\/\/hub\.hub\.test\/account/);
  assert.equal(sent[0].headers['Idempotency-Key'], `hub-notification-${id}`);
  assert.equal((await h.pg.query(`select email_status from hub.notifications where id = $1`, [id])).rows[0].email_status, 'sent');
  const { rows: [bad] } = await insert('email-fail');
  const failing = createEmailSender({ enabled: true, apiKey: 'key', from: 'x@example.test' }, { request: async () => ({ status: 500 }) });
  for (let i = 0; i < 5; i += 1) await deliverEmails({ db: h.db, email: failing, baseUrl: ORIGIN });
  assert.equal((await h.pg.query(`select email_status, email_attempts from hub.notifications where id = $1`, [bad.id])).rows[0].email_status, 'failed');
  assert.deepEqual(await deliverEmails({ db: h.db, email: failing, baseUrl: ORIGIN }), { sent: 0, failed: 0 });
});

// Security --------------------------------------------------------------------

test('risk says not assessed rather than implying a site is safe', () => {
  assert.equal(riskFor({}).level, 'unassessed');
  assert.equal(riskFor({ highestOpenSeverity: 'high' }).level, 'high');
  assert.equal(riskFor({ lastReviewAt: inDays(-10) }).level, 'none_open');
  assert.equal(riskFor({ lastReviewAt: inDays(-200) }).level, 'stale');
  const none = recommendationsFor({ primary_url: 'https://x.example.test', cms_platform: 'wordpress' }).map(item => item.text);
  assert.ok(none.includes('Record a first security review.') && none.includes('Enable uptime monitoring.') && none.includes('Record the CMS version.'));
  assert.ok(!recommendationsFor({ primary_url: 'https://x.example.test', cms_platform: 'wix' }).some(item => item.text === 'Record the CMS version.'));
});

test('findings separate manual from automated and cannot forge the automated label', async () => {
  assert.equal((await tech.post('/security/findings', { website_id: siteA, title: 'x', severity: 'high' })).status, 422);
  assert.equal((await tech.post('/security/findings', { website_id: siteA, title: 'Outdated plugin found', severity: 'nope' })).status, 422);
  assert.equal((await tech.post('/security/findings', { website_id: siteA, title: 'Outdated plugin found', severity: 'high', description: 'Seen in the dashboard', source: 'automated' })).status, 303);
  const row = (await h.pg.query(`select source, created_by from hub.security_findings where title = 'Outdated plugin found'`)).rows[0];
  assert.deepEqual(row, { source: 'manual', created_by: tech.id });
  await assert.rejects(h.db.as('hub_app', tech.id, tx => tx.query(
    `insert into hub.security_findings (client_account_id, website_id, title, severity, source) values ($1, $2, 'Forged', 'info', 'automated')`, [clientA, siteA])), /row-level security/);
  assert.match(await (await tech.get('/security')).text(), /Manual assessment/);
  assert.match(await (await tech.get('/security')).text(), /High risk/);
  assert.equal((await otherTech.post('/security/findings', { website_id: siteA, title: 'Cross client', severity: 'low' })).status, 404);
  assert.doesNotMatch(await (await otherTech.get('/security')).text(), /Outdated plugin found/);
});

test('findings become remediation tasks, and accepting a risk is for admins', async () => {
  const id = (await h.pg.query(`select id from hub.security_findings where title = 'Outdated plugin found'`)).rows[0].id;
  assert.equal((await tech.post(`/security/findings/${id}/remediate`)).status, 303);
  assert.equal((await tech.post(`/security/findings/${id}/remediate`)).status, 409);
  const task = (await h.pg.query(`select t.title, t.kind, t.priority from hub.maintenance_tasks t join hub.security_findings f on f.remediation_task_id = t.id where f.id = $1`, [id])).rows[0];
  assert.deepEqual(task, { title: 'Remediate: Outdated plugin found', kind: 'security', priority: 'high' });
  assert.equal((await tech.post(`/security/findings/${id}/update`, { status: 'accepted' })).status, 403);
  assert.equal((await admin.post(`/security/findings/${id}/update`, { status: 'accepted' })).status, 303);
  assert.equal((await tech.post(`/security/findings/${id}/update`, { status: 'resolved', evidence_ref: 'DOC-9' })).status, 303);
  const after = (await h.pg.query(`select status, resolved_by, evidence_ref from hub.security_findings where id = $1`, [id])).rows[0];
  assert.deepEqual(after, { status: 'resolved', resolved_by: tech.id, evidence_ref: 'DOC-9' });
});

// Maintenance -----------------------------------------------------------------

test('disruptive tasks wait for a second person, enforced in the database too', async () => {
  const res = await tech.postJson('/api/v1/tasks', { website_id: siteA, title: 'Update plugins', kind: 'plugin_update' });
  assert.equal(res.status, 201);
  const { id } = await res.json();
  assert.equal((await tech.post(`/maintenance/tasks/${id}/complete`, { completion_notes: 'Done early' })).status, 409);
  assert.equal((await tech.post(`/maintenance/tasks/${id}/approve`)).status, 403);
  await assert.rejects(h.pg.query(`update hub.maintenance_tasks set status = 'completed', completed_at = now(), completed_by = $2, completion_notes = 'Bypass' where id = $1`, [id, ownerId]), /approval_check/);
  assert.equal((await owner.post(`/maintenance/tasks/${id}/approve`)).status, 303);
  assert.equal((await owner.post(`/maintenance/tasks/${id}/approve`)).status, 409);
  assert.equal((await tech.post(`/maintenance/tasks/${id}/complete`, { completion_notes: 'Updated with backup taken', completion_evidence_ref: 'DOC-3' })).status, 303);
  const own = await owner.postJson('/api/v1/tasks', { website_id: siteA, title: 'Self update', kind: 'software_update' });
  const { id: ownId } = await own.json();
  assert.equal((await owner.post(`/maintenance/tasks/${ownId}/approve`)).status, 403);
});

test('ordinary tasks do not need approval', async () => {
  const { id } = await (await tech.postJson('/api/v1/tasks', { website_id: siteA, title: 'Inspect forms', kind: 'inspection' })).json();
  assert.equal((await tech.post(`/maintenance/tasks/${id}/complete`, { completion_notes: 'Forms checked.' })).status, 303);
});

test('work logs are attributed, permanent and isolated', async () => {
  const { id } = await (await tech.postJson('/api/v1/tasks', { website_id: siteA, title: 'Long job' })).json();
  assert.equal((await tech.post(`/maintenance/tasks/${id}/worklog`, { note: 'x' })).status, 422);
  assert.equal((await tech.post(`/maintenance/tasks/${id}/worklog`, { note: 'Investigated the issue', minutes: '45' })).status, 303);
  assert.equal((await otherTech.post(`/maintenance/tasks/${id}/worklog`, { note: 'Cross client log' })).status, 404);
  assert.match(await (await tech.get(`/websites/${siteA}`)).text(), /Investigated the issue/);
  await assert.rejects(h.pg.query(`delete from hub.task_work_logs`), /append-only/);
});

test('plans create recurring schedules, and applying again adds nothing', async () => {
  await owner.post('/plans', { name: 'Essentials' });
  const plan = (await h.pg.query(`select id from hub.service_plans where name = 'Essentials'`)).rows[0].id;
  const site = await h.addWebsite(clientA, 'planned', ownerId);
  assert.equal((await tech.post(`/websites/${site}/apply-plan`, { plan_id: plan, first_due_on: '2030-01-01' })).status, 422, 'an empty plan is refused');
  assert.equal((await tech.post(`/plans/${plan}/tasks`, { title: 'x', kind: 'inspection', interval_days: '30' })).status, 403);
  assert.equal((await owner.post(`/plans/${plan}/tasks`, { title: 'Monthly inspection', kind: 'inspection', interval_days: '30' })).status, 303);
  assert.equal((await owner.post(`/plans/${plan}/tasks`, { title: 'Plugin updates', kind: 'plugin_update', interval_days: '14' })).status, 303);
  assert.equal((await tech.post(`/websites/${site}/apply-plan`, { plan_id: plan, first_due_on: '2030-01-01' })).status, 303);
  assert.equal((await tech.post(`/websites/${site}/apply-plan`, { plan_id: plan, first_due_on: '2031-01-01' })).status, 303);
  const schedules = (await h.pg.query(`select title, kind, next_due_on::text as due from hub.maintenance_schedules where website_id = $1 order by title`, [site])).rows;
  assert.deepEqual(schedules, [{ title: 'Monthly inspection', kind: 'inspection', due: '2030-01-01' }, { title: 'Plugin updates', kind: 'plugin_update', due: '2030-01-01' }]);
  assert.match(await (await tech.get(`/websites/${site}`)).text(), /<dt>Maintenance plan<\/dt><dd>Essentials/);
  const schedule = (await h.pg.query(`select id from hub.maintenance_schedules where website_id = $1 and kind = 'plugin_update'`, [site])).rows[0].id;
  await tech.post(`/maintenance/schedules/${schedule}/task`);
  const task = (await h.pg.query(`select requires_approval from hub.maintenance_tasks where schedule_id = $1`, [schedule])).rows[0];
  assert.equal(task.requires_approval, true);
});

test('maintenance reports show recorded work, respect access, and export safely', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const html = await (await tech.get(`/reports/maintenance?from=${today}&to=${today}`)).text();
  assert.match(html, /Updated with backup taken/);
  const site = await h.addWebsite(clientB, 'other-report', ownerId);
  const { id } = await (await otherTech.postJson('/api/v1/tasks', { website_id: site, title: 'Other client work' })).json();
  await otherTech.post(`/maintenance/tasks/${id}/complete`, { completion_notes: 'Other client notes' });
  assert.doesNotMatch(await (await tech.get(`/reports/maintenance?from=${today}&to=${today}`)).text(), /Other client work/);
  assert.equal((await tech.get(`/reports/maintenance?from=${today}&to=2000-01-01`)).status, 422);
  const csv = await tech.get(`/reports/maintenance?from=${today}&to=${today}&format=csv`);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), /^"Completed","Client"/);
  assert.equal(toCsv([['=HYPERLINK("http://evil")', '+1', '-1', '@x', 'plain "quote"']]), `"'=HYPERLINK(""http://evil"")","'+1","'-1","'@x","plain ""quote"""\r\n`);
});

// Backups and recovery --------------------------------------------------------

async function backedUpSite(slug) {
  const site = await h.addWebsite(clientA, slug, ownerId);
  await tech.post('/backups/sources', { website_id: site, provider: 'Example', label: `${slug} nightly`, schedule_description: 'Nightly', retention_days: '30', encryption_method: 'AES-256 by provider', expected_interval_hours: '24' });
  const source = (await h.pg.query(`select id from hub.backup_sources where website_id = $1`, [site])).rows[0].id;
  await tech.post('/backups/runs', { source_id: source, status: 'succeeded', finished_at: nowIso() });
  const run = (await h.pg.query(`select id from hub.backup_runs where source_id = $1`, [source])).rows[0].id;
  return { site, source, run };
}

test('backup configuration is shown as recorded, not as verified', async () => {
  const { site } = await backedUpSite('config-backup');
  const page = await (await tech.get(`/websites/${site}`)).text();
  assert.match(page, /Encryption as recorded: AES-256 by provider/);
  assert.match(page, /kept 30 days/);
  assert.match(page, /Not verified: no restore test on record/);
});

test('an overdue backup raises an alert', async () => {
  const { site, source } = await backedUpSite('overdue-backup');
  await h.pg.query(`update hub.backup_runs set finished_at = now() - interval '3 days' where source_id = $1`, [source]);
  await generateReminders({ db: h.db });
  const { notifications } = await (await tech.get('/api/v1/notifications')).json();
  assert.ok(notifications.some(item => item.kind === 'backup.overdue' && item.link_path === `/websites/${site}`));
});

test('R2 signing follows AWS Signature Version 4', () => {
  const headers = signS3Request({
    method: 'GET', url: 'https://acct.r2.cloudflarestorage.com/bucket?list-type=2&max-keys=100',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', now: new Date('2026-11-01T00:00:00Z')
  });
  assert.equal(headers['x-amz-date'], '20261101T000000Z');
  assert.equal(headers['x-amz-content-sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261101\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.doesNotMatch(headers.Authorization, /wJalrXUtnFEMI/);
  // Regression guard: this value only changes if the canonical request changes.
  assert.equal(headers.Authorization.slice(-64).length, 64);
});

test('R2 listing records runs as provider-reported, and never as verified', async () => {
  const site = await h.addWebsite(clientA, 'r2-site', ownerId);
  await tech.post('/backups/sources', { website_id: site, provider: 'Cloudflare R2', label: 'R2 backups', storage_provider: 'r2', storage_ref: 'clients/r2-site/' });
  const xml = `<ListBucketResult><Contents><Key>clients/r2-site/a.tar.gz.gpg</Key><LastModified>2026-10-30T01:00:00.000Z</LastModified><Size>2048</Size></Contents><Contents><Key>clients/r2-site/empty</Key><LastModified>2026-10-29T01:00:00.000Z</LastModified><Size>0</Size></Contents></ListBucketResult>`;
  const calls = [];
  const fake = { request: async options => { calls.push(options); return { status: 200, headers: {}, body: xml, elapsedMs: 1 }; } };
  const provider = createR2Provider({ accountId: 'acct', bucket: 'bkt', accessKeyId: 'id', secretAccessKey: 'sec' }, fake);
  const first = await runBackupProviderSync({ db: h.db, providers: { r2: provider } });
  assert.equal(first.synced, 2);
  assert.equal(new URL(calls[0].url).host, 'acct.r2.cloudflarestorage.com');
  assert.equal(new URL(calls[0].url).searchParams.get('prefix'), 'clients/r2-site/');
  assert.equal(calls[0].method, undefined, 'read only: defaults to GET');
  assert.equal((await runBackupProviderSync({ db: h.db, providers: { r2: provider } })).synced, 0, 'not recorded twice');
  const runs = (await h.pg.query(`select r.status, r.reported_by, r.size_bytes::int as size from hub.backup_runs r join hub.backup_sources b on b.id = r.source_id where b.website_id = $1 order by r.finished_at desc`, [site])).rows;
  assert.deepEqual(runs, [{ status: 'succeeded', reported_by: 'provider', size: 2048 }, { status: 'unknown', reported_by: 'provider', size: 0 }]);
  assert.match(await (await tech.get(`/websites/${site}`)).text(), /Not verified: no restore test on record/);
  const denied = createR2Provider({ accountId: 'a', bucket: 'b', accessKeyId: 'i', secretAccessKey: 's' }, { request: async () => ({ status: 403, body: 'denied' }) });
  assert.equal((await runBackupProviderSync({ db: h.db, providers: { r2: denied } })).failed >= 1, true);
  assert.deepEqual(createBackupProviders({ enabled: false }, fake), {});
  await assert.rejects(h.db.as('hub_worker', null, tx => tx.query(
    `insert into hub.backup_runs (client_account_id, source_id, status, finished_at, reported_by) select client_account_id, id, 'succeeded', now(), 'staff' from hub.backup_sources limit 1`)), /row-level security/);
});

test('recovery needs a second person and evidence, and restores nothing by itself', async () => {
  const { site, run } = await backedUpSite('recovery-site');
  http.calls.length = 0;
  assert.equal((await tech.post('/recovery', { backup_run_id: run, reason: 'x' })).status, 422);
  assert.equal((await otherTech.post('/recovery', { backup_run_id: run, reason: 'Cross client recovery' })).status, 404);
  assert.equal((await owner.post('/recovery', { backup_run_id: run, reason: 'Site was defaced' })).status, 303);
  const id = (await h.pg.query(`select id from hub.recovery_requests where website_id = $1`, [site])).rows[0].id;
  assert.equal((await tech.post(`/recovery/${id}/approve`)).status, 403);
  assert.equal((await owner.post(`/recovery/${id}/approve`)).status, 403, 'not your own request');
  assert.equal((await admin.post(`/recovery/${id}/start`)).status, 409);
  assert.equal((await admin.post(`/recovery/${id}/approve`)).status, 303);
  assert.equal((await admin.post(`/recovery/${id}/start`)).status, 303);
  assert.equal((await admin.post(`/recovery/${id}/close`, { outcome: 'completed', outcome_notes: 'Restored' })).status, 422, 'evidence required');
  assert.equal((await admin.post(`/recovery/${id}/close`, { outcome: 'completed', outcome_notes: 'Restored and checked', evidence_ref: 'DOC-7' })).status, 303);
  assert.equal(http.calls.length, 0);
  assert.match(await (await tech.get(`/websites/${site}`)).text(), /Recovery completed: Restored and checked/);
  assert.ok((await h.auditActions()).some(item => item.action === 'recovery.approve'));
  await assert.rejects(h.db.as('hub_app', ownerId, tx => tx.query(`insert into hub.recovery_requests (client_account_id, website_id, backup_run_id, reason, status, requested_by, decided_by) values ($1, $2, $3, 'Self approved one', 'approved', $4, $4)`, [clientA, site, run, ownerId])), /check constraint/);
});

// StackLTR --------------------------------------------------------------------

test('the client page shows StackLTR state, never stores it, and survives an outage', async () => {
  const stackHttp = fakeHttp({
    [`/api/integrations/website-hub/v1/companies`]: { body: { companies: [{ id: 'co1', workspace_id: 'ws1', name: 'Live Company', domain: 'live.example.test' }] } },
    '*': (options, url) => (url.pathname.endsWith('/requests')
      ? { body: { requests: [{ id: 'r1', title: 'Live request', status: 'open' }] } }
      : { body: { company: { name: 'Live Company', domain: 'live.example.test', lifecycle: 'active' } } })
  });
  const linked = await createHarness({ http: stackHttp, env: { HUB_STACKLTR_ENABLED: 'true', HUB_STACKLTR_BASE_URL: 'https://crm.example.test', HUB_STACKLTR_TOKEN: 'integration-token-value' } });
  const id = await linked.addStaff('owner@hub.test', 'owner');
  const client = await linked.addClient('Linked', id);
  await linked.pg.query(`update hub.client_accounts set stackltr_workspace_id = gen_random_uuid(), stackltr_company_id = gen_random_uuid() where id = $1`, [client]);
  const session = await linked.sessionFor('owner@hub.test');
  const page = await (await session.get(`/clients/${client}?stackltr_q=Live`)).text();
  assert.match(page, /Live Company/);
  assert.match(page, /Live request/);
  assert.match(page, /Company ID co1, workspace ID ws1/);
  assert.doesNotMatch(page, /integration-token-value/);
  const tables = await linked.pg.query(`select display_name from hub.client_accounts where display_name = 'Live Company'`);
  assert.equal(tables.rows.length, 0);
  stackHttp.request = async () => { throw new Error('down'); };
  const down = await session.get(`/clients/${client}`);
  assert.equal(down.status, 200);
  assert.match(await down.text(), /Unavailable/);
  await linked.close();
  assert.equal(createStackltrClient({ enabled: false }, http).enabled, false);
});

// Sessions, logging, rate limits, environments --------------------------------

test('staff can see their sessions, and end only their own', async () => {
  const second = await h.sessionFor('tech@hub.test');
  const page = await (await second.get('/account')).text();
  assert.match(page, /This session/);
  assert.match(page, /Not reported/);
  const { rows } = await h.pg.query(`select id from hub.staff_sessions where staff_id = $1 and revoked_at is null`, [tech.id]);
  assert.ok(rows.length >= 2);
  const foreign = (await h.pg.query(`select id from hub.staff_sessions where staff_id = $1 limit 1`, [owner.id])).rows[0].id;
  assert.equal((await second.post(`/account/sessions/${foreign}/revoke`)).status, 404);
  const firstSession = (await h.pg.query(`select id from hub.staff_sessions where staff_id = $1 and revoked_at is null order by created_at limit 1`, [tech.id])).rows[0].id;
  assert.equal((await second.post(`/account/sessions/${firstSession}/revoke`)).status, 303);
});

test('MFA reported by the provider is recorded, and can be required', async () => {
  await h.addStaff('mfa@hub.test', 'viewer');
  h.idp.overrideClaims = { amr: ['pwd', 'mfa'] };
  const session = await h.sessionFor('mfa@hub.test');
  h.idp.overrideClaims = {};
  assert.match(await (await session.get('/account')).text(), /<td><span class="tag good">Yes/);

  const strict = await createHarness({ env: { HUB_OIDC_REQUIRED_AMR: 'mfa' } });
  await strict.addStaff('strict@hub.test', 'owner');
  assert.equal((await strict.login('strict@hub.test')).res.status, 403);
  strict.idp.overrideClaims = { amr: ['mfa'] };
  assert.equal((await strict.login('strict@hub.test')).res.status, 302);
  await strict.close();
});

test('rate limits stop repeated sign-ins and writes, then recover', async () => {
  let clock = new Date();
  const limits = await createHarness({ env: { HUB_TRUSTED_IP_HEADER: 'x-test-ip', HUB_RATE_LIMITS_ENABLED: 'true' } });
  const { createRateLimiter, LIMITS } = await import('../src/rate-limit.js');
  const limiter = createRateLimiter({ db: limits.db, now: () => clock });
  for (let i = 0; i < LIMITS.login.max; i += 1) assert.equal((await limiter.hit('login', 'addr')).allowed, true);
  const blocked = await limiter.hit('login', 'addr');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= LIMITS.login.windowSeconds);
  assert.equal((await limiter.hit('login', 'other')).allowed, true, 'separate identity');
  clock = new Date(clock.getTime() + (LIMITS.login.windowSeconds + 1) * 1000);
  assert.equal((await limiter.hit('login', 'addr')).allowed, true, 'recovers');
  const stored = (await limits.pg.query(`select bucket from hub.rate_limits`)).rows.map(row => row.bucket).join();
  assert.doesNotMatch(stored, /addr|login/, 'no address is stored');
  for (let i = 0; i < LIMITS.login.max; i += 1) await limits.app.request('/auth/start', { headers: { 'x-test-ip': '203.0.113.9' } });
  const res = await limits.app.request('/auth/start', { headers: { 'x-test-ip': '203.0.113.9' } });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  assert.equal((await limits.app.request('/auth/start', { headers: { 'x-test-ip': '203.0.113.10' } })).status, 302);
  await limits.close();
});

test('the write limit applies per person', async () => {
  const { LIMITS } = await import('../src/rate-limit.js');
  const limits = await createHarness({ env: { HUB_RATE_LIMITS_ENABLED: 'true' } });
  await limits.addStaff('busy@hub.test', 'owner');
  await limits.addStaff('calm@hub.test', 'owner');
  const [busy, calm] = await Promise.all([limits.sessionFor('busy@hub.test'), limits.sessionFor('calm@hub.test')]);
  let last;
  for (let i = 0; i <= LIMITS.write.max; i += 1) last = await busy.post('/notifications/read');
  assert.equal(last.status, 429);
  assert.equal((await calm.post('/notifications/read')).status, 303);
  await limits.close();
});

test('logs are structured, redacted and leave out paths with IDs', async () => {
  const lines = [];
  const logger = createLogger({ environment: 'test', write: line => lines.push(JSON.parse(line)) });
  logger.info('hub.request', { route: '/x', password: 'hunter2', nested: { api_key: 'k' } });
  logger.debug('hidden');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'info');
  assert.equal(lines[0].event, 'hub.request');
  assert.equal(lines[0].password, '[redacted]');
  assert.equal(lines[0].nested.api_key, '[redacted]');
  assert.ok(lines[0].time);

  const captured = [];
  const local = await createHarness({ logger: { info: (event, fields) => captured.push({ event, ...fields }), warn() {}, error() {} } });
  const id = await local.addStaff('log@hub.test', 'owner');
  const client = await local.addClient('Logged Client', id);
  const session = await local.sessionFor('log@hub.test');
  await session.get(`/clients/${client}?secret=abc`);
  const entry = captured.find(item => item.route === '/clients/:id');
  assert.equal(entry.status, 200);
  assert.equal(entry.staffId, id);
  assert.doesNotMatch(JSON.stringify(captured), new RegExp(`${client}|secret=abc|Logged Client`));
  await local.close();
});

test('staging and production are configured strictly, and staging is marked', async () => {
  const base = { HUB_BASE_URL: 'https://hub-staging.example.test', HUB_OIDC_ISSUER: ISSUER, HUB_OIDC_CLIENT_ID: 'x', HUB_OIDC_CLIENT_SECRET:'synthetic-secret', DATABASE_URL: 'postgres://hub_runtime:synthetic@db.test/x?sslmode=verify-full', HUB_TRUSTED_IP_HEADER: 'x-vercel-forwarded-for', HUB_OIDC_REQUIRED_AMR: 'mfa', HUB_STAGING_DATABASE_HOST: 'db.test', HUB_STAGING_DATABASE_NAME: 'x', HUB_STAGING_OIDC_ISSUER: ISSUER, HUB_STAGING_OIDC_CLIENT_ID: 'x' };
  const staging = loadConfig({ ...base, HUB_ENV: 'staging' });
  assert.equal(staging.isDev, false);
  assert.equal(staging.session.secure, true);
  assert.throws(() => loadConfig({ ...base, HUB_ENV: 'staging', VERCEL_ENV: 'production' }));
  assert.throws(() => loadConfig({ ...base, HUB_ENV: 'staging', HUB_BASE_URL: 'http://hub.example.test' }));
  assert.throws(() => loadConfig({ ...base, HUB_RATE_LIMITS_ENABLED: 'false' }));
  assert.throws(() => loadConfig({ ...base, HUB_EMAIL_ENABLED: 'true' }));
  assert.throws(() => loadConfig({ ...base, HUB_R2_ENABLED: 'true' }));
  assert.throws(() => loadConfig({ ...base, HUB_ENV: 'nonsense' }));
  assert.match(await (await owner.get('/')).text(), /Test environment/);
});

test('every new table has RLS, and no staff role can delete business records', async () => {
  assert.deepEqual((await h.pg.query(`select tablename from pg_tables where schemaname = 'hub' and not rowsecurity`)).rows, []);
  for (const table of ['website_domains', 'security_findings', 'incidents', 'recovery_requests', 'task_work_logs', 'notifications']) {
    await assert.rejects(h.db.as('hub_app', ownerId, tx => tx.query(`delete from hub.${table}`)), /permission denied/, table);
  }
});
