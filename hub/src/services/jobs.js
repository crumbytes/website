import { randomUUID } from 'node:crypto';
import { safeCode } from '../adapters/framework.js';
import { writeAudit } from '../audit.js';
import { deliverEmails } from '../email.js';
import { OutboundError } from '../safe-http.js';
import { enqueueDueMaintenance } from './automation.js';
import { deliverOutbox } from '../stackltr.js';

const CODE = error => (error instanceof OutboundError ? error.code : 'internal_error');
const DAY = 86400000;

// A result row is only written when a probe truly ran. If probing is turned off,
// nothing is recorded and the check keeps showing as unknown.
export async function probeCheck(http, check) {
  if (check.kind === 'dns') {
    try { return { outcome: 'up', dns_addresses: await http.dnsAddresses({url:check.target_url}) }; }
    catch(error) { return {outcome:'error',error_code:CODE(error)}; }
  }
  if (check.kind === 'ssl') {
    try {
      const certificate = await http.tlsCertificate({ url: check.target_url });
      return {
        outcome: certificate.trusted ? 'up' : 'error',
        tls_valid_to: certificate.validTo,
        tls_issuer: certificate.issuer?.slice(0, 200) ?? null,
        error_code: certificate.trusted ? null : 'tls_untrusted'
      };
    } catch (error) {
      return { outcome: 'error', error_code: CODE(error) };
    }
  }
  try {
    const response = await http.request({ url: check.target_url, allowHttp: true, maxBytes: 512 * 1024 });
    // A redirect shows the server answered. It is not followed.
    return {
      outcome: response.status < 500 ? 'up' : 'down',
      http_status: response.status,
      response_ms: response.elapsedMs
    };
  } catch (error) {
    const code = CODE(error);
    // A refused target is a configuration problem, not evidence the site is down.
    return { outcome: code === 'blocked_target' ? 'error' : 'down', error_code: code };
  }
}

// Sends one notice to everyone responsible for a client: owners, admins and
// assigned technicians. The dedupe key stops a repeat alert for the same event.
export async function notifyClientStaff(tx, { clientId, kind, severity, title, body, link, dedupeKey, emailEnabled }) {
  await tx.query(
    `insert into hub.notifications (staff_id, client_account_id, kind, severity, title, body, link_path, dedupe_key, email_status)
     select u.id, $1, $2, $3, $4, $5, $6, $7, $8
     from hub.staff_users u
     where u.status = 'active' and (u.role in ('owner', 'admin') or (u.role = 'technician' and exists (
       select 1 from hub.staff_client_assignments a where a.staff_id = u.id and a.client_account_id = $1::uuid)))
     on conflict (staff_id, dedupe_key) do nothing`,
    [clientId, kind, severity, title, body, link, dedupeKey, emailEnabled && severity !== 'info' ? 'pending' : 'none']);
}

async function evaluateResult(tx, check, result, inWindow, now, emailEnabled) {
  const link = `/websites/${check.website_id}`;
  const notify = (kind, severity, title, body, dedupeKey) =>
    notifyClientStaff(tx, { clientId: check.client_account_id, kind, severity, title, body, link, dedupeKey, emailEnabled });
  const open = (await tx.query(`select id from hub.incidents where check_id = $1 and status = 'open'`, [check.id])).rows[0];

  if (result.outcome === 'up') {
    if (open) {
      await tx.query(`update hub.incidents set status = 'resolved', resolved_at = $2 where id = $1`, [open.id, now]);
      await notify('incident.resolved', 'info', `${check.website_name} recovered`, 'The latest check succeeded.', `incident-resolved:${open.id}`);
      await writeAudit(tx, { action: 'incident.resolve', clientId: check.client_account_id, entityType: 'incident', entityId: open.id });
    }
    if (result.response_ms && check.response_warn_ms && result.response_ms > check.response_warn_ms && !inWindow) {
      await notify('monitoring.slow', 'warning', `${check.website_name} is responding slowly`, `${result.response_ms} ms, above the ${check.response_warn_ms} ms threshold.`, `slow:${check.id}:${now.toISOString().slice(0, 10)}`);
    }
  } else if (!inWindow && !open) {
    // Only consecutive failures open an incident, so one blip stays a single result.
    const recent = (await tx.query(
      `select outcome from hub.monitoring_results where check_id = $1 and not in_maintenance_window order by checked_at desc limit $2`,
      [check.id, check.failure_threshold])).rows;
    if (recent.length >= check.failure_threshold && recent.every(row => row.outcome !== 'up')) {
      const kind = check.kind === 'ssl' ? 'certificate' : 'availability';
      const { rows: [incident] } = await tx.query(
        `insert into hub.incidents (client_account_id, website_id, check_id, kind, opened_at, last_error_code) values ($1, $2, $3, $4, $5, $6) returning id`,
        [check.client_account_id, check.website_id, check.id, kind, now, result.error_code ?? null]);
      await notify('incident.opened', 'critical', `${check.website_name}: ${kind} problem`, `${check.failure_threshold} checks in a row failed.`, `incident-opened:${incident.id}`);
      await writeAudit(tx, { action: 'incident.open', clientId: check.client_account_id, entityType: 'incident', entityId: incident.id, metadata: { kind, code: result.error_code ?? null } });
    }
  }

  if (check.kind === 'ssl' && result.tls_valid_to) {
    const daysLeft = Math.floor((result.tls_valid_to.getTime() - now.getTime()) / DAY);
    const expiry = result.tls_valid_to.toISOString().slice(0, 10);
    if (daysLeft <= check.cert_warn_days) {
      const expired = daysLeft < 0;
      await notify('certificate.expiring', expired || daysLeft <= 7 ? 'critical' : 'warning',
        expired ? `${check.website_name}: certificate has expired` : `${check.website_name}: certificate expires in ${daysLeft} days`,
        `Certificate valid to ${expiry}.`, `certificate:${check.id}:${expiry}:${daysLeft <= 7 ? 'urgent' : 'notice'}`);
      await tx.query(
        `insert into hub.security_findings (client_account_id, website_id, title, description, severity, source, source_detail, dedupe_key, found_at)
         values ($1, $2, $3, $4, $5, 'automated', 'Certificate check', $6, $7) on conflict do nothing`,
        [check.client_account_id, check.website_id, expired ? 'TLS certificate has expired' : 'TLS certificate expires soon', `Certificate valid to ${expiry}.`,
          expired ? 'critical' : daysLeft <= 7 ? 'high' : 'medium', `certificate:${expiry}`, now]);
    }
  }
  if (check.kind === 'ssl' && result.error_code === 'tls_untrusted') {
    await tx.query(
      `insert into hub.security_findings (client_account_id, website_id, title, description, severity, source, source_detail, dedupe_key, found_at)
       values ($1, $2, 'TLS certificate is not trusted', 'The certificate failed validation for this hostname.', 'high', 'automated', 'Certificate check', 'certificate:untrusted', $3) on conflict do nothing`,
      [check.client_account_id, check.website_id, now]);
  }
}

export async function runDueMonitoring({ db, http, outboundEnabled, emailEnabled = false, now = () => new Date(), limit = 50, deadline=Date.now()+30000 }) {
  if (!outboundEnabled) return { ran: 0, skipped: 'outbound_disabled' };
  const token = randomUUID();
  // Claim one at a time: no lease can expire while waiting behind 49 network probes.
  let ran=0;
  for (let n=0; n<Math.min(limit,50)&&Date.now()<deadline; n++) {
    const due = await db.as('hub_worker',null,async tx=>(await tx.query(
      `update hub.monitoring_checks m set lease_token=$2,lease_until=$1::timestamptz+interval '2 minutes'
       from (select x.id from hub.monitoring_checks x join hub.managed_websites w on w.id=x.website_id
         where x.enabled and w.lifecycle='active' and x.next_run_at <= $1 and (x.lease_until is null or x.lease_until < $1)
         order by x.next_run_at for update of x skip locked limit 1) candidate
       where m.id=candidate.id returning m.*`,[now(),token])).rows);
    if(!due.length)break;
  for (const check of due) {
    const result = await probeCheck(http, check);
    const checkedAt = now();
    await db.as('hub_worker', null, async tx => {
      const held=(await tx.query('select id from hub.monitoring_checks where id=$1 and lease_token=$2 and enabled for update',[check.id,token])).rows.length;
      if(!held)return;
      const previous=(await tx.query('select dns_addresses from hub.monitoring_results where check_id=$1 and dns_addresses is not null order by checked_at desc limit 1',[check.id])).rows[0]?.dns_addresses;
      const dnsChanged=Boolean(previous&&result.dns_addresses&&JSON.stringify(previous)!==JSON.stringify(result.dns_addresses));
      if(dnsChanged)await notifyClientStaff(tx,{clientId:check.client_account_id,kind:'dns.changed',severity:'warning',title:'DNS addresses changed',body:check.target_url,link:`/websites/${check.website_id}`,dedupeKey:`dns:${check.id}:${JSON.stringify(result.dns_addresses)}`,emailEnabled});
      const inWindow = (await tx.query(
        `select 1 from hub.maintenance_windows where website_id = $1 and starts_at <= $2 and ends_at > $2 limit 1`, [check.website_id, checkedAt])).rows.length > 0;
      await tx.query(
        `insert into hub.monitoring_results (client_account_id, check_id, outcome, http_status, response_ms, tls_valid_to, tls_issuer, error_code, checked_at, in_maintenance_window,dns_addresses,dns_changed)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,$11,$12)`,
        [check.client_account_id, check.id, result.outcome, result.http_status ?? null, result.response_ms ?? null,
          result.tls_valid_to ?? null, result.tls_issuer ?? null, result.error_code ?? null, checkedAt, inWindow, result.dns_addresses ? JSON.stringify(result.dns_addresses) : null,dnsChanged]);
      await tx.query(`update hub.monitoring_checks set lease_token=null,lease_until=null,next_run_at = $2 where id = $1`,
        [check.id, new Date(checkedAt.getTime() + check.interval_minutes * 60000)]);
      check.website_name=(await tx.query('select display_name from hub.managed_websites where id=$1',[check.website_id])).rows[0]?.display_name??'Website';
      await evaluateResult(tx, check, result, inWindow, checkedAt, emailEnabled);
      ran++;
    });
  }
  }
  if (ran) {
    await db.as('hub_worker', null, tx => writeAudit(tx, { action: 'monitoring.run', metadata: { checks: ran } }));
  }
  return { ran };
}

// Registry data over RDAP. Where a registry offers nothing, the date is left as it
// was, because guessing an expiry date is worse than having none.
export async function syncDomainExpiry({ db, http, outboundEnabled, now = () => new Date(), limit = 25, deadline=Date.now()+30000 }) {
  if (!outboundEnabled) return { checked: 0, skipped: 'outbound_disabled' };
  const domains = await db.as('hub_worker', null, async tx => (await tx.query(
    `select id, hostname from hub.website_domains where expiry_checked_at is null or expiry_checked_at < $1 order by expiry_checked_at nulls first limit $2`,
    [new Date(now().getTime() - 7 * DAY), limit])).rows);
  if (!domains.length) return { checked: 0 };
  let services;
  try {
    const bootstrap = await http.request({ url: 'https://data.iana.org/rdap/dns.json', maxBytes: 1024 * 1024 });
    services = JSON.parse(bootstrap.body).services;
  } catch {
    return { checked: 0, failed: 'bootstrap_unavailable' };
  }
  let updated = 0;
  for (const domain of domains) {
    if(Date.now()>=deadline)break;
    const labels = domain.hostname.split('.');
    const registrable = labels.slice(-2).join('.');
    const server = services.find(([tlds]) => tlds.includes(labels.at(-1)))?.[1]?.find(url => url.startsWith('https://'));
    let expires = null;
    if (server) {
      try {
        const response = await http.request({ url: `${server.replace(/\/$/, '')}/domain/${registrable}`, headers: { Accept: 'application/rdap+json' } });
        if (response.status === 200) {
          const event = JSON.parse(response.body).events?.find(item => item.eventAction === 'expiration');
          const parsed = event ? new Date(event.eventDate) : null;
          if (parsed && !Number.isNaN(parsed.getTime())) expires = parsed.toISOString().slice(0, 10);
        }
      } catch { /* Recorded below as checked with no date. */ }
    }
    await db.as('hub_worker', null, tx => tx.query(
      `update hub.website_domains set expiry_checked_at = $2, expires_on = coalesce($3::date, expires_on),
         expiry_source = case when $3::date is not null then 'rdap' else expiry_source end where id = $1`, [domain.id, now(), expires]));
    if (expires) updated += 1;
  }
  return { checked: domains.length, updated };
}

export async function runBackupProviderSync({ db, providers = {}, logger, deadline=Date.now()+30000 }) {
  if (!Object.keys(providers).length) return { synced: 0, skipped: 'no_provider_configured' };
  const sources = await db.as('hub_worker', null, async tx => (await tx.query(
    `select id, client_account_id, website_id, storage_provider, storage_ref from hub.backup_sources where active and storage_provider <> 'manual'`)).rows);
  let synced = 0;
  let failed = 0;
  for (const source of sources) {
    if(Date.now()>=deadline)break;
    const provider = providers[source.storage_provider];
    if (!provider) continue;
    try {
      const runs = await provider.listRuns(source);
      await db.as('hub_worker', null, async tx => {
        for (const run of runs) {
          const { rows } = await tx.query(
            `insert into hub.backup_runs (client_account_id, source_id, status, finished_at, size_bytes, artifact_ref, external_id, reported_by)
             values ($1, $2, $3, $4, $5, $6, $6, 'provider') on conflict do nothing returning id`,
            [source.client_account_id, source.id, run.status, run.finishedAt, run.sizeBytes, run.externalId]);
          synced += rows.length;
        }
      });
    } catch (error) {
      failed += 1;
      logger?.warn('hub.backup_sync_failed', { source: source.id, code: safeCode(error) });
    }
  }
  return { synced, failed };
}

// Turns records into reminders: overdue work, expiring domains, backup problems.
export async function generateReminders({ db, emailEnabled = false, now = () => new Date() }) {
  return db.as('hub_worker', null, async tx => {
    const today = now();
    const stamp = today.toISOString().slice(0, 10);
    let created = 0;
    const send = async notice => {
      await notifyClientStaff(tx, { emailEnabled, ...notice });
      created += 1;
    };
    for(const task of (await tx.query("select id,title,client_account_id,website_id,updated_at from hub.maintenance_tasks where status='blocked' limit 200")).rows){
      await send({clientId:task.client_account_id,kind:'maintenance.failed',severity:'warning',title:`Blocked maintenance: ${task.title}`,body:'Review the task and its approval before retrying. No automatic CMS retry was sent.',link:`/websites/${task.website_id}`,dedupeKey:`blocked:${task.id}:${new Date(task.updated_at).toISOString()}`});
    }
    for (const task of (await tx.query(
      `select t.id, t.title, t.client_account_id, t.website_id, w.display_name from hub.maintenance_tasks t join hub.managed_websites w on w.id = t.website_id
       where t.status in ('open', 'in_progress', 'blocked') and t.due_on < $1::date and w.lifecycle <> 'archived' limit 200`, [stamp])).rows) {
      await send({ clientId: task.client_account_id, kind: 'task.overdue', severity: 'warning', title: `Overdue: ${task.title}`, body: task.display_name, link: `/websites/${task.website_id}`, dedupeKey: `task-overdue:${task.id}` });
    }
    for (const schedule of (await tx.query(
      `select m.id, m.title, m.client_account_id, m.website_id, m.next_due_on::text as due, w.display_name from hub.maintenance_schedules m join hub.managed_websites w on w.id = m.website_id
       where m.active and m.next_due_on <= ($1::date + 7) and w.lifecycle <> 'archived' limit 200`, [stamp])).rows) {
      await send({ clientId: schedule.client_account_id, kind: 'schedule.due', severity: 'info', title: `Due ${schedule.due}: ${schedule.title}`, body: schedule.display_name, link: `/websites/${schedule.website_id}`, dedupeKey: `schedule-due:${schedule.id}:${schedule.due}` });
    }
    for (const domain of (await tx.query(
      `select d.hostname, d.client_account_id, d.website_id, d.expires_on::text as expires, d.expiry_source from hub.website_domains d
       where d.expires_on <= ($1::date + 30) limit 200`, [stamp])).rows) {
      const severity = domain.expires <= stamp ? 'critical' : 'warning';
      await send({ clientId: domain.client_account_id, kind: 'domain.expiring', severity, title: `Domain ${domain.hostname} expires ${domain.expires}`, body: `Date source: ${domain.expiry_source}.`, link: `/websites/${domain.website_id}`, dedupeKey: `domain:${domain.hostname}:${domain.expires}` });
    }
    for (const source of (await tx.query(
      `select b.id, b.label, b.client_account_id, b.website_id, b.expected_interval_hours, r.id as run_id, r.status, r.finished_at, w.display_name
       from hub.backup_sources b join hub.managed_websites w on w.id = b.website_id
       left join lateral (select id, status, finished_at from hub.backup_runs x where x.source_id = b.id order by x.finished_at desc limit 1) r on true
       where b.active and w.lifecycle <> 'archived' limit 200`)).rows) {
      const link = `/websites/${source.website_id}`;
      if (source.status === 'failed') {
        await send({ clientId: source.client_account_id, kind: 'backup.failed', severity: 'critical', title: `Backup failed: ${source.display_name}`, body: source.label, link, dedupeKey: `backup-failed:${source.run_id}` });
      } else if (source.expected_interval_hours && (!source.finished_at
        || today.getTime() - new Date(source.finished_at).getTime() > source.expected_interval_hours * 1.5 * 3600000)) {
        await send({ clientId: source.client_account_id, kind: 'backup.overdue', severity: 'warning', title: `Backup overdue: ${source.display_name}`, body: source.label, link, dedupeKey: `backup-overdue:${source.id}:${stamp}` });
      }
    }
    return { evaluated: created };
  });
}

// Each step runs on its own, so one failing part cannot stop the others.
export async function runJobs(deps) {
  deps={...deps,deadline:Date.now()+45000};
  const { logger } = deps;
  const step = async (name, fn) => {
    if(Date.now()>=deps.deadline)return {skipped:'execution_budget'};
    try {
      return await fn();
    } catch (error) {
      logger?.error('hub.job_failed', { job: name, name: error?.name, code: error?.code });
      return { failed: true };
    }
  };
  const emailEnabled = Boolean(deps.email?.enabled);
  return {
    maintenance: await step('maintenance',()=>enqueueDueMaintenance(deps)),
    monitoring: await step('monitoring', () => runDueMonitoring({ ...deps, emailEnabled })),
    domains: await step('domains', () => syncDomainExpiry(deps)),
    backups: await step('backups', () => runBackupProviderSync({...deps,providers:deps.backupProviders??{}})),
    reminders: await step('reminders', () => generateReminders({ ...deps, emailEnabled })),
    stackltr: await step('stackltr', () => deliverOutbox(deps)),
    email: await step('email', () => deliverEmails(deps))
  };
}
