import { auditStaff } from '../audit.js';
import { requirePermission } from '../authz.js';
import { one } from '../db.js';
import { conflict, invalid, notFound } from '../errors.js';
import { isUuid, parse, schemas } from '../validation.js';

const asStaff = (ctx, fn) => ctx.db.as('hub_app', ctx.staff.id, fn);

async function guarded(fn, uniqueMessage) {
  try {
    return await fn();
  } catch (error) {
    if (error?.code === '23505') throw conflict(uniqueMessage);
    if (error?.code === '42501') throw notFound();
    throw error;
  }
}

async function website(tx, id) {
  if (!isUuid(id)) throw notFound();
  const row = one(await tx.query(`select id, client_account_id, lifecycle from hub.managed_websites where id = $1`, [id]));
  if (!row) throw notFound();
  return row;
}

// Hosting providers -----------------------------------------------------------

export async function listHostingProviders(ctx) {
  requirePermission(ctx.staff, 'website.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select p.id, p.name, p.support_url, p.notes, (select count(*)::int from hub.managed_websites w where w.hosting_provider_id = p.id) as website_count
     from hub.hosting_providers p where p.active order by lower(p.name)`)).rows);
}

export async function createHostingProvider(ctx, input) {
  requirePermission(ctx.staff, 'website.write');
  const data = parse(schemas.hostingProvider, input);
  return guarded(() => asStaff(ctx, async tx => {
    const row = one(await tx.query(
      `insert into hub.hosting_providers (name, support_url, notes, created_by) values ($1, $2, $3, $4) returning id`,
      [data.name, data.support_url ?? null, data.notes, ctx.staff.id]));
    await auditStaff(tx, ctx, 'hosting_provider.create', { entityType: 'hosting_provider', entityId: row.id, metadata: { name: data.name } });
    return row;
  }), 'A hosting provider with that name already exists.');
}

// Domains ---------------------------------------------------------------------

export async function listDomains(ctx, websiteId) {
  requirePermission(ctx.staff, 'website.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select id, hostname, is_primary, registrar, dns_provider, domain_owner, expires_on::text as expires_on, expiry_source, expiry_checked_at
     from hub.website_domains where website_id = $1 order by is_primary desc, hostname`, [websiteId])).rows);
}

export async function addDomain(ctx, websiteId, input) {
  requirePermission(ctx.staff, 'website.write');
  const data = parse(schemas.domain, input);
  return guarded(() => asStaff(ctx, async tx => {
    const site = await website(tx, websiteId);
    if (data.is_primary) {
      await tx.query(`update hub.website_domains set is_primary = false where website_id = $1 and is_primary`, [site.id]);
    }
    const row = one(await tx.query(
      `insert into hub.website_domains (client_account_id, website_id, hostname, is_primary, registrar, dns_provider, domain_owner, expires_on, expiry_source, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [site.client_account_id, site.id, data.hostname, data.is_primary, data.registrar ?? null, data.dns_provider ?? null, data.domain_owner ?? null,
        data.expires_on ?? null, data.expires_on ? 'manual' : null, ctx.staff.id]));
    await auditStaff(tx, ctx, 'domain.add', { entityType: 'website_domain', entityId: row.id, clientId: site.client_account_id, metadata: { hostname: data.hostname } });
    return row;
  }), 'That domain is already recorded.');
}

// Archive ---------------------------------------------------------------------

export async function archiveWebsite(ctx, id) {
  requirePermission(ctx.staff, 'website.write');
  return asStaff(ctx, async tx => {
    const site = await website(tx, id);
    if (site.lifecycle === 'archived') throw conflict('This website is already archived.');
    await tx.query(
      `update hub.managed_websites set lifecycle = 'archived', archived_at = now(), archived_by = $2, updated_at = now() where id = $1`, [id, ctx.staff.id]);
    await tx.query(`update hub.monitoring_checks set enabled = false where website_id = $1`, [id]);
    await auditStaff(tx, ctx, 'website.archive', { entityType: 'managed_website', entityId: id, clientId: site.client_account_id });
    return { id };
  });
}

// Monitoring stays off after restoring, since someone should decide to re-enable it.
export async function restoreWebsite(ctx, id) {
  requirePermission(ctx.staff, 'website.write');
  return asStaff(ctx, async tx => {
    const site = await website(tx, id);
    if (site.lifecycle !== 'archived') throw conflict('This website is not archived.');
    await tx.query(
      `update hub.managed_websites set lifecycle = 'paused', archived_at = null, archived_by = null, updated_at = now() where id = $1`, [id]);
    await auditStaff(tx, ctx, 'website.restore', { entityType: 'managed_website', entityId: id, clientId: site.client_account_id });
    return { id };
  });
}

export async function recordCmsVersion(ctx, id, input) {
  requirePermission(ctx.staff, 'website.write');
  const data = parse(schemas.cmsVersion, input);
  return asStaff(ctx, async tx => {
    const site = await website(tx, id);
    await tx.query(
      `update hub.managed_websites set cms_version = $2, cms_version_source = 'manual', cms_version_recorded_at = now(), updated_at = now() where id = $1`, [id, data.cms_version]);
    await auditStaff(tx, ctx, 'website.cms_version', { entityType: 'managed_website', entityId: id, clientId: site.client_account_id, metadata: { version: data.cms_version, source: 'manual' } });
    return { id };
  });
}

// Plans -----------------------------------------------------------------------

export async function listPlanTasks(ctx, planId) {
  requirePermission(ctx.staff, 'website.read');
  return asStaff(ctx, async tx => (await tx.query(
    `select id, plan_id, title, kind, interval_days from hub.plan_tasks where active and ($1::uuid is null or plan_id = $1) order by title`, [planId ?? null])).rows);
}

export async function addPlanTask(ctx, planId, input) {
  requirePermission(ctx.staff, 'plan.write');
  if (!isUuid(planId)) throw notFound();
  const data = parse(schemas.planTask, input);
  return asStaff(ctx, async tx => {
    if (!one(await tx.query(`select id from hub.service_plans where id = $1`, [planId]))) throw notFound();
    const row = one(await tx.query(
      `insert into hub.plan_tasks (plan_id, title, kind, interval_days) values ($1, $2, $3, $4) returning id`,
      [planId, data.title, data.kind, data.interval_days]));
    await auditStaff(tx, ctx, 'plan_task.add', { entityType: 'plan_task', entityId: row.id, metadata: { title: data.title } });
    return row;
  });
}

// Creates one recurring schedule per plan item. Running it again adds only what is new.
export async function applyPlanToWebsite(ctx, websiteId, input) {
  requirePermission(ctx.staff, 'maintenance.write');
  const data = parse(schemas.applyPlan, input);
  return asStaff(ctx, async tx => {
    const site = await website(tx, websiteId);
    const { rows: items } = await tx.query(`select id, title, kind, interval_days from hub.plan_tasks where plan_id = $1 and active`, [data.plan_id]);
    if (!items.length) throw invalid({ plan_id: 'This plan has no recurring work yet.' });
    await tx.query(`update hub.managed_websites set service_plan_id = $2, updated_at = now() where id = $1`, [site.id, data.plan_id]);
    let created = 0;
    for (const item of items) {
      const result = await tx.query(
        `insert into hub.maintenance_schedules (client_account_id, website_id, title, kind, interval_days, next_due_on, plan_task_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing returning id`,
        [site.client_account_id, site.id, item.title, item.kind, item.interval_days, data.first_due_on, item.id, ctx.staff.id]);
      created += result.rows.length;
    }
    await auditStaff(tx, ctx, 'plan.apply', { entityType: 'managed_website', entityId: site.id, clientId: site.client_account_id, metadata: { plan_id: data.plan_id, schedules_created: created } });
    return { created };
  });
}

// Reports ---------------------------------------------------------------------

// Everything here comes from recorded work. Empty months stay empty.
export async function maintenanceReport(ctx, { clientId, from, to }) {
  requirePermission(ctx.staff, 'maintenance.read');
  const filters = parse(schemas.report, { client_id: clientId, from, to });
  return asStaff(ctx, async tx => {
    const tasks = (await tx.query(
      `select t.id, t.title, t.kind, t.completed_at, t.completion_notes, t.completion_evidence_ref, w.display_name as website_name, c.display_name as client_name,
         s.display_name as completed_by_name, (select coalesce(sum(l.minutes), 0)::int from hub.task_work_logs l where l.task_id = t.id) as minutes
       from hub.maintenance_tasks t
       join hub.managed_websites w on w.id = t.website_id
       join hub.client_accounts c on c.id = t.client_account_id
       left join hub.staff_users s on s.id = t.completed_by
       where t.status = 'completed' and t.completed_at >= $1::date and t.completed_at < ($2::date + 1)
         and ($3::uuid is null or t.client_account_id = $3)
       order by t.completed_at desc limit 500`, [filters.from, filters.to, filters.client_id ?? null])).rows;
    return { ...filters, tasks, totalMinutes: tasks.reduce((sum, task) => sum + task.minutes, 0) };
  });
}
