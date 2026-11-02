import { auditStaff } from '../audit.js';
import { requirePermission } from '../authz.js';
import { one } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { isUuid, parse, schemas } from '../validation.js';

const asStaff = (ctx, fn) => ctx.db.as('hub_app', ctx.staff.id, fn);

async function website(tx, id) {
  if (!isUuid(id)) throw notFound();
  const row = one(await tx.query(`select id, client_account_id from hub.managed_websites where id = $1`, [id]));
  if (!row) throw notFound();
  return row;
}

// Monitoring ------------------------------------------------------------------

export async function listIncidents(ctx, { websiteId, status } = {}) {
  requirePermission(ctx.staff, 'monitoring.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select i.id, i.website_id, i.kind, i.status, i.opened_at, i.resolved_at, i.last_error_code, i.acknowledged_at,
       w.display_name as website_name, c.display_name as client_name, s.display_name as acknowledged_by_name
     from hub.incidents i
     join hub.managed_websites w on w.id = i.website_id
     join hub.client_accounts c on c.id = i.client_account_id
     left join hub.staff_users s on s.id = i.acknowledged_by
     where ($1::uuid is null or i.website_id = $1) and ($2::text is null or i.status = $2)
     order by i.opened_at desc limit 200`, [websiteId ?? null, status ?? null])).rows);
}

export async function acknowledgeIncident(ctx, id) {
  requirePermission(ctx.staff, 'monitoring.write');
  if (!isUuid(id)) throw notFound();
  return asStaff(ctx, async tx => {
    const row = one(await tx.query(`select id, client_account_id, status, website_id from hub.incidents where id = $1`, [id]));
    if (!row) throw notFound();
    if (row.status !== 'open') throw conflict('This incident is already resolved.');
    await tx.query(`update hub.incidents set acknowledged_by = $2, acknowledged_at = now() where id = $1`, [id, ctx.staff.id]);
    await auditStaff(tx, ctx, 'incident.acknowledge', { entityType: 'incident', entityId: id, clientId: row.client_account_id });
    return row;
  });
}

export async function listMaintenanceWindows(ctx, websiteId) {
  requirePermission(ctx.staff, 'monitoring.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select m.id, m.starts_at, m.ends_at, m.reason, s.display_name as created_by_name from hub.maintenance_windows m
     join hub.staff_users s on s.id = m.created_by where m.website_id = $1 and m.ends_at > now() - interval '30 days' order by m.starts_at desc limit 50`, [websiteId])).rows);
}

export async function createMaintenanceWindow(ctx, input) {
  requirePermission(ctx.staff, 'monitoring.write');
  const data = parse(schemas.maintenanceWindow, input);
  return asStaff(ctx, async tx => {
    const site = await website(tx, data.website_id);
    const row = one(await tx.query(
      `insert into hub.maintenance_windows (client_account_id, website_id, starts_at, ends_at, reason, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [site.client_account_id, site.id, data.starts_at, data.ends_at, data.reason, ctx.staff.id]));
    await auditStaff(tx, ctx, 'maintenance_window.create', { entityType: 'maintenance_window', entityId: row.id, clientId: site.client_account_id, metadata: { reason: data.reason } });
    return row;
  });
}

// Share of real probes that succeeded. Probes inside a maintenance window are left
// out. With no probes the figure is null, shown as no data rather than a percentage.
export async function uptimeReport(ctx, { websiteId, days }) {
  requirePermission(ctx.staff, 'monitoring.read');
  return asStaff(ctx, async tx => {
    const row = one(await tx.query(
      `select count(*)::int as total, count(*) filter (where r.outcome = 'up')::int as up,
         round(avg(r.response_ms) filter (where r.response_ms is not null))::int as average_ms, min(r.checked_at) as first_checked_at
       from hub.monitoring_results r join hub.monitoring_checks m on m.id = r.check_id
       where m.website_id = $1 and m.kind = 'uptime' and not r.in_maintenance_window and r.checked_at > now() - make_interval(days => $2::int)`, [websiteId, days]));
    return { days, total: row.total, up: row.up, average_ms: row.average_ms, first_checked_at: row.first_checked_at, percent: row.total ? Math.round((row.up / row.total) * 10000) / 100 : null };
  });
}

// Security --------------------------------------------------------------------

const RISK_ORDER = ['info', 'low', 'medium', 'high', 'critical'];

// Reflects open findings only. Without a recorded review it says unassessed: a
// site nobody has looked at must not read as low risk.
export function riskFor({ highestOpenSeverity, lastReviewAt }, now = new Date()) {
  if (highestOpenSeverity) return { level: highestOpenSeverity, label: `${highestOpenSeverity[0].toUpperCase()}${highestOpenSeverity.slice(1)} risk`, basis: 'Highest open finding' };
  if (!lastReviewAt) return { level: 'unassessed', label: 'Not assessed', basis: 'No review or finding on record' };
  const age = (now.getTime() - new Date(lastReviewAt).getTime()) / 86400000;
  if (age > 180) return { level: 'stale', label: 'Review out of date', basis: 'Last review over 180 days ago' };
  return { level: 'none_open', label: 'No open findings', basis: 'Limited to what has been reviewed or checked' };
}

// Rule-based prompts from recorded facts. They are suggestions, not scan results.
export function recommendationsFor(site, now = new Date()) {
  const list = [];
  const inDays = date => (new Date(date).getTime() - now.getTime()) / 86400000;
  if (!site.last_review_at) list.push({ severity: 'warning', text: 'Record a first security review.' });
  else if (inDays(site.last_review_at) < -180) list.push({ severity: 'warning', text: 'Security review is over 180 days old.' });
  if (!site.has_uptime_check) list.push({ severity: 'info', text: 'Enable uptime monitoring.' });
  if (!site.has_ssl_check && site.primary_url.startsWith('https://')) list.push({ severity: 'info', text: 'Enable certificate monitoring.' });
  if (site.tls_valid_to && inDays(site.tls_valid_to) < 30) list.push({ severity: 'warning', text: 'Certificate expires within 30 days.' });
  if (!site.cms_version && site.cms_platform !== 'wix' && site.cms_platform !== 'squarespace' && site.cms_platform !== 'shopify') list.push({ severity: 'info', text: 'Record the CMS version.' });
  if (!site.backup_sources) list.push({ severity: 'warning', text: 'Record where this site is backed up.' });
  if (site.open_critical) list.push({ severity: 'critical', text: 'Plan remediation for critical findings.' });
  return list;
}

export async function securityDashboard(ctx) {
  requirePermission(ctx.staff, 'security.read');
  const rows = await asStaff(ctx, async tx => (await tx.query(
    `select w.id, w.display_name, w.primary_url, w.cms_platform, w.cms_version, w.cms_version_source, w.cms_version_recorded_at, c.display_name as client_name,
       (select max(r.reviewed_at) from hub.security_reviews r where r.website_id = w.id) as last_review_at,
       (select f.severity from hub.security_findings f where f.website_id = w.id and f.status in ('open', 'in_progress')
          order by array_position(array['info','low','medium','high','critical'], f.severity) desc limit 1) as highest_open_severity,
       (select count(*)::int from hub.security_findings f where f.website_id = w.id and f.status in ('open', 'in_progress')) as open_findings,
       (select count(*)::int from hub.security_findings f where f.website_id = w.id and f.status in ('open', 'in_progress') and f.severity = 'critical') as open_critical,
       exists (select 1 from hub.monitoring_checks m where m.website_id = w.id and m.kind = 'uptime' and m.enabled) as has_uptime_check,
       exists (select 1 from hub.monitoring_checks m where m.website_id = w.id and m.kind = 'ssl' and m.enabled) as has_ssl_check,
       (select count(*)::int from hub.backup_sources b where b.website_id = w.id and b.active) as backup_sources,
       ssl.tls_valid_to, ssl.outcome as tls_outcome, ssl.checked_at as tls_checked_at
     from hub.managed_websites w join hub.client_accounts c on c.id = w.client_account_id
     left join lateral (select x.tls_valid_to, x.outcome, x.checked_at from hub.monitoring_results x join hub.monitoring_checks m on m.id = x.check_id
       where m.website_id = w.id and m.kind = 'ssl' order by x.checked_at desc limit 1) ssl on true
     where w.lifecycle <> 'archived' order by lower(c.display_name), lower(w.display_name) limit 500`)).rows);
  return rows.map(row => ({
    ...row,
    risk: riskFor({ highestOpenSeverity: row.highest_open_severity, lastReviewAt: row.last_review_at }),
    recommendations: recommendationsFor(row)
  }));
}

export async function listFindings(ctx, { websiteId, status = 'current' } = {}) {
  requirePermission(ctx.staff, 'security.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select f.id, f.website_id, f.title, f.description, f.severity, f.status, f.source, f.source_detail, f.evidence_ref, f.remediation_task_id, f.found_at, f.resolved_at,
       w.display_name as website_name, c.display_name as client_name, s.display_name as created_by_name
     from hub.security_findings f
     join hub.managed_websites w on w.id = f.website_id
     join hub.client_accounts c on c.id = f.client_account_id
     left join hub.staff_users s on s.id = f.created_by
     where ($1::uuid is null or f.website_id = $1) and ($2 = 'all' or f.status in ('open', 'in_progress'))
     order by array_position(array['critical','high','medium','low','info'], f.severity), f.found_at desc limit 300`, [websiteId ?? null, status])).rows);
}

export async function createFinding(ctx, input) {
  requirePermission(ctx.staff, 'security.write');
  const data = parse(schemas.finding, input);
  return asStaff(ctx, async tx => {
    const site = await website(tx, data.website_id);
    const row = one(await tx.query(
      `insert into hub.security_findings (client_account_id, website_id, title, description, severity, source, source_detail, evidence_ref, created_by)
       values ($1, $2, $3, $4, $5, 'manual', 'Staff assessment', $6, $7) returning id`,
      [site.client_account_id, site.id, data.title, data.description, data.severity, data.evidence_ref ?? null, ctx.staff.id]));
    await auditStaff(tx, ctx, 'finding.create', { entityType: 'security_finding', entityId: row.id, clientId: site.client_account_id, metadata: { severity: data.severity, source: 'manual' } });
    return { ...row, website_id: site.id };
  });
}

export async function updateFinding(ctx, id, input) {
  requirePermission(ctx.staff, 'security.write');
  if (!isUuid(id)) throw notFound();
  const data = parse(schemas.findingUpdate, input);
  // Accepting a risk is a business decision, so it stays with owners and admins.
  if (data.status === 'accepted' && !['owner', 'admin'].includes(ctx.staff.role)) throw forbidden('Only an owner or admin can accept a risk.');
  return asStaff(ctx, async tx => {
    const finding = one(await tx.query(`select id, client_account_id, website_id, status from hub.security_findings where id = $1`, [id]));
    if (!finding) throw notFound();
    const resolved = data.status === 'resolved';
    await tx.query(
      `update hub.security_findings set status = $2, resolved_at = case when $3::boolean then now() end, resolved_by = case when $3::boolean then $4::uuid end,
         evidence_ref = coalesce($5, evidence_ref) where id = $1`,
      [id, data.status, resolved, ctx.staff.id, data.evidence_ref ?? null]);
    await auditStaff(tx, ctx, 'finding.update', { entityType: 'security_finding', entityId: id, clientId: finding.client_account_id, metadata: { from: finding.status, to: data.status } });
    return { id, website_id: finding.website_id };
  });
}

export async function createRemediationTask(ctx, findingId) {
  requirePermission(ctx.staff, 'security.write');
  requirePermission(ctx.staff, 'maintenance.write');
  if (!isUuid(findingId)) throw notFound();
  return asStaff(ctx, async tx => {
    const finding = one(await tx.query(`select * from hub.security_findings where id = $1`, [findingId]));
    if (!finding) throw notFound();
    if (finding.remediation_task_id) throw conflict('This finding already has a remediation task.');
    const task = one(await tx.query(
      `insert into hub.maintenance_tasks (client_account_id, website_id, title, details, kind, priority, created_by)
       values ($1, $2, $3, $4, 'security', $5, $6) returning id`,
      [finding.client_account_id, finding.website_id, `Remediate: ${finding.title}`.slice(0, 160), finding.description,
        finding.severity === 'critical' ? 'urgent' : RISK_ORDER.indexOf(finding.severity) >= 3 ? 'high' : 'normal', ctx.staff.id]));
    await tx.query(`update hub.security_findings set remediation_task_id = $2, status = case when status = 'open' then 'in_progress' else status end where id = $1`, [findingId, task.id]);
    await auditStaff(tx, ctx, 'finding.remediate', { entityType: 'security_finding', entityId: findingId, clientId: finding.client_account_id, metadata: { task_id: task.id } });
    return { id: findingId, website_id: finding.website_id };
  });
}

// Notifications ---------------------------------------------------------------

export async function listNotifications(ctx, { unreadOnly = false } = {}) {
  return asStaff(ctx, async tx => (await tx.query(
    `select id, kind, severity, title, body, link_path, read_at, created_at from hub.notifications
     where staff_id = $1 and (client_account_id is null or hub.can_access_client(client_account_id)) and (not $2::boolean or read_at is null) order by created_at desc limit 200`, [ctx.staff.id, unreadOnly])).rows);
}

export async function unreadCount(ctx) {
  return asStaff(ctx, async tx => one(await tx.query(
    `select count(*)::int as n from hub.notifications where staff_id = $1 and read_at is null and (client_account_id is null or hub.can_access_client(client_account_id))`, [ctx.staff.id])).n);
}

export async function markNotificationsRead(ctx, id) {
  if (id !== undefined && !isUuid(id)) throw notFound();
  return asStaff(ctx, async tx => {
    await tx.query(`update hub.notifications set read_at = now() where read_at is null and ($1::uuid is null or id = $1)`, [id ?? null]);
    return {};
  });
}

// Recovery --------------------------------------------------------------------

export async function listRecoveryRequests(ctx, websiteId) {
  requirePermission(ctx.staff, 'backup.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select q.id, q.website_id, q.backup_run_id, q.reason, q.status, q.outcome_notes, q.evidence_ref, q.created_at, q.closed_at, q.requested_by,
       r.display_name as requested_by_name, d.display_name as decided_by_name, b.finished_at as backup_finished_at
     from hub.recovery_requests q
     join hub.staff_users r on r.id = q.requested_by
     left join hub.staff_users d on d.id = q.decided_by
     join hub.backup_runs b on b.id = q.backup_run_id
     where q.website_id = $1 order by q.created_at desc limit 50`, [websiteId])).rows);
}

export async function requestRecovery(ctx, input) {
  requirePermission(ctx.staff, 'backup.write');
  const data = parse(schemas.recoveryRequest, input);
  return asStaff(ctx, async tx => {
    const run = one(await tx.query(
      `select r.id, r.client_account_id, s.website_id from hub.backup_runs r join hub.backup_sources s on s.id = r.source_id where r.id = $1`, [data.backup_run_id]));
    if (!run) throw notFound();
    const row = one(await tx.query(
      `insert into hub.recovery_requests (client_account_id, website_id, backup_run_id, reason, requested_by) values ($1, $2, $3, $4, $5) returning id`,
      [run.client_account_id, run.website_id, run.id, data.reason, ctx.staff.id]));
    await auditStaff(tx, ctx, 'recovery.request', { entityType: 'recovery_request', entityId: row.id, clientId: run.client_account_id });
    return { id: row.id, website_id: run.website_id };
  });
}

const RECOVERY_MOVES = { approve: ['requested', 'approved'], reject: ['requested', 'rejected'], start: ['approved', 'in_progress'] };

// The hub tracks and authorizes a recovery. People carry it out, so it never
// restores anything by itself.
export async function moveRecovery(ctx, id, action, input = {}) {
  requirePermission(ctx.staff, 'operation.decide');
  if (!isUuid(id)) throw notFound();
  return asStaff(ctx, async tx => {
    const request = one(await tx.query(`select id, client_account_id, website_id, status, requested_by from hub.recovery_requests where id = $1`, [id]));
    if (!request) throw notFound();
    if (action === 'close') {
      if (request.status !== 'in_progress') throw conflict('Only a recovery in progress can be closed.');
      const data = parse(schemas.recoveryClose, input);
      await tx.query(`update hub.recovery_requests set status = $2, outcome_notes = $3, evidence_ref = $4, closed_at = now() where id = $1`,
        [id, data.outcome, data.outcome_notes, data.evidence_ref ?? null]);
      await tx.query(
        `insert into hub.service_history (client_account_id, website_id, kind, summary, source, performed_by) values ($1, $2, 'restore', $3, 'staff', $4)`,
        [request.client_account_id, request.website_id, `Recovery ${data.outcome}: ${data.outcome_notes}`.slice(0, 4000), ctx.staff.id]);
      await auditStaff(tx, ctx, 'recovery.close', { entityType: 'recovery_request', entityId: id, clientId: request.client_account_id, metadata: { outcome: data.outcome } });
      return { id, website_id: request.website_id };
    }
    const move = RECOVERY_MOVES[action];
    if (!move) throw notFound();
    if (request.status !== move[0]) throw conflict('This request is not in a state that allows that.');
    if (action === 'approve' && request.requested_by === ctx.staff.id) throw forbidden('A second person must approve your request.');
    if (action === 'start') {
      await tx.query(`update hub.recovery_requests set status = 'in_progress' where id = $1`, [id]);
    } else {
      await tx.query(`update hub.recovery_requests set status = $2, decided_by = $3, decided_at = now(), closed_at = case when $2 = 'rejected' then now() end where id = $1`, [id, move[1], ctx.staff.id]);
    }
    await auditStaff(tx, ctx, `recovery.${action}`, { entityType: 'recovery_request', entityId: id, clientId: request.client_account_id });
    return { id, website_id: request.website_id };
  });
}

// Account ---------------------------------------------------------------------

export async function listOwnSessions(ctx) {
  return ctx.db.as('hub_auth', null, async tx => (await tx.query(
    `select id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, mfa_reported from hub.staff_sessions
     where staff_id = $1 and revoked_at is null and idle_expires_at > now() and absolute_expires_at > now() order by last_seen_at desc limit 50`, [ctx.staff.id])).rows);
}

export async function revokeOwnSession(ctx, id) {
  if (!isUuid(id)) throw notFound();
  return ctx.db.as('hub_auth', null, async tx => {
    const { rows } = await tx.query(
      `update hub.staff_sessions set revoked_at = now() where id = $1 and staff_id = $2 and revoked_at is null returning id`, [id, ctx.staff.id]);
    if (!rows.length) throw notFound();
    return { id };
  });
}
