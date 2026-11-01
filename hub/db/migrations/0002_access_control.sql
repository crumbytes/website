-- Website Management Hub: database roles and row level security.
-- PROPOSAL. Not applied to any hosted database.
--
-- hub_auth    sign-in and session lookup, before a staff identity is known.
-- hub_app     every staff request; scoped by hub.staff_id through RLS.
-- hub_worker  background probes and credential decryption inputs.
--
-- hub_runtime is what the application connects as. It has no rights of its own
-- and must pick one of the three per transaction. It is created without a login:
-- deployment grants LOGIN and a password from the secrets manager, outside any
-- migration, so no credential ever appears in this repository.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hub_runtime') then
    create role hub_runtime nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;
grant hub_auth, hub_app, hub_worker to hub_runtime;

create function hub.current_staff_id() returns uuid
language sql stable as $$
  select nullif(current_setting('hub.staff_id', true), '')::uuid
$$;

create function hub.current_staff_role() returns text
language sql stable security definer set search_path = hub, pg_temp as $$
  select role from hub.staff_users where id = hub.current_staff_id() and status = 'active'
$$;

create function hub.has_role(variadic allowed text[]) returns boolean
language sql stable security definer set search_path = hub, pg_temp as $$
  select coalesce(hub.current_staff_role() = any (allowed), false)
$$;

-- Owners and admins see every client. Everyone else sees assigned clients only.
create function hub.can_access_client(client uuid) returns boolean
language sql stable security definer set search_path = hub, pg_temp as $$
  select hub.has_role('owner', 'admin') or (
    hub.current_staff_role() is not null and exists (
      select 1 from hub.staff_client_assignments
      where staff_id = hub.current_staff_id() and client_account_id = client
    )
  )
$$;

-- Lets a technician assign work only to someone who can see that client, without
-- being able to read other people's assignments.
create function hub.staff_can_access_client(staff uuid, client uuid) returns boolean
language sql stable security definer set search_path = hub, pg_temp as $$
  select exists (
    select 1 from hub.staff_users u
    where u.id = staff and u.status = 'active' and (
      u.role in ('owner', 'admin') or exists (
        select 1 from hub.staff_client_assignments a where a.staff_id = staff and a.client_account_id = client
      )
    )
  ) and hub.can_access_client(client)
$$;

revoke all on all functions in schema hub from public;
grant usage on schema hub to hub_auth, hub_app, hub_worker;
grant execute on function hub.current_staff_id(), hub.current_staff_role(), hub.can_access_client(uuid),
  hub.has_role(text[]) to hub_app, hub_worker, hub_auth;
grant execute on function hub.verify_audit_chain(), hub.staff_can_access_client(uuid, uuid) to hub_app;

-- RLS is on for every table. Only the migration owner is exempt, and the
-- application never connects as the owner.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'hub' loop
    execute format('alter table hub.%I enable row level security', t);
  end loop;
end $$;

-- Sign-in ------------------------------------------------------------------

grant select, insert, delete on hub.oidc_login_states to hub_auth;
grant select, insert, update on hub.staff_sessions to hub_auth;
grant select on hub.staff_users to hub_auth;
grant update (oidc_issuer, oidc_subject, last_login_at) on hub.staff_users to hub_auth;
create policy auth_all on hub.oidc_login_states for all to hub_auth using (true) with check (true);
create policy auth_all on hub.staff_sessions for all to hub_auth using (true) with check (true);
create policy auth_read on hub.staff_users for select to hub_auth using (true);
create policy auth_bind on hub.staff_users for update to hub_auth using (true) with check (true);

-- Staff directory ----------------------------------------------------------

-- Sign-in identifiers are left out of the staff-facing column grant.
grant select (id, email, display_name, role, status, last_login_at, created_at) on hub.staff_users to hub_app;
grant insert (email, display_name, role) on hub.staff_users to hub_app;
grant update (display_name, role, status, updated_at) on hub.staff_users to hub_app;
create policy staff_read on hub.staff_users for select to hub_app using (hub.current_staff_role() is not null);
-- Only an owner can create, change or disable an owner.
create policy staff_insert on hub.staff_users for insert to hub_app
  with check (hub.has_role('owner') or (hub.has_role('admin') and role <> 'owner'));
create policy staff_update on hub.staff_users for update to hub_app
  using (hub.has_role('owner') or (hub.has_role('admin') and role <> 'owner'))
  with check (hub.has_role('owner') or (hub.has_role('admin') and role <> 'owner'));
grant select (id, status) on hub.staff_users to hub_worker;
create policy worker_read on hub.staff_users for select to hub_worker using (true);

grant select, insert, delete on hub.staff_client_assignments to hub_app;
create policy assignment_read on hub.staff_client_assignments for select to hub_app
  using (hub.has_role('owner', 'admin') or staff_id = hub.current_staff_id());
create policy assignment_insert on hub.staff_client_assignments for insert to hub_app
  with check (hub.has_role('owner', 'admin') and assigned_by = hub.current_staff_id());
create policy assignment_delete on hub.staff_client_assignments for delete to hub_app
  using (hub.has_role('owner', 'admin'));

-- Clients and plans --------------------------------------------------------

grant select, insert, update on hub.client_accounts to hub_app;
create policy client_read on hub.client_accounts for select to hub_app using (hub.can_access_client(id));
create policy client_insert on hub.client_accounts for insert to hub_app
  with check (hub.has_role('owner', 'admin') and created_by = hub.current_staff_id());
create policy client_update on hub.client_accounts for update to hub_app
  using (hub.has_role('owner', 'admin')) with check (hub.has_role('owner', 'admin'));
grant select on hub.client_accounts to hub_worker;
create policy worker_read on hub.client_accounts for select to hub_worker using (true);

grant select, insert, update on hub.service_plans to hub_app;
create policy plan_read on hub.service_plans for select to hub_app using (hub.current_staff_role() is not null);
create policy plan_insert on hub.service_plans for insert to hub_app
  with check (hub.has_role('owner', 'admin') and created_by = hub.current_staff_id());
create policy plan_update on hub.service_plans for update to hub_app
  using (hub.has_role('owner', 'admin')) with check (hub.has_role('owner', 'admin'));

-- Client-scoped records ----------------------------------------------------

-- Everyone assigned to a client can read it. Writes follow the role lists below
-- and also need access to that client. No hub_app role has DELETE on these.
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('managed_websites',      array['owner','admin','technician'], true),
      ('platform_connections',  array['owner','admin'],              true),
      ('operation_requests',    array['owner','admin','technician'], false),
      ('maintenance_schedules', array['owner','admin','technician'], true),
      ('maintenance_tasks',     array['owner','admin','technician'], true),
      ('monitoring_checks',     array['owner','admin','technician'], true),
      ('backup_sources',        array['owner','admin','technician'], true),
      ('backup_runs',           array['owner','admin','technician'], false),
      ('service_history',       array['owner','admin','technician'], false),
      ('security_reviews',      array['owner','admin','technician'], false),
      ('restore_verifications', array['owner','admin','technician'], false)
    ) as s(tbl, writers, updatable)
  loop
    execute format('grant select, insert on hub.%I to hub_app', spec.tbl);
    execute format('create policy scoped_read on hub.%I for select to hub_app
      using (hub.can_access_client(client_account_id))', spec.tbl);
    execute format('create policy scoped_insert on hub.%I for insert to hub_app
      with check (hub.can_access_client(client_account_id) and hub.has_role(variadic %L::text[]))',
      spec.tbl, spec.writers);
    if spec.updatable then
      execute format('grant update on hub.%I to hub_app', spec.tbl);
      execute format('create policy scoped_update on hub.%I for update to hub_app
        using (hub.can_access_client(client_account_id) and hub.has_role(variadic %L::text[]))
        with check (hub.can_access_client(client_account_id) and hub.has_role(variadic %L::text[]))',
        spec.tbl, spec.writers, spec.writers);
    end if;
  end loop;
end $$;

-- Technicians can ask for an operation. Only owners and admins can decide one.
grant update (status, decided_by, decided_at) on hub.operation_requests to hub_app;
create policy operation_decide on hub.operation_requests for update to hub_app
  using (hub.can_access_client(client_account_id) and hub.has_role('owner', 'admin'))
  with check (hub.can_access_client(client_account_id) and hub.has_role('owner', 'admin') and decided_by = hub.current_staff_id());

-- Read-only for staff; only the worker writes these.
grant select on hub.platform_snapshots, hub.monitoring_results to hub_app;
create policy scoped_read on hub.platform_snapshots for select to hub_app using (hub.can_access_client(client_account_id));
create policy scoped_read on hub.monitoring_results for select to hub_app using (hub.can_access_client(client_account_id));

-- Credentials: hub_app can add and revoke but can never read encrypted columns.
grant select (id, client_account_id, connection_id, key_id, created_by, created_at, revoked_at, revoked_by)
  on hub.connection_credentials to hub_app;
grant insert on hub.connection_credentials to hub_app;
grant update (revoked_at, revoked_by) on hub.connection_credentials to hub_app;
create policy credential_read on hub.connection_credentials for select to hub_app
  using (hub.can_access_client(client_account_id) and hub.has_role('owner', 'admin'));
create policy credential_insert on hub.connection_credentials for insert to hub_app
  with check (hub.can_access_client(client_account_id) and hub.has_role('owner', 'admin')
    and created_by = hub.current_staff_id());
create policy credential_revoke on hub.connection_credentials for update to hub_app
  using (hub.can_access_client(client_account_id) and hub.has_role('owner', 'admin'))
  with check (hub.can_access_client(client_account_id) and hub.has_role('owner', 'admin'));

-- StackLTR outbox: staff actions enqueue, only the worker reads and delivers.
grant insert on hub.stackltr_outbox to hub_app;
create policy outbox_insert on hub.stackltr_outbox for insert to hub_app
  with check (hub.can_access_client(client_account_id));

-- Worker -------------------------------------------------------------------

grant select on hub.managed_websites, hub.monitoring_checks, hub.connection_credentials, hub.operation_requests
  to hub_worker;
grant select, update on hub.platform_connections, hub.stackltr_outbox to hub_worker;
grant update (next_run_at) on hub.monitoring_checks to hub_worker;
grant update (status, executed_at, result_code) on hub.operation_requests to hub_worker;
grant insert on hub.monitoring_results, hub.platform_snapshots, hub.service_history to hub_worker;
create policy worker_all on hub.managed_websites for select to hub_worker using (true);
create policy worker_all on hub.monitoring_checks for all to hub_worker using (true) with check (true);
create policy worker_all on hub.connection_credentials for select to hub_worker using (true);
create policy worker_all on hub.operation_requests for all to hub_worker using (true) with check (true);
create policy worker_all on hub.platform_connections for all to hub_worker using (true) with check (true);
create policy worker_all on hub.stackltr_outbox for all to hub_worker using (true) with check (true);
create policy worker_insert on hub.monitoring_results for insert to hub_worker with check (true);
create policy worker_insert on hub.platform_snapshots for insert to hub_worker with check (true);
create policy worker_insert on hub.service_history for insert to hub_worker
  with check (source = 'system');

-- Audit log ----------------------------------------------------------------

-- Staff can only write entries in their own name, and only owners and admins
-- read the log. Nobody has UPDATE or DELETE, and triggers refuse them anyway.
grant insert (actor_type, actor_staff_id, action, outcome, entity_type, entity_id, client_account_id, request_id, metadata, prev_hash, entry_hash)
  on hub.audit_log to hub_auth, hub_app, hub_worker;
create policy audit_auth_insert on hub.audit_log for insert to hub_auth with check (true);
create policy audit_worker_insert on hub.audit_log for insert to hub_worker with check (true);
create policy audit_app_insert on hub.audit_log for insert to hub_app
  with check (actor_type = 'staff' and actor_staff_id = hub.current_staff_id());
grant select on hub.audit_log to hub_app;
create policy audit_read on hub.audit_log for select to hub_app using (hub.has_role('owner', 'admin'));
