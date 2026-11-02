import { assertLocalDatabaseUrl } from '../src/local-recovery.js';
// Real pg_dump/pg_restore rehearsal. Refuses hosted endpoints and non-empty restore targets.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { runDueMonitoring } from '../src/services/jobs.js';
import { createDb,pgDriver } from '../src/db.js';
const exec=promisify(execFile),sourceUrl=process.env.HUB_PG_OWNER_URL;
assertLocalDatabaseUrl(sourceUrl);
if(!sourceUrl||!['localhost','127.0.0.1'].includes(new URL(sourceUrl).hostname))throw new Error('Disposable local PostgreSQL required');
const source=new pg.Client({connectionString:sourceUrl});await source.connect();
const targetUrl=new URL(sourceUrl);targetUrl.pathname='/hub_restore';
const target=new pg.Client({connectionString:targetUrl.href});await target.connect();
const dir=await mkdtemp(path.join(os.tmpdir(),'hub-pg-recovery-'));
try{
 const ownerId=(await source.query("select id from hub.staff_users where role='owner' and status='active' limit 1")).rows[0].id;
 const customer=(await source.query("insert into hub.staff_users(email,display_name,role,is_customer) values('recovery-alpha@synthetic.test','Alpha Customer','viewer',true) returning id")).rows[0].id;
 const alpha=(await source.query("insert into hub.client_accounts(display_name,created_by) values('Recovery Alpha',$1) returning id",[ownerId])).rows[0].id;
 const bravo=(await source.query("insert into hub.client_accounts(display_name,created_by) values('Recovery Bravo',$1) returning id",[ownerId])).rows[0].id;
 await source.query('insert into hub.staff_client_assignments(staff_id,client_account_id,assigned_by) values($1,$2,$3)',[customer,alpha,ownerId]);
 for(const [id,name] of [[alpha,'alpha'],[bravo,'bravo']])await source.query("insert into hub.managed_websites(client_account_id,display_name,primary_url,cms_platform,created_by) values($1,$2,$3,'other',$4)",[id,'Recovery '+name,`https://recovery-${name}.example.test`,ownerId]);
 // Two independent pool transactions must not probe the same due check.
 await source.query('update hub.monitoring_checks set enabled=false');
 const website=(await source.query('select id from hub.managed_websites where client_account_id=$1',[alpha])).rows[0].id;
 const check=(await source.query("insert into hub.monitoring_checks(client_account_id,website_id,kind,target_url,interval_minutes,created_by) values($1,$2,'uptime','https://alpha.example.test',5,$3) returning id",[alpha,website,ownerId])).rows[0].id;
 const sourceRuntime=new URL(sourceUrl);sourceRuntime.username='hub_runtime';sourceRuntime.password='disposable-ci-password';
 const workerDb=createDb(pgDriver(sourceRuntime.href,pg.Pool));
 let release,started;const entered=new Promise(r=>started=r),hold=new Promise(r=>release=r);let probes=0;
 const http={request:async()=>{probes++;started();await hold;return {status:200,elapsedMs:2};}};
 try {
  const first=runDueMonitoring({db:workerDb,http,outboundEnabled:true,limit:1});await entered;
  const second=await runDueMonitoring({db:workerDb,http,outboundEnabled:true,limit:1});assert.equal(second.ran,0);
  release();assert.equal((await first).ran,1);assert.equal(probes,1);
  assert.equal((await source.query('select count(*)::int n from hub.monitoring_results where check_id=$1',[check])).rows[0].n,1);
 }finally{release?.();await workerDb.close();}
 const env={...process.env,HUB_LOCAL_DATABASE_URL:sourceUrl,HUB_LOCAL_RECOVERY_CONFIRM:new URL(sourceUrl).pathname.slice(1),HUB_LOCAL_SNAPSHOT_DIR:dir,HUB_LOCAL_BACKUP_KEY:randomBytes(32).toString('base64')};
 const result=await exec(process.execPath,['scripts/local-backup.mjs','backup'],{env});const snapshot=JSON.parse(result.stdout);
 const restored=await exec(process.execPath,['scripts/local-backup.mjs','restore',snapshot.id],{env:{...env,HUB_LOCAL_DATABASE_URL:targetUrl.href,HUB_LOCAL_RECOVERY_CONFIRM:'hub_restore'}});assert.equal(JSON.parse(restored.stdout).restored,true);
 for(const table of ['managed_websites','staff_users','client_accounts','support_requests','operation_execution_claims','staff_sessions','audit_log']){
  const sql=`select count(*)::int n from hub.${table}`;
  assert.equal((await source.query(sql)).rows[0].n,(await target.query(sql)).rows[0].n,table);
 }
 assert.equal((await target.query('select hub.verify_audit_chain() broken')).rows[0].broken,null);
 const runtimeUrl=new URL(targetUrl);runtimeUrl.username='hub_runtime';runtimeUrl.password='disposable-ci-password';
 const db=createDb(pgDriver(runtimeUrl.href,pg.Pool));
 try{
  const ids=await db.as('hub_app',customer,async tx=>(await tx.query('select client_account_id from hub.managed_websites')).rows.map(r=>r.client_account_id));
  assert.deepEqual(ids,[alpha]);assert.ok(!ids.includes(bravo));
  assert.equal((await db.as('hub_app',customer,tx=>tx.query('select id from hub.managed_websites where client_account_id=$1',[bravo]))).rows.length,0);
  await assert.rejects(db.as('hub_app',customer,tx=>tx.query("insert into hub.support_requests(client_account_id,requested_by,subject,body) values($1,$2,'Wrong tenant','Must fail')",[bravo,customer])),/row-level security/);
 }finally{await db.close();}
 await assert.rejects(exec(process.execPath,['scripts/local-backup.mjs','restore',snapshot.id],{env:{...env,HUB_LOCAL_DATABASE_URL:targetUrl.href,HUB_LOCAL_RECOVERY_CONFIRM:'hub_restore'}}),e=>e.code===1);
 console.log('PostgreSQL encrypted backup/restore, audit integrity, preserved counts/grants and Alpha/Bravo isolation passed.');
}finally{await source.end();await target.end();await rm(dir,{recursive:true,force:true});}
