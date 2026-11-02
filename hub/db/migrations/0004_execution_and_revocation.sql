-- Durable, single-use execution claims. Never delete/release a claim after an
-- uncertain external result: a crash or timeout must not permit a second send.
create table hub.operation_execution_claims (
  operation_id uuid primary key references hub.operation_requests(id),
  claim_token uuid not null unique,
  claimed_by uuid not null references hub.staff_users(id),
  claimed_at timestamptz not null default now()
);
alter table hub.operation_execution_claims enable row level security;
grant select, insert on hub.operation_execution_claims to hub_app;
create policy claim_read on hub.operation_execution_claims for select to hub_app using (
  exists (select 1 from hub.operation_requests o where o.id = operation_id)
);
create policy claim_insert on hub.operation_execution_claims for insert to hub_app with check (
  hub.has_role('owner', 'admin') and claimed_by = hub.current_staff_id() and exists (
    select 1 from hub.operation_requests o where o.id = operation_id and o.status = 'approved'
      and o.decided_by is not null and o.decided_by <> o.requested_by
  )
);
grant select on hub.operation_execution_claims to hub_worker;
create policy worker_read on hub.operation_execution_claims for select to hub_worker using (true);

-- Enforce revocation even for direct administrative SQL updates. The function
-- owner can update sessions; ordinary staff roles never gain that privilege.
create function hub.revoke_disabled_staff_sessions() returns trigger
language plpgsql security definer set search_path = hub, pg_temp as $$
begin
  if new.status = 'disabled' and old.status is distinct from new.status then
    update hub.staff_sessions set revoked_at = now() where staff_id = new.id and revoked_at is null;
  end if;
  return new;
end $$;
revoke all on function hub.revoke_disabled_staff_sessions() from public;
create trigger revoke_disabled_staff_sessions after update of status on hub.staff_users
  for each row execute function hub.revoke_disabled_staff_sessions();
-- Cover accounts disabled before this migration too.
update hub.staff_sessions s set revoked_at = now() from hub.staff_users u
  where s.staff_id = u.id and u.status = 'disabled' and s.revoked_at is null;
