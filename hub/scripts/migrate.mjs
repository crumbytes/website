// Applies pending migrations. Hosted databases need explicit approval first, so this
// refuses to run unless the target host is repeated in HUB_MIGRATE_CONFIRM_HOST.
import pg from 'pg';
import { migrate } from '../src/db.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
const host = new URL(url).hostname;
if (process.env.HUB_MIGRATE_CONFIRM_HOST !== host) {
  console.error(`Refusing to run. Set HUB_MIGRATE_CONFIRM_HOST to ${host} once this has been approved.`);
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const ran = await migrate({ exec: sql => client.query(sql), query: (sql, params) => client.query(sql, params) }, { log: console.log });
  console.log(ran.length ? `Applied ${ran.length} migration(s).` : 'Already up to date.');
} catch (error) {
  // Everything in the failed file rolled back, and earlier files stay applied.
  await client.query('rollback').catch(() => {});
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
