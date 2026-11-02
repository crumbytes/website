import { html, raw } from 'hono/html';
import { ADAPTERS, CMS_PLATFORMS, OTHER_PLATFORM, getAdapter } from '../adapters/index.js';
import { ERROR_MESSAGES, SUPPORT_LABELS } from '../adapters/framework.js';
import { can } from '../authz.js';
import { dateTime, empty, fields, formErrorBanner, monitoringTag, postForm, recoverabilityTag, roleLabel, shell, stateBanner, statusTag, submit, tag } from './layout.js';
import { domainsSection, findingForm, findingList, inventoryFilters, lifecycleSection, monitoringExtras, planItemsPanel, profileCard, recoverySection, riskTag, stackltrPanel, TASK_KINDS, workLogList } from './pages2.js';

const today = () => new Date().toISOString().slice(0, 10);
const nowLocal = () => new Date().toISOString().slice(0, 16);
const platformLabel = key => CMS_PLATFORMS.find(item => item.key === key)?.label ?? key;
const NOTICES = {
  saved: { kind: 'ok', title: 'Saved.' },
  credential_stored: { kind: 'ok', title: 'Credential encrypted and stored.', text: ' It cannot be displayed again.' },
  credential_revoked: { kind: 'ok', title: 'Credential revoked.', text: ' Also revoke it on the platform itself.' },
  check_done: { kind: 'ok', title: 'Connection check finished.', text: ' See the latest result below.' }
};
export const noticeFor = code => (Object.hasOwn(NOTICES, code) ? NOTICES[code] : null);

// Overview -------------------------------------------------------------------

export function overviewPage(view, data) {
  const card = (label, value, note, word, href) => html`<a class="card metric-card" href="${href}"><div class="label">${label}<span class="card-arrow" aria-hidden="true"></span></div><div class="metric ${word ? 'word' : ''}">${value}</div><div class="note">${note}</div></a>`;
  const monitored = data.active_checks === 0 ? ['Not set up', 'No monitoring checks are enabled', true]
    : data.checks_with_results === 0 ? ['Unknown', `${data.active_checks} enabled, none has run yet`, true]
    : [`${data.checks_with_results} of ${data.active_checks}`, 'Enabled checks with at least one recorded result', false];
  return shell({
    title: 'Overview', active: '/', view,
    actions: can(view.staff, 'website.write') ? html`<a class="btn" href="/websites/new">Add website</a>` : '',
    body: html`
    <section class="workspace-intro" aria-labelledby="workspace-title"><div><p class="eyebrow">Website operations</p><h2 id="workspace-title">Your website workspace</h2><p class="muted">Inventory, work and recorded checks for the clients you can access.</p></div><a class="btn quiet" href="/maintenance">View maintenance</a></section>
    <div class="cards primary-metrics">
      ${card('Customer requests',data.open_requests??0,'Open, in progress or waiting',false,'/requests')}
      ${card('Pending updates',data.pending_updates??0,'Recorded update tasks, not inferred provider updates',false,'/maintenance')}
      ${card('Managed websites', data.websites, data.websites ? 'Active and paused websites in your scope' : 'None added yet', false, '/websites')}
      ${card('Open maintenance', data.open_tasks, data.overdue_tasks ? `${data.overdue_tasks} overdue` : 'None overdue', false, '/maintenance')}
      ${card('Open findings', data.open_findings, 'Recorded findings awaiting resolution', false, '/security')}
      ${card('Open incidents', data.open_incidents, 'From monitoring checks that ran', false, '/monitoring')}
    </div>
    <div class="cards coverage-metrics">
      ${card('Monitoring', monitored[0], monitored[1], monitored[2], '/monitoring')}
      ${card('Backup sources', data.backup_sources || 'None recorded', data.backup_sources ? `${data.websites_with_backup_sources} of ${data.websites} managed websites have a source. Restore evidence is separate.` : 'Backup coverage is unknown.', !data.backup_sources, '/backups')}
      ${card('Platform connections', data.connected_platforms, `${data.total_platforms} configured; count reflects the latest check, not live availability`, false, '/integrations')}
      ${card('Security reviews', data.security_reviews || 'None recorded', data.security_reviews ? 'Reviews on record; findings and scope remain important' : 'No review has been recorded. This is not a clean result.', !data.security_reviews, '/security')}
    </div>
    <div class="split">
      <section class="panel" aria-labelledby="reminders"><div class="panel-head"><div><p class="section-kicker">Work queue</p><h2 id="reminders">Due within 7 days</h2><p class="muted">Overdue and upcoming work from your records.</p></div><a href="/maintenance">All maintenance</a></div>
        ${data.tasks_awaiting_approval ? html`<p class="approval-note">${tag(`${data.tasks_awaiting_approval} awaiting approval`, 'warn')} A second person must approve these changes.</p>` : ''}
        ${data.reminders.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-label="Upcoming work"><table><thead><tr><th>Due</th><th>Item</th><th>Website</th></tr></thead><tbody>
          ${data.reminders.map(item => html`<tr><td>${item.due_on}${item.due_on < today() ? html` ${tag('Overdue', 'bad')}` : ''}</td><td>${item.title}</td><td><a href="/websites/${item.website_id}#maintenance">${item.website_name}</a></td></tr>`)}
        </tbody></table></div>` : empty('Nothing due', 'No tasks, schedules or reviews fall due in the next 7 days.')}
      </section>
      <section class="panel" aria-labelledby="dashboard-notifications"><div class="panel-head"><div><p class="section-kicker">Your inbox</p><h2 id="dashboard-notifications">Unread notifications</h2></div><a href="/notifications">View notifications</a></div>
        ${data.notifications.length ? html`<ul class="feed">${data.notifications.map(item => html`<li><span class="feed-marker ${['critical','high','warning'].includes(item.severity) ? 'attention' : ''}" aria-hidden="true"></span><div><a href="/notifications">${item.title}</a><div class="note">${dateTime(item.created_at)}</div></div></li>`)}</ul>` : empty('You’re up to date', 'No unread notifications for your account.')}
      </section>
    </div>
    <div class="split">
      <section class="panel" aria-labelledby="recent-activity"><div class="panel-head"><div><p class="section-kicker">Recorded work</p><h2 id="recent-activity">Recent activity</h2><p class="muted">Service history for websites in your scope.</p></div></div>
        ${data.activity.length ? html`<ul class="feed">${data.activity.map(item => html`<li><span class="feed-marker" aria-hidden="true"></span><div><p>${item.summary}</p><a href="/websites/${item.website_id}#history">${item.website_name}</a><div class="note">${dateTime(item.performed_at)} · ${item.source === 'system' ? 'System record' : 'Recorded by staff'}</div></div></li>`)}</ul>` : empty('No activity recorded', 'Completed work will appear here when it is saved to service history.')}
      </section>
      <section class="panel" aria-labelledby="dashboard-incidents"><div class="panel-head"><div><p class="section-kicker">Attention needed</p><h2 id="dashboard-incidents">Monitoring incidents</h2></div><a href="/monitoring">All incidents</a></div>
        ${data.incidents.length ? html`<ul class="feed">${data.incidents.map(item => html`<li><span class="feed-marker attention" aria-hidden="true"></span><div><a href="/websites/${item.website_id}#monitoring">${item.website_name}</a><p>${item.kind === 'certificate' ? 'Certificate' : 'Availability'} incident</p><div class="note">Opened ${dateTime(item.opened_at)}</div></div></li>`)}</ul>` : empty('No open incidents recorded', 'This is not a claim of availability. Websites without checks remain unknown.')}
      </section>
    </div>
    <div class="split">
      <section class="panel" aria-labelledby="dashboard-platforms"><div class="panel-head"><div><h2 id="dashboard-platforms">Platform connection status</h2><p class="muted">Saved connection records, not live checks.</p></div><a href="/integrations">Capabilities</a></div>
        ${data.platforms.length ? html`<ul class="feed">${data.platforms.map(item => html`<li><span class="feed-marker" aria-hidden="true"></span><div><a href="/websites/${item.website_id}#connection">${item.website_name}</a><p>${platformLabel(item.adapter_key)} ${statusTag(item.status)}</p><div class="note">${item.last_checked_at ? `Last checked ${dateTime(item.last_checked_at)}` : 'No check recorded'}${item.last_error_code ? ` · ${ERROR_MESSAGES[item.last_error_code] ?? 'Check failed'}` : ''}</div></div></li>`)}</ul>` : empty('No platform connections', 'Inventory and manual maintenance work without a connected CMS.')}
      </section>
      <section class="panel" aria-labelledby="certs"><div class="panel-head"><div><h2 id="certs">Certificates expiring within 30 days</h2><p class="muted">Only from certificate checks that have actually run.</p></div></div>
        ${data.certificates.length ? html`<ul class="feed">${data.certificates.map(item => html`<li><span class="feed-marker attention" aria-hidden="true"></span><div><a href="/websites/${item.website_id}#monitoring">${item.website_name}</a><div class="note">${dateTime(item.tls_valid_to)}</div></div></li>`)}</ul>`
          : empty('None known', 'This covers only websites with a completed certificate check.')}
      </section>
    </div>`
  });
}

// Websites -------------------------------------------------------------------

export function websitesPage(view, { websites, filters, clients, hosting, notice }) {
  const search = filters.search || filters.client || filters.platform || filters.hosting || filters.monitoring || filters.lifecycle;
  return shell({
    title: 'Client websites', active: '/websites', view, notice,
    actions: can(view.staff, 'website.write') ? html`<a class="btn" href="/websites/new">Add website</a>` : '',
    body: html`<section class="panel"><div class="panel-head">${inventoryFilters({ filters, clients, hosting })}</div>
      ${websites.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Website</th><th>Client</th><th>Platform</th><th>Hosting</th><th>Plan</th><th>Open tasks</th><th>Next due</th><th>Uptime</th><th>Backup</th><th>Security</th></tr></thead><tbody>
        ${websites.map(site => html`<tr><td><a href="/websites/${site.id}">${site.display_name}</a><br><span class="note">${site.primary_url}</span>${site.lifecycle !== 'active' ? html` ${statusTag(site.lifecycle)}` : ''}</td>
          <td>${site.client_name}</td><td>${site.cms_other_name ?? platformLabel(site.cms_platform)}</td><td>${site.hosting_provider ?? html`<span class="muted">Not recorded</span>`}</td><td>${site.plan_name ?? html`<span class="muted">None</span>`}</td>
          <td>${site.open_tasks}</td><td>${site.next_maintenance_on ?? html`<span class="muted">None</span>`}</td><td>${monitoringTag(site.uptime_outcome)}${site.uptime_checked_at ? html`<br><span class="note">${dateTime(site.uptime_checked_at)}</span>` : ''}</td><td>${recoverabilityTag(site.recoverability)}</td><td>${riskTag(site.risk)}</td></tr>`)}
      </tbody></table></div>` : empty(search ? 'No matches' : 'No client websites yet', search ? 'Try different filters.' : 'Add a website to start tracking it. Only clients you can access appear here.')}
    </section>`
  });
}

export function websiteFormPage(view, { clients, plans, hosting, owners, website, state }) {
  const editing = Boolean(website);
  const values = state?.values ?? website ?? {};
  const list = [
    { name: 'client_account_id', label: 'Client', type: 'select', required: true, placeholder: 'Choose a client', options: clients.map(item => ({ value: item.id, label: item.display_name })), help: editing ? 'A website cannot move to another client.' : undefined },
    { name: 'display_name', label: 'Website name', required: true },
    { name: 'primary_url', label: 'Website address', type: 'url', required: true, help: 'Include https://' },
    { name: 'cms_platform', label: 'CMS platform', type: 'select', required: true, placeholder: 'Choose a platform', options: CMS_PLATFORMS.map(item => ({ value: item.key, label: item.label })) },
    { name: 'cms_other_name', label: 'Platform name if Other', help: 'Only used when the platform is Other CMS.' },
    { name: 'hosting_provider_id', label: 'Hosting provider', type: 'select', placeholder: 'Not recorded', options: hosting.map(item => ({ value: item.id, label: item.name })), help: 'Add providers on the Hosting providers page.' },
    { name: 'account_owner_id', label: 'Account owner', type: 'select', placeholder: 'Not assigned', options: owners.map(item => ({ value: item.id, label: item.display_name })), help: 'The CrumByte person responsible for this website.' },
    { name: 'service_plan_id', label: 'Service plan', type: 'select', placeholder: 'No plan', options: plans.map(item => ({ value: item.id, label: item.name })) },
    { name: 'lifecycle', label: 'Status', type: 'select', required: true, options: ['active', 'paused', 'offboarded'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) })) },
    { name: 'notes', label: 'Internal notes', type: 'textarea', help: 'Do not put passwords, keys or other credentials here.' }
  ];
  return shell({
    title: editing ? `Edit ${website.display_name}` : 'Add website', active: '/websites', view,
    body: html`${clients.length ? '' : html`<div class="banner warn" role="status"><strong>No clients available.</strong>A client must exist, and you must be assigned to it, before you can add a website.</div>`}
    <section class="panel"><div class="panel-body">${formErrorBanner(state)}
      ${postForm(editing ? `/websites/${website.id}` : '/websites', view, html`${fields(list, { values: { lifecycle: 'active', ...values }, errors: state?.errors })}${submit(editing ? 'Save website' : 'Add website')}`)}
    </div></section>`
  });
}

function capabilityList(platform) {
  return platform.capabilities.map(item => html`<div class="capability"><strong>${item.label}</strong>${tag(SUPPORT_LABELS[item.support], { api: 'good', api_permission: 'warn', manual: '', unsupported: 'unknown' }[item.support])}
    <div class="detail">${item.notes}${item.requires ? html` <strong>Needs:</strong> ${item.requires}.` : ''}</div></div>`);
}

function connectionSection(view, website, connections, operations, credentials, config) {
  const adapter = getAdapter(website.cms_platform);
  const canManage = can(view.staff, 'connection.write');
  const connection = connections.find(item => item.adapter_key === adapter?.key);
  if (!adapter) {
    return html`<section class="panel" id="connection"><div class="panel-head"><div><h2>Platform connection</h2><p class="muted">Other CMS has no adapter, so this site uses monitoring and manual records.</p></div></div><div class="panel-body">${capabilityList(OTHER_PLATFORM)}</div></section>`;
  }
  const authOptions = adapter.authTypes.map(item => ({ value: item.key, label: item.label }));
  const snapshot = connection?.latest_snapshot;
  const authType = connection && adapter.authTypes.find(item => item.key === connection.auth_type);
  const credential = connection ? credentials[connection.id] : null;
  return html`<section class="panel" id="connection"><div class="panel-head"><div><h2>${adapter.label} connection</h2><p class="muted">Credentials are encrypted on the server and never returned to the browser.</p></div>${statusTag(connection?.status ?? 'not_connected')}</div>
    <div class="panel-body">
    ${connection ? html`<dl class="facts"><dt>API address</dt><dd>${connection.base_url}</dd><dt>Authentication</dt><dd>${authType?.label ?? connection.auth_type}</dd>
      ${credential !== undefined && canManage ? html`<dt>Credential</dt><dd>${credential ? `Stored ${dateTime(credential.created_at)}` : 'None stored'}</dd>` : ''}
      <dt>Last checked</dt><dd>${connection.last_checked_at ? dateTime(connection.last_checked_at) : 'Never'}</dd>
      <dt>Last successful connection</dt><dd>${connection.last_successful_at ? dateTime(connection.last_successful_at) : 'No successful check recorded'}</dd>
      ${connection.last_error_code ? html`<dt>Last problem</dt><dd>${ERROR_MESSAGES[connection.last_error_code] ?? connection.last_error_code}</dd>` : ''}</dl>
      ${snapshot ? snapshotView(snapshot) : ''}` : html`<p class="muted">Not connected. Connecting is optional, and monitoring and manual records work without it.</p>`}
    </div>
    ${connection && can(view.staff, 'connection.check') ? html`<details><summary>Run a connection check</summary>
      ${config.outboundEnabled ? '' : html`<p class="muted">Outbound connections are turned off in this environment, so the check will report that and contact nothing.</p>`}
      ${postForm(`/connections/${connection.id}/test`, view, submit('Test connection only', 'btn quiet'))}
      ${postForm(`/connections/${connection.id}/check`, view, submit('Run full check', 'btn quiet'))}</details>` : ''}
    ${!connection && canManage ? html`<details><summary>Connect ${adapter.label}</summary>
      ${postForm(`/websites/${website.id}/connections`, view, html`<input type="hidden" name="adapter_key" value="${adapter.key}">
        ${fields([
          ...(adapter.fixedBaseUrl ? [] : [{ name: 'base_url', label: 'Site address', type: 'url', required: true, help: adapter.baseUrlHint, value: website.primary_url.startsWith('https://') ? website.primary_url : '' }]),
          ...(adapter.settingsFields ?? []),
          { name: 'auth_type', label: 'Authentication', type: 'select', required: true, options: authOptions, help: adapter.authTypes.map(item => item.guidance).join(' ') }
        ])}${submit('Create connection')}`)}</details>` : ''}
    ${connection && canManage ? html`<details><summary>${credential ? 'Replace or revoke credential' : 'Store credential'}</summary>
      ${config.credentialStorageEnabled ? html`<p class="muted">${authType?.guidance}</p>
        ${postForm(`/connections/${connection.id}/credential`, view, html`${fields(authType.fields.map(field => ({ name: field.name, label: field.label, type: 'password', required: true })))}${submit('Encrypt and store')}`)}
        ${credential ? postForm(`/connections/${connection.id}/rewrap`,view,submit('Rewrap encryption key','btn quiet')) : ''}
        ${credential ? postForm(`/connections/${connection.id}/credential/revoke`, view, submit('Revoke stored credential', 'btn danger')) : ''}`
        : html`<p class="muted">Credential storage is turned off in this environment. No credential can be entered or stored here.</p>`}</details>` : ''}
    ${connection && adapter.operations.length ? operationsSection(view, connection, adapter, operations.filter(item => item.connection_id === connection.id), config) : ''}
    <details><summary>What this platform supports</summary><div>${capabilityList(adapter)}</div>
      <p class="note">Built from official documentation and tested against simulated responses, not a live site. <a href="${adapter.docsUrl}" rel="noreferrer noopener">Platform API documentation</a>.</p></details>
  </section>`;
}

function snapshotView(snapshot) {
  const sections = Object.entries(snapshot.data ?? {});
  return html`<h3 class="note">Latest check ${dateTime(snapshot.captured_at)}: ${statusTag({ ok: 'connected', partial: 'partial', failed: 'failed' }[snapshot.outcome])}</h3>
    ${snapshot.error_code && !sections.length ? html`<p class="muted">${ERROR_MESSAGES[snapshot.error_code] ?? snapshot.error_code}</p>` : ''}
    ${sections.length ? html`<ul class="plain">${sections.map(([key, item]) => html`<li><strong>${key.replaceAll('_', ' ')}:</strong>
      ${item.status === 'ok' ? html`${tag('Reported', 'good')} ${sectionSummary(item.data)}`
        : item.status === 'permission_required' ? tag('Needs added permission', 'warn')
        : html`${tag('Not available', 'bad')} <span class="note">${ERROR_MESSAGES[item.code] ?? ''}</span>`}</li>`)}</ul>` : ''}`;
}

function sectionSummary(data) {
  if (Array.isArray(data)) return html`<span class="note">${data.length} item${data.length === 1 ? '' : 's'}</span>`;
  if (data?.core_version !== undefined) return html`<span class="note">Core version ${data.core_version ?? 'not reported'}, ${data.extensions?.length ?? 0} extensions</span>`;
  return '';
}

function operationsSection(view, connection, adapter, operations, config) {
  const canRequest = can(view.staff, 'operation.request');
  const canDecide = can(view.staff, 'operation.decide');
  const paramFields = { 'plugin.set_status': [
    { name: 'plugin', label: 'Plugin identifier', required: true, help: 'For example akismet/akismet' },
    { name: 'status', label: 'New state', type: 'select', required: true, options: [{ value: 'inactive', label: 'Inactive' }, { value: 'active', label: 'Active' }] }
  ], 'url_redirect.create': [
    { name: 'path', label: 'From path', required: true, help: 'For example /old-page' },
    { name: 'target', label: 'To', required: true, help: 'A path or an https address' }
  ] };
  return html`<details><summary>Approved maintenance operations</summary>
    <p class="muted">A second person must approve each change before it can run.${config.operationsEnabled ? '' : ' Live operations are turned off in this environment, so approved requests cannot run here.'}</p>
    ${operations.length ? html`<ul class="plain">${operations.map(item => html`<li>${statusTag(item.status)} <strong>${item.operation_key}</strong> <span class="note">${JSON.stringify(item.params)}, requested by ${item.requested_by_name}: ${item.reason}${item.result_code ? `. ${ERROR_MESSAGES[item.result_code] ?? item.result_code}` : ''}</span>
      ${item.status === 'requested' && canDecide ? html`<div>${item.requested_by === view.staff.id ? '' : postForm(`/operations/${item.id}/approve`, view, html`<button class="btn quiet" type="submit">Approve</button>`, 'inline')} ${postForm(`/operations/${item.id}/reject`, view, html`<button class="btn quiet" type="submit">Reject</button>`, 'inline')}</div>` : ''}
      ${item.status === 'approved' && canDecide && config.operationsEnabled ? postForm(`/operations/${item.id}/execute`, view, html`<button class="btn" type="submit">Run now</button>`, 'inline') : ''}</li>`)}</ul>` : ''}
    ${canRequest ? adapter.operations.map(operation => html`<h3>${operation.label}</h3>${postForm('/operations', view, html`
      <input type="hidden" name="connection_id" value="${connection.id}"><input type="hidden" name="operation_key" value="${operation.key}">
      ${fields([...(paramFields[operation.key] ?? []), { name: 'reason', label: 'Reason', required: true }])}${submit('Request approval', 'btn quiet')}`)}`) : ''}
  </details>`;
}

export function websiteDetailPage(view, data) {
  const { website, tasks, schedules, checks, reviews, sources, runs, history, connections, operations, credentials, assignable, config, state, notice, domains, plans, incidents, windows, uptime, findings, recovery, workLogs, restores = [] } = data;
  const writeMaintenance = can(view.staff, 'maintenance.write');
  const assigneeOptions = assignable.map(item => ({ value: item.id, label: item.display_name }));
  const existingKinds = new Set(checks.map(item => item.kind));
  return shell({
    title: website.display_name, active: '/websites', view, notice,
    actions: can(view.staff, 'website.write') ? html`<a class="btn quiet" href="/websites/${website.id}/edit">Edit</a>` : '',
    body: html`${stateBanner(state)}
    <nav class="subnav" aria-label="On this page">${[['domains', 'Domains'], ['maintenance', 'Maintenance'], ['monitoring', 'Monitoring'], ['connection', 'Connection'], ['security', 'Security'], ['backups', 'Backups'], ['history', 'History'], ...(can(view.staff, 'website.write') ? [['administration', 'Administration']] : [])].map(([id, label]) => html`<a href="#${id}">${label}</a>`)}</nav>
    ${profileCard(website)}
    ${domainsSection(view, website, domains)}

    <section class="panel" id="maintenance"><div class="panel-head"><div><h2>Maintenance</h2><p class="muted">Open work and recurring schedules for this website.</p></div></div>
      ${tasks.length ? taskTable(view, tasks, assigneeOptions, false) : empty('No open tasks', 'Nothing is assigned on this website right now.')}
      ${workLogList(workLogs)}
      ${schedules.length ? html`<div class="panel-body"><h3>Schedules</h3><ul class="plain">${schedules.map(item => scheduleRow(view, item, assigneeOptions, true))}</ul></div>` : ''}
      ${writeMaintenance ? html`<details><summary>Add a task</summary>${postForm('/maintenance/tasks', view, html`<input type="hidden" name="website_id" value="${website.id}"><input type="hidden" name="_return" value="/websites/${website.id}">${taskFields(assigneeOptions)}${submit('Add task')}`)}</details>
      <details><summary>Add a schedule</summary>${postForm('/maintenance/schedules', view, html`<input type="hidden" name="website_id" value="${website.id}"><input type="hidden" name="_return" value="/websites/${website.id}">${scheduleFields(assigneeOptions)}${submit('Add schedule')}`)}</details>` : ''}
    </section>

    <section class="panel" id="monitoring"><div class="panel-head"><div><h2>Monitoring</h2><p class="muted">Results come only from checks the hub actually ran.</p></div></div>
      ${checks.length ? checkTable(checks, false) : empty('Monitoring is not set up', 'No check has been enabled, so this site\'s status is unknown.')}
      ${monitoringExtras(view, website, { incidents, windows, uptime })}
      ${can(view.staff, 'monitoring.write') && existingKinds.size < 2 ? html`<details><summary>Enable a check</summary>${postForm('/monitoring/checks', view, html`<input type="hidden" name="website_id" value="${website.id}"><input type="hidden" name="_return" value="/websites/${website.id}">
        ${fields([
          { name: 'kind', label: 'Check', type: 'select', required: true, options: [{ value: 'uptime', label: 'Uptime' }, { value: 'dns', label: 'DNS addresses' }, { value: 'ssl', label: 'SSL certificate expiry' }].filter(item => !existingKinds.has(item.value)) },
          { name: 'interval_minutes', label: 'Run every (minutes)', type: 'number', required: true, value: 60 },
          { name: 'failure_threshold', label: 'Open an incident after this many failures in a row', type: 'number', required: true, value: 2 },
          { name: 'response_warn_ms', label: 'Warn when slower than (ms)', type: 'number' },
          { name: 'cert_warn_days', label: 'Warn this many days before a certificate expires', type: 'number', required: true, value: 30 }
        ])}${config.outboundEnabled ? '' : html`<p class="muted">Outbound connections are turned off in this environment, so checks stay unknown until they are enabled.</p>`}${submit('Enable check')}`)}</details>` : ''}
    </section>

    ${connectionSection(view, website, connections, operations, credentials, config)}

    <section class="panel" id="security"><div class="panel-head"><div><h2>Security</h2><p class="muted">Automated checks and manual assessments are labelled. No vulnerability scanner is connected.</p></div></div>
      ${findings.length ? findingList(view, findings, false) : ''}
      ${reviews.length ? reviewTable(reviews, false) : empty('No security review recorded', 'No review on record does not mean the site is secure.')}
      ${findingForm(view, website)}
      ${can(view.staff, 'security.write') ? html`<details><summary>Record a review</summary>${postForm('/security/reviews', view, html`<input type="hidden" name="website_id" value="${website.id}"><input type="hidden" name="_return" value="/websites/${website.id}">${reviewFields()}${submit('Record review')}`)}</details>` : ''}
    </section>

    <section class="panel" id="backups"><div class="panel-head"><div><h2>Backups and restore evidence</h2><p class="muted">A successful backup does not prove it can be restored. Only a recorded restore test can.</p></div></div>
      ${sources.length ? sourceTable(sources, false) : empty('No backup source recorded', 'Backup coverage for this website is unknown.')}
      ${runs.length ? html`<div class="panel-body"><h3>Recent backup runs</h3><ul class="plain">${runs.map(run => html`<li>${statusTag(run.status)} ${run.source_label}, ${dateTime(run.finished_at)} <span class="note">reported by ${run.reported_by}${run.artifact_ref ? `, ${run.artifact_ref}` : ''}</span></li>`)}</ul></div>` : ''}
      ${can(view.staff, 'backup.write') ? html`
      <details><summary>Add a backup source</summary>${postForm('/backups/sources', view, html`<input type="hidden" name="website_id" value="${website.id}"><input type="hidden" name="_return" value="/websites/${website.id}">
        ${fields([{ name: 'provider', label: 'Provider', required: true }, { name: 'label', label: 'Description', required: true }, { name: 'schedule_description', label: 'Schedule', help: 'For example nightly at 02:00 UTC. The provider runs it, not the hub.' }, { name: 'expected_interval_hours', label: 'Expected every (hours)', type: 'number', help: 'An alert is raised when a backup is overdue.' }, { name: 'retention_days', label: 'Retention (days)', type: 'number' }, { name: 'storage_provider', label: 'Status comes from', type: 'select', required: true, options: [{ value: 'manual', label: 'Entered by staff' }, { value: 'r2', label: 'Cloudflare R2 listing' }] }, { name: 'storage_ref', label: 'Storage path', help: 'For R2, the object prefix. No keys or passwords.' }, { name: 'encryption_method', label: 'Encryption in use', help: 'What the provider or your process does. The hub cannot verify this.' }])}${submit('Add source')}`)}</details>
      ${sources.length ? html`<details><summary>Record a backup run</summary>${postForm('/backups/runs', view, html`<input type="hidden" name="_return" value="/websites/${website.id}">
        ${fields([{ name: 'source_id', label: 'Source', type: 'select', required: true, options: sources.map(item => ({ value: item.id, label: item.label })) },
          { name: 'status', label: 'Result', type: 'select', required: true, options: [{ value: 'succeeded', label: 'Succeeded' }, { value: 'failed', label: 'Failed' }, { value: 'unknown', label: 'Unknown' }] },
          { name: 'finished_at', label: 'Finished (UTC)', type: 'datetime-local', required: true, value: nowLocal() }, { name: 'artifact_ref', label: 'Provider reference', help: 'A reference, not a download link or a credential.' }])}${submit('Record run')}`)}</details>` : ''}
      ${runs.length ? html`<details><summary>Record a restore test</summary><p class="muted">Follow docs/restore-verification.md. Record what was actually restored and checked.</p>${postForm('/backups/restores', view, html`<input type="hidden" name="_return" value="/websites/${website.id}">
        ${fields([{ name: 'backup_run_id', label: 'Backup run', type: 'select', required: true, options: runs.map(run => ({ value: run.id, label: `${run.source_label}, ${dateTime(run.finished_at)} (${run.status})` })) },
          { name: 'target_environment', label: 'Restored to', type: 'select', required: true, options: [{ value: 'isolated', label: 'Isolated environment' }, { value: 'staging', label: 'Staging' }, { value: 'production', label: 'Production' }] },
          { name: 'outcome', label: 'Outcome', type: 'select', required: true, options: [{ value: 'failed', label: 'Failed' }, { value: 'partial', label: 'Partial' }, { value: 'passed', label: 'Passed' }] },
          { name: 'checks_performed', label: 'Checks performed', type: 'textarea', required: true },
          { name: 'evidence_ref', label: 'Evidence reference', help: 'Required for a passed test: a ticket, document or file reference.' },
          { name: 'performed_at', label: 'Performed (UTC)', type: 'datetime-local', required: true, value: nowLocal() }])}${submit('Record restore test')}`)}</details>` : ''}` : ''}
      ${restoreHistory(restores)}
      ${recoverySection(view, website, recovery, runs)}
    </section>

    <section class="panel" id="history"><div class="panel-head"><div><h2>Service history</h2><p class="muted">Permanent record of work on this website. Entries cannot be edited.</p></div></div>
      ${history.length ? html`<div class="panel-body"><ul class="plain">${history.map(item => html`<li>${dateTime(item.performed_at)} ${tag(item.kind)} ${item.summary} <span class="note">${item.performed_by_name ?? 'System'}${item.source === 'system' ? ' (automatic)' : ''}</span>${writeMaintenance ? postForm(`/history/${item.id}/share`,view,submit('Share this entry with customers','btn quiet'),'inline'):''}${writeMaintenance ? postForm(`/history/${item.id}/unshare`,view,submit('Remove from customer portal','btn quiet'),'inline'):''}</li>`)}</ul></div>` : empty('No history yet', 'Completed work on this website will appear here.')}
      ${writeMaintenance ? html`<details><summary>Record completed work</summary>${postForm('/history', view, html`<input type="hidden" name="website_id" value="${website.id}"><input type="hidden" name="_return" value="/websites/${website.id}">
        ${fields([{ name: 'kind', label: 'Type', type: 'select', required: true, options: ['maintenance', 'security', 'backup', 'restore', 'connection', 'other'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) })) },
          { name: 'summary', label: 'What was done', type: 'textarea', required: true }, { name: 'performed_at', label: 'Performed (UTC)', type: 'datetime-local', required: true, value: nowLocal() }])}${submit('Add to history')}`)}</details>` : ''}
    </section>
    ${lifecycleSection(view, website, plans)}`
  });
}

// Shared fragments ------------------------------------------------------------

const taskFields = assignees => fields([
  { name: 'title', label: 'Task', required: true },
  { name: 'kind', label: 'Type', type: 'select', required: true, value: 'other', options: TASK_KINDS, help: 'Software and plugin updates need a second person to approve them first.' },
  { name: 'details', label: 'Details', type: 'textarea' },
  { name: 'priority', label: 'Priority', type: 'select', required: true, value: 'normal', options: ['low', 'normal', 'high', 'urgent'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) })) },
  { name: 'assignee_id', label: 'Assign to', type: 'select', placeholder: 'Unassigned', options: assignees },
  { name: 'due_on', label: 'Due', type: 'date' },
  { name: 'stackltr_request_id', label: 'StackLTR service request ID', help: 'Links this task to the request in StackLTR.' }
]);

const scheduleFields = (assignees, values = {}) => fields([
  { name: 'title', label: 'Recurring work', required: true },
  { name: 'kind', label: 'Type', type: 'select', required: true, value: 'inspection', options: TASK_KINDS },
  { name: 'interval_days', label: 'Repeat every (days)', type: 'number', required: true, value: 30 },
  { name: 'next_due_on', label: 'Next due', type: 'date', required: true },
  { name: 'default_assignee_id', label: 'Default assignee', type: 'select', placeholder: 'Unassigned', options: assignees }
], { values });

const reviewFields = () => fields([
  { name: 'scope', label: 'What was reviewed', required: true },
  { name: 'outcome', label: 'Outcome', type: 'select', required: true, value: 'incomplete', options: [{ value: 'incomplete', label: 'Incomplete' }, { value: 'findings', label: 'Findings' }, { value: 'no_findings', label: 'No findings in this scope' }] },
  { name: 'summary', label: 'Summary', type: 'textarea', required: true },
  { name: 'evidence_ref', label: 'Evidence reference' },
  { name: 'reviewed_at', label: 'Reviewed (UTC)', type: 'datetime-local', required: true, value: nowLocal() },
  { name: 'next_due_on', label: 'Next review due', type: 'date' }
]);

function taskTable(view, tasks, assignees, showWebsite) {
  const write = can(view.staff, 'maintenance.write');
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Task</th>${showWebsite ? html`<th>Website</th>` : ''}<th>Priority</th><th>Status</th><th>Assigned to</th><th>Due</th>${write ? html`<th>Update</th>` : ''}</tr></thead><tbody>
    ${tasks.map(task => html`<tr><td><strong>${task.title}</strong> <span class="note">${task.kind.replaceAll('_', ' ')}</span>${task.requires_approval ? html` ${task.approved_at ? tag('Approved', 'good') : tag('Needs approval', 'warn')}` : ''}${task.details ? html`<br><span class="note">${task.details}</span>` : ''}${task.stackltr_request_id ? html`<br><span class="note">StackLTR request ${task.stackltr_request_id}</span>` : ''}${task.completion_notes ? html`<br><span class="note">Completed: ${task.completion_notes}</span>` : ''}</td>
      ${showWebsite ? html`<td><a href="/websites/${task.website_id}">${task.website_name}</a><br><span class="note">${task.client_name}</span></td>` : ''}
      <td>${statusTag(task.priority)}</td><td>${statusTag(task.status)}</td><td>${task.assignee_name ?? html`<span class="muted">Unassigned</span>`}</td>
      <td>${task.due_on ?? html`<span class="muted">None</span>`}${task.due_on && task.due_on < today() && !['completed', 'cancelled'].includes(task.status) ? html` ${tag('Overdue', 'bad')}` : ''}</td>
      ${write ? html`<td><details><summary>Rollback plan or outcome</summary>${postForm(`/tasks/${task.id}/rollback`,view,html`${fields([{name:'plan',label:'Rollback plan / work performed',type:'textarea',required:true},{name:'status',label:'Rollback status',type:'select',required:true,options:[{value:'planned',label:'Planned'},{value:'completed',label:'Completed'},{value:'failed',label:'Failed'}]},{name:'evidence_ref',label:'Evidence (required after execution)'}])}${submit('Record rollback')}`)}</details>${['completed', 'cancelled'].includes(task.status) ? '' : html`
        ${postForm(`/maintenance/tasks/${task.id}/update`, view, html`<input type="hidden" name="_return" value="${showWebsite ? '/maintenance' : `/websites/${task.website_id}`}">
          <select name="status" aria-label="Status for ${task.title}">${['open', 'in_progress', 'blocked', 'cancelled'].map(value => html`<option value="${value}" ${value === task.status ? raw('selected') : ''}>${value.replaceAll('_', ' ')}</option>`)}</select>
          <select name="assignee_id" aria-label="Assignee for ${task.title}"><option value="">Unassigned</option>${assignees.map(item => html`<option value="${item.value}" ${item.value === task.assignee_id ? raw('selected') : ''}>${item.label}</option>`)}</select>
          <button class="btn quiet" type="submit">Update</button>`, 'inline')}
        ${task.requires_approval && !task.approved_at && can(view.staff, 'operation.decide') && task.created_by !== view.staff.id ? postForm(`/maintenance/tasks/${task.id}/approve`, view, html`<input type="hidden" name="_return" value="${showWebsite ? '/maintenance' : `/websites/${task.website_id}`}"><button class="btn quiet" type="submit">Approve change</button>`, 'inline') : ''}

        <details><summary>Log work</summary>${postForm(`/maintenance/tasks/${task.id}/worklog`, view, html`<input type="hidden" name="_return" value="${showWebsite ? '/maintenance' : `/websites/${task.website_id}`}">
          ${fields([{ name: 'note', label: 'What you did', type: 'textarea', required: true }, { name: 'minutes', label: 'Minutes', type: 'number' }])}${submit('Add to work log', 'btn quiet')}`)}</details>
        ${task.requires_approval && !task.approved_at ? '' : html`<details><summary>Complete</summary>${postForm(`/maintenance/tasks/${task.id}/complete`, view, html`<input type="hidden" name="_return" value="${showWebsite ? '/maintenance' : `/websites/${task.website_id}`}">
          ${fields([{ name: 'completion_notes', label: 'What was done', type: 'textarea', required: true }, { name: 'completion_evidence_ref', label: 'Evidence reference' }])}${submit('Mark completed')}`)}</details>`}`}</td>` : ''}
    </tr>`)}
  </tbody></table></div>`;
}

const scheduleRow = (view, item, assignees = [], onWebsite = false) => html`<li><strong>${item.title}</strong> ${item.active ? tag('Active','good') : tag('Paused','unknown')} every ${item.interval_days} days, next due ${item.next_due_on}${item.active && item.next_due_on < today() ? html` ${tag('Overdue', 'bad')}` : ''}
  <span class="note">${item.assignee_name ? `Default: ${item.assignee_name}` : 'No default assignee'}</span>
  ${can(view.staff, 'maintenance.write') ? html`${item.active ? postForm(`/maintenance/schedules/${item.id}/task`, view, html`<button class="btn quiet" type="submit">Create task</button>`, 'inline') : ''}
  <details><summary>Edit schedule</summary>${postForm(`/maintenance/schedules/${item.id}/update`,view,html`<input type="hidden" name="_return" value="${onWebsite ? `/websites/${item.website_id}` : '/maintenance'}">${scheduleFields(assignees,item)}
    ${fields([{name:'active',label:'Schedule status',type:'select',required:true,value:item.active ? 'on' : 'off',options:[{value:'on',label:'Active'},{value:'off',label:'Paused'}]}])}${submit('Save schedule')}`)}</details>` : ''}</li>`;

export function checkTable(checks, showWebsite) {
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Check</th>${showWebsite ? html`<th>Website</th>` : ''}<th>Latest result</th><th>Details</th><th>Checked</th></tr></thead><tbody>
    ${checks.map(check => html`<tr><td>${check.kind === 'ssl' ? 'SSL certificate' : check.kind==='dns'?'DNS addresses':'Uptime'}<br><span class="note">every ${check.interval_minutes} min</span></td>
      ${showWebsite ? html`<td><a href="/websites/${check.website_id}">${check.website_name}</a><br><span class="note">${check.client_name}</span></td>` : ''}
      <td>${monitoringTag(check.outcome)}</td>
      <td>${check.dns_addresses ? check.dns_addresses.join(', ') : ''}${check.dns_changed ? ' (changed)' : ''}${check.http_status ? `HTTP ${check.http_status}` : ''}${check.response_ms != null ? `, ${check.response_ms} ms` : ''}${check.tls_valid_to ? `Expires ${dateTime(check.tls_valid_to)}` : ''}${check.tls_issuer ? `, ${check.tls_issuer}` : ''}${check.error_code ? ` ${ERROR_MESSAGES[check.error_code] ?? check.error_code}` : ''}</td>
      <td>${check.checked_at ? dateTime(check.checked_at) : html`<span class="muted">Never</span>`}</td></tr>`)}
  </tbody></table></div>`;
}

function reviewTable(reviews, showWebsite) {
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Reviewed</th>${showWebsite ? html`<th>Website</th>` : ''}<th>Scope</th><th>Outcome</th><th>Summary</th><th>Reviewer</th><th>Next due</th></tr></thead><tbody>
    ${reviews.map(review => html`<tr><td>${dateTime(review.reviewed_at)}</td>${showWebsite ? html`<td><a href="/websites/${review.website_id}">${review.website_name}</a></td>` : ''}<td>${review.scope}</td><td>${statusTag(review.outcome)}</td><td>${review.summary}${review.evidence_ref ? html`<br><span class="note">Evidence: ${review.evidence_ref}</span>` : ''}</td><td>${review.reviewer_name}</td><td>${review.next_due_on ?? ''}</td></tr>`)}
  </tbody></table></div>`;
}

function sourceTable(sources, showWebsite) {
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Source</th>${showWebsite ? html`<th>Website</th>` : ''}<th>Latest backup</th><th>Can it be restored?</th></tr></thead><tbody>
    ${sources.map(source => html`<tr><td>${source.label}<br><span class="note">${source.provider}${source.schedule_description ? `, ${source.schedule_description}` : ''}${source.retention_days ? `, kept ${source.retention_days} days` : ''}${source.encryption_method ? `. Encryption as recorded: ${source.encryption_method}` : ''}</span></td>${showWebsite ? html`<td><a href="/websites/${source.website_id}">${source.website_name}</a><br><span class="note">${source.client_name}</span></td>` : ''}
      <td>${source.latest_run_status ? html`${statusTag(source.latest_run_status)}<br><span class="note">${dateTime(source.latest_run_finished_at)}</span>` : html`<span class="muted">None recorded</span>`}</td>
      <td>${recoverabilityTag(source.recoverability)}${source.latest_passed_at ? html`<br><span class="note">Last passed ${dateTime(source.latest_passed_at)}</span>` : ''}</td></tr>`)}
  </tbody></table></div>`;
}

function restoreHistory(restores, showWebsite = false) {
  return html`<section class="panel-body" aria-label="Restore verification history"><h3>Restore verification history</h3>
    ${restores.length ? html`<ul class="plain">${restores.map(item => html`<li>${statusTag(item.outcome)} <strong>${item.source_label}</strong>
      ${showWebsite ? html`<a href="/websites/${item.website_id}#backups">${item.website_name}</a>` : ''}
      <div class="note">${dateTime(item.performed_at)} · ${item.target_environment} · Recorded by ${item.performed_by_name}</div>
      <p>${item.checks_performed}</p>${item.evidence_ref ? html`<p class="note">Evidence: ${item.evidence_ref}</p>` : ''}</li>`)}</ul>`
      : html`<p class="muted">No restore tests recorded. Backup success alone does not verify recovery.</p>`}</section>`;
}

// Clients --------------------------------------------------------------------

export function clientsPage(view, { clients, plans, planTasks, notice, state }) {
  const write = can(view.staff, 'client.write');
  return shell({
    title: 'Clients', active: '/clients', view, notice,
    actions: write ? html`<a class="btn" href="/clients/new">Add client</a>` : '',
    body: html`${stateBanner(state)}<div class="banner"><strong>Customer details stay in StackLTR.</strong>The hub only keeps the name and a link. Sales, billing and CRM tickets stay in StackLTR. The portal keeps only scoped operational contacts and local service requests.</div>
    <section class="panel"><form method="get" action="/clients" class="filters"><label>Search clients<input name="q" type="search" maxlength="160"></label><label>Client status<select name="status"><option value="all">All</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label><button class="btn" type="submit">Filter clients</button></form>${clients.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Client</th><th>Websites</th><th>Status</th><th>StackLTR</th></tr></thead><tbody>
      ${clients.map(client => html`<tr><td><a href="/clients/${client.id}">${client.display_name}</a></td><td>${client.website_count}</td><td>${statusTag(client.status)}</td><td>${client.stackltr_company_id ? tag('Linked', 'good') : tag('Not linked', 'unknown')}</td></tr>`)}
    </tbody></table></div>` : empty('No clients yet', write ? 'Add a client to begin. No sample records are created.' : 'You are not assigned to any clients yet. Ask an admin for access.')}</section>
    <section class="panel"><div class="panel-head"><div><h2>Maintenance plans</h2><p class="muted">Recurring work for a website, with a StackLTR billing reference. Pricing and invoices stay in StackLTR.</p></div></div>
      ${plans.length ? planItemsPanel(view, plans, planTasks) : empty('No maintenance plans yet', 'Plans are optional. No sample plans are created.')}
      ${can(view.staff, 'plan.write') ? html`<details><summary>Add a maintenance plan</summary>${postForm('/plans', view, html`${fields([{ name: 'name', label: 'Plan name', required: true }, { name: 'description', label: 'Description', type: 'textarea' }, { name: 'maintenance_interval_days', label: 'Maintenance every (days)', type: 'number' }, { name: 'stackltr_billing_ref', label: 'StackLTR billing reference' }])}${submit('Add plan')}`)}</details>` : ''}
    </section>`
  });
}

export function clientFormPage(view, { client, websites, state, notice, stackltr }) {
  const values = state?.values ?? client ?? {};
  const write = can(view.staff, 'client.write');
  const list = [
    { name: 'display_name', label: 'Client name', required: true },
    { name: 'status', label: 'Status', type: 'select', required: true, options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
    { name: 'stackltr_workspace_id', label: 'StackLTR workspace ID', help: 'From the StackLTR record. Leave empty until it is linked.' },
    { name: 'stackltr_company_id', label: 'StackLTR company ID' },
    { name: 'stackltr_billing_ref', label: 'StackLTR billing reference', help: 'A reference only. Billing stays in StackLTR.' }
  ];
  return shell({
    title: client ? client.display_name : 'Add client', active: '/clients', view, notice,
    actions: client ? html`<a class="btn quiet" href="/reports/customer/${client.id}">Customer report</a><a class="btn quiet" href="/portal?client=${client.id}">Portal preview / contacts</a>` : '',
    body: html`${client && stackltr ? stackltrPanel(view, { ...stackltr, client }) : ''}${client ? html`<section class="panel"><div class="panel-head"><h2>Websites</h2></div>${websites.length ? html`<div class="panel-body"><ul class="plain">${websites.map(site => html`<li><a href="/websites/${site.id}">${site.display_name}</a> <span class="note">${site.primary_url}</span></li>`)}</ul></div>` : empty('No websites', 'This client has no managed websites.')}</section>` : ''}
    ${write ? html`<section class="panel"><div class="panel-body">${formErrorBanner(state)}${postForm(client ? `/clients/${client.id}` : '/clients', view, html`${fields(list, { values: { status: 'active', ...values }, errors: state?.errors })}${submit(client ? 'Save client' : 'Add client')}`)}</div></section>`
      : html`<section class="panel"><div class="panel-body"><dl class="facts"><dt>Status</dt><dd>${statusTag(client.status)}</dd><dt>StackLTR</dt><dd>${client.stackltr_company_id ?? 'Not linked'}</dd></dl></div></section>`}`
  });
}

// Section pages --------------------------------------------------------------

export function maintenancePage(view, { tasks, schedules, websites, assignable, scope, state, notice }) {
  const assignees = assignable.map(item => ({ value: item.id, label: item.display_name }));
  return shell({
    title: 'Maintenance', active: '/maintenance', view, notice,
    actions: html`<a class="btn quiet" href="/reports/maintenance">Maintenance report</a>`,
    body: html`${stateBanner(state)}
    <nav class="subnav" aria-label="Task filter"><a href="/maintenance" ${scope === 'open' ? raw('aria-current="true"') : ''}>Open tasks</a><a href="/maintenance?scope=all" ${scope === 'all' ? raw('aria-current="true"') : ''}>All tasks</a></nav>
    <section class="panel">${tasks.length ? taskTable(view, tasks, assignees, true) : empty('No tasks', 'Nothing matches this view.')}
      ${can(view.staff, 'maintenance.write') && websites.length ? html`<details><summary>Add a task</summary>${postForm('/maintenance/tasks', view, html`<input type="hidden" name="_return" value="/maintenance">
        ${fields([{ name: 'website_id', label: 'Website', type: 'select', required: true, placeholder: 'Choose a website', options: websites.map(item => ({ value: item.id, label: `${item.display_name} (${item.client_name})` })) }])}${taskFields(assignees)}${submit('Add task')}`)}</details>` : ''}
    </section>
    <section class="panel"><div class="panel-head"><div><h2>Schedules</h2><p class="muted">Recurring work. Staff create the task when it comes due.</p></div></div>
      ${schedules.length ? html`<div class="panel-body"><ul class="plain">${schedules.map(item => html`${scheduleRow(view, item, assignees)}`)}</ul></div>` : empty('No schedules', 'Add one from a website page.')}
    </section>`
  });
}

export function backupsPage(view, { sources, restores = [] }) {
  return shell({
    title: 'Backups', active: '/backups', view,
    notice: { title: 'A backup is not proven until it is restored.', text: ' Only a passed restore test with evidence from the last 90 days shows as verified.' },
    body: html`<section class="panel">${sources.length ? sourceTable(sources, true) : empty('No backup sources recorded', 'Backup coverage is unknown. Add a source from a website page.')}</section><section class="panel">${restoreHistory(restores,true)}</section>`
  });
}

export function integrationsPage(view, { config, stackltrEnabled }) {
  return shell({
    title: 'Integrations', active: '/integrations', view,
    body: html`<div class="banner warn"><strong>Not yet verified against live platforms.</strong>Each adapter is built from official documentation and tested with simulated responses. None has connected to a real site.</div>
    <section class="panel"><div class="panel-head"><div><h2>This environment</h2></div></div><div class="panel-body"><dl class="facts">
      <dt>Outbound connections</dt><dd>${config.outboundEnabled ? tag('On', 'warn') : tag('Off', 'unknown')}</dd>
      <dt>Credential storage</dt><dd>${config.credentialStorageEnabled ? tag('On', 'warn') : tag('Off', 'unknown')}</dd>
      <dt>Live operations</dt><dd>${config.operationsEnabled ? tag('On', 'warn') : tag('Off', 'unknown')}</dd>
      <dt>StackLTR</dt><dd>${stackltrEnabled ? tag('On', 'warn') : tag('Not connected', 'unknown')}</dd>
    </dl></div></section>
    ${[...Object.values(ADAPTERS), OTHER_PLATFORM].map(platform => html`<section class="panel"><div class="panel-head"><div><h2>${platform.label}</h2>${platform.docsUrl ? html`<p class="muted"><a href="${platform.docsUrl}" rel="noreferrer noopener">Official documentation</a></p>` : ''}</div></div><div class="panel-body">${capabilityList(platform)}</div></section>`)}`
  });
}

export function staffPage(view, { staff, clients, state, notice }) {
  const roles = ['owner', 'admin', 'technician', 'billing', 'viewer'].filter(role => role !== 'owner' || view.staff.role === 'owner');
  const roleOptions = roles.map(value => ({ value, label: roleLabel(value) }));
  return shell({
    title: 'Staff', active: '/staff', view, notice,
    body: html`${stateBanner(state)}
    <section class="panel"><div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Person</th><th>Role and status</th><th>Clients</th><th>Last sign-in</th></tr></thead><tbody>
      ${staff.map(member => html`<tr><td><strong>${member.display_name}</strong><br><span class="note">${member.email}</span></td>
        <td>${member.id === view.staff.id || (member.role === 'owner' && view.staff.role !== 'owner') ? html`${roleLabel(member.role)} ${statusTag(member.status)}` : postForm(`/staff/${member.id}`, view, html`
          <select name="role" aria-label="Role for ${member.display_name}">${roleOptions.map(option => html`<option value="${option.value}" ${option.value === member.role ? raw('selected') : ''}>${option.label}</option>`)}</select>
          <select name="status" aria-label="Status for ${member.display_name}">${['active', 'disabled'].map(value => html`<option value="${value}" ${value === member.status ? raw('selected') : ''}>${value}</option>`)}</select>
          <button class="btn quiet" type="submit">Save</button>`, 'inline')}</td>
        <td>${['owner', 'admin'].includes(member.role) ? html`<span class="muted">All clients</span>` : html`
          ${member.assignments.map(item => postForm('/staff/unassign', view, html`<input type="hidden" name="staff_id" value="${member.id}"><input type="hidden" name="client_account_id" value="${item.client_account_id}">${item.client_name} <button class="btn quiet" type="submit" aria-label="Remove ${item.client_name} from ${member.display_name}">Remove</button>`, 'inline'))}
          ${clients.some(client => !member.assignments.some(item => item.client_account_id === client.id)) ? postForm('/staff/assign', view, html`<input type="hidden" name="staff_id" value="${member.id}"><select name="client_account_id" aria-label="Client to assign to ${member.display_name}">${clients.filter(client => !member.assignments.some(item => item.client_account_id === client.id)).map(client => html`<option value="${client.id}">${client.display_name}</option>`)}</select><button class="btn quiet" type="submit">Assign</button>`, 'inline') : ''}`}</td>
        <td>${member.last_login_at ? dateTime(member.last_login_at) : html`<span class="muted">Never</span>`}</td></tr>`)}
    </tbody></table></div>
    <details><summary>Add a staff member</summary><p class="muted">They sign in through the identity provider using this verified email. The hub never stores a password.</p>
      ${postForm('/staff', view, html`${fields([{ name: 'display_name', label: 'Name', required: true }, { name: 'email', label: 'Work email', type: 'email', required: true }, { name: 'role', label: 'Role', type: 'select', required: true, value: 'technician', options: roleOptions }], { values: state?.values, errors: state?.errors })}${submit('Add staff member')}`)}</details></section>`
  });
}

export function auditPage(view, { entries, chainBrokenAt }) {
  return shell({
    title: 'Audit log', active: '/audit', view,
    notice: chainBrokenAt
      ? { kind: 'error', title: 'The audit chain failed verification.', text: ` The first entry that does not verify is ${chainBrokenAt}. Treat this as a security incident.` }
      : { kind: 'ok', title: 'Hash chain verified.', text: ' No entry has been altered since it was written.' },
    body: html`<section class="panel">${entries.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>#</th><th>When</th><th>Who</th><th>Action</th><th>Result</th><th>Client</th><th>Details</th></tr></thead><tbody>
      ${entries.map(entry => html`<tr><td>${entry.seq}</td><td>${dateTime(entry.occurred_at)}</td><td>${entry.actor_name ?? entry.actor_type}</td><td><code>${entry.action}</code></td><td>${tag(entry.outcome, entry.outcome === 'success' ? 'good' : 'bad')}</td><td>${entry.client_name ?? ''}</td><td class="note">${JSON.stringify(entry.metadata)}</td></tr>`)}
    </tbody></table></div>` : empty('No entries', 'Nothing has been recorded yet.')}</section>`
  });
}
