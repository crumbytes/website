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

const newRef='abcdefghijklmnopqrst'; // Synthetic configuration fixture, not a resource.
const pooler='aws-0-test.pooler.supabase.com';
const supabase={...env,HUB_STAGING_SUPABASE_PROJECT_REF:newRef,HUB_STAGING_DATABASE_HOST:pooler,HUB_STAGING_DATABASE_NAME:'postgres',DATABASE_URL:`postgres://hub_runtime.${newRef}:synthetic-only@${pooler}:6543/postgres?sslmode=verify-full`};

test('Supabase shared-pooler login requires independent project pin while SQL role remains hub_runtime',()=>{
 assert.equal(validateStagingEnvironment(supabase).hosted_verified,false);
 for(const change of [{HUB_STAGING_SUPABASE_PROJECT_REF:''},{HUB_STAGING_SUPABASE_PROJECT_REF:'z'.repeat(20)},{DATABASE_URL:`postgres://postgres.${newRef}:synthetic-only@${pooler}:6543/postgres?sslmode=verify-full`},{DATABASE_URL:`postgres://hub_runtime.${newRef}:synthetic-only@${pooler}/postgres?sslmode=verify-full`}])assert.throws(()=>validateStagingEnvironment({...supabase,...change}));
});

test('Supabase direct connection supports only the independently pinned new Hub project',()=>{
 const host=`db.${newRef}.supabase.co`;
 assert.equal(validateStagingEnvironment({...supabase,HUB_STAGING_DATABASE_HOST:host,DATABASE_URL:`postgres://hub_runtime:synthetic-only@${host}:5432/postgres?sslmode=verify-full`}).hosted_verified,false);
 assert.throws(()=>validateStagingEnvironment({...supabase,HUB_STAGING_DATABASE_HOST:'db.'+'z'.repeat(20)+'.supabase.co',DATABASE_URL:'postgres://hub_runtime:synthetic-only@db.'+'z'.repeat(20)+'.supabase.co:5432/postgres?sslmode=verify-full'}));
});

test('both supplied StackLTR project references are refused for direct and pooler Hub connections',()=>{
 for(const ref of ['oyvnmolqtzzfljvztfbe','tpkptbpzasrcozjorcko']){
  assert.throws(()=>validateStagingEnvironment({...supabase,HUB_STAGING_SUPABASE_PROJECT_REF:ref,DATABASE_URL:`postgres://hub_runtime.${ref}:synthetic-only@${pooler}:6543/postgres?sslmode=verify-full`}));
  const host=`db.${ref}.supabase.co`;
  assert.throws(()=>validateStagingEnvironment({...supabase,HUB_STAGING_SUPABASE_PROJECT_REF:ref,HUB_STAGING_DATABASE_HOST:host,DATABASE_URL:`postgres://hub_runtime:synthetic-only@${host}:5432/postgres?sslmode=verify-full`}));
 }
});

test('a Supabase project pin cannot be redirected to an unrelated provider or database',()=>{
 for(const change of [{HUB_STAGING_DATABASE_HOST:'db.example.test',DATABASE_URL:'postgres://hub_runtime:synthetic-only@db.example.test/postgres?sslmode=verify-full'},{HUB_STAGING_DATABASE_NAME:'other',DATABASE_URL:`postgres://hub_runtime.${newRef}:synthetic-only@${pooler}:6543/other?sslmode=verify-full`}])assert.throws(()=>validateStagingEnvironment({...supabase,...change}));
});

// Reserved test hostname only; no managed Neon endpoint is contacted.
const neonHost='ep-synthetic-pooler.neon.example.test';
const neon={...env,HUB_STAGING_DATABASE_HOST:neonHost,HUB_STAGING_DATABASE_NAME:'hub_staging',
 DATABASE_URL:`postgres://hub_runtime:synthetic-only@${neonHost}:5432/hub_staging?sslmode=verify-full`};

test('Neon-style pooled and direct runtime profiles use the dedicated SQL role without a Supabase pin',()=>{
 for(const host of [neonHost,neonHost.replace('-pooler','')]){
  const result=validateStagingEnvironment({...neon,HUB_STAGING_DATABASE_HOST:host,
   DATABASE_URL:`postgres://hub_runtime:synthetic-only@${host}:5432/hub_staging?sslmode=verify-full`});
  assert.equal(result.status,'configuration-consistent');assert.equal(result.hosted_verified,false);
 }
});

test('Neon runtime profile rejects owner credentials, endpoint/database drift and inherited Supabase pins',()=>{
 for(const change of [
  {DATABASE_URL:neon.DATABASE_URL.replace('hub_runtime:','neondb_owner:')},
  {HUB_STAGING_DATABASE_HOST:'ep-other.neon.example.test'},
  {HUB_STAGING_DATABASE_NAME:'neondb'},
  {HUB_STAGING_SUPABASE_PROJECT_REF:newRef},
  {DATABASE_URL:neon.DATABASE_URL.replace('verify-full','require')},
  {HUB_PG_OWNER_URL:'postgres://operator@owner.example.test/hub_staging'}
 ])assert.throws(()=>validateStagingEnvironment({...neon,...change}));
});
