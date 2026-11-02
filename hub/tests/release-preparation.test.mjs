import test from 'node:test';
import assert from 'node:assert/strict';
import {validateStagingEnvironment,validateOidcMetadata} from '../staging/validate.js';
const env={HUB_ENV:'staging',HUB_BASE_URL:'https://hub-preview.crumbyte.com',VERCEL_ENV:'preview',
 DATABASE_URL:'postgres://hub_runtime:synthetic-only@db.example.test/hub_staging?sslmode=verify-full',HUB_STAGING_DATABASE_HOST:'db.example.test',HUB_STAGING_DATABASE_NAME:'hub_staging',
 HUB_OIDC_ISSUER:'https://staging-id.example.test/',HUB_STAGING_OIDC_ISSUER:'https://staging-id.example.test/',HUB_OIDC_CLIENT_ID:'synthetic-client',HUB_STAGING_OIDC_CLIENT_ID:'synthetic-client',
 HUB_OIDC_CLIENT_SECRET:'synthetic-client-secret',HUB_OIDC_REQUIRED_AMR:'mfa',HUB_TRUSTED_IP_HEADER:'x-vercel-forwarded-for'};
const issuer=env.HUB_OIDC_ISSUER;
const metadata={issuer,authorization_endpoint:issuer+'authorize',token_endpoint:issuer+'oauth/token',jwks_uri:issuer+'.well-known/jwks.json',response_types_supported:['code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['client_secret_post'],id_token_signing_alg_values_supported:['RS256']};

test('staging release preflight validates consistency without claiming hosted readiness or exposing credentials',()=>{
 const result=validateStagingEnvironment(env);assert.equal(result.hosted_verified,false);assert.equal(result.status,'configuration-consistent');
 assert.doesNotMatch(JSON.stringify(result),/synthetic-client-secret|synthetic-only/);
});

test('staging preflight refuses unverified TLS, duplicate options and database identity overrides',()=>{
 for(const query of ['', '?sslmode=require','?sslmode=disable','?sslmode=verify-full&sslmode=disable','?sslmode=verify-full&host=production.example.test','?sslmode=verify-full&user=owner','?sslmode=verify-full&ssl=false']) {
  assert.throws(()=>validateStagingEnvironment({...env,DATABASE_URL:'postgres://hub_runtime:synthetic-only@db.example.test/hub_staging'+query}));
 }
 assert.throws(()=>validateStagingEnvironment({...env,NODE_TLS_REJECT_UNAUTHORIZED:'0'}));
});

test('staging preflight refuses missing confidential credentials, jobs, production scope and owner bindings',()=>{
 for(const change of [{HUB_OIDC_CLIENT_SECRET:''},{HUB_JOB_SECRET:'synthetic-job-secret-longer-than-32-characters'},{VERCEL_ENV:'production'},{HUB_BASE_URL:'https://other.example.test'},{HUB_PG_OWNER_URL:'postgres://owner@db.example.test/hub_staging'}]) {
  assert.throws(()=>validateStagingEnvironment({...env,...change}));
 }
});

test('compatible OIDC discovery remains separate from MFA and client-configuration verification',()=>{
 const result=validateOidcMetadata(metadata,issuer);assert.equal(result.status,'metadata-compatible');assert.equal(result.mfa_verified,false);assert.equal(result.client_configuration_verified,false);
});

test('OIDC preparation rejects mismatched issuer, unsafe endpoints and unsupported protocol capabilities',()=>{
 for(const change of [{issuer:'https://production.example.test/'},{token_endpoint:'https://elsewhere.example.test/token'},{jwks_uri:'http://staging-id.example.test/jwks'},{authorization_endpoint:'https://user:pass@staging-id.example.test/authorize'},{response_types_supported:'code'},{code_challenge_methods_supported:['plain']},{token_endpoint_auth_methods_supported:['client_secret_basic']},{id_token_signing_alg_values_supported:['none']}]) {
  assert.throws(()=>validateOidcMetadata({...metadata,...change},issuer));
 }
});

test('deployment request validation refuses production, moving commits and unrelated projects',async()=>{
 const {validateDeploymentRequest}=await import('../staging/validate.js');
 const sha='a'.repeat(40),projectId='prj_syntheticOnly';
 const request={name:'crumbyte-hub-staging',project:projectId,gitSource:{type:'github',repoId:1432611751,ref:'codex/hub-release-candidate',sha},withLatestCommit:false};
 assert.equal(validateDeploymentRequest(request,{projectId,sha}).hosted_verified,false);
 for(const change of [{target:'production'},{target:'staging'},{withLatestCommit:true},{project:'prj_unrelated'},{gitSource:{...request.gitSource,sha:'b'.repeat(40)}},{gitSource:{...request.gitSource,repoId:1}},{gitSource:{...request.gitSource,ref:'main'}}]) assert.throws(()=>validateDeploymentRequest({...request,...change},{projectId,sha}));
});
