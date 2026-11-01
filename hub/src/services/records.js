import { auditStaff } from '../audit.js';
import { requirePermission } from '../authz.js';
import { one } from '../db.js';
import { conflict, invalid, notFound } from '../errors.js';
import { isUuid, parse, schemas } from '../validation.js';

const asStaff = (ctx, fn) => ctx.db.as('hub_app', ctx.staff.id, fn);

// Runs a write and turns database constraint failures into staff-readable errors.
async function guarded(fn, uniqueMessage = 'That record already exists.') {
  try {
    return await fn();
  } catch (error) {
    if (error?.code === '23505') throw conflict(uniqueMessage);
    if (error?.code === '23503') throw invalid({ _: 'A linked record is not available to you.' });
    if (error?.code === '42501') throw notFound();
    throw error;
  }
}

// Row level security hides other clients' rows, so a foreign ID is simply absent.
// Staff get the same response whether a record is missing or not theirs.
async function visibleWebsite(tx, websiteId) {
  if (!isUuid(websiteId)) throw notFound();
  const row = one(await tx.query(`select id, client_account_id from hub.managed_websites where id = $1`, [websiteId]));
  if (!row) throw notFound();
  return row;
}

// Clients --------------------------------------------------------------------

export async function listClients(ctx) {
  requirePermission(ctx.staff, 'client.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select c.id, c.display_name, c.status, c.stackltr_company_id, c.stackltr_billing_ref,
       (select count(*)::int from hub.managed_websites w where w.client_account_id = c.id and w.lifecycle <> 'offboarded') as website_count
     from hub.client_accounts c order by lower(c.display_name)`)).rows);
}

export async function getClient(ctx, id) {
  requirePermission(ctx.staff, 'client.read');
  if (!isUuid(id)) throw notFound();
  const client = await asStaff(ctx, async tx => one(await tx.query(`select * from hub.client_accounts where id = $1`, [id])));
  if (!client) throw notFound();
  return client;
}

export async function createClient(ctx, input) {
  requirePermission(ctx.staff, 'client.write');
  const data = parse(schemas.client, input);
  return guarded(() => asStaff(ctx, async tx => {
    const row = one(await tx.query(
      `insert into hub.client_accounts (display_name, status, stackltr_workspace_id, stackltr_company_id, stackltr_billing_ref, created_by)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [data.display_name, data.status, data.stackltr_workspace_id ?? null, data.stackltr_company_id ?? null, data.stackltr_billing_ref ?? null, ctx.staff.id]));
    await auditStaff(tx, ctx, 'client.create', { entityType: 'client_account', entityId: row.id, clientId: row.id, metadata: { linked_to_stackltr: Boolean(data.stackltr_company_id) } });
    return row;
  }), 'That StackLTR company is already linked to a client.');
}

export async function updateClient(ctx, id, input) {
  requirePermission(ctx.staff, 'client.write');
  if (!isUuid(id)) throw notFound();
  const data = parse(schemas.client, input);
  return guarded(() => asStaff(ctx, async tx => {
    const row = one(await tx.query(
      `update hub.client_accounts set display_name = $2, status = $3, stackltr_workspace_id = $4, stackltr_company_id = $5,
         stackltr_billing_ref = $6, updated_at = now() where id = $1 returning id`,
      [id, data.display_name, data.status, data.stackltr_workspace_id ?? null, data.stackltr_company_id ?? null, data.stackltr_billing_ref ?? null]));
    if (!row) throw notFound();
    await auditStaff(tx, ctx, 'client.update', { entityType: 'client_account', entityId: id, clientId: id, metadata: { status: data.status } });
    return row;
  }), 'That StackLTR company is already linked to a client.');
}

// Service plans --------------------------------------------------------------

export async function listPlans(ctx) {
  requirePermission(ctx.staff, 'website.read');
  return asStaff(ctx, async tx => (await tx.query(`select * from hub.service_plans where active order by lower(name)`)).rows);
}

export async function createPlan(ctx, input) {
  requirePermission(ctx.staff, 'plan.write');
  const data = parse(schemas.plan, input);
  return guarded(() => asStaff(ctx, async tx => {
    const row = one(await tx.query(
      `insert into hub.service_plans (name, description, maintenance_interval_days, stackltr_billing_ref, created_by)
       values ($1, $2, $3, $4, $5) returning id`,
      [data.name, data.description, data.maintenance_interval_days ?? null, data.stackltr_billing_ref ?? null, ctx.staff.id]));
    await auditStaff(tx, ctx, 'plan.create', { entityType: 'service_plan', entityId: row.id, metadata: { name: data.name } });
    return row;
  }), 'A service plan with that name already exists.');
}

// Websites -------------------------------------------------------------------

const WEBSITE_LIST = `
  select w.id, w.client_account_id, w.display_name, w.primary_url, w.cms_platform, w.cms_other_name, w.hosting_provider, w.lifecycle,
    c.display_name as client_name, p.name as plan_name,
    (select count(*)::int from hub.maintenance_tasks t where t.website_id = w.id and t.status in ('open', 'in_progress', 'blocked')) as open_tasks,
    (select r.outcome from hub.monitoring_results r join hub.monitoring_checks m on m.id = r.check_id
       where m.website_id = w.id and m.kind = 'uptime' order by r.checked_at desc limit 1) as uptime_outcome,
    (select r.checked_at from hub.monitoring_results r join hub.monitoring_checks m on m.id = r.check_id
       where m.website_id = w.id and m.kind = 'uptime' order by r.checked_at desc limit 1) as uptime_checked_at
  from hub.managed_websites w
  join hub.client_accounts c on c.id = w.client_account_id
  left join hub.service_plans p on p.id = w.service_plan_id`;

export async function listWebsites(ctx, { search } = {}) {
  requirePermission(ctx.staff, 'website.read');
  const term = typeof search === 'string' ? search.trim().slice(0, 100) : '';
  return asStaff(ctx, async tx => (await tx.query(
    `${WEBSITE_LIST}
     where $1 = '' or w.display_name ilike '%' || $1 || '%' or w.primary_url ilike '%' || $1 || '%' or c.display_name ilike '%' || $1 || '%'
     order by lower(c.display_name), lower(w.display_name) limit 500`, [term])).rows);
}

export async function getWebsite(ctx, id) {
  requirePermission(ctx.staff, 'website.read');
  if (!isUuid(id)) throw notFound();
  const row = await asStaff(ctx, async tx => one(await tx.query(`
    select w.*, c.display_name as client_name, c.stackltr_company_id, c.stackltr_billing_ref, p.name as plan_name
    from hub.managed_websites w
    join hub.client_accounts c on c.id = w.client_account_id
    left join hub.service_plans p on p.id = w.service_plan_id
    where w.id = $1`, [id])));
  if (!row) throw notFound();
  return row;
}

export async function createWebsite(ctx, input) {
  requirePermission(ctx.staff, 'website.write');
  const data = parse(schemas.website, input);
  return guarded(() => asStaff(ctx, async tx => {
    if (!one(await tx.query(`select id from hub.client_accounts where id = $1`, [data.client_account_id]))) {
      throw invalid({ client_account_id: 'Choose a client you are assigned to.' });
    }
    const row = one(await tx.query(
      `insert into hub.managed_websites (client_account_id, display_name, primary_url, cms_platform, cms_other_name, hosting_provider, service_plan_id, lifecycle, notes, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [data.client_account_id, data.display_name, data.primary_url, data.cms_platform, data.cms_other_name, data.hosting_provider ?? null,
        data.service_plan_id ?? null, data.lifecycle, data.notes, ctx.staff.id]));
    await auditStaff(tx, ctx, 'website.create', { entityType: 'managed_website', entityId: row.id, clientId: data.client_account_id, metadata: { url: data.primary_url, platform: data.cms_platform } });
    return row;
  }), 'A website with that address is already managed.');
}

export async function updateWebsite(ctx, id, input) {
  requirePermission(ctx.staff, 'website.write');
  const data = parse(schemas.website, input);
  return guarded(() => asStaff(ctx, async tx => {
    const current = await visibleWebsite(tx, id);
    // Moving a site between clients would carry its history across the boundary.
    if (current.client_account_id !== data.client_account_id) throw invalid({ client_account_id: 'A website cannot move to another client.' });
    await tx.query(
      `update hub.managed_websites set display_name = $2, primary_url = $3, cms_platform = $4, cms_other_name = $5, hosting_provider = $6,
         service_plan_id = $7, lifecycle = $8, notes = $9, updated_at = now() where id = $1`,
      [id, data.display_name, data.primary_url, data.cms_platform, data.cms_other_name, data.hosting_provider ?? null, data.service_plan_id ?? null, data.lifecycle, data.notes]);
    await auditStaff(tx, ctx, 'website.update', { entityType: 'managed_website', entityId: id, clientId: current.client_account_id, metadata: { url: data.primary_url, lifecycle: data.lifecycle } });
    return { id };
  }), 'A website with that address is already managed.');
}

// Maintenance ----------------------------------------------------------------

export async function listTasks(ctx, { websiteId, scope = 'open' } = {}) {
  requirePermission(ctx.staff, 'maintenance.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select t.id, t.website_id, t.client_account_id, t.title, t.details, t.status, t.priority, t.assignee_id, t.due_on::text as due_on, t.completed_at,
       t.completion_notes, t.stackltr_request_id, w.display_name as website_name, c.display_name as client_name, s.display_name as assignee_name
     from hub.maintenance_tasks t
     join hub.managed_websites w on w.id = t.website_id
     join hub.client_accounts c on c.id = t.client_account_id
     left join hub.staff_users s on s.id = t.assignee_id
     where ($1::uuid is null or t.website_id = $1)
       and (($2 = 'open' and t.status in ('open', 'in_progress', 'blocked')) or ($2 = 'all'))
     order by t.due_on nulls last, t.created_at desc limit 200`,
    [websiteId ?? null, scope])).rows);
}

async function assertAssignable(tx, assigneeId, clientId) {
  if (!assigneeId) return;
  const row = one(await tx.query(`select role, status from hub.staff_users where id = $1`, [assigneeId]));
  if (!row || row.status !== 'active') throw invalid({ assignee_id: 'Choose an active staff member.' });
  if (!['owner', 'admin', 'technician'].includes(row.role)) throw invalid({ assignee_id: 'This role cannot carry out maintenance.' });
  // Work must never go to someone who is not allowed to see this client.
  const { allowed } = one(await tx.query(`select hub.staff_can_access_client($1, $2) as allowed`, [assigneeId, clientId]));
  if (!allowed) throw invalid({ assignee_id: 'This person is not assigned to this client.' });
}

export async function createTask(ctx, input) {
  requirePermission(ctx.staff, 'maintenance.write');
  const data = parse(schemas.task, input);
  return guarded(() => asStaff(ctx, async tx => {
    const website = await visibleWebsite(tx, data.website_id);
    await assertAssignable(tx, data.assignee_id, website.client_account_id);
    const row = one(await tx.query(
      `insert into hub.maintenance_tasks (client_account_id, website_id, title, details, priority, assignee_id, due_on, stackltr_request_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [website.client_account_id, website.id, data.title, data.details, data.priority, data.assignee_id ?? null, data.due_on ?? null, data.stackltr_request_id ?? null, ctx.staff.id]));
    await auditStaff(tx, ctx, 'task.create', { entityType: 'maintenance_task', entityId: row.id, clientId: website.client_account_id, metadata: { title: data.title, assignee_id: data.assignee_id ?? null } });
    return row;
  }));
}

export async function updateTask(ctx, id, input) {
  requirePermission(ctx.staff, 'maintenance.write');
  if (!isUuid(id)) throw notFound();
  const data = parse(schemas.taskUpdate, input);
  return guarded(() => asStaff(ctx, async tx => {
    const task = one(await tx.query(`select id, client_account_id, status from hub.maintenance_tasks where id = $1`, [id]));
    if (!task) throw notFound();
    if (task.status === 'completed') throw conflict('A completed task is part of the service record and cannot be changed.');
    await assertAssignable(tx, data.assignee_id, task.client_account_id);
    // An assignee left out of the request stays as it is; an empty one clears it.
    await tx.query(
      `update hub.maintenance_tasks set status = coalesce($2, status),
         assignee_id = case when $4::boolean then $3::uuid else assignee_id end, updated_at = now() where id = $1`,
      [id, data.status ?? null, data.assignee_id ?? null, data.assignee_id !== undefined]);
    await auditStaff(tx, ctx, 'task.update', { entityType: 'maintenance_task', entityId: id, clientId: task.client_account_id, metadata: { status: data.status ?? task.status, assignee_id: data.assignee_id ?? null } });
    return { id };
  }));
}

// Completing a task writes its history entry and queues the StackLTR note in the
// same transaction, so the record of work cannot disagree with the task.
export async function completeTask(ctx, id, input) {
  requirePermission(ctx.staff, 'maintenance.write');
  if (!isUuid(id)) throw notFound();
  const data = parse(schemas.taskComplete, input);
  return guarded(() => asStaff(ctx, async tx => {
    const task = one(await tx.query(`select * from hub.maintenance_tasks where id = $1`, [id]));
    if (!task) throw notFound();
    if (task.status === 'completed') throw conflict('This task is already completed.');
    if (task.status === 'cancelled') throw conflict('A cancelled task cannot be completed.');
    await tx.query(
      `update hub.maintenance_tasks set status = 'completed', completed_at = now(), completed_by = $2, completion_notes = $3, updated_at = now() where id = $1`,
      [id, ctx.staff.id, data.completion_notes]);
    await tx.query(
      `insert into hub.service_history (client_account_id, website_id, task_id, kind, summary, source, performed_by)
       values ($1, $2, $3, 'maintenance', $4, 'staff', $5)`,
      [task.client_account_id, task.website_id, id, `${task.title}: ${data.completion_notes}`, ctx.staff.id]);
    await tx.query(
      `insert into hub.stackltr_outbox (client_account_id, event_type, idempotency_key, payload)
       values ($1, 'maintenance.completed', $2, $3::jsonb)`,
      [task.client_account_id, `maintenance.completed:${id}`, JSON.stringify({
        task_id: id, website_id: task.website_id, title: task.title, stackltr_request_id: task.stackltr_request_id
      })]);
    if (task.schedule_id) {
      await tx.query(
        `update hub.maintenance_schedules set next_due_on = greatest(next_due_on, current_date) + interval_days where id = $1`, [task.schedule_id]);
    }
    await auditStaff(tx, ctx, 'task.complete', { entityType: 'maintenance_task', entityId: id, clientId: task.client_account_id, metadata: { title: task.title } });
    return { id };
  }));
}

export async function listSchedules(ctx, { websiteId } = {}) {
  requirePermission(ctx.staff, 'maintenance.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select m.id, m.website_id, m.title, m.interval_days, m.next_due_on::text as next_due_on, m.active, m.client_account_id,
       w.display_name as website_name, c.display_name as client_name, s.display_name as assignee_name
     from hub.maintenance_schedules m
     join hub.managed_websites w on w.id = m.website_id
     join hub.client_accounts c on c.id = m.client_account_id
     left join hub.staff_users s on s.id = m.default_assignee_id
     where m.active and ($1::uuid is null or m.website_id = $1) order by m.next_due_on limit 200`, [websiteId ?? null])).rows);
}

export async function createSchedule(ctx, input) {
  requirePermission(ctx.staff, 'maintenance.write');
  const data = parse(schemas.schedule, input);
  return guarded(() => asStaff(ctx, async tx => {
    const website = await visibleWebsite(tx, data.website_id);
    await assertAssignable(tx, data.default_assignee_id, website.client_account_id);
    const row = one(await tx.query(
      `insert into hub.maintenance_schedules (client_account_id, website_id, title, interval_days, next_due_on, default_assignee_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [website.client_account_id, website.id, data.title, data.interval_days, data.next_due_on, data.default_assignee_id ?? null, ctx.staff.id]));
    await auditStaff(tx, ctx, 'schedule.create', { entityType: 'maintenance_schedule', entityId: row.id, clientId: website.client_account_id, metadata: { title: data.title, interval_days: data.interval_days } });
    return row;
  }));
}

// Turns a due schedule into a task. Staff start this; it is not silently automatic.
export async function createTaskFromSchedule(ctx, id) {
  requirePermission(ctx.staff, 'maintenance.write');
  if (!isUuid(id)) throw notFound();
  return guarded(() => asStaff(ctx, async tx => {
    const schedule = one(await tx.query(`select *, next_due_on::text as due from hub.maintenance_schedules where id = $1 and active`, [id]));
    if (!schedule) throw notFound();
    const open = one(await tx.query(`select id from hub.maintenance_tasks where schedule_id = $1 and status in ('open', 'in_progress', 'blocked') limit 1`, [id]));
    if (open) throw conflict('This schedule already has an open task.');
    const row = one(await tx.query(
      `insert into hub.maintenance_tasks (client_account_id, website_id, schedule_id, title, assignee_id, due_on, created_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [schedule.client_account_id, schedule.website_id, id, schedule.title, schedule.default_assignee_id, schedule.due, ctx.staff.id]));
    await auditStaff(tx, ctx, 'task.create', { entityType: 'maintenance_task', entityId: row.id, clientId: schedule.client_account_id, metadata: { title: schedule.title, schedule_id: id } });
    return row;
  }));
}

// Service history ------------------------------------------------------------

export async function listHistory(ctx, websiteId) {
  requirePermission(ctx.staff, 'website.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select h.id, h.kind, h.summary, h.source, h.performed_at, s.display_name as performed_by_name
     from hub.service_history h left join hub.staff_users s on s.id = h.performed_by
     where h.website_id = $1 order by h.performed_at desc limit 200`, [websiteId])).rows);
}

export async function addHistory(ctx, input) {
  requirePermission(ctx.staff, 'maintenance.write');
  const data = parse(schemas.history, input);
  return guarded(() => asStaff(ctx, async tx => {
    const website = await visibleWebsite(tx, data.website_id);
    const row = one(await tx.query(
      `insert into hub.service_history (client_account_id, website_id, kind, summary, source, performed_by, performed_at)
       values ($1, $2, $3, $4, 'staff', $5, $6) returning id`,
      [website.client_account_id, website.id, data.kind, data.summary, ctx.staff.id, data.performed_at]));
    await auditStaff(tx, ctx, 'history.add', { entityType: 'service_history', entityId: row.id, clientId: website.client_account_id, metadata: { kind: data.kind } });
    return row;
  }));
}

// Monitoring -----------------------------------------------------------------

export async function listChecks(ctx, { websiteId } = {}) {
  requirePermission(ctx.staff, 'monitoring.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select m.id, m.website_id, m.kind, m.target_url, m.interval_minutes, m.enabled, m.next_run_at,
       w.display_name as website_name, c.display_name as client_name,
       r.outcome, r.http_status, r.response_ms, r.tls_valid_to, r.tls_issuer, r.error_code, r.checked_at
     from hub.monitoring_checks m
     join hub.managed_websites w on w.id = m.website_id
     join hub.client_accounts c on c.id = m.client_account_id
     left join lateral (select * from hub.monitoring_results x where x.check_id = m.id order by x.checked_at desc limit 1) r on true
     where $1::uuid is null or m.website_id = $1 order by lower(w.display_name), m.kind limit 300`, [websiteId ?? null])).rows);
}

export async function createCheck(ctx, input) {
  requirePermission(ctx.staff, 'monitoring.write');
  const data = parse(schemas.monitoringCheck, input);
  return guarded(() => asStaff(ctx, async tx => {
    const website = await visibleWebsite(tx, data.website_id);
    const { primary_url: target } = one(await tx.query(`select primary_url from hub.managed_websites where id = $1`, [website.id]));
    if (data.kind === 'ssl' && !target.startsWith('https://')) throw invalid({ kind: 'A certificate check needs an https address.' });
    const row = one(await tx.query(
      `insert into hub.monitoring_checks (client_account_id, website_id, kind, target_url, interval_minutes, created_by)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [website.client_account_id, website.id, data.kind, target, data.interval_minutes, ctx.staff.id]));
    await auditStaff(tx, ctx, 'monitoring.enable', { entityType: 'monitoring_check', entityId: row.id, clientId: website.client_account_id, metadata: { kind: data.kind } });
    return row;
  }), 'That check already exists for this website.');
}

// Security reviews -----------------------------------------------------------

export async function listSecurityReviews(ctx, { websiteId } = {}) {
  requirePermission(ctx.staff, 'security.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select r.id, r.website_id, r.scope, r.outcome, r.summary, r.evidence_ref, r.reviewed_at, r.next_due_on::text as next_due_on,
       w.display_name as website_name, c.display_name as client_name, s.display_name as reviewer_name
     from hub.security_reviews r
     join hub.managed_websites w on w.id = r.website_id
     join hub.client_accounts c on c.id = r.client_account_id
     join hub.staff_users s on s.id = r.reviewed_by
     where $1::uuid is null or r.website_id = $1 order by r.reviewed_at desc limit 200`, [websiteId ?? null])).rows);
}

export async function createSecurityReview(ctx, input) {
  requirePermission(ctx.staff, 'security.write');
  const data = parse(schemas.securityReview, input);
  return guarded(() => asStaff(ctx, async tx => {
    const website = await visibleWebsite(tx, data.website_id);
    const row = one(await tx.query(
      `insert into hub.security_reviews (client_account_id, website_id, scope, outcome, summary, evidence_ref, reviewed_by, reviewed_at, next_due_on)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [website.client_account_id, website.id, data.scope, data.outcome, data.summary, data.evidence_ref ?? null, ctx.staff.id, data.reviewed_at, data.next_due_on ?? null]));
    await tx.query(
      `insert into hub.service_history (client_account_id, website_id, kind, summary, source, performed_by, performed_at)
       values ($1, $2, 'security', $3, 'staff', $4, $5)`,
      [website.client_account_id, website.id, `Security review recorded (${data.outcome.replace('_', ' ')}): ${data.scope}`, ctx.staff.id, data.reviewed_at]);
    await auditStaff(tx, ctx, 'security_review.create', { entityType: 'security_review', entityId: row.id, clientId: website.client_account_id, metadata: { outcome: data.outcome } });
    return row;
  }));
}

// Backups --------------------------------------------------------------------

// Restore evidence is only trusted for a limited time, because a site changes.
export const RESTORE_EVIDENCE_DAYS = 90;

// The single place that decides what may be said about a backup source. Only a
// passed restore of a successful backup, recent enough, counts as verified.
export function recoverabilityOf({ latestRunStatus, latestPassedAt, latestFailedAt }, now = new Date()) {
  if (!latestRunStatus) return { state: 'no_backups', label: 'No backups recorded', verified: false };
  const cutoff = now.getTime() - RESTORE_EVIDENCE_DAYS * 86400000;
  const passed = latestPassedAt ? new Date(latestPassedAt).getTime() : null;
  const failed = latestFailedAt ? new Date(latestFailedAt).getTime() : null;
  if (failed && (!passed || failed > passed)) return { state: 'restore_failed', label: 'Latest restore test did not pass', verified: false };
  if (passed && passed >= cutoff) return { state: 'verified', label: 'Restore verified with evidence', verified: true };
  if (passed) return { state: 'evidence_stale', label: `Restore evidence older than ${RESTORE_EVIDENCE_DAYS} days`, verified: false };
  return { state: 'unverified', label: 'Not verified: no restore test on record', verified: false };
}

export async function listBackupSources(ctx, { websiteId } = {}) {
  requirePermission(ctx.staff, 'backup.read');
  const rows = await asStaff(ctx, async tx => (await tx.query(
    `select b.id, b.website_id, b.provider, b.label, b.expected_interval_hours, b.active, w.display_name as website_name, c.display_name as client_name,
       latest.id as latest_run_id, latest.status as latest_run_status, latest.finished_at as latest_run_finished_at,
       (select max(v.performed_at) from hub.restore_verifications v join hub.backup_runs r on r.id = v.backup_run_id
         where r.source_id = b.id and v.outcome = 'passed') as latest_passed_at,
       (select max(v.performed_at) from hub.restore_verifications v join hub.backup_runs r on r.id = v.backup_run_id
         where r.source_id = b.id and v.outcome <> 'passed') as latest_failed_at
     from hub.backup_sources b
     join hub.managed_websites w on w.id = b.website_id
     join hub.client_accounts c on c.id = b.client_account_id
     left join lateral (select * from hub.backup_runs r where r.source_id = b.id order by r.finished_at desc limit 1) latest on true
     where b.active and ($1::uuid is null or b.website_id = $1) order by lower(w.display_name), lower(b.label) limit 200`, [websiteId ?? null])).rows);
  return rows.map(row => ({
    ...row,
    recoverability: recoverabilityOf({ latestRunStatus: row.latest_run_status, latestPassedAt: row.latest_passed_at, latestFailedAt: row.latest_failed_at })
  }));
}

export async function createBackupSource(ctx, input) {
  requirePermission(ctx.staff, 'backup.write');
  const data = parse(schemas.backupSource, input);
  return guarded(() => asStaff(ctx, async tx => {
    const website = await visibleWebsite(tx, data.website_id);
    const row = one(await tx.query(
      `insert into hub.backup_sources (client_account_id, website_id, provider, label, expected_interval_hours, created_by)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [website.client_account_id, website.id, data.provider, data.label, data.expected_interval_hours ?? null, ctx.staff.id]));
    await auditStaff(tx, ctx, 'backup_source.create', { entityType: 'backup_source', entityId: row.id, clientId: website.client_account_id, metadata: { provider: data.provider } });
    return row;
  }));
}

export async function listBackupRuns(ctx, websiteId) {
  requirePermission(ctx.staff, 'backup.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select r.id, r.source_id, r.status, r.finished_at, r.size_bytes, r.artifact_ref, r.reported_by, b.label as source_label
     from hub.backup_runs r join hub.backup_sources b on b.id = r.source_id
     where b.website_id = $1 order by r.finished_at desc limit 50`, [websiteId])).rows);
}

export async function recordBackupRun(ctx, input) {
  requirePermission(ctx.staff, 'backup.write');
  const data = parse(schemas.backupRun, input);
  return guarded(() => asStaff(ctx, async tx => {
    const source = one(await tx.query(`select id, client_account_id, website_id from hub.backup_sources where id = $1`, [data.source_id]));
    if (!source) throw notFound();
    const row = one(await tx.query(
      `insert into hub.backup_runs (client_account_id, source_id, status, finished_at, size_bytes, artifact_ref, reported_by, recorded_by)
       values ($1, $2, $3, $4, $5, $6, 'staff', $7) returning id`,
      [source.client_account_id, source.id, data.status, data.finished_at, data.size_bytes ?? null, data.artifact_ref ?? null, ctx.staff.id]));
    await tx.query(
      `insert into hub.service_history (client_account_id, website_id, kind, summary, source, performed_by, performed_at)
       values ($1, $2, 'backup', $3, 'staff', $4, $5)`,
      [source.client_account_id, source.website_id, `Backup run recorded as ${data.status}. This does not show that it can be restored.`, ctx.staff.id, data.finished_at]);
    await auditStaff(tx, ctx, 'backup_run.record', { entityType: 'backup_run', entityId: row.id, clientId: source.client_account_id, metadata: { status: data.status } });
    return row;
  }));
}

export async function recordRestoreVerification(ctx, input) {
  requirePermission(ctx.staff, 'backup.write');
  const data = parse(schemas.restoreVerification, input);
  try {
    return await guarded(() => asStaff(ctx, async tx => {
      const run = one(await tx.query(
        `select r.id, r.client_account_id, b.website_id from hub.backup_runs r join hub.backup_sources b on b.id = r.source_id where r.id = $1`, [data.backup_run_id]));
      if (!run) throw notFound();
      const row = one(await tx.query(
        `insert into hub.restore_verifications (client_account_id, backup_run_id, target_environment, outcome, checks_performed, evidence_ref, performed_by, performed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [run.client_account_id, run.id, data.target_environment, data.outcome, data.checks_performed, data.evidence_ref ?? null, ctx.staff.id, data.performed_at]));
      await tx.query(
        `insert into hub.service_history (client_account_id, website_id, kind, summary, source, performed_by, performed_at)
         values ($1, $2, 'restore', $3, 'staff', $4, $5)`,
        [run.client_account_id, run.website_id, `Restore test ${data.outcome} in ${data.target_environment}.`, ctx.staff.id, data.performed_at]);
      await auditStaff(tx, ctx, 'restore.verify', { entityType: 'restore_verification', entityId: row.id, clientId: run.client_account_id, metadata: { outcome: data.outcome, environment: data.target_environment } });
      return row;
    }));
  } catch (error) {
    if (error?.code === '23514') throw invalid({ outcome: 'A passed restore needs a backup run that succeeded.' });
    throw error;
  }
}

// Staff and assignments ------------------------------------------------------

export async function listAssignableStaff(ctx) {
  requirePermission(ctx.staff, 'maintenance.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select id, display_name, role from hub.staff_users where status = 'active' and role in ('owner', 'admin', 'technician') order by lower(display_name)`)).rows);
}

export async function listStaff(ctx) {
  requirePermission(ctx.staff, 'staff.read');
  return asStaff(ctx, async tx => {
    const staff = (await tx.query(`select id, email, display_name, role, status, last_login_at from hub.staff_users order by lower(display_name)`)).rows;
    const assignments = (await tx.query(
      `select a.staff_id, a.client_account_id, c.display_name as client_name
       from hub.staff_client_assignments a join hub.client_accounts c on c.id = a.client_account_id order by lower(c.display_name)`)).rows;
    return staff.map(member => ({ ...member, assignments: assignments.filter(item => item.staff_id === member.id) }));
  });
}

export async function createStaff(ctx, input) {
  requirePermission(ctx.staff, 'staff.write');
  const data = parse(schemas.staff, input);
  if (data.role === 'owner' && ctx.staff.role !== 'owner') throw invalid({ role: 'Only an owner can add another owner.' });
  return guarded(() => asStaff(ctx, async tx => {
    const row = one(await tx.query(
      `insert into hub.staff_users (email, display_name, role) values ($1, $2, $3) returning id`, [data.email, data.display_name, data.role]));
    await auditStaff(tx, ctx, 'staff.create', { entityType: 'staff_user', entityId: row.id, metadata: { role: data.role } });
    return row;
  }), 'A staff member with that email already exists.');
}

export async function updateStaff(ctx, id, input) {
  requirePermission(ctx.staff, 'staff.write');
  if (!isUuid(id)) throw notFound();
  const data = parse(schemas.staffUpdate, input);
  if (id === ctx.staff.id) throw invalid({ role: 'You cannot change your own role or status.' });
  if (data.role === 'owner' && ctx.staff.role !== 'owner') throw invalid({ role: 'Only an owner can make someone an owner.' });
  return guarded(() => asStaff(ctx, async tx => {
    const row = one(await tx.query(
      `update hub.staff_users set role = $2, status = $3, updated_at = now() where id = $1 returning id`, [id, data.role, data.status]));
    if (!row) throw notFound();
    await auditStaff(tx, ctx, 'staff.update', { entityType: 'staff_user', entityId: id, metadata: { role: data.role, status: data.status } });
    return row;
  }));
}

export async function assignStaff(ctx, input) {
  requirePermission(ctx.staff, 'staff.write');
  const data = parse(schemas.assignment, input);
  return guarded(() => asStaff(ctx, async tx => {
    await tx.query(
      `insert into hub.staff_client_assignments (staff_id, client_account_id, assigned_by) values ($1, $2, $3)`,
      [data.staff_id, data.client_account_id, ctx.staff.id]);
    await auditStaff(tx, ctx, 'staff.assign', { entityType: 'staff_user', entityId: data.staff_id, clientId: data.client_account_id });
    return data;
  }), 'That staff member is already assigned to this client.');
}

export async function unassignStaff(ctx, input) {
  requirePermission(ctx.staff, 'staff.write');
  const data = parse(schemas.assignment, input);
  return asStaff(ctx, async tx => {
    await tx.query(`delete from hub.staff_client_assignments where staff_id = $1 and client_account_id = $2`, [data.staff_id, data.client_account_id]);
    await auditStaff(tx, ctx, 'staff.unassign', { entityType: 'staff_user', entityId: data.staff_id, clientId: data.client_account_id });
    return data;
  });
}

// Audit log ------------------------------------------------------------------

export async function listAudit(ctx, { limit = 200 } = {}) {
  requirePermission(ctx.staff, 'audit.read');
  return asStaff(ctx, async tx => {
    const entries = (await tx.query(
      `select a.seq, a.occurred_at, a.actor_type, a.action, a.outcome, a.entity_type, a.entity_id, a.request_id, a.metadata,
         s.display_name as actor_name, c.display_name as client_name
       from hub.audit_log a
       left join hub.staff_users s on s.id = a.actor_staff_id
       left join hub.client_accounts c on c.id = a.client_account_id
       order by a.seq desc limit $1`, [Math.min(limit, 500)])).rows;
    const { broken } = one(await tx.query(`select hub.verify_audit_chain() as broken`));
    return { entries, chainBrokenAt: broken };
  });
}

// Overview -------------------------------------------------------------------

// Counts of real records only. Anything never measured stays null so the page
// can say "unknown" rather than imply a healthy zero.
export async function getOverview(ctx) {
  requirePermission(ctx.staff, 'overview.read');
  return asStaff(ctx, async tx => {
    const row = one(await tx.query(`
      select
        (select count(*)::int from hub.managed_websites where lifecycle <> 'offboarded') as websites,
        (select count(*)::int from hub.maintenance_tasks where status in ('open', 'in_progress', 'blocked')) as open_tasks,
        (select count(*)::int from hub.maintenance_tasks where status in ('open', 'in_progress', 'blocked') and due_on < current_date) as overdue_tasks,
        (select count(*)::int from hub.maintenance_schedules where active and next_due_on <= current_date + 7) as schedules_due,
        (select count(*)::int from hub.monitoring_checks where enabled) as active_checks,
        (select count(distinct check_id)::int from hub.monitoring_results) as checks_with_results,
        (select count(*)::int from hub.security_reviews) as security_reviews,
        (select count(*)::int from hub.backup_sources where active) as backup_sources,
        (select count(*)::int from hub.platform_connections where status = 'connected') as connected_platforms`));
    const certificates = (await tx.query(`
      select m.website_id, w.display_name as website_name, r.tls_valid_to
      from hub.monitoring_checks m
      join hub.managed_websites w on w.id = m.website_id
      join lateral (select tls_valid_to from hub.monitoring_results x where x.check_id = m.id order by x.checked_at desc limit 1) r on true
      where m.kind = 'ssl' and r.tls_valid_to is not null and r.tls_valid_to < now() + interval '30 days'
      order by r.tls_valid_to limit 20`)).rows;
    const reminders = (await tx.query(`
      select 'task' as kind, t.title, t.due_on::text as due_on, w.id as website_id, w.display_name as website_name
      from hub.maintenance_tasks t join hub.managed_websites w on w.id = t.website_id
      where t.status in ('open', 'in_progress', 'blocked') and t.due_on <= current_date + 7
      union all
      select 'schedule', m.title, m.next_due_on::text, w.id, w.display_name
      from hub.maintenance_schedules m join hub.managed_websites w on w.id = m.website_id
      where m.active and m.next_due_on <= current_date + 7
      union all
      select 'security_review', 'Security review due', r.next_due_on::text, w.id, w.display_name
      from hub.security_reviews r join hub.managed_websites w on w.id = r.website_id
      where r.next_due_on <= current_date + 7
        and r.reviewed_at = (select max(x.reviewed_at) from hub.security_reviews x where x.website_id = r.website_id)
      order by due_on limit 25`)).rows;
    return { ...row, certificates, reminders };
  });
}
