import { html, raw } from 'hono/html';
import { CMS_PLATFORMS } from '../adapters/index.js';
import { can } from '../authz.js';
import { dateTime, empty, fields, formErrorBanner, monitoringTag, postForm, recoverabilityTag, shell, stateBanner, statusTag, submit, tag } from './layout.js';

const today = () => new Date().toISOString().slice(0, 10);
const nowLocal = () => new Date().toISOString().slice(0, 16);
const hidden = (name, value) => html`<input type="hidden" name="${name}" value="${value}">`;
const SEVERITY_KIND = { info: 'unknown', low: '', medium: 'warn', high: 'bad', critical: 'bad', warning: 'warn' };
const severityTag = severity => tag(severity[0].toUpperCase() + severity.slice(1), SEVERITY_KIND[severity]);
const RISK_KIND = { unassessed: 'unknown', stale: 'warn', none_open: 'good', info: 'unknown', low: '', medium: 'warn', high: 'bad', critical: 'bad' };
export const riskTag = risk => tag(risk.label, RISK_KIND[risk.level]);
const sourceTag = source => tag(source === 'automated' ? 'Automated check' : 'Manual assessment', source === 'automated' ? '' : 'unknown');

// Website profile -------------------------------------------------------------

export function profileCard(site) {
  const fact = (label, value) => html`<dt>${label}</dt><dd>${value}</dd>`;
  const muted = text => html`<span class="muted">${text}</span>`;
  return html`<section class="panel" aria-labelledby="profile"><div class="panel-head"><h2 id="profile">Management profile</h2>${statusTag(site.lifecycle)}</div>
    <div class="panel-body"><dl class="facts">
    ${fact('Client', html`<a href="/clients/${site.client_account_id}">${site.client_name}</a>`)}
    ${fact('Website', html`${site.display_name} <span class="note">${site.primary_url}</span>`)}
    ${fact('Primary domain', site.primary_domain ?? muted('Not recorded'))}
    ${fact('CMS platform', site.cms_other_name ?? CMS_PLATFORMS.find(item => item.key === site.cms_platform)?.label ?? site.cms_platform)}
    ${fact('CMS version', site.cms_version ? html`${site.cms_version} <span class="note">${site.cms_version_source === 'api' ? 'Reported by the platform API' : 'Recorded by staff'}, ${dateTime(site.cms_version_recorded_at)}</span>` : muted('Not recorded'))}
    ${fact('Hosting provider', site.hosting_provider ?? muted('Not recorded'))}
    ${fact('Maintenance plan', site.plan_name ?? muted('None'))}
    ${fact('Account owner', site.account_owner_name ?? muted('Not assigned'))}
    ${fact('Monitoring status', html`${monitoringTag(site.uptime_outcome)}${site.uptime_checked_at ? html` <span class="note">${dateTime(site.uptime_checked_at)}</span>` : ''}${site.open_incidents ? html` ${tag(`${site.open_incidents} open incident${site.open_incidents === 1 ? '' : 's'}`, 'bad')}` : ''}`)}
    ${fact('Backup status', html`${recoverabilityTag(site.recoverability)}${site.backup_source_count ? '' : html` <span class="note">No source recorded</span>`}`)}
    ${fact('Security review', html`${riskTag(site.risk)}${site.last_review_at ? html` <span class="note">Last review ${dateTime(site.last_review_at)}</span>` : ''}`)}
    ${fact('Last maintenance', site.last_maintenance_at ? dateTime(site.last_maintenance_at) : muted('None recorded'))}
    ${fact('Next scheduled', site.next_maintenance_on ? html`${site.next_maintenance_on}${site.next_maintenance_on < today() ? html` ${tag('Overdue', 'bad')}` : ''}` : muted('Nothing scheduled'))}
    ${fact('StackLTR', site.stackltr_company_id ? `Linked to company ${site.stackltr_company_id}` : muted('Client not linked yet'))}
    ${site.notes ? fact('Notes', site.notes) : ''}
    </dl></div></section>`;
}

export function inventoryFilters({ filters, clients, hosting }) {
  const option = (value, label, current) => html`<option value="${value}" ${String(current ?? '') === String(value) ? raw('selected') : ''}>${label}</option>`;
  return html`<form class="filters" method="get" action="/websites" role="search">
    <input type="search" name="q" value="${filters.search ?? ''}" aria-label="Search websites and clients" placeholder="Search websites and clients">
    <select name="client" aria-label="Filter by client">${option('', 'All clients', filters.client)}${clients.map(item => option(item.id, item.display_name, filters.client))}</select>
    <select name="platform" aria-label="Filter by platform">${option('', 'All platforms', filters.platform)}${CMS_PLATFORMS.map(item => option(item.key, item.label, filters.platform))}</select>
    <select name="hosting" aria-label="Filter by hosting provider">${option('', 'All hosting', filters.hosting)}${hosting.map(item => option(item.id, item.name, filters.hosting))}</select>
    <select name="monitoring" aria-label="Filter by monitoring result">${option('', 'Any monitoring', filters.monitoring)}${option('up', 'Reachable', filters.monitoring)}${option('down', 'Not reachable', filters.monitoring)}${option('error', 'Check failed', filters.monitoring)}${option('unknown', 'Not checked', filters.monitoring)}</select>
    <select name="lifecycle" aria-label="Filter by status">${option('', 'Not archived', filters.lifecycle)}${['active', 'paused', 'offboarded', 'archived', 'all'].map(item => option(item, item[0].toUpperCase() + item.slice(1), filters.lifecycle))}</select>
    <button class="btn quiet" type="submit">Apply</button> <a class="btn quiet" href="/websites">Clear</a>
  </form>`;
}

// Website sections ------------------------------------------------------------

export function domainsSection(view, website, domains) {
  return html`<section class="panel" id="domains"><div class="panel-head"><div><h2>Domains</h2><p class="muted">Expiry dates show where they came from. No date means it is not known.</p></div></div>
    ${domains.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Domain</th><th>Registrar</th><th>DNS</th><th>Owner</th><th>Expires</th></tr></thead><tbody>
      ${domains.map(item => html`<tr><td>${item.hostname}${item.is_primary ? html` ${tag('Primary', 'good')}` : ''}</td><td>${item.registrar ?? ''}</td><td>${item.dns_provider ?? ''}</td><td>${item.domain_owner ?? ''}</td>
        <td>${item.expires_on ? html`${item.expires_on}${item.expires_on < today() ? html` ${tag('Expired', 'bad')}` : ''} <span class="note">${item.expiry_source === 'rdap' ? 'From registry' : 'Recorded by staff'}</span>` : html`<span class="muted">Unknown</span>`}</td></tr>`)}
    </tbody></table></div>` : empty('No domains recorded', 'Add the domain so its expiry can be tracked.')}
    ${can(view.staff, 'website.write') && website.lifecycle !== 'archived' ? html`<details><summary>Add a domain</summary>${postForm(`/websites/${website.id}/domains`, view, html`
      ${fields([{ name: 'hostname', label: 'Domain', required: true, help: 'For example example.com' },
        { name: 'is_primary', label: 'Primary domain', type: 'select', required: true, options: [{ value: 'on', label: 'Yes' }, { value: '', label: 'No' }] },
        { name: 'registrar', label: 'Registrar' }, { name: 'dns_provider', label: 'DNS provider' },
        { name: 'domain_owner', label: 'Who owns the domain' }, { name: 'expires_on', label: 'Expiry date', type: 'date', help: 'Only if you have confirmed it.' }])}${submit('Add domain')}`)}</details>` : ''}
  </section>`;
}

export function lifecycleSection(view, website, plans) {
  if (!can(view.staff, 'website.write')) return '';
  const archived = website.lifecycle === 'archived';
  return html`<section class="panel" id="administration"><div class="panel-head"><div><h2>Administration</h2></div></div>
    ${archived ? html`<div class="panel-body"><p class="muted">Archived ${dateTime(website.archived_at)}. Records are kept. Restoring leaves monitoring off until someone enables it.</p>${postForm(`/websites/${website.id}/restore`, view, submit('Restore website', 'btn quiet'))}</div>` : html`
    ${can(view.staff, 'maintenance.write') && plans.length ? html`<details><summary>Apply a maintenance plan</summary>${postForm(`/websites/${website.id}/apply-plan`, view, html`
      ${fields([{ name: 'plan_id', label: 'Plan', type: 'select', required: true, value: website.service_plan_id, options: plans.map(item => ({ value: item.id, label: item.name })), help: 'Creates a recurring schedule for each item in the plan. Items already scheduled are skipped.' },
        { name: 'first_due_on', label: 'First due', type: 'date', required: true, value: today() }])}${submit('Apply plan')}`)}</details>` : ''}
    <details><summary>Record the CMS version</summary>${postForm(`/websites/${website.id}/cms-version`, view, html`
      ${fields([{ name: 'cms_version', label: 'Version', required: true, value: website.cms_version, help: 'Labelled as recorded by staff. A version reported by the platform API replaces it.' }])}${submit('Save version')}`)}</details>
    <details><summary>Archive this website</summary><p class="muted">Hides it from the inventory and stops monitoring. Nothing is deleted.</p>${postForm(`/websites/${website.id}/archive`, view, submit('Archive website', 'btn danger'))}</details>`}
  </section>`;
}

export function incidentTable(view, incidents, showWebsite) {
  const write = can(view.staff, 'monitoring.write');
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Opened</th>${showWebsite ? html`<th>Website</th>` : ''}<th>Type</th><th>Status</th><th>Resolved</th><th>Acknowledged</th></tr></thead><tbody>
    ${incidents.map(item => html`<tr><td>${dateTime(item.opened_at)}</td>${showWebsite ? html`<td><a href="/websites/${item.website_id}">${item.website_name}</a><br><span class="note">${item.client_name}</span></td>` : ''}
      <td>${item.kind}${item.last_error_code ? html`<br><span class="note">${item.last_error_code.replaceAll('_', ' ')}</span>` : ''}</td>
      <td>${item.status === 'open' ? tag('Open', 'bad') : tag('Resolved', 'good')}</td><td>${item.resolved_at ? dateTime(item.resolved_at) : ''}</td>
      <td>${item.acknowledged_at ? html`${item.acknowledged_by_name} <span class="note">${dateTime(item.acknowledged_at)}</span>` : item.status === 'open' && write ? postForm(`/incidents/${item.id}/acknowledge`, view, html`<button class="btn quiet" type="submit">Acknowledge</button>`, 'inline') : ''}</td></tr>`)}
  </tbody></table></div>`;
}

const uptimeSummary = report => html`<div class="card"><div class="label">Last ${report.days} days</div>
  <div class="metric ${report.percent === null ? 'word' : ''}">${report.percent === null ? 'No data' : `${report.percent}%`}</div>
  <div class="note">${report.total ? `${report.up} of ${report.total} real checks succeeded${report.average_ms != null ? `, averaging ${report.average_ms} ms` : ''}` : 'No checks have run in this period.'}</div></div>`;

export function monitoringExtras(view, website, { incidents, windows, uptime }) {
  return html`${uptime.some(item => item.total) ? html`<div class="panel-body"><h3>Uptime</h3><div class="cards">${uptime.map(uptimeSummary)}</div></div>` : ''}
    ${incidents.length ? html`<div class="panel-body"><h3>Incidents</h3></div>${incidentTable(view, incidents, false)}` : ''}
    ${windows.length ? html`<div class="panel-body"><h3>Maintenance windows</h3><ul class="plain">${windows.map(item => html`<li>${dateTime(item.starts_at)} to ${dateTime(item.ends_at)}: ${item.reason} <span class="note">${item.created_by_name}</span></li>`)}</ul></div>` : ''}
    ${can(view.staff, 'monitoring.write') ? html`<details><summary>Add a maintenance window</summary><p class="muted">Failures during a window do not open incidents or count against uptime.</p>${postForm('/monitoring/windows', view, html`${hidden('website_id', website.id)}${hidden('_return', `/websites/${website.id}`)}
      ${fields([{ name: 'starts_at', label: 'Starts (UTC)', type: 'datetime-local', required: true, value: nowLocal() }, { name: 'ends_at', label: 'Ends (UTC)', type: 'datetime-local', required: true }, { name: 'reason', label: 'Reason', required: true }])}${submit('Add window')}`)}</details>` : ''}`;
}

export function findingList(view, findings, showWebsite) {
  const write = can(view.staff, 'security.write');
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Severity</th><th>Finding</th>${showWebsite ? html`<th>Website</th>` : ''}<th>Source</th><th>Status</th>${write ? html`<th>Update</th>` : ''}</tr></thead><tbody>
    ${findings.map(item => html`<tr><td>${severityTag(item.severity)}</td><td><strong>${item.title}</strong>${item.description ? html`<br><span class="note">${item.description}</span>` : ''}${item.evidence_ref ? html`<br><span class="note">Evidence: ${item.evidence_ref}</span>` : ''}<br><span class="note">Found ${dateTime(item.found_at)}</span></td>
      ${showWebsite ? html`<td><a href="/websites/${item.website_id}">${item.website_name}</a><br><span class="note">${item.client_name}</span></td>` : ''}
      <td>${sourceTag(item.source)}${item.created_by_name ? html`<br><span class="note">${item.created_by_name}</span>` : item.source_detail ? html`<br><span class="note">${item.source_detail}</span>` : ''}</td>
      <td>${statusTag(item.status)}</td>
      ${write ? html`<td>${item.status === 'resolved' ? '' : html`${postForm(`/security/findings/${item.id}/update`, view, html`
        <select name="status" aria-label="Status for ${item.title}">${['open', 'in_progress', 'resolved', ...(['owner', 'admin'].includes(view.staff.role) ? ['accepted'] : [])].map(value => html`<option value="${value}" ${value === item.status ? raw('selected') : ''}>${value.replaceAll('_', ' ')}</option>`)}</select>
        <input type="text" name="evidence_ref" aria-label="Evidence reference for ${item.title}" placeholder="Evidence reference"><button class="btn quiet" type="submit">Update</button>`, 'inline')}
        ${item.remediation_task_id ? html`<span class="note">Remediation task created</span>` : postForm(`/security/findings/${item.id}/remediate`, view, html`<button class="btn quiet" type="submit">Create remediation task</button>`, 'inline')}`}</td>` : ''}</tr>`)}
  </tbody></table></div>`;
}

export function findingForm(view, website) {
  return can(view.staff, 'security.write') ? html`<details><summary>Record a finding</summary>${postForm('/security/findings', view, html`${hidden('website_id', website.id)}${hidden('_return', `/websites/${website.id}`)}
    ${fields([{ name: 'title', label: 'Finding', required: true }, { name: 'severity', label: 'Risk', type: 'select', required: true, value: 'medium', options: ['info', 'low', 'medium', 'high', 'critical'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) })) },
      { name: 'description', label: 'Details', type: 'textarea' }, { name: 'evidence_ref', label: 'Evidence reference' }])}${submit('Record finding')}`)}</details>` : '';
}

export function recoverySection(view, website, requests, runs) {
  const decide = can(view.staff, 'operation.decide');
  return html`${requests.length ? html`<div class="panel-body"><h3>Recovery requests</h3><ul class="plain">${requests.map(item => html`<li>${statusTag(item.status)} Backup from ${dateTime(item.backup_finished_at)}: ${item.reason} <span class="note">Requested by ${item.requested_by_name}${item.decided_by_name ? `, decided by ${item.decided_by_name}` : ''}${item.outcome_notes ? `. ${item.outcome_notes}` : ''}${item.evidence_ref ? `. Evidence: ${item.evidence_ref}` : ''}</span>
      ${decide && item.status === 'requested' ? html`<div>${item.requested_by === view.staff.id ? '' : postForm(`/recovery/${item.id}/approve`, view, html`<button class="btn quiet" type="submit">Approve</button>`, 'inline')} ${postForm(`/recovery/${item.id}/reject`, view, html`<button class="btn quiet" type="submit">Reject</button>`, 'inline')}</div>` : ''}
      ${decide && item.status === 'approved' ? postForm(`/recovery/${item.id}/start`, view, html`<button class="btn quiet" type="submit">Mark as started</button>`, 'inline') : ''}
      ${decide && item.status === 'in_progress' ? html`<details><summary>Close this recovery</summary>${postForm(`/recovery/${item.id}/close`, view, html`
        ${fields([{ name: 'outcome', label: 'Outcome', type: 'select', required: true, options: [{ value: 'failed', label: 'Failed' }, { value: 'completed', label: 'Completed' }] }, { name: 'outcome_notes', label: 'What happened', type: 'textarea', required: true }, { name: 'evidence_ref', label: 'Evidence reference', help: 'Required when completed.' }])}${submit('Close recovery')}`)}</details>` : ''}</li>`)}</ul></div>` : ''}
    ${can(view.staff, 'backup.write') && runs.length ? html`<details><summary>Request a recovery</summary><p class="muted">Tracks and authorizes the work. A second person approves it, and people carry it out. The hub never restores anything itself. See docs/recovery-runbook.md.</p>${postForm('/recovery', view, html`
      ${fields([{ name: 'backup_run_id', label: 'Backup to restore', type: 'select', required: true, options: runs.map(run => ({ value: run.id, label: `${run.source_label}, ${dateTime(run.finished_at)} (${run.status})` })) }, { name: 'reason', label: 'Why', type: 'textarea', required: true }])}${submit('Request recovery')}`)}</details>` : ''}`;
}

export const workLogList = logs => (logs.length ? html`<div class="panel-body"><h3>Work log</h3><ul class="plain">${logs.map(item => html`<li>${dateTime(item.logged_at)} <strong>${item.task_title}</strong>: ${item.note} <span class="note">${item.staff_name}${item.minutes ? `, ${item.minutes} min` : ''}</span></li>`)}</ul></div>` : '');

// Dashboards ------------------------------------------------------------------

export function monitoringDashboardPage(view, { checks, incidents, config, table }) {
  const open = incidents.filter(item => item.status === 'open');
  return shell({
    title: 'Monitoring', active: '/monitoring', view,
    notice: config.outboundEnabled ? null : { kind: 'warn', title: 'Probes are turned off in this environment.', text: ' No site is contacted, and checks stay unknown.' },
    body: html`<div class="cards">
      <div class="card"><div class="label">Open incidents</div><div class="metric">${open.length}</div><div class="note">From consecutive failed checks</div></div>
      <div class="card"><div class="label">Enabled checks</div><div class="metric">${checks.filter(item => item.enabled).length}</div><div class="note">${checks.filter(item => item.checked_at).length} have a real result</div></div>
    </div>
    <section class="panel"><div class="panel-head"><h2>Incidents</h2></div>${incidents.length ? incidentTable(view, incidents, true) : empty('No incidents recorded', 'This only covers websites with enabled checks that have run.')}</section>
    <section class="panel"><div class="panel-head"><h2>Checks</h2></div>${checks.length ? table : empty('No checks enabled', 'Enable uptime and certificate checks from a website page.')}</section>`
  });
}

export function securityDashboardPage(view, { sites, findings }) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const item of findings) counts[item.severity] += 1;
  return shell({
    title: 'Security', active: '/security', view,
    notice: { title: 'No vulnerability scanner is connected.', text: ' This shows certificate checks, platform reports and what people recorded. An empty list is not a clean result, and this does not cover every vulnerability.' },
    body: html`<div class="cards">
      ${Object.entries(counts).map(([severity, count]) => html`<div class="card"><div class="label">${severity[0].toUpperCase() + severity.slice(1)}</div><div class="metric">${count}</div><div class="note">Open findings</div></div>`)}
    </div>
    <section class="panel"><div class="panel-head"><div><h2>Findings</h2><p class="muted">Each one says whether a check or a person found it.</p></div></div>${findings.length ? findingList(view, findings, true) : empty('No open findings recorded', 'Nothing recorded does not mean nothing is wrong.')}</section>
    <section class="panel"><div class="panel-head"><div><h2>Websites</h2><p class="muted">Risk reflects open findings. Recommendations are rules applied to your records, not scan results.</p></div></div>
      ${sites.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Website</th><th>Risk</th><th>CMS version</th><th>TLS</th><th>Last review</th><th>Recommendations</th></tr></thead><tbody>
        ${sites.map(site => html`<tr><td><a href="/websites/${site.id}">${site.display_name}</a><br><span class="note">${site.client_name}</span></td><td>${riskTag(site.risk)}<br><span class="note">${site.risk.basis}</span></td>
          <td>${site.cms_version ?? html`<span class="muted">Not recorded</span>`}${site.cms_version_source ? html`<br><span class="note">${site.cms_version_source === 'api' ? 'From API' : 'By staff'}</span>` : ''}</td>
          <td>${site.tls_checked_at ? html`${monitoringTag(site.tls_outcome)}${site.tls_valid_to ? html`<br><span class="note">To ${dateTime(site.tls_valid_to)}</span>` : ''}` : html`<span class="muted">Not checked</span>`}</td>
          <td>${site.last_review_at ? dateTime(site.last_review_at) : html`<span class="muted">Never</span>`}</td>
          <td>${site.recommendations.length ? html`<ul class="plain">${site.recommendations.map(item => html`<li>${item.text}</li>`)}</ul>` : html`<span class="muted">None from the current rules</span>`}</td></tr>`)}
      </tbody></table></div>` : empty('No websites', 'Add a website to see its security status.')}</section>`
  });
}

// Other pages -----------------------------------------------------------------

export function notificationsPage(view, { notifications }) {
  return shell({
    title: 'Notifications', active: '/notifications', view,
    actions: notifications.some(item => !item.read_at) ? postForm('/notifications/read', view, html`<button class="btn quiet" type="submit">Mark all as read</button>`, 'inline') : '',
    body: html`<section class="panel">${notifications.length ? html`<div class="panel-body"><ul class="plain">${notifications.map(item => html`<li>${item.read_at ? '' : html`${tag('New', 'warn')} `}${severityTag(item.severity)} ${item.link_path ? html`<a href="${item.link_path}">${item.title}</a>` : item.title} <span class="note">${item.body} ${dateTime(item.created_at)}</span></li>`)}</ul></div>` : empty('No notifications', 'Alerts about your clients will appear here.')}</section>`
  });
}

export function accountPage(view, { sessions, config, notice }) {
  const { staff } = view;
  return shell({
    title: 'Your account', active: '/account', view, notice,
    body: html`<section class="panel"><div class="panel-body"><dl class="facts"><dt>Name</dt><dd>${staff.display_name}</dd><dt>Email</dt><dd>${staff.email}</dd><dt>Role</dt><dd>${staff.role}</dd>
      <dt>Password and MFA</dt><dd>Managed at your identity provider. The hub stores no password.</dd>
      <dt>MFA required here</dt><dd>${config.mfaRequired ? tag('Yes', 'good') : tag('Left to the identity provider', 'warn')}</dd></dl></div></section>
    <section class="panel"><div class="panel-head"><div><h2>Active sessions</h2><p class="muted">Sessions end after 30 idle minutes or 8 hours.</p></div></div>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Started</th><th>Last active</th><th>Provider reported MFA</th><th></th></tr></thead><tbody>
      ${sessions.map(item => html`<tr><td>${dateTime(item.created_at)}</td><td>${dateTime(item.last_seen_at)}</td><td>${item.mfa_reported ? tag('Yes', 'good') : tag('Not reported', 'unknown')}</td>
        <td>${item.id === view.sessionId ? tag('This session') : postForm(`/account/sessions/${item.id}/revoke`, view, html`<button class="btn quiet" type="submit">End session</button>`, 'inline')}</td></tr>`)}
      </tbody></table></div></section>`
  });
}

export function hostingPage(view, { providers, state, notice }) {
  return shell({
    title: 'Hosting providers', active: '/hosting', view, notice,
    body: html`<section class="panel">${providers.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Provider</th><th>Websites</th><th>Support</th><th>Notes</th></tr></thead><tbody>
      ${providers.map(item => html`<tr><td>${item.name}</td><td>${item.website_count}</td><td>${item.support_url ? html`<a href="${item.support_url}" rel="noreferrer noopener">Support page</a>` : ''}</td><td>${item.notes}</td></tr>`)}</tbody></table></div>` : empty('No hosting providers yet', 'Add the providers your clients use. No sample providers are created.')}
      ${can(view.staff, 'website.write') ? html`<details ${state ? raw('open') : ''}><summary>Add a hosting provider</summary>${formErrorBanner(state)}${postForm('/hosting', view, html`${fields([{ name: 'name', label: 'Name', required: true }, { name: 'support_url', label: 'Support page', type: 'url' }, { name: 'notes', label: 'Notes', type: 'textarea', help: 'Do not put passwords or keys here.' }], { values: state?.values, errors: state?.errors })}${submit('Add provider')}`)}</details>` : ''}</section>`
  });
}

export function planItemsPanel(view, plans, planTasks) {
  return html`${plans.map(plan => html`<div class="panel-body"><h3>${plan.name}</h3>${plan.description ? html`<p class="muted">${plan.description}</p>` : ''}
    ${plan.stackltr_billing_ref ? html`<p class="note">StackLTR billing reference: ${plan.stackltr_billing_ref}</p>` : ''}
    <ul class="plain">${planTasks.filter(item => item.plan_id === plan.id).map(item => html`<li>${item.title} <span class="note">${item.kind.replaceAll('_', ' ')}, every ${item.interval_days} days</span></li>`)}</ul>
    ${can(view.staff, 'plan.write') ? html`<details><summary>Add recurring work to this plan</summary>${postForm(`/plans/${plan.id}/tasks`, view, html`
      ${fields([{ name: 'title', label: 'Work', required: true }, { name: 'kind', label: 'Type', type: 'select', required: true, value: 'inspection', options: TASK_KINDS }, { name: 'interval_days', label: 'Repeat every (days)', type: 'number', required: true, value: 30 }])}${submit('Add to plan')}`)}</details>` : ''}</div>`)}`;
}

export const TASK_KINDS = ['inspection', 'software_update', 'plugin_update', 'content_request', 'security', 'backup_verification', 'other']
  .map(value => ({ value, label: `${value[0].toUpperCase()}${value.slice(1).replaceAll('_', ' ')}` }));

export function reportPage(view, { report, clients }) {
  const query = new URLSearchParams({ from: report.from, to: report.to, ...(report.client_id ? { client: report.client_id } : {}), format: 'csv' }).toString();
  return shell({
    title: 'Maintenance report', active: '/maintenance', view,
    body: html`<section class="panel"><div class="panel-body"><form class="filters" method="get" action="/reports/maintenance">
        <label>From <input type="date" name="from" value="${report.from}" required></label><label>To <input type="date" name="to" value="${report.to}" required></label>
        <label>Client <select name="client"><option value="">All clients</option>${clients.map(item => html`<option value="${item.id}" ${item.id === report.client_id ? raw('selected') : ''}>${item.display_name}</option>`)}</select></label>
        <button class="btn quiet" type="submit">Run report</button> <a class="btn quiet" href="/reports/maintenance?${query}">Download CSV</a></form></div>
      ${report.tasks.length ? html`<div class="panel-body"><p class="muted">${report.tasks.length} completed task${report.tasks.length === 1 ? '' : 's'}, ${report.totalMinutes} minutes logged.</p></div>
      <div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Completed</th><th>Client</th><th>Website</th><th>Work</th><th>By</th><th>Minutes</th><th>Evidence</th></tr></thead><tbody>
      ${report.tasks.map(item => html`<tr><td>${dateTime(item.completed_at)}</td><td>${item.client_name}</td><td>${item.website_name}</td><td><strong>${item.title}</strong><br><span class="note">${item.completion_notes}</span></td><td>${item.completed_by_name}</td><td>${item.minutes || ''}</td><td>${item.completion_evidence_ref ?? ''}</td></tr>`)}
      </tbody></table></div>` : empty('No completed work in this period', 'Only recorded work appears in this report.')}</section>`
  });
}

// CSV cells that start with these run as formulas in a spreadsheet, so they get a
// leading quote. Client names and notes are typed by people and exported here.
export function toCsv(rows) {
  const cell = value => {
    const text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return `${rows.map(row => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

export function stackltrPanel(view, { enabled, company, requests, error, client, results, query }) {
  if (!enabled) return html`<section class="panel"><div class="panel-head"><div><h2>StackLTR</h2><p class="muted">Not connected in this environment. IDs entered below are not checked against StackLTR.</p></div>${tag('Not connected', 'unknown')}</div></section>`;
  return html`<section class="panel"><div class="panel-head"><div><h2>StackLTR</h2><p class="muted">Read live from StackLTR and not stored in the hub.</p></div>${error ? tag('Unavailable', 'bad') : tag('Connected', 'good')}</div>
    <div class="panel-body">${error ? html`<p class="muted">${error}</p>` : ''}
    ${company ? html`<dl class="facts"><dt>Company</dt><dd>${company.name ?? ''}</dd><dt>Domain</dt><dd>${company.domain ?? ''}</dd><dt>Lifecycle</dt><dd>${company.lifecycle ?? ''}</dd></dl>` : ''}
    ${requests?.length ? html`<h3>Service requests</h3><ul class="plain">${requests.map(item => html`<li>${item.title ?? item.id} <span class="note">${item.status ?? ''}</span></li>`)}</ul>` : ''}
    ${client && can(view.staff, 'client.write') ? html`<form class="filters" method="get" action="/clients/${client.id}"><input type="search" name="stackltr_q" value="${query ?? ''}" aria-label="Search StackLTR companies" placeholder="Search StackLTR companies"><button class="btn quiet" type="submit">Search</button></form>
      ${results?.length ? html`<ul class="plain">${results.map(item => html`<li>${item.name} <span class="note">${item.domain ?? ''} Company ID ${item.id}, workspace ID ${item.workspace_id}</span></li>`)}</ul>` : ''}` : ''}
    </div></section>`;
}

export { stateBanner };
