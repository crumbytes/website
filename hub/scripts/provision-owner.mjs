// Creates the first owner on an approved database. They sign in through the identity
// provider using this email. Usage: node scripts/provision-owner.mjs <email> "<name>"
import pg from 'pg';
import { provisionFirstOwner } from '../src/db.js';

const [email, displayName] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url || !email || !displayName) {
  console.error('Usage: DATABASE_URL=... HUB_MIGRATE_CONFIRM_HOST=... node scripts/provision-owner.mjs <email> "<name>"');
  process.exit(1);
}
if (process.env.HUB_MIGRATE_CONFIRM_HOST !== new URL(url).hostname) {
  console.error('Refusing to run. Set HUB_MIGRATE_CONFIRM_HOST to the database host once this has been approved.');
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await provisionFirstOwner(client, { email, displayName });
  console.log('Owner created.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
