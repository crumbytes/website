import { getRequestListener } from '@hono/node-server';
import pg from 'pg';
import { ConfigError, loadConfig } from '../src/config.js';
import { createDb, pgDriver } from '../src/db.js';
import { buildApp } from '../src/runtime.js';

// A missing or unsafe setting serves a plain 503. The app is never reachable in a
// half-configured state, which is what an unconfigured preview deployment would be.
function createHandler() {
  try {
    const config = loadConfig();
    const db = createDb(pgDriver(config.databaseUrl, pg.Pool));
    return getRequestListener(buildApp({ config, db }).fetch);
  } catch (error) {
    if (!(error instanceof ConfigError)) console.error('hub.startup_failed', { name: error?.name });
    else console.error('hub.not_configured');
    return (_req, res) => {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end('This service is not configured.');
    };
  }
}

export default createHandler();
