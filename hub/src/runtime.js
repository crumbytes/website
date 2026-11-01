import { createApp } from './app.js';
import { createSafeHttp } from './safe-http.js';
import { createStackltrClient } from './stackltr.js';
import { createVault } from './vault.js';

// Wires real dependencies. Only the database driver differs between environments.
export function buildApp({ config, db, fetchImpl, http, logger }) {
  const outbound = http ?? createSafeHttp({ enabled: config.outboundEnabled });
  return createApp({
    config, db, fetchImpl, logger,
    vault: createVault(config.credentials),
    http: outbound,
    stackltr: createStackltrClient(config.stackltr, outbound)
  });
}
