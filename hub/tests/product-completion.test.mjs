import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness,fakeHttp } from './helpers.mjs';
import * as portal from '../src/services/portal.js';
import { enqueueDueMaintenance } from '../src/services/automation.js';
import { runDueMonitoring } from '../src/services/jobs.js';
import { createVault } from '../src/vault.js';
import { localSnapshotStore,sealSnapshot,openSnapshot } from '../src/local-recovery.js';
import { createPlatformClient } from '../src/adapters/framework.js';

async function fixture(){
 const h=await createHarness({env:{HUB_OIDC_REQUIRED_AMR:'mfa'}});h.idp.overrideClaims={amr:['pwd','mfa']};
 const owner=await h.addStaff('owner@product.test','owner');const alpha=await h.addClient('Alpha',owner),bravo=await h.addClient('Bravo',owner);
 const a=await h.addWebsite(alpha,'alpha-product',owner),b=await h.addWebsite(bravo,'bravo-product',owner);
 const staff=await h.sessionFor('owner@product.test'),ctx={db:h.db,staff:staff.staff};
 await portal.inviteCustomer(ctx,alpha,{email:'alpha@product.test',display_name:'Alpha Customer'});
 await portal.inviteCustomer(ctx,bravo,{email:'bravo@product.test',display_name:'Bravo Customer'});
 return {h,owner,alpha,bravo,a,b,ctx,customer:await h.sessionFor('alpha@product.test')};
}

test('customer portal enforces MFA and isolates Alpha from Bravo, staff routes and operation execution',async()=>{
 const {h,alpha,bravo,a,b,ctx,customer}=await fixture();try{
  assert.equal(customer.staff.is_customer,true);
  assert.equal((await customer.get('/portal')).status,200);
  for(const p of ['/api/v1/websites','/api/v1/clients','/api/v1/security/findings','/staff','/audit','/integrations'])assert.equal((await customer.get(p)).status,403,p);
  assert.equal((await customer.get('/portal?client='+bravo)).status,404);
  assert.equal((await customer.get('/portal/reports/'+bravo)).status,404);
  assert.equal((await customer.post('/operations/anything/execute')).status,403);
  assert.equal((await customer.post('/portal/requests',{client_account_id:alpha,website_id:b,subject:'Invalid website',body:'Must not cross clients'})).status,404);
  assert.equal((await customer.post('/portal/requests',{client_account_id:bravo,subject:'Wrong organization',body:'Must not cross clients'})).status,404);
  assert.equal((await customer.post('/portal/requests',{client_account_id:alpha,website_id:a,subject:'Alpha help',body:'Synthetic customer request'})).status,303);
  assert.equal((await portal.requests(ctx,bravo)).length,0);
  const r=await portal.requests(ctx,alpha);assert.equal(r.length,1);
  await portal.updateRequest(ctx,r[0].id,{status:'resolved',resolution:'The service team completed the synthetic request.'});
  assert.match(await (await customer.get('/portal')).text(),/service team completed/);
  h.idp.overrideClaims={amr:['pwd']};assert.equal((await h.login('alpha@product.test')).res.status,403);
 }finally{await h.close();}
});

test('customer contacts are tenant-scoped records and never grant access or disclose internal notes in exports',async()=>{
 const {h,alpha,bravo,a,b,ctx,customer}=await fixture();try{
  const bc=await portal.saveContact(ctx,{client_account_id:bravo,display_name:'Bravo Secret',email:'bravo-secret@product.test'});
  const ac=await portal.saveContact({db:h.db,staff:customer.staff},{client_account_id:alpha,display_name:'Alpha Contact',email:'alpha-contact@product.test'});
  assert.ok(ac.id);
  assert.equal((await h.pg.query('select id from hub.staff_users where email=$1',['alpha-contact@product.test'])).rows.length,0);
  assert.equal((await customer.post('/portal/contacts/'+bc.id,{client_account_id:alpha,display_name:'Wrong contact',email:'wrong@product.test'})).status,404);
  await h.pg.query('update hub.managed_websites set notes=$2 where id=$1',[a,'INTERNAL-SECRET-NOTE']);
  await h.pg.query("insert into hub.service_history(client_account_id,website_id,kind,summary,source,performed_by) values($1,$2,'other','PRIVATE-HISTORY','staff',$3)",[alpha,a,ctx.staff.id]);
  const text=await (await customer.get('/portal/reports/'+alpha)).text();
  assert.doesNotMatch(text,/INTERNAL-SECRET-NOTE|PRIVATE-HISTORY|bravo-product|bravo-secret|storage_ref|artifact_ref/);
  const rows=await h.db.as('hub_app',customer.staff.id,tx=>tx.query('select * from hub.client_contacts'));
  assert.deepEqual(rows.rows.map(x=>x.id),[ac.id]);
  await h.pg.query("update hub.staff_users set status='disabled' where id=$1",[customer.staff.id]);
  assert.equal((await customer.get('/portal')).status,302);
 }finally{await h.close();}
});

test('customer onboarding does not convert internal staff or grant operator privileges',async()=>{
 const {h,alpha,ctx,customer}=await fixture();try{
  await assert.rejects(portal.inviteCustomer(ctx,alpha,{email:'owner@product.test',display_name:'Cannot convert'}),/cannot be converted/);
  await assert.rejects(h.pg.query("update hub.staff_users set role='admin' where id=$1",[customer.staff.id]),/customer_role/);
  assert.equal((await customer.post('/requests/onboard',{client_account_id:alpha,display_name:'Evil admin',email:'evil@product.test'})).status,403);
 }finally{await h.close();}
});

test('scheduled maintenance queue persists one occurrence per tenant and never dispatches CMS work',async()=>{
 const {h,alpha,a,owner}=await fixture();try{
  await h.pg.query("insert into hub.maintenance_schedules(client_account_id,website_id,title,kind,interval_days,next_due_on,created_by) values($1,$2,'Alpha updates','software_update',30,current_date,$3)",[alpha,a,owner]);
  const first=await enqueueDueMaintenance({db:h.db});assert.equal(first.created,1);
  assert.equal((await enqueueDueMaintenance({db:h.db})).created,0);
  const t=(await h.pg.query('select * from hub.maintenance_tasks')).rows[0];assert.equal(t.client_account_id,alpha);assert.equal(t.requires_approval,true);assert.equal(t.approved_at,null);
  await h.pg.query("update hub.maintenance_tasks set status='cancelled' where id=$1",[t.id]);
  assert.equal((await enqueueDueMaintenance({db:h.db})).created,0,'cancelled occurrence stays cancelled, even after a restart');
 }finally{await h.close();}
});

test('DNS monitoring records actual public answers, changes and recovery without following URLs',async()=>{
 const {h,alpha,a,owner}=await fixture();try{
  await h.pg.query("insert into hub.monitoring_checks(client_account_id,website_id,kind,target_url,interval_minutes,failure_threshold,created_by) values($1,$2,'dns','https://alpha-product.example.test',5,1,$3)",[alpha,a,owner]);
  let answers=['1.1.1.1'];const http={dnsAddresses:async()=>answers};
  assert.equal((await runDueMonitoring({db:h.db,http,outboundEnabled:true})).ran,1);
  await h.pg.query('update hub.monitoring_checks set next_run_at=now()');answers=['8.8.8.8'];
  await runDueMonitoring({db:h.db,http,outboundEnabled:true});
  const rows=(await h.pg.query('select dns_addresses,dns_changed from hub.monitoring_results order by checked_at')).rows;assert.equal(rows.length,2);assert.equal(rows[1].dns_changed,true);
  assert.equal((await h.pg.query("select count(*)::int n from hub.notifications where kind='dns.changed'")).rows[0].n,1);
  assert.equal((await runDueMonitoring({db:h.db,http,outboundEnabled:false})).skipped,'outbound_disabled');
 }finally{await h.close();}
});

test('local backup encryption authenticates archive and metadata, retention keeps the latest copy',async()=>{
 const key=randomBytes(32).toString('base64'),directory=await mkdtemp(path.join(os.tmpdir(),'hub-snapshots-'));
 try{
  const store=await localSnapshotStore(directory,key),bytes=Buffer.from('Synthetic Alpha and Bravo archive');
  const old=await store.save(bytes,{createdAt:'2025-01-01T00:00:00Z'}),latest=await store.save(bytes,{createdAt:'2025-02-01T00:00:00Z'});
  assert.deepEqual(await store.restore(old.id),bytes);
  const disk=await readFile(path.join(directory,`hub-snapshot-${old.id}.json`),'utf8');assert.doesNotMatch(disk,/Synthetic Alpha/);
  const s=JSON.parse(disk);assert.throws(()=>openSnapshot({...s,createdAt:'2025-03-01T00:00:00Z'},key));assert.throws(()=>openSnapshot(s,randomBytes(32).toString('base64')));
  assert.deepEqual(await store.prune({now:new Date('2026-01-01'),retentionDays:7}),{removed:1,retained:1});
  assert.deepEqual(await store.restore(latest.id),bytes);await assert.rejects(store.restore('../escape'));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('credential KEK rotation rewraps the same authenticated data key without exposing credential plaintext',()=>{
 const old=randomBytes(32).toString('base64'),fresh=randomBytes(32).toString('base64');
 const v1=createVault({storageEnabled:true,keks:'old:'+old,activeKey:'old'}),v2=createVault({storageEnabled:true,keks:`old:${old},new:${fresh}`,activeKey:'new'});
 const row={id:'cred',connection_id:'connection',...v1.encrypt('connection','cred',{password:'synthetic-only'})};
 const wrapped=v2.rewrap(row);assert.equal(wrapped.key_id,'new');assert.doesNotMatch(JSON.stringify(wrapped),/synthetic-only/);
 const v3=createVault({storageEnabled:true,keks:'new:'+fresh,activeKey:'new'});assert.deepEqual(v3.decrypt({...row,...wrapped}).reveal(),{password:'synthetic-only'});
 assert.throws(()=>v2.rewrap({...row,connection_id:'another'}));
});

test('adapter rate limits honor HTTP-date and bounded numeric Retry-After without automatic mutation retries',async()=>{
 for(const retry of ['999999',new Date(Date.now()+60000).toUTCString()]){
  const client=createPlatformClient({baseUrl:'https://platform.example.test',http:fakeHttp({'*':{status:429,headers:{'retry-after':retry}}})});
  await assert.rejects(client.get('/test'),e=>e.code==='rate_limited'&&e.retryAfterSeconds>=1&&e.retryAfterSeconds<=3600);
 }
});

test('OIDC discovery cannot move confidential credentials to a different origin',async()=>{
 const {createAuth}=await import('../src/auth.js');let touched=false;
 const auth=createAuth({db:{as(){touched=true;throw new Error('must not persist login state');}},config:{isDev:false,oidc:{issuer:'https://issuer.example.test'},session:{}},fetchImpl:async(_url,options)=>{
  assert.equal(options.redirect,'error');return new Response(JSON.stringify({issuer:'https://issuer.example.test',authorization_endpoint:'https://issuer.example.test/authorize',token_endpoint:'https://evil.example.test/token',jwks_uri:'https://issuer.example.test/keys'}));
 }});
 await assert.rejects(auth.beginLogin(),e=>e.reason==='invalid_discovery');assert.equal(touched,false);
});
test('local recovery rejects URL query overrides that could redirect a loopback URI to a hosted database',async()=>{
 const {assertLocalDatabaseUrl}=await import('../src/local-recovery.js');
 assert.equal(assertLocalDatabaseUrl('postgres://owner@localhost/hub').hostname,'localhost');
 for(const url of ['postgres://owner@remote.example.test/hub','postgres://owner@localhost/hub?host=remote.example.test','postgres://owner@localhost/hub?user=admin','https://localhost/hub'])assert.throws(()=>assertLocalDatabaseUrl(url));
});
test('configured backup provider registry reaches the scheduler instead of being silently discarded',async()=>{
 const {h,alpha,a,owner}=await fixture();try{
  await h.pg.query("insert into hub.backup_sources(client_account_id,website_id,provider,label,storage_provider,created_by) values($1,$2,'Synthetic R2','Alpha backup','r2',$3)",[alpha,a,owner]);
  let called=0;const {runJobs}=await import('../src/services/jobs.js');
  const result=await runJobs({db:h.db,http:{},outboundEnabled:false,backupProviders:{r2:{listRuns:async()=>{called++;return [{externalId:'synthetic-backup',status:'succeeded',finishedAt:new Date(),sizeBytes:50}];}}}});
  assert.equal(called,1);assert.equal(result.backups.synced,1);
 }finally{await h.close();}
});

test('hosted startup itself rejects weak MFA, TLS downgrade and query-string database host overrides',async()=>{
 const {loadConfig}=await import('../src/config.js');
 const base={HUB_ENV:'production',HUB_BASE_URL:'https://hub.example.test',HUB_OIDC_ISSUER:'https://id.example.test',HUB_OIDC_CLIENT_ID:'synthetic',HUB_OIDC_CLIENT_SECRET:'synthetic',HUB_OIDC_REQUIRED_AMR:'mfa',HUB_TRUSTED_IP_HEADER:'x-vercel-forwarded-for',DATABASE_URL:'postgres://hub_runtime:synthetic@db.example.test/hub?sslmode=verify-full'};
 assert.equal(loadConfig(base).environment,'production');
 for(const change of [{HUB_OIDC_REQUIRED_AMR:'pwd'},{HUB_OIDC_CLIENT_SECRET:''},{DATABASE_URL:base.DATABASE_URL+'&host=production.example.test'},{DATABASE_URL:base.DATABASE_URL.replace('verify-full','require')},{NODE_TLS_REJECT_UNAUTHORIZED:'0'}])assert.throws(()=>loadConfig({...base,...change}));
});

test('history sharing is explicit, idempotent and revocable without editing immutable evidence',async()=>{
 const {h,alpha,a,ctx,customer}=await fixture();try{
  const id=(await h.pg.query("insert into hub.service_history(client_account_id,website_id,kind,summary,source,performed_by) values($1,$2,'other','Explicit shared activity','staff',$3) returning id",[alpha,a,ctx.staff.id])).rows[0].id;
  const {shareHistory}=await import('../src/services/automation.js');
  assert.equal((await portal.customerSummary({db:h.db,staff:customer.staff},alpha)).activity.length,0);
  await shareHistory(ctx,id);await shareHistory(ctx,id);assert.equal((await portal.customerSummary({db:h.db,staff:customer.staff},alpha)).activity.length,1);
  await shareHistory(ctx,id,false);assert.equal((await portal.customerSummary({db:h.db,staff:customer.staff},alpha)).activity.length,0);
  assert.equal((await h.pg.query('select summary from hub.service_history where id=$1',[id])).rows[0].summary,'Explicit shared activity');
 }finally{await h.close();}
});
