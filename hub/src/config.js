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
  if (!['development', 'test', 'staging', 'production'].includes(environment)) problems.push('HUB_ENV is invalid');
  const isDev = DEV_ENVIRONMENTS.has(environment);
  if (isDev && (env.VERCEL || env.VERCEL_ENV || env.NODE_ENV === 'production')) {
    problems.push('HUB_ENV cannot be a development value on a hosted or production environment');
  }

  // A production deployment must never be running with staging settings.
  if (environment === 'staging' && env.VERCEL_ENV === 'production') problems.push('HUB_ENV cannot be staging on a production host');

  const baseUrl = required('HUB_BASE_URL');
  let origin = null;
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      origin = url.origin;
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) problems.push('HUB_BASE_URL must be an origin without credentials, path, query or fragment');
      if (url.protocol !== 'https:' && !(isDev && local)) problems.push('HUB_BASE_URL must use https');
    } catch {
      problems.push('HUB_BASE_URL is not a valid URL');
    }
  }

  const issuer = required('HUB_OIDC_ISSUER');
  if (issuer) {
    try {
      const url = new URL(issuer);
      const local = ['localhost', '127.0.0.1'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(isDev && local && url.protocol === 'http:')) problems.push('HUB_OIDC_ISSUER must use https');
      if (url.username || url.password || url.search || url.hash) problems.push('HUB_OIDC_ISSUER must not contain credentials, query or fragment');
    } catch {
      problems.push('HUB_OIDC_ISSUER is not a valid URL');
    }
  }
  const clientId = required('HUB_OIDC_CLIENT_ID');
  if (!isDev) required('HUB_OIDC_REQUIRED_AMR');

  const jobSecret = env.HUB_JOB_SECRET || null;
  if (jobSecret && jobSecret.length < 32) problems.push('HUB_JOB_SECRET must be at least 32 characters');

  const credentialStorageEnabled = flag(env.HUB_CREDENTIAL_STORAGE_ENABLED);
  if (credentialStorageEnabled && (!env.HUB_CREDENTIAL_KEKS || !env.HUB_CREDENTIAL_ACTIVE_KEY)) {
    problems.push('Credential storage needs HUB_CREDENTIAL_KEKS and HUB_CREDENTIAL_ACTIVE_KEY');
  }

  if (env.HUB_RATE_LIMITS_ENABLED === 'false' && !isDev) problems.push('Rate limits can only be turned off in development');
  if (flag(env.HUB_EMAIL_ENABLED) && (!env.HUB_RESEND_API_KEY || !env.HUB_EMAIL_FROM)) problems.push('Email needs HUB_RESEND_API_KEY and HUB_EMAIL_FROM');
  if (flag(env.HUB_R2_ENABLED) && !(env.HUB_R2_ACCOUNT_ID && env.HUB_R2_BUCKET && env.HUB_R2_ACCESS_KEY_ID && env.HUB_R2_SECRET_ACCESS_KEY)) problems.push('R2 needs its account, bucket and key settings');

  if (!isDev) {
    required('DATABASE_URL');
    // Without it every person shares one sign-in limit and can lock the others out.
    required('HUB_TRUSTED_IP_HEADER');
  }
  if (environment === 'staging') {
    // Independent pins catch an accidental production connection/client copy.
    const databaseHost = required('HUB_STAGING_DATABASE_HOST');
    const databaseName = required('HUB_STAGING_DATABASE_NAME');
    const stagingIssuer = required('HUB_STAGING_OIDC_ISSUER');
    const stagingClient = required('HUB_STAGING_OIDC_CLIENT_ID');
    try {
      const db = new URL(env.DATABASE_URL);
      let runtimeLogin = 'hub_runtime';
      const projectRef = env.HUB_STAGING_SUPABASE_PROJECT_REF;
      const protectedRefs = ['oyvnmolqtzzfljvztfbe', 'tpkptbpzasrcozjorcko'];
      const supabaseHost = db.hostname.endsWith('.supabase.co') || db.hostname.endsWith('.pooler.supabase.com');
      if (projectRef || supabaseHost) {
        if (!projectRef || !/^[a-z0-9]{20}$/.test(projectRef) || protectedRefs.includes(projectRef)) {
          problems.push('A new, independently approved HUB_STAGING_SUPABASE_PROJECT_REF is required; StackLTR projects are prohibited');
        }
        const sharedPooler = db.hostname.endsWith('.pooler.supabase.com');
        if ((!sharedPooler && db.hostname !== `db.${projectRef}.supabase.co`) || databaseName !== 'postgres') {
          problems.push('Supabase connection must match the approved new project and postgres database');
        }
        if (sharedPooler) {
          runtimeLogin = `hub_runtime.${projectRef}`;
          if (!['5432', '6543'].includes(db.port)) problems.push('Supabase shared pooler requires an explicit supported port');
        }
      }
      if (protectedRefs.some(ref => db.hostname.includes(ref) || decodeURIComponent(db.username).includes(ref))) {
        problems.push('Existing StackLTR database connections are prohibited for Hub staging');
      }
      if (!['postgres:', 'postgresql:'].includes(db.protocol) || db.hostname !== databaseHost ||
          decodeURIComponent(db.pathname.slice(1)) !== databaseName || decodeURIComponent(db.username) !== runtimeLogin) {
        problems.push('Staging DATABASE_URL must match the approved host/database and dedicated hub_runtime login');
      }
    } catch { problems.push('Staging DATABASE_URL is invalid'); }
    if (issuer !== stagingIssuer || clientId !== stagingClient) problems.push('Staging OIDC configuration must match the approved staging identity');
    if (origin === 'https://hub.crumbyte.com') problems.push('Staging cannot use the production Hub origin');
    for (const name of ['HUB_OUTBOUND_ENABLED', 'HUB_OPERATIONS_ENABLED', 'HUB_CREDENTIAL_STORAGE_ENABLED',
      'HUB_STACKLTR_ENABLED', 'HUB_EMAIL_ENABLED', 'HUB_R2_ENABLED']) {
      if (flag(env[name])) problems.push(`${name} must remain disabled in staging`);
    }
  }
  if (problems.length) throw new ConfigError(problems.join('; '));

  return Object.freeze({
    environment,
    isDev,
    baseUrl,
    origin,
    databaseUrl: env.DATABASE_URL || null,
    oidc: Object.freeze({
      issuer,
      clientId,
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
    logLevel: env.HUB_LOG_LEVEL || 'info',
    // Set only to a header the platform itself sets, such as x-vercel-forwarded-for.
    trustedIpHeader: env.HUB_TRUSTED_IP_HEADER || null,
    rateLimitsEnabled: env.HUB_RATE_LIMITS_ENABLED !== 'false',
    email: Object.freeze({
      enabled: flag(env.HUB_EMAIL_ENABLED),
      apiKey: env.HUB_RESEND_API_KEY || null,
      from: env.HUB_EMAIL_FROM || null
    }),
    r2: Object.freeze({
      enabled: flag(env.HUB_R2_ENABLED),
      accountId: env.HUB_R2_ACCOUNT_ID || null,
      bucket: env.HUB_R2_BUCKET || null,
      accessKeyId: env.HUB_R2_ACCESS_KEY_ID || null,
      secretAccessKey: env.HUB_R2_SECRET_ACCESS_KEY || null
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
