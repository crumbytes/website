-- Website Management Hub: inventory, monitoring, security, recovery, notifications.
-- PROPOSAL. Not applied to any hosted database.

-- Reference data ------------------------------------------------------------

-- has_adapter says whether an API integration exists, not whether one is verified.
create table hub.website_platforms (
  key text primary key,
  label text not null,
  has_adapter boolean not null
);
insert into hub.website_platforms (key, label, has_adapter) values
  ('wordpress', 'WordPress', true), ('shopify', 'Shopify', true), ('wix', 'Wix', true),
  ('squarespace', 'Squarespace', true), ('joomla', 'Joomla', true), ('other', 'Other CMS', false);

alter table hub.managed_websites drop constraint managed_websites_cms_platform_check;
alter table hub.managed_websites add foreign key (cms_platform) references hub.website_platforms (key);

create table hub.hosting_providers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  support_url text check (support_url ~ '^https://' and length(support_url) <= 500),
  notes text not null default '' check (length(notes) <= 2000),
  active boolean not null default true,
  created_by uuid not null references hub.staff_users (id),
  created_at timestamptz not null default now()
);
create unique index hosting_providers_name_idx on hub.hosting_providers (lower(name));

-- Websites ------------------------------------------------------------------

alter table hub.managed_websites
  add column hosting_provider_id uuid references hub.hosting_providers (id),
  add column account_owner_id uuid references hub.staff_users (id),
  add column cms_version text check (length(cms_version) <= 40),
  add column cms_version_source text check (cms_version_source in ('api', 'manual')),
  add column cms_version_recorded_at timestamptz,
  add column archived_at timestamptz,
  add column archived_by uuid references hub.staff_users (id);

insert into hub.hosting_providers (name, created_by)
  select distinct on (lower(hosting_provider)) hosting_provider, created_by
  from hub.managed_websites where hosting_provider is not null order by lower(hosting_provider), created_at;
update hub.managed_websites w set hosting_provider_id = p.id
  from hub.hosting_providers p where lower(p.name) = lower(w.hosting_provider);
alter table hub.managed_websites drop column hosting_provider;

alter table hub.managed_websites drop constraint managed_websites_lifecycle_check;
alter table hub.managed_websites
  add constraint managed_websites_lifecycle_check check (lifecycle in ('active', 'paused', 'offboarded', 'archived')),
  add constraint managed_websites_archive_check check ((lifecycle = 'archived') = (archived_at is not null));
create index managed_websites_filter_idx on hub.managed_websites (cms_platform, lifecycle);
create index managed_websites_host_idx on hub.managed_websites (hosting_provider_id);

create table hub.website_domains (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  website_id uuid not null,
  hostname text not null check (hostname = lower(hostname) and length(hostname) between 3 and 253),
  is_primary boolean not null default false,
  registrar text check (length(registrar) <= 120),
  dns_provider text check (length(dns_provider) <= 120),
  domain_owner text check (length(domain_owner) <= 160),
  expires_on date,
  -- Where the date came from. The interface always shows this.
  expiry_source text check (expiry_source in ('manual', 'rdap')),
  expiry_checked_at timestamptz,
  created_by uuid not null references hub.staff_users (id),
  created_at timestamptz not null default now(),
  unique (hostname),
  foreign key (client_account_id, website_id) references hub.managed_websites (client_account_id, id),
  check ((expires_on is null) = (expiry_source is null))
);
create unique index website_domains_one_primary on hub.website_domains (website_id) where is_primary;
create index website_domains_expiry_idx on hub.website_domains (expires_on);

-- Maintenance plans and work ------------------------------------------------

create table hub.plan_tasks (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references hub.service_plans (id),
  title text not null check (length(title) between 1 and 160),
  kind text not null check (kind in ('inspection', 'software_update', 'plugin_update', 'content_request', 'security', 'backup_verification', 'other')),
  interval_days integer not null check (interval_days between 1 and 366),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index plan_tasks_plan_idx on hub.plan_tasks (plan_id);

alter table hub.maintenance_schedules
  add column kind text not null default 'inspection'
    check (kind in ('inspection', 'software_update', 'plugin_update', 'content_request', 'security', 'backup_verification', 'other')),
  add column plan_task_id uuid references hub.plan_tasks (id);
create unique index maintenance_schedules_plan_task on hub.maintenance_schedules (website_id, plan_task_id) where plan_task_id is not null;

-- Updates can disrupt a live site, so those tasks need a person's approval first.
alter table hub.maintenance_tasks
  add column kind text not null default 'other'
    check (kind in ('inspection', 'software_update', 'plugin_update', 'content_request', 'security', 'backup_verification', 'other')),
  add column requires_approval boolean not null default false,
  add column approved_by uuid references hub.staff_users (id),
  add column approved_at timestamptz,
  add column completion_evidence_ref text check (length(completion_evidence_ref) <= 500),
  add constraint maintenance_tasks_approval_check check (status <> 'completed' or not requires_approval or approved_at is not null),
  add constraint maintenance_tasks_approver_check check ((approved_at is null) = (approved_by is null)),
  add constraint maintenance_tasks_two_people check (approved_by is null or approved_by <> created_by);

create table hub.task_work_logs (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  task_id uuid not null,
  note text not null check (length(note) between 3 and 4000),
  minutes integer check (minutes between 1 and 1440),
  staff_id uuid not null references hub.staff_users (id),
  logged_at timestamptz not null default now(),
  foreign key (client_account_id, task_id) references hub.maintenance_tasks (client_account_id, id)
);
create index task_work_logs_task_idx on hub.task_work_logs (task_id, logged_at desc);

-- Set when a platform answers 429 with Retry-After, and honoured by later checks.
alter table hub.platform_connections add column not_before timestamptz;

-- Monitoring ----------------------------------------------------------------

alter table hub.monitoring_checks
  add column failure_threshold integer not null default 2 check (failure_threshold between 1 and 20),
  add column response_warn_ms integer check (response_warn_ms between 100 and 60000),
  add column cert_warn_days integer not null default 30 check (cert_warn_days between 1 and 90);
alter table hub.monitoring_results
  add column in_maintenance_window boolean not null default false;

create table hub.maintenance_windows (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  website_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null check (length(reason) between 3 and 500),
  created_by uuid not null references hub.staff_users (id),
  created_at timestamptz not null default now(),
  foreign key (client_account_id, website_id) references hub.managed_websites (client_account_id, id),
  check (ends_at > starts_at)
);
create index maintenance_windows_active_idx on hub.maintenance_windows (website_id, starts_at, ends_at);

create table hub.incidents (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  website_id uuid not null,
  check_id uuid not null,
  kind text not null check (kind in ('availability', 'certificate')),
  status text not null default 'open' check (status in ('open', 'resolved')),
  opened_at timestamptz not null,
  resolved_at timestamptz,
  last_error_code text check (length(last_error_code) <= 60),
  acknowledged_by uuid references hub.staff_users (id),
  acknowledged_at timestamptz,
  foreign key (client_account_id, website_id) references hub.managed_websites (client_account_id, id),
  foreign key (client_account_id, check_id) references hub.monitoring_checks (client_account_id, id),
  check ((status = 'resolved') = (resolved_at is not null))
);
create unique index incidents_one_open on hub.incidents (check_id) where status = 'open';
create index incidents_recent_idx on hub.incidents (website_id, opened_at desc);

-- Security ------------------------------------------------------------------

create table hub.security_findings (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  website_id uuid not null,
  title text not null check (length(title) between 3 and 200),
  description text not null default '' check (length(description) <= 4000),
  severity text not null check (severity in ('info', 'low', 'medium', 'high', 'critical')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'accepted', 'resolved')),
  -- Keeps automated checks and human assessment visibly separate.
  source text not null check (source in ('automated', 'manual')),
  source_detail text check (length(source_detail) <= 200),
  dedupe_key text check (length(dedupe_key) <= 200),
  evidence_ref text check (length(evidence_ref) <= 500),
  remediation_task_id uuid,
  created_by uuid references hub.staff_users (id),
  found_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references hub.staff_users (id),
  foreign key (client_account_id, website_id) references hub.managed_websites (client_account_id, id),
  foreign key (client_account_id, remediation_task_id) references hub.maintenance_tasks (client_account_id, id),
  check ((status = 'resolved') = (resolved_at is not null)),
  check (source <> 'manual' or created_by is not null)
);
create index security_findings_open_idx on hub.security_findings (website_id, status, severity);
create unique index security_findings_dedupe on hub.security_findings (website_id, dedupe_key)
  where dedupe_key is not null and status <> 'resolved';

-- Backups and recovery ------------------------------------------------------

alter table hub.backup_sources
  add column schedule_description text check (length(schedule_description) <= 200),
  add column retention_days integer check (retention_days between 1 and 3650),
  add column storage_provider text not null default 'manual' check (storage_provider in ('manual', 'r2')),
  add column storage_ref text check (length(storage_ref) <= 500),
  -- What staff recorded about encryption. The hub cannot inspect a provider's archive.
  add column encryption_method text check (length(encryption_method) <= 200);
alter table hub.backup_runs
  add column external_id text check (length(external_id) <= 500);
create unique index backup_runs_external on hub.backup_runs (source_id, external_id) where external_id is not null;

create table hub.recovery_requests (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  website_id uuid not null,
  backup_run_id uuid not null,
  reason text not null check (length(reason) between 5 and 2000),
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'rejected', 'in_progress', 'completed', 'failed')),
  requested_by uuid not null references hub.staff_users (id),
  decided_by uuid references hub.staff_users (id),
  decided_at timestamptz,
  outcome_notes text check (length(outcome_notes) <= 4000),
  evidence_ref text check (length(evidence_ref) <= 500),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (client_account_id, website_id) references hub.managed_websites (client_account_id, id),
  foreign key (client_account_id, backup_run_id) references hub.backup_runs (client_account_id, id),
  check (decided_by is null or decided_by <> requested_by or status = 'rejected'),
  check (status in ('requested', 'rejected') or decided_by is not null),
  check (status <> 'completed' or coalesce(length(evidence_ref), 0) >= 3)
);
create index recovery_requests_website_idx on hub.recovery_requests (website_id, created_at desc);

-- Notifications -------------------------------------------------------------

create table hub.notifications (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references hub.staff_users (id),
  client_account_id uuid references hub.client_accounts (id),
  kind text not null check (length(kind) <= 60),
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  title text not null check (length(title) between 1 and 200),
  body text not null default '' check (length(body) <= 1000),
  link_path text check (link_path ~ '^/[A-Za-z0-9/_-]*$'),
  dedupe_key text not null check (length(dedupe_key) <= 200),
  email_status text not null default 'none' check (email_status in ('none', 'pending', 'sent', 'failed')),
  email_attempts integer not null default 0,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (staff_id, dedupe_key)
);
create index notifications_unread_idx on hub.notifications (staff_id, created_at desc) where read_at is null;
create index notifications_email_idx on hub.notifications (created_at) where email_status = 'pending';

-- Sessions and rate limits --------------------------------------------------

alter table hub.staff_sessions
  add column id uuid not null default gen_random_uuid() unique,
  -- What the identity provider reported. Absent is not proof that MFA was skipped.
  add column mfa_reported boolean not null default false;

-- Counters only. Keys are hashed, so no address is stored.
create table hub.rate_limits (
  bucket text primary key,
  window_started_at timestamptz not null,
  hits integer not null
);

-- Access control ------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['website_platforms', 'hosting_providers', 'website_domains', 'plan_tasks', 'task_work_logs',
    'maintenance_windows', 'incidents', 'security_findings', 'recovery_requests', 'notifications', 'rate_limits'] loop
    execute format('alter table hub.%I enable row level security', t);
  end loop;
end $$;

grant select on hub.website_platforms to hub_app, hub_worker;
create policy read_all on hub.website_platforms for select to hub_app, hub_worker using (true);

grant select, insert, update on hub.hosting_providers, hub.plan_tasks to hub_app;
create policy staff_read on hub.hosting_providers for select to hub_app using (hub.current_staff_role() is not null);
create policy admin_insert on hub.hosting_providers for insert to hub_app with check (hub.has_role('owner', 'admin', 'technician') and created_by = hub.current_staff_id());
create policy admin_update on hub.hosting_providers for update to hub_app using (hub.has_role('owner', 'admin')) with check (hub.has_role('owner', 'admin'));
create policy staff_read on hub.plan_tasks for select to hub_app using (hub.current_staff_role() is not null);
create policy admin_insert on hub.plan_tasks for insert to hub_app with check (hub.has_role('owner', 'admin'));
create policy admin_update on hub.plan_tasks for update to hub_app using (hub.has_role('owner', 'admin')) with check (hub.has_role('owner', 'admin'));

do $$
declare spec record;
begin
  for spec in
    select * from (values
      ('website_domains',     array['owner','admin','technician'], true),
      ('maintenance_windows', array['owner','admin','technician'], false),
      ('task_work_logs',      array['owner','admin','technician'], false),
      ('security_findings',   array['owner','admin','technician'], true),
      ('recovery_requests',   array['owner','admin','technician'], false)
    ) as s(tbl, writers, updatable)
  loop
    execute format('grant select, insert on hub.%I to hub_app', spec.tbl);
    execute format('create policy scoped_read on hub.%I for select to hub_app using (hub.can_access_client(client_account_id))', spec.tbl);
    execute format('create policy scoped_insert on hub.%I for insert to hub_app
      with check (hub.can_access_client(client_account_id) and hub.has_role(variadic %L::text[]))', spec.tbl, spec.writers);
    if spec.updatable then
      execute format('grant update on hub.%I to hub_app', spec.tbl);
      execute format('create policy scoped_update on hub.%I for update to hub_app
        using (hub.can_access_client(client_account_id) and hub.has_role(variadic %L::text[]))
        with check (hub.can_access_client(client_account_id) and hub.has_role(variadic %L::text[]))', spec.tbl, spec.writers, spec.writers);
    end if;
  end loop;
end $$;

-- Staff record manual findings only. Automated ones come from the worker, so the
-- automated label cannot be forged through the application role.
drop policy scoped_insert on hub.security_findings;
create policy manual_insert on hub.security_findings for insert to hub_app
  with check (hub.can_access_client(client_account_id) and hub.has_role('owner', 'admin', 'technician')
    and source = 'manual' and created_by = hub.current_staff_id());

-- Recovery changes follow the same two-person rule as operations.
grant update (status, decided_by, decided_at, outcome_notes, evidence_ref, closed_at) on hub.recovery_requests to hub_app;
create policy recovery_update on hub.recovery_requests for update to hub_app
  using (hub.can_access_client(client_account_id) and hub.has_role('owner', 'admin'))
  with check (hub.can_access_client(client_account_id) and hub.has_role('owner', 'admin'));

grant select on hub.incidents to hub_app;
grant update (acknowledged_by, acknowledged_at) on hub.incidents to hub_app;
create policy scoped_read on hub.incidents for select to hub_app using (hub.can_access_client(client_account_id));
create policy scoped_ack on hub.incidents for update to hub_app
  using (hub.can_access_client(client_account_id) and hub.has_role('owner', 'admin', 'technician'))
  with check (acknowledged_by = hub.current_staff_id());

grant select on hub.notifications to hub_app;
grant update (read_at) on hub.notifications to hub_app;
create policy own_read on hub.notifications for select to hub_app using (staff_id = hub.current_staff_id());
create policy own_update on hub.notifications for update to hub_app using (staff_id = hub.current_staff_id()) with check (staff_id = hub.current_staff_id());

grant select (id, status, role, email, display_name) on hub.staff_users to hub_worker;

grant select, insert, update on hub.rate_limits to hub_auth;
create policy auth_all on hub.rate_limits for all to hub_auth using (true) with check (true);

grant select (id, client_account_id, website_id, hostname, expires_on, expiry_source, expiry_checked_at) on hub.website_domains to hub_worker;
grant update (expires_on, expiry_source, expiry_checked_at) on hub.website_domains to hub_worker;
create policy worker_all on hub.website_domains for all to hub_worker using (true) with check (true);

grant select, insert, update on hub.incidents, hub.notifications to hub_worker;
create policy worker_all on hub.incidents for all to hub_worker using (true) with check (true);
create policy worker_all on hub.notifications for all to hub_worker using (true) with check (true);
grant select, insert on hub.security_findings to hub_worker;
create policy worker_read on hub.security_findings for select to hub_worker using (true);
create policy worker_insert on hub.security_findings for insert to hub_worker with check (source = 'automated');
grant select on hub.maintenance_windows, hub.maintenance_tasks, hub.maintenance_schedules, hub.staff_client_assignments,
  hub.backup_sources, hub.backup_runs to hub_worker;
create policy worker_read on hub.maintenance_windows for select to hub_worker using (true);
create policy worker_read on hub.maintenance_tasks for select to hub_worker using (true);
create policy worker_read on hub.maintenance_schedules for select to hub_worker using (true);
create policy worker_read on hub.staff_client_assignments for select to hub_worker using (true);
create policy worker_read on hub.backup_sources for select to hub_worker using (true);
create policy worker_read on hub.backup_runs for select to hub_worker using (true);
grant insert on hub.backup_runs to hub_worker;
create policy worker_insert on hub.backup_runs for insert to hub_worker with check (reported_by = 'provider');
grant select on hub.monitoring_results, hub.platform_snapshots to hub_worker;
create policy worker_read on hub.monitoring_results for select to hub_worker using (true);
create policy worker_read on hub.platform_snapshots for select to hub_worker using (true);
grant update (cms_version, cms_version_source, cms_version_recorded_at) on hub.managed_websites to hub_worker;
create policy worker_update on hub.managed_websites for update to hub_worker using (true) with check (true);

-- Append-only records added by this migration.
do $$
declare t text;
begin
  foreach t in array array['task_work_logs'] loop
    execute format('create trigger %I before update or delete on hub.%I
      for each row execute function hub.forbid_mutation()', t || '_append_only', t);
  end loop;
end $$;
