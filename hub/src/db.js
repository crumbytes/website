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
  const pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 10000 });
  return {
    async transaction(fn) {
      const client = await pool.connect();
      try {
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

export async function applyMigrations(pglite) {
  const files = (await readdir(MIGRATIONS_DIR)).filter(name => name.endsWith('.sql')).sort();
  for (const file of files) {
    await pglite.exec(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

export const one = result => result.rows[0] ?? null;
