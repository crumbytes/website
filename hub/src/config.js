const DEV_ENVIRONMENTS = new Set(['development', 'test']);

export class ConfigError extends Error {}

const flag = value => value === 'true';

// A missing or unsafe setting stops the app. It never falls back to something
// weaker, because an unconfigured preview deployment must not serve anything.
export function loadConfig(env = process.env) {
  const problems = [];
  const required = name => {
    if (!env[name]) problems.push(`${name} is required`);
    return env[name];
  };
  const environment = env.HUB_ENV || 'production';
  if (!['development', 'test', 'production'].includes(environment)) problems.push('HUB_ENV is invalid');
  const isDev = DEV_ENVIRONMENTS.has(environment);
  if (isDev && (env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production')) {
    problems.push('HUB_ENV cannot be a development value on a production host');
  }

  const baseUrl = required('HUB_BASE_URL');
  let origin = null;
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      origin = url.origin;
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (url.protocol !== 'https:' && !(isDev && local)) problems.push('HUB_BASE_URL must use https');
    } catch {
      problems.push('HUB_BASE_URL is not a valid URL');
    }
  }

  const issuer = required('HUB_OIDC_ISSUER');
  if (issuer && !issuer.startsWith('https://') && !isDev) problems.push('HUB_OIDC_ISSUER must use https');

  const jobSecret = env.HUB_JOB_SECRET || null;
  if (jobSecret && jobSecret.length < 32) problems.push('HUB_JOB_SECRET must be at least 32 characters');

  const credentialStorageEnabled = flag(env.HUB_CREDENTIAL_STORAGE_ENABLED);
  if (credentialStorageEnabled && (!env.HUB_CREDENTIAL_KEKS || !env.HUB_CREDENTIAL_ACTIVE_KEY)) {
    problems.push('Credential storage needs HUB_CREDENTIAL_KEKS and HUB_CREDENTIAL_ACTIVE_KEY');
  }

  if (!isDev) required('DATABASE_URL');
  if (problems.length) throw new ConfigError(problems.join('; '));

  return Object.freeze({
    environment,
    isDev,
    baseUrl,
    origin,
    databaseUrl: env.DATABASE_URL || null,
    oidc: Object.freeze({
      issuer,
      clientId: required('HUB_OIDC_CLIENT_ID'),
      clientSecret: env.HUB_OIDC_CLIENT_SECRET || null,
      redirectUri: `${origin}/auth/callback`,
      requiredAmr: env.HUB_OIDC_REQUIRED_AMR || null
    }),
    session: Object.freeze({
      cookieName: isDev ? 'hub_session' : '__Host-hub_session',
      bindingCookieName: isDev ? 'hub_login' : '__Host-hub_login',
      secure: !isDev,
      idleMinutes: 30,
      absoluteMinutes: 8 * 60
    }),
    credentials: Object.freeze({
      storageEnabled: credentialStorageEnabled,
      keks: env.HUB_CREDENTIAL_KEKS || '',
      activeKey: env.HUB_CREDENTIAL_ACTIVE_KEY || ''
    }),
    outboundEnabled: flag(env.HUB_OUTBOUND_ENABLED),
    operationsEnabled: flag(env.HUB_OPERATIONS_ENABLED),
    jobSecret,
    stackltr: Object.freeze({
      enabled: flag(env.HUB_STACKLTR_ENABLED),
      baseUrl: env.HUB_STACKLTR_BASE_URL || null,
      token: env.HUB_STACKLTR_TOKEN || null
    })
  });
}
