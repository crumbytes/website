// Checks the current environment's settings without printing any value.
import { ConfigError, loadConfig } from '../src/config.js';
import { createVault } from '../src/vault.js';

try {
  const config = loadConfig();
  createVault(config.credentials);
  console.log(`Configuration is valid for ${config.environment}.`);
  for (const [name, on] of Object.entries({
    'Outbound requests and monitoring': config.outboundEnabled,
    'Credential storage': config.credentials.storageEnabled,
    'Live operations': config.operationsEnabled,
    'StackLTR delivery': config.stackltr.enabled,
    'Email': config.email.enabled,
    'R2 backup listing': config.r2.enabled,
    'MFA required at sign-in': Boolean(config.oidc.requiredAmr),
    'Scheduled jobs route': Boolean(config.jobSecret)
  })) console.log(`  ${on ? 'ON ' : 'off'}  ${name}`);
} catch (error) {
  console.error(error instanceof ConfigError ? `Not ready: ${error.message}` : `Not ready: ${error.name}`);
  process.exit(1);
}
