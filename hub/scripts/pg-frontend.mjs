import { assertLocalDatabaseUrl } from '../src/local-recovery.js';
// Exercises new frontend projections through the actual non-owner runtime pool.
// Only a local disposable database already seeded by pg-integration is accepted.
import assert from 'node:assert/strict';
import pg from 'pg';
import {createDb,pgDriver} from '../src/db.js';
import * as records from '../src/services/records.js';
const ownerUrl=process.env.HUB_PG_OWNER_URL;
if(!ownerUrl||!['localhost','127.0.0.1'].includes(new URL(ownerUrl).hostname))throw new Error('Local disposable PostgreSQL required');
const owner=new pg.Client({connectionString:ownerUrl});await owner.connect();
const url=new URL(ownerUrl);url.username='hub_runtime';url.password='disposable-ci-password';
const db=createDb(pgDriver(url.href,pg.Pool));
try{
 const users=(await owner.query('select id,email from hub.staff_users')).rows;
 const ownerId=users.find(row=>row.email==='owner@hub.test').id,techId=users.find(row=>row.email==='a@hub.test').id;
 const site=(await owner.query("select id from hub.managed_websites where display_name='alpha'")).rows[0].id;
 const ctx={db,staff:{id:techId,role:'technician'},requestId:'synthetic-frontend-test'};
 const schedule=await records.createSchedule(ctx,{website_id:site,title:'PG UI schedule',kind:'inspection',interval_days:'30',next_due_on:'2026-11-20',default_assignee_id:techId});
 await records.updateSchedule(ctx,schedule.id,{title:'PG UI revised schedule',kind:'inspection',interval_days:'14',next_due_on:'2026-11-21',default_assignee_id:techId,active:'off'});
 assert.equal((await records.listSchedules(ctx)).length,0);
 assert.equal((await records.listSchedules(ctx,{includeInactive:true}))[0].active,false);
 await assert.rejects(records.createTaskFromSchedule(ctx,schedule.id),{status:404,code:'not_found'});
 const source=await records.createBackupSource(ctx,{website_id:site,provider:'Synthetic local',label:'PG UI source',storage_provider:'manual'});
 const run=await records.recordBackupRun(ctx,{source_id:source.id,status:'succeeded',finished_at:new Date().toISOString()});
 await records.recordRestoreVerification(ctx,{backup_run_id:run.id,target_environment:'isolated',outcome:'partial',checks_performed:'Synthetic schema and interface verification',evidence_ref:'SYNTHETIC-PG-UI',performed_at:new Date().toISOString()});
 const restores=await records.listRestoreVerifications(ctx);assert.equal(restores.length,1);assert.equal(restores[0].evidence_ref,'SYNTHETIC-PG-UI');
 const overview=await records.getOverview(ctx);assert.equal(overview.websites,1);assert.equal(overview.websites_with_backup_sources,1);
 assert.ok(overview.activity.every(row=>row.website_id===site));
 assert.equal((await records.getOverview({db,staff:{id:ownerId,role:'owner'}})).websites,2);
 console.log('PostgreSQL frontend overview, schedule management, restore history and client scoping passed.');
}finally{await db.close();await owner.end()}
