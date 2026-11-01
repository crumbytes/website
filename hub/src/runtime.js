import { createApp } from './app.js';
import { createBackupProviders } from './backups.js';
import { createEmailSender } from './email.js';
import { createLogger } from './logger.js';
import { createSafeHttp } from './safe-http.js';
import { createStackltrClient } from './stackltr.js';
import { createVault } from './vault.js';

// Wires real dependencies. Only the database driver differs between environments.
export function buildApp({ config, db, fetchImpl, http, logger, now }) {
  const outbound = http ?? createSafeHttp({ enabled: config.outboundEnabled });
  return createApp({
    config, db, fetchImpl, now,
    logger: logger ?? createLogger({ level: config.logLevel, environment: config.environment }),
    vault: createVault(config.credentials),
    http: outbound,
    stackltr: createStackltrClient(config.stackltr, outbound),
    email: createEmailSender(config.email, outbound),
    backupProviders: createBackupProviders(config.r2, outbound)
  });
}
