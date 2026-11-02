import { loadConfig } from '../src/config.js';

// Additional release gates for the proposed confidential web-client/DB setup.
// Pure validation: no connections, provider changes, secret output or migration.
export function validateStagingEnvironment(env) {
  const config = loadConfig(env);
  const problems = [];
  if (config.environment !== 'staging') problems.push('HUB_ENV must be staging');
  if (config.origin !== 'https://hub-preview.crumbyte.com') problems.push('HUB_BASE_URL must be the approved preview origin');
  if (env.VERCEL_ENV && env.VERCEL_ENV !== 'preview') problems.push('VERCEL_ENV must be preview when present');
  if (!env.HUB_OIDC_CLIENT_SECRET?.trim()) problems.push('A separate staging confidential OIDC client secret is required');
  if (env.HUB_OIDC_REQUIRED_AMR !== 'mfa') problems.push('The selected provider must emit and require mfa');
  if (config.jobSecret) problems.push('Scheduled jobs must remain disabled');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') problems.push('TLS certificate verification must remain enabled');
  const url = new URL(config.databaseUrl);
  if (!url.password) problems.push('Dedicated runtime database authentication is required');
  if (url.searchParams.getAll('sslmode').length !== 1 || url.searchParams.get('sslmode') !== 'verify-full') {
    problems.push('DATABASE_URL must request exactly one sslmode=verify-full');
  }
  // Query parameters can otherwise override the host/user approved in URL pins.
  const allowed = new Set(['sslmode', 'application_name', 'connect_timeout']);
  if ([...url.searchParams.keys()].some(key => !allowed.has(key))) problems.push('Unreviewed database connection URL parameters are not allowed');
  if (env.HUB_MIGRATION_DATABASE_URL || env.HUB_PG_OWNER_URL) problems.push('Do not inject migration-owner connections into the runtime environment');
  if (problems.length) throw new Error(problems.join('; '));
  return { status: 'configuration-consistent', environment: 'staging', hosted_verified: false,
    required_external_evidence: ['account protection and plan', 'isolated database identity/network/backups', 'real IdP MFA', 'exact DNS target/TLS', 'hosted acceptance'] };
}

export function validateOidcMetadata(metadata, issuer) {
  const problems = [];
  const expected = new URL(issuer);
  if (expected.protocol !== 'https:' || metadata.issuer !== issuer) problems.push('Discovery issuer must match the approved HTTPS issuer exactly');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    try {
      const url = new URL(metadata[key]);
      if (url.protocol !== 'https:' || url.origin !== expected.origin || url.username || url.password || url.hash) throw new Error();
    } catch { problems.push(`${key} must be an approved same-origin HTTPS endpoint`); }
  }
  if (!Array.isArray(metadata.response_types_supported) || !metadata.response_types_supported.includes('code')) problems.push('Authorization code flow is required');
  if (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes('S256')) problems.push('S256 PKCE support must be confirmed');
  if (!Array.isArray(metadata.token_endpoint_auth_methods_supported) || !metadata.token_endpoint_auth_methods_supported.includes('client_secret_post')) problems.push('Current client requires client_secret_post compatibility');
  if (!Array.isArray(metadata.id_token_signing_alg_values_supported) || !metadata.id_token_signing_alg_values_supported.some(alg => ['RS256', 'ES256', 'PS256'].includes(alg))) problems.push('An approved asymmetric ID token signing algorithm is required');
  if (problems.length) throw new Error(problems.join('; '));
  return { status: 'metadata-compatible', mfa_verified: false, client_configuration_verified: false };
}

// This validates a proposed API request only; it never sends or authorizes it.
export function validateDeploymentRequest(request, {projectId, sha}) {
  if (!/^prj_[A-Za-z0-9]+$/.test(projectId ?? '') || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Approved staging project ID and full candidate SHA are required');
  const keys = ['name','project','gitSource','withLatestCommit'];
  if (Object.keys(request).some(key=>!keys.includes(key)) || request.name!=='crumbyte-hub-staging' || request.project!==projectId || request.withLatestCommit!==false) throw new Error('Request must use the approved staging project, no target override and no latest-commit resolution');
  const source=request.gitSource;
  if (!source || Object.keys(source).some(key=>!['type','repoId','ref','sha'].includes(key)) || source.type!=='github' || source.repoId!==1432611751 || source.ref!=='codex/hub-release-candidate' || source.sha!==sha) throw new Error('Deployment source must pin the approved repository, release branch and exact SHA');
  return {status:'request-consistent',target:'preview-by-omission',approval_still_required:true,hosted_verified:false};
}
