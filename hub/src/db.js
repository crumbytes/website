import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROLES = new Set(['hub_auth', 'hub_app', 'hub_worker']);
const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations/', import.meta.url));

// Every query runs inside a transaction that has dropped to one database role.
// The settings are transaction-local, so they cannot leak across pooled connections.
export function createDb(driver) {
  return {
    as(role, staffId, fn) {
      if (!ROLES.has(role)) throw new Error('Unknown database role');
      return driver.transaction(async tx => {
        await tx.query(`select set_config('role', $1, true), set_config('hub.staff_id', $2, true)`, [role, staffId || '']);
        return fn(tx);
      });
    },
    close: () => driver.close()
  };
}

export function pgDriver(connectionString, Pool) {
  const pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000, query_timeout: 15000, statement_timeout: 15000 });
  const checked = new WeakSet();
  return {
    async transaction(fn) {
      const client = await pool.connect();
      try {
        if (!checked.has(client)) {
          const { rows: [role] } = await client.query(`select exists (select 1 from pg_roles dangerous where dangerous.rolname in ('hub_auth','hub_app','hub_worker')
              and (dangerous.rolsuper or dangerous.rolbypassrls or dangerous.rolcreaterole or dangerous.rolcreatedb)) as unsafe_hub_roles,
            current_user as name, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
            (select pg_has_role(current_user, d.datdba, 'MEMBER') from pg_database d where d.datname=current_database()) as owns_database,
            exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
              where n.nspname='hub' and pg_has_role(current_user, c.relowner, 'MEMBER')) as owns_hub_objects
            from pg_roles r where r.rolname=current_user`);
          if (!role || role.name !== 'hub_runtime' || role.rolsuper || role.rolbypassrls || role.rolcreaterole ||
              role.rolcreatedb || role.unsafe_hub_roles || role.owns_database || role.owns_hub_objects) throw new Error('Unsafe Hub runtime database role');
          checked.add(client);
        }
        await client.query('begin');
        const result = await fn(client);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
}

// In-process PostgreSQL for tests and local development.
export function pgliteDriver(pglite) {
  return {
    transaction: fn => pglite.transaction(fn),
    close: () => pglite.close()
  };
}

// Each file runs once, inside its own transaction, and is recorded with a checksum.
// A file edited after it was applied stops the run, because history must not change.
export async function migrate(executor, { log = () => {} } = {}) {
  await executor.exec(`create schema if not exists hub_meta;
    create table if not exists hub_meta.migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  const applied = new Map((await executor.query(`select name, checksum from hub_meta.migrations`)).rows.map(row => [row.name, row.checksum]));
  const files = (await readdir(MIGRATIONS_DIR)).filter(name => name.endsWith('.sql')).sort();
  const ran = [];
  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
    if (applied.has(file)) {
      if (applied.get(file) !== checksum) throw new Error(`Migration ${file} changed after it was applied. Add a new migration instead.`);
      continue;
    }
    log(`Applying ${file}`);
    await executor.exec(`begin;\n${sql}\ninsert into hub_meta.migrations (name, checksum) values ('${file}', '${checksum}');\ncommit;`);
    ran.push(file);
  }
  return ran;
}

export const applyMigrations = pglite => migrate(pglite);

// Creates the first owner. Later staff are added in the app, so this refuses to run twice.
export async function provisionFirstOwner(executor, { email, displayName }) {
  const { rows } = await executor.query(`select 1 from hub.staff_users where role = 'owner' limit 1`);
  if (rows.length) throw new Error('An owner already exists. Add staff in the app.');
  const created = await executor.query(
    `insert into hub.staff_users (email, display_name, role) values ($1, $2, 'owner') returning id`, [email.trim().toLowerCase(), displayName.trim()]);
  await executor.query(
    `insert into hub.audit_log (actor_type, action, entity_type, entity_id, metadata, prev_hash, entry_hash)
     values ('system', 'staff.provision_owner', 'staff_user', $1, '{}', '', '')`, [created.rows[0].id]);
  return created.rows[0].id;
}

export const one = result => result.rows[0] ?? null;
