-- Customer portal uses existing OIDC identities/tenant assignments, never a CRM.
alter table hub.staff_users add column is_customer boolean not null default false;
alter table hub.staff_users add constraint customer_role check (not is_customer or role = 'viewer');
create function hub.is_customer() returns boolean language sql stable security definer set search_path=hub,pg_temp as $$
 select coalesce((select is_customer from hub.staff_users where id=hub.current_staff_id() and status='active'),false)
$$;
revoke all on function hub.is_customer() from public;
grant execute on function hub.is_customer() to hub_app;
create table hub.client_contacts (
 id uuid primary key default gen_random_uuid(), client_account_id uuid not null references hub.client_accounts(id),
 display_name text not null check(length(display_name) between 1 and 160),
 email text not null check(length(email) between 3 and 254), phone text not null default '' check(length(phone)<=80),
 purpose text not null default '' check(length(purpose)<=500), active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table hub.support_requests (
 id uuid primary key default gen_random_uuid(), client_account_id uuid not null references hub.client_accounts(id),
 website_id uuid references hub.managed_websites(id), requested_by uuid not null references hub.staff_users(id),
 subject text not null check(length(subject) between 3 and 160), body text not null check(length(body) between 3 and 4000),
 status text not null default 'open' check(status in ('open','in_progress','waiting','resolved','closed')),
 resolution text not null default '' check(length(resolution)<=4000),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key (website_id,client_account_id) references hub.managed_websites(id,client_account_id)
);
create index support_client_status on hub.support_requests(client_account_id,status,created_at desc);
create table hub.task_rollbacks (
 id uuid primary key default gen_random_uuid(), task_id uuid not null references hub.maintenance_tasks(id),
 client_account_id uuid not null references hub.client_accounts(id), plan text not null check(length(plan) between 10 and 4000),
 status text not null check(status in ('planned','completed','failed')), evidence_ref text,
 recorded_by uuid not null references hub.staff_users(id), recorded_at timestamptz not null default now(),
 check(status='planned' or length(evidence_ref)>=3)
);
do $$ declare t text; begin
 foreach t in array array['client_contacts','support_requests','task_rollbacks'] loop
  execute format('alter table hub.%I enable row level security',t);
  execute format('grant select,insert,update on hub.%I to hub_app',t);
  execute format('grant select on hub.%I to hub_worker',t);
  execute format('create policy tenant_read on hub.%I for select to hub_app using(hub.can_access_client(client_account_id))',t);
  execute format('create policy worker_read on hub.%I for select to hub_worker using(true)',t);
 end loop;
end $$;
create policy contact_insert on hub.client_contacts for insert to hub_app with check(hub.can_access_client(client_account_id) and (hub.has_role('owner','admin') or hub.is_customer()));
create policy contact_update on hub.client_contacts for update to hub_app using(hub.can_access_client(client_account_id) and (hub.has_role('owner','admin') or hub.is_customer())) with check(hub.can_access_client(client_account_id));
create policy request_insert on hub.support_requests for insert to hub_app with check(hub.can_access_client(client_account_id) and requested_by=hub.current_staff_id());
create policy request_update on hub.support_requests for update to hub_app using(hub.can_access_client(client_account_id) and hub.has_role('owner','admin','technician')) with check(hub.can_access_client(client_account_id));
create policy rollback_insert on hub.task_rollbacks for insert to hub_app with check(hub.can_access_client(client_account_id) and hub.has_role('owner','admin','technician') and recorded_by=hub.current_staff_id() and exists(select 1 from hub.maintenance_tasks t where t.id=task_id and t.client_account_id=task_rollbacks.client_account_id));
-- Append-only rollback evidence; no update policy.
alter table hub.monitoring_checks drop constraint monitoring_checks_kind_check;
alter table hub.monitoring_checks add constraint monitoring_checks_kind_check check(kind in ('uptime','ssl','dns'));
alter table hub.monitoring_checks add column lease_token uuid;
alter table hub.monitoring_checks add column lease_until timestamptz;
alter table hub.monitoring_results add column dns_addresses jsonb;
alter table hub.monitoring_results add column dns_changed boolean not null default false;
-- One queued occurrence per schedule. Cancelled/completed occurrences stay history.
alter table hub.maintenance_tasks add column schedule_due_on date;
create unique index maintenance_occurrence on hub.maintenance_tasks(schedule_id,schedule_due_on) where schedule_id is not null and schedule_due_on is not null;
grant update(is_customer) on hub.staff_users to hub_app;
grant select(id,email,display_name,role,status,last_login_at,created_at,is_customer) on hub.staff_users to hub_app;
grant insert(email,display_name,role,is_customer) on hub.staff_users to hub_app;

alter table hub.task_rollbacks add foreign key(client_account_id,task_id) references hub.maintenance_tasks(client_account_id,id);
grant insert on hub.maintenance_tasks to hub_worker;
create policy worker_schedule_insert on hub.maintenance_tasks for insert to hub_worker with check (
 schedule_id is not null and schedule_due_on is not null and exists(
 select 1 from hub.maintenance_schedules s where s.id=maintenance_tasks.schedule_id and s.client_account_id=maintenance_tasks.client_account_id and s.website_id=maintenance_tasks.website_id and s.active
  and s.next_due_on=maintenance_tasks.schedule_due_on and s.created_by=maintenance_tasks.created_by)
);


grant update(key_id,wrapped_dek,dek_nonce,dek_tag) on hub.connection_credentials to hub_worker;
create policy worker_rewrap on hub.connection_credentials for update to hub_worker using(revoked_at is null) with check(revoked_at is null);
grant update(lease_token,lease_until) on hub.monitoring_checks to hub_worker;
grant update(next_due_on) on hub.maintenance_schedules to hub_worker;
create policy worker_schedule_lock on hub.maintenance_schedules for update to hub_worker using(true) with check(true);
-- Sharing is reversible metadata; original service history remains immutable.
create table hub.portal_history_shares (
 history_id uuid primary key references hub.service_history(id),client_account_id uuid not null references hub.client_accounts(id),
 active boolean not null default true,shared_by uuid not null references hub.staff_users(id),updated_at timestamptz not null default now()
);
alter table hub.portal_history_shares enable row level security;
grant select,insert,update on hub.portal_history_shares to hub_app;
create policy share_read on hub.portal_history_shares for select to hub_app using(hub.can_access_client(client_account_id));
create policy share_write on hub.portal_history_shares for insert to hub_app with check(hub.has_role('owner','admin','technician') and shared_by=hub.current_staff_id() and exists(select 1 from hub.service_history h where h.id=history_id and h.client_account_id=portal_history_shares.client_account_id));
create policy share_update on hub.portal_history_shares for update to hub_app using(hub.has_role('owner','admin','technician') and hub.can_access_client(client_account_id)) with check(hub.can_access_client(client_account_id) and shared_by=hub.current_staff_id() and exists(select 1 from hub.service_history h where h.id=history_id and h.client_account_id=portal_history_shares.client_account_id));
