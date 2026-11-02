// Additional real PostgreSQL security regressions. Run only after pg-integration.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import { createDb, pgDriver } from '../src/db.js';
import { createVault } from '../src/vault.js';
import { createAuth, sha256 } from '../src/auth.js';
import * as connections from '../src/services/connections.js';
const ownerUrl = process.env.HUB_PG_OWNER_URL;
if (!ownerUrl || !['localhost','127.0.0.1'].includes(new URL(ownerUrl).hostname)) throw new Error('Local disposable PostgreSQL required');
const owner = new pg.Client({connectionString:ownerUrl});
await owner.connect();
const url = new URL(ownerUrl); url.username='hub_runtime'; url.password='disposable-ci-password';
const db = createDb(pgDriver(url.href,pg.Pool));
const observer = new pg.Client({connectionString:url.href});
await observer.connect();
try {
 const staff = (await owner.query('select id,email from hub.staff_users')).rows;
 const ownerId=staff.find(s=>s.email==='owner@hub.test').id;
 const techId=staff.find(s=>s.email==='a@hub.test').id;
 await assert.rejects(db.as('hub_app',techId,async tx=>{await tx.query('set local row_security=off');await tx.query('select * from hub.managed_websites')}),/row-level security/);
 const site=(await owner.query("select id from hub.managed_websites where display_name='alpha'")).rows[0].id;
 let started, release;
 const began=new Promise(resolve=>{started=resolve});
 const gate=new Promise(resolve=>{release=resolve});
 let dispatches=0;
 const http={async request(){dispatches++;started();await gate;return {status:200,headers:{},body:'{}'}}};
 const vault=createVault({storageEnabled:true,keks:`local:${randomBytes(32).toString('base64')}`,activeKey:'local'});
 const ctx={db,staff:{id:ownerId,role:'owner'},vault,http,operationsEnabled:true,requestId:'synthetic-pg-security'};
 const connection=await connections.createConnection(ctx,site,{adapter_key:'wordpress',auth_type:'application_password',base_url:'https://synthetic.example.test'});
 await connections.storeCredential(ctx,connection.id,{username:'synthetic',application_password:'not-real'});
 const operation=await connections.requestOperation({...ctx,staff:{id:techId,role:'technician'}},{connection_id:connection.id,operation_key:'plugin.set_status',reason:'Synthetic concurrency check',plugin:'a/a',status:'inactive'});
 await connections.decideOperation(ctx,operation.id,'approved');
 const winning=connections.executeOperation(ctx,operation.id);
 try {
  await began;
  const duplicates=await Promise.allSettled(Array.from({length:8},()=>connections.executeOperation(ctx,operation.id)));
  assert.ok(duplicates.every(r=>r.status==='rejected'&&r.reason.status===409));
  assert.equal(dispatches,1);
 } finally {release()}
 await winning;
 await assert.rejects(connections.executeOperation(ctx,operation.id),/approved/);
 assert.equal(dispatches,1);
 await assert.rejects(db.as('hub_app',ownerId,tx=>tx.query('delete from hub.operation_execution_claims')),/permission denied/);
 await owner.query(`insert into hub.staff_sessions(token_hash,staff_id,csrf_token,idle_expires_at,absolute_expires_at)
 values($1,$2,'synthetic',now()+interval '30 minutes',now()+interval '8 hours')`,[sha256('synthetic-local-session'),techId]);
 await db.as('hub_app',ownerId,tx=>tx.query("update hub.staff_users set status='disabled' where id=$1",[techId]));
 await db.as('hub_app',ownerId,tx=>tx.query("update hub.staff_users set status='active' where id=$1",[techId]));
 const auth=createAuth({db,config:{oidc:{},session:{idleMinutes:30}}});
 assert.equal(await auth.resolveSession('synthetic-local-session'),null);
 const ownerRuntime=createDb(pgDriver(ownerUrl,pg.Pool));
 try {await assert.rejects(ownerRuntime.as('hub_app',ownerId,tx=>tx.query('select 1')),/Unsafe Hub runtime database role/)} finally {await ownerRuntime.close()}
 const roles=(await owner.query("select rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb from pg_roles where rolname in ('hub_runtime','hub_auth','hub_app','hub_worker')")).rows;
 assert.equal(roles.length,4);
 assert.ok(roles.every(r=>!r.rolsuper&&!r.rolbypassrls&&!r.rolcreaterole&&!r.rolcreatedb));
 // A disable transaction in progress must block login's staff-row lock. Without
 // FOR UPDATE, login can read the old active row and insert after revocation.
 const keys=await generateKeyPair('RS256');
 const jwk={...await exportJWK(keys.publicKey),kid:'race',alg:'RS256',use:'sig'};
 const issuer='https://synthetic-id.example.test';
 let nonce;
 const raceAuth=createAuth({db,config:{oidc:{issuer,clientId:'local-race',redirectUri:'https://hub.example.test/auth/callback'},session:{idleMinutes:30,absoluteMinutes:480}},
  fetchImpl:async endpoint=> {
   let body;
   if(endpoint.endsWith('/.well-known/openid-configuration')) body={issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks'};
   else if(endpoint.endsWith('/jwks')) body={keys:[jwk]};
   else body={id_token:await new SignJWT({email:'a@hub.test',email_verified:true,nonce}).setProtectedHeader({alg:'RS256',kid:'race'}).setSubject('race-tech').setAudience('local-race').setIssuer(issuer).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey)};
   return new Response(JSON.stringify(body),{status:200});
  }});
 const login=await raceAuth.beginLogin();
 const start=new URL(login.redirectUrl);nonce=start.searchParams.get('nonce');
 await owner.query('begin');
 await owner.query("update hub.staff_users set status='disabled' where id=$1",[techId]);
 let result;
 const pending=raceAuth.completeLogin({code:'synthetic-code',state:start.searchParams.get('state'),binding:login.binding,requestId:'race'}).then(value=>{result={value}},error=>{result={error}});
 try {
  let blocked=false;
  for(let i=0;i<1000;i++) {
   blocked=(await observer.query("select exists(select 1 from pg_stat_activity where usename='hub_runtime' and wait_event_type='Lock') as blocked")).rows[0].blocked;
   if(blocked||result) break;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(blocked,true,'Login must wait on disabled staff row');
 } finally {await owner.query('commit');await pending}
 assert.equal(result.error?.reason,'staff_disabled');
 await owner.query("update hub.staff_users set status='active' where id=$1",[techId]);
 assert.equal((await owner.query('select count(*)::int as n from hub.staff_sessions where staff_id=$1 and revoked_at is null',[techId])).rows[0].n,0);
 console.log('PostgreSQL concurrent dispatch, permanent revocation, login/disable race and runtime role checks passed.');
} finally {await db.close();await observer.end();await owner.end()}
