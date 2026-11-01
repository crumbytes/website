-- Website Management Hub: core schema.
-- PROPOSAL. Not applied to any hosted database. Applying it anywhere other than
-- a local or disposable database needs a reviewed plan and release-owner approval.

create schema if not exists hub;

do $$
declare r text;
begin
  foreach r in array array['hub_auth', 'hub_app', 'hub_worker'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;

-- Identity ------------------------------------------------------------------

-- Role names match StackLTR workspace_memberships so one vocabulary covers both.
create table hub.staff_users (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email) and length(email) between 3 and 254),
  display_name text not null check (length(display_name) between 1 and 120),
  role text not null check (role in ('owner', 'admin', 'technician', 'billing', 'viewer')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  oidc_issuer text,
  oidc_subject text,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (email),
  unique (oidc_issuer, oidc_subject),
  check ((oidc_issuer is null) = (oidc_subject is null))
);

create table hub.oidc_login_states (
  state_hash text primary key,
  binding_hash text not null,
  nonce text not null,
  code_verifier text not null,
  return_to text not null default '/',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table hub.staff_sessions (
  token_hash text primary key,
  staff_id uuid not null references hub.staff_users (id),
  csrf_token text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz
);
create index staff_sessions_staff_idx on hub.staff_sessions (staff_id);

-- Client accounts -----------------------------------------------------------

-- A reference to the customer, not a CRM record. Contacts, tickets and invoices
-- stay in StackLTR; this table only holds what the hub needs to scope its data.
create table hub.client_accounts (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(display_name) between 1 and 160),
  status text not null default 'active' check (status in ('active', 'inactive')),
  stackltr_workspace_id uuid,
  stackltr_company_id uuid,
  stackltr_billing_ref text check (length(stackltr_billing_ref) <= 120),
  created_by uuid not null references hub.staff_users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stackltr_workspace_id, stackltr_company_id),
  check ((stackltr_workspace_id is null) = (stackltr_company_id is null))
);

create table hub.staff_client_assignments (
  staff_id uuid not null references hub.staff_users (id),
  client_account_id uuid not null references hub.client_accounts (id),
  assigned_by uuid not null references hub.staff_users (id),
  created_at timestamptz not null default now(),
  primary key (staff_id, client_account_id)
);
create index staff_client_assignments_client_idx on hub.staff_client_assignments (client_account_id);

create table hub.service_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(name) between 1 and 120),
  description text not null default '' check (length(description) <= 2000),
  maintenance_interval_days integer check (maintenance_interval_days between 1 and 366),
  stackltr_billing_ref text check (length(stackltr_billing_ref) <= 120),
  active boolean not null default true,
  created_by uuid not null references hub.staff_users (id),
  created_at timestamptz not null default now()
);

-- Managed websites ----------------------------------------------------------

-- Child tables carry client_account_id and use composite foreign keys, so a row
-- cannot name a website that belongs to another client.
create table hub.managed_websites (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null references hub.client_accounts (id),
  display_name text not null check (length(display_name) between 1 and 160),
  primary_url text not null unique check (primary_url ~ '^https?://' and length(primary_url) <= 2048),
  cms_platform text not null check (cms_platform in ('wordpress', 'shopify', 'wix', 'squarespace', 'joomla', 'other')),
  cms_other_name text check (length(cms_other_name) <= 80),
  hosting_provider text check (length(hosting_provider) <= 120),
  service_plan_id uuid references hub.service_plans (id),
  lifecycle text not null default 'active' check (lifecycle in ('active', 'paused', 'offboarded')),
  notes text not null default '' check (length(notes) <= 4000),
  created_by uuid not null references hub.staff_users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_account_id, id),
  check (cms_platform = 'other' or cms_other_name is null)
);
create index managed_websites_client_idx on hub.managed_websites (client_account_id);

-- Platform connections and credentials --------------------------------------

create table hub.platform_connections (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  website_id uuid not null,
  adapter_key text not null check (adapter_key in ('wordpress', 'shopify', 'wix', 'squarespace', 'joomla')),
  base_url text not null check (base_url ~ '^https://' and length(base_url) <= 2048),
  auth_type text not null check (length(auth_type) <= 40),
  -- Non-secret identifiers only, such as a Wix site ID.
  settings jsonb not null default '{}',
  status text not null default 'not_connected'
    check (status in ('not_connected', 'connected', 'partial', 'failed')),
  granted_permissions jsonb not null default '[]',
  last_checked_at timestamptz,
  last_error_code text check (length(last_error_code) <= 60),
  created_by uuid not null references hub.staff_users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (website_id, adapter_key),
  unique (client_account_id, id),
  foreign key (client_account_id, website_id) references hub.managed_websites (client_account_id, id)
);

-- Envelope-encrypted secrets. The key-encryption key is never in this database,
-- and hub_app has no SELECT on the encrypted columns (see 0002).
create table hub.connection_credentials (
  id uuid primary key,
  client_account_id uuid not null,
  connection_id uuid not null,
  key_id text not null check (length(key_id) between 1 and 40),
  wrapped_dek text not null,
  dek_nonce text not null,
  dek_tag text not null,
  ciphertext text not null,
  nonce text not null,
  auth_tag text not null,
  created_by uuid not null references hub.staff_users (id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references hub.staff_users (id),
  foreign key (client_account_id, connection_id) references hub.platform_connections (client_account_id, id),
  check ((revoked_at is null) = (revoked_by is null))
);
create unique index connection_credentials_one_active
  on hub.connection_credentials (connection_id) where revoked_at is null;

create table hub.platform_snapshots (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  connection_id uuid not null,
  outcome text not null check (outcome in ('ok', 'partial', 'failed')),
  error_code text check (length(error_code) <= 60),
  data jsonb not null default '{}',
  captured_at timestamptz not null default now(),
  requested_by uuid references hub.staff_users (id),
  foreign key (client_account_id, connection_id) references hub.platform_connections (client_account_id, id)
);
create index platform_snapshots_recent_idx on hub.platform_snapshots (connection_id, captured_at desc);

create table hub.operation_requests (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  connection_id uuid not null,
  operation_key text not null check (length(operation_key) <= 60),
  params jsonb not null default '{}',
  reason text not null check (length(reason) between 5 and 1000),
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'rejected', 'executed', 'failed')),
  requested_by uuid not null references hub.staff_users (id),
  decided_by uuid references hub.staff_users (id),
  decided_at timestamptz,
  executed_at timestamptz,
  result_code text check (length(result_code) <= 60),
  created_at timestamptz not null default now(),
  foreign key (client_account_id, connection_id) references hub.platform_connections (client_account_id, id),
  -- Nobody approves their own change to a customer's site.
  check (decided_by is null or decided_by <> requested_by or status = 'rejected'),
  check (status not in ('approved', 'executed', 'failed') or decided_by is not null)
);

-- Maintenance ---------------------------------------------------------------

create table hub.maintenance_schedules (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  website_id uuid not null,
  title text not null check (length(title) between 1 and 160),
  interval_days integer not null check (interval_days between 1 and 366),
  next_due_on date not null,
  default_assignee_id uuid references hub.staff_users (id),
  active boolean not null default true,
  created_by uuid not null references hub.staff_users (id),
  created_at timestamptz not null default now(),
  unique (client_account_id, id),
  foreign key (client_account_id, website_id) references hub.managed_websites (client_account_id, id)
);

create table hub.maintenance_tasks (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  website_id uuid not null,
  schedule_id uuid,
  title text not null check (length(title) between 1 and 160),
  details text not null default '' check (length(details) <= 4000),
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'blocked', 'completed', 'cancelled')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assignee_id uuid references hub.staff_users (id),
  due_on date,
  completed_at timestamptz,
  completed_by uuid references hub.staff_users (id),
  completion_notes text check (length(completion_notes) <= 4000),
  stackltr_request_id uuid,
  created_by uuid not null references hub.staff_users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_account_id, id),
  foreign key (client_account_id, website_id) references hub.managed_websites (client_account_id, id),
  foreign key (client_account_id, schedule_id) references hub.maintenance_schedules (client_account_id, id),
  check ((status = 'completed') = (completed_at is not null)),
  check ((status = 'completed') = (completed_by is not null)),
  check (status <> 'completed' or coalesce(length(completion_notes), 0) >= 3)
);
create index maintenance_tasks_open_idx on hub.maintenance_tasks (client_account_id, status, due_on);

-- Append-only record of work done.
create table hub.service_history (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  website_id uuid not null,
  task_id uuid,
  kind text not null check (kind in ('maintenance', 'security', 'backup', 'restore', 'connection', 'other')),
  summary text not null check (length(summary) between 3 and 4000),
  source text not null check (source in ('staff', 'system')),
  performed_by uuid references hub.staff_users (id),
  performed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (client_account_id, website_id) references hub.managed_websites (client_account_id, id),
  foreign key (client_account_id, task_id) references hub.maintenance_tasks (client_account_id, id)
);
create index service_history_website_idx on hub.service_history (website_id, performed_at desc);

-- Monitoring ----------------------------------------------------------------

create table hub.monitoring_checks (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  website_id uuid not null,
  kind text not null check (kind in ('uptime', 'ssl')),
  target_url text not null check (target_url ~ '^https?://' and length(target_url) <= 2048),
  interval_minutes integer not null check (interval_minutes between 5 and 10080),
  enabled boolean not null default true,
  next_run_at timestamptz not null default now(),
  created_by uuid not null references hub.staff_users (id),
  created_at timestamptz not null default now(),
  unique (website_id, kind),
  unique (client_account_id, id),
  foreign key (client_account_id, website_id) references hub.managed_websites (client_account_id, id)
);

-- Only written by a probe that actually ran. An absent row means unknown.
create table hub.monitoring_results (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  check_id uuid not null,
  outcome text not null check (outcome in ('up', 'down', 'error')),
  http_status integer check (http_status between 100 and 599),
  response_ms integer check (response_ms >= 0),
  tls_valid_to timestamptz,
  tls_issuer text check (length(tls_issuer) <= 200),
  error_code text check (length(error_code) <= 60),
  checked_at timestamptz not null default now(),
  foreign key (client_account_id, check_id) references hub.monitoring_checks (client_account_id, id)
);
create index monitoring_results_recent_idx on hub.monitoring_results (check_id, checked_at desc);

-- Security reviews ----------------------------------------------------------

create table hub.security_reviews (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  website_id uuid not null,
  scope text not null check (length(scope) between 3 and 1000),
  outcome text not null check (outcome in ('no_findings', 'findings', 'incomplete')),
  summary text not null check (length(summary) between 3 and 4000),
  evidence_ref text check (length(evidence_ref) <= 500),
  reviewed_by uuid not null references hub.staff_users (id),
  reviewed_at timestamptz not null,
  next_due_on date,
  created_at timestamptz not null default now(),
  foreign key (client_account_id, website_id) references hub.managed_websites (client_account_id, id)
);
create index security_reviews_website_idx on hub.security_reviews (website_id, reviewed_at desc);

-- Backups and restore evidence ----------------------------------------------

create table hub.backup_sources (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  website_id uuid not null,
  provider text not null check (length(provider) between 1 and 80),
  label text not null check (length(label) between 1 and 160),
  expected_interval_hours integer check (expected_interval_hours between 1 and 8760),
  active boolean not null default true,
  created_by uuid not null references hub.staff_users (id),
  created_at timestamptz not null default now(),
  unique (client_account_id, id),
  foreign key (client_account_id, website_id) references hub.managed_websites (client_account_id, id)
);

create table hub.backup_runs (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  source_id uuid not null,
  status text not null check (status in ('succeeded', 'failed', 'unknown')),
  finished_at timestamptz not null,
  size_bytes bigint check (size_bytes >= 0),
  artifact_ref text check (length(artifact_ref) <= 500),
  reported_by text not null check (reported_by in ('provider', 'staff')),
  recorded_by uuid references hub.staff_users (id),
  created_at timestamptz not null default now(),
  unique (client_account_id, id),
  foreign key (client_account_id, source_id) references hub.backup_sources (client_account_id, id)
);
create index backup_runs_recent_idx on hub.backup_runs (source_id, finished_at desc);

-- The only evidence that may support a claim that a backup can be restored.
create table hub.restore_verifications (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null,
  backup_run_id uuid not null,
  target_environment text not null check (target_environment in ('isolated', 'staging', 'production')),
  outcome text not null check (outcome in ('passed', 'partial', 'failed')),
  checks_performed text not null check (length(checks_performed) between 10 and 4000),
  evidence_ref text check (length(evidence_ref) <= 500),
  performed_by uuid not null references hub.staff_users (id),
  performed_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (client_account_id, backup_run_id) references hub.backup_runs (client_account_id, id),
  -- coalesce matters: a NULL check result counts as passing.
  check (outcome <> 'passed' or coalesce(length(evidence_ref), 0) >= 3)
);
create index restore_verifications_run_idx on hub.restore_verifications (backup_run_id, performed_at desc);

create function hub.restore_requires_successful_backup() returns trigger
language plpgsql security definer set search_path = hub, pg_temp as $$
begin
  if new.outcome = 'passed' and not exists (
    select 1 from hub.backup_runs where id = new.backup_run_id and status = 'succeeded'
  ) then
    raise exception 'A passed restore needs a backup run that succeeded' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger restore_requires_successful_backup before insert on hub.restore_verifications
  for each row execute function hub.restore_requires_successful_backup();

-- StackLTR integration ------------------------------------------------------

-- Outbound events wait here so a StackLTR outage can never block hub work.
create table hub.stackltr_outbox (
  id uuid primary key default gen_random_uuid(),
  client_account_id uuid not null references hub.client_accounts (id),
  event_type text not null check (length(event_type) <= 60),
  idempotency_key text not null unique check (length(idempotency_key) <= 120),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error_code text check (length(last_error_code) <= 60),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index stackltr_outbox_pending_idx on hub.stackltr_outbox (created_at) where status = 'pending';

-- Audit log -----------------------------------------------------------------

create table hub.audit_log (
  seq bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('staff', 'system', 'anonymous')),
  actor_staff_id uuid references hub.staff_users (id),
  action text not null check (length(action) between 3 and 80),
  outcome text not null default 'success' check (outcome in ('success', 'denied', 'failure')),
  entity_type text check (length(entity_type) <= 60),
  entity_id text check (length(entity_id) <= 120),
  client_account_id uuid references hub.client_accounts (id),
  request_id text check (length(request_id) <= 80),
  metadata jsonb not null default '{}',
  prev_hash text not null,
  entry_hash text not null,
  check ((actor_type = 'staff') = (actor_staff_id is not null))
);
create index audit_log_client_idx on hub.audit_log (client_account_id, seq desc);

create function hub.audit_entry_hash(a hub.audit_log) returns text
language sql immutable as $$
  select encode(sha256(convert_to(concat_ws('|',
    a.prev_hash, extract(epoch from a.occurred_at)::text, a.actor_type,
    coalesce(a.actor_staff_id::text, '-'), a.action, a.outcome,
    coalesce(a.entity_type, '-'), coalesce(a.entity_id, '-'),
    coalesce(a.client_account_id::text, '-'), coalesce(a.request_id, '-'),
    a.metadata::text), 'UTF8')), 'hex')
$$;

create function hub.audit_chain() returns trigger
language plpgsql security definer set search_path = hub, pg_temp as $$
begin
  -- Serialized so each entry commits against its true predecessor.
  perform pg_advisory_xact_lock(hashtext('hub.audit_log'));
  new.occurred_at := clock_timestamp();
  new.prev_hash := coalesce((select entry_hash from hub.audit_log order by seq desc limit 1), 'genesis');
  new.entry_hash := hub.audit_entry_hash(new);
  return new;
end $$;
create trigger audit_chain before insert on hub.audit_log
  for each row execute function hub.audit_chain();

-- Returns the first sequence number whose hash does not verify, or null.
create function hub.verify_audit_chain() returns bigint
language plpgsql security definer set search_path = hub, pg_temp as $$
declare a hub.audit_log; previous text := 'genesis';
begin
  for a in select * from hub.audit_log order by seq loop
    if a.prev_hash <> previous or a.entry_hash <> hub.audit_entry_hash(a) then
      return a.seq;
    end if;
    previous := a.entry_hash;
  end loop;
  return null;
end $$;

create function hub.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;

do $$
declare t text;
begin
  foreach t in array array['audit_log', 'service_history', 'monitoring_results', 'restore_verifications'] loop
    execute format('create trigger %I before update or delete on hub.%I
      for each row execute function hub.forbid_mutation()', t || '_append_only', t);
    execute format('create trigger %I before truncate on hub.%I
      for each statement execute function hub.forbid_mutation()', t || '_no_truncate', t);
  end loop;
end $$;
