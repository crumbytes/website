import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './helpers.mjs';
import {getOverview,listRestoreVerifications} from '../src/services/records.js';
let h, owner, tech, viewer, ownerId, techId, clientA,clientB,siteA,siteB;
before(async()=>{
 h=await createHarness();ownerId=await h.addStaff('ui-owner@hub.test','owner');techId=await h.addStaff('ui-tech@hub.test','technician');
 const viewerId=await h.addStaff('ui-viewer@hub.test','viewer');
 clientA=await h.addClient('UI Client A',ownerId);clientB=await h.addClient('UI Client B',ownerId);
 siteA=await h.addWebsite(clientA,'ui-alpha',ownerId);siteB=await h.addWebsite(clientB,'ui-bravo',ownerId);
 await h.assign(techId,clientA,ownerId);await h.assign(viewerId,clientA,ownerId);
 [owner,tech,viewer]=await Promise.all(['ui-owner','ui-tech','ui-viewer'].map(name=>h.sessionFor(name+'@hub.test')));
});
after(()=>h.close());
const context=session=>({db:h.db,staff:session.staff});

test('overview activity and unread notifications contain only current client scope',async()=>{
 for(const [site,summary] of [[siteA,'UI Alpha completed work'],[siteB,'UI Bravo private work']])
  assert.equal((await owner.post('/history',{website_id:site,kind:'maintenance',summary,performed_at:new Date().toISOString()})).status,303);
 for(const [client,title] of [[clientA,'UI Alpha reminder'],[clientB,'UI Bravo private reminder']])
  await h.pg.query(`insert into hub.notifications(staff_id,client_account_id,kind,title,dedupe_key)values($1,$2,'test',$3,$3)`,[techId,client,title]);
 const data=await getOverview(context(tech));assert.equal(data.websites,1);
 assert.deepEqual(data.activity.map(row=>row.website_id),[siteA]);
 assert.deepEqual(data.notifications.map(row=>row.title),['UI Alpha reminder']);
 const page=await (await tech.get('/')).text();assert.match(page,/UI Alpha completed work/);assert.match(page,/UI Alpha reminder/);
 assert.doesNotMatch(page,/UI Bravo/);
 const inbox=await (await tech.get('/api/v1/notifications')).json();assert.equal(inbox.notifications.length,1);
});

test('disabled checks do not inflate the enabled monitoring coverage total',async()=>{
 for(const [kind,enabled]of [['uptime',true],['ssl',false]]){
  const check=(await h.pg.query(`insert into hub.monitoring_checks(client_account_id,website_id,kind,target_url,interval_minutes,enabled,created_by)values($1,$2,$3,'https://ui-alpha.example.test',60,$4,$5)returning id`,[clientA,siteA,kind,enabled,ownerId])).rows[0].id;
  await h.pg.query(`insert into hub.monitoring_results(client_account_id,check_id,outcome)values($1,$2,'up')`,[clientA,check]);
 }
 const data=await getOverview(context(tech));assert.equal(data.active_checks,1);assert.equal(data.checks_with_results,1);
});

test('recurring schedules can be edited, reassigned, paused and resumed without changing clients',async()=>{
 assert.equal((await tech.post('/maintenance/schedules',{website_id:siteA,title:'UI recurring task',kind:'inspection',interval_days:'30',next_due_on:'2026-11-20'})).status,303);
 const id=(await h.pg.query(`select id from hub.maintenance_schedules where title='UI recurring task'`)).rows[0].id;
 const input={title:'UI updated schedule',kind:'inspection',interval_days:'14',next_due_on:'2026-11-21',default_assignee_id:techId,active:'off',website_id:siteB};
 assert.equal((await tech.post(`/maintenance/schedules/${id}/update`,input)).status,303);
 const row=(await h.pg.query('select active,interval_days,website_id,default_assignee_id from hub.maintenance_schedules where id=$1',[id])).rows[0];
 assert.deepEqual(row,{active:false,interval_days:14,website_id:siteA,default_assignee_id:techId});
 assert.equal((await tech.post(`/maintenance/schedules/${id}/task`)).status,404);
 assert.match(await(await tech.get('/maintenance')).text(),/UI updated schedule/);
 assert.equal((await viewer.post(`/maintenance/schedules/${id}/update`,input)).status,403);
 assert.equal((await tech.post(`/maintenance/schedules/${id}/update`,{...input,active:'on'})).status,303);
 assert.equal((await tech.post(`/maintenance/schedules/${id}/task`)).status,303);
 assert.ok((await h.auditActions()).some(row=>row.action==='schedule.update'));
});

test('schedule edits reject invalid intervals and foreign-client identifiers',async()=>{
 assert.equal((await owner.post('/maintenance/schedules',{website_id:siteB,title:'UI private schedule',kind:'inspection',interval_days:'30',next_due_on:'2026-11-20'})).status,303);
 const id=(await h.pg.query(`select id from hub.maintenance_schedules where title='UI private schedule'`)).rows[0].id;
 const input={title:'Invalid edit',kind:'inspection',interval_days:'20',next_due_on:'2026-11-20',active:'on'};
 assert.equal((await tech.post(`/maintenance/schedules/${id}/update`,input)).status,404);
 assert.equal((await owner.post(`/maintenance/schedules/${id}/update`,{...input,interval_days:'0'})).status,422);
});

test('restoration history includes failed and partial records with evidence but no foreign-client entries',async()=>{
 for(const [site,summary]of [[siteA,'UI local restore evidence'],[siteB,'UI foreign restore evidence']]){
  assert.equal((await owner.post('/backups/sources',{website_id:site,provider:'Synthetic local',label:summary,storage_provider:'manual'})).status,303);
  const source=(await h.pg.query('select id from hub.backup_sources where website_id=$1',[site])).rows[0].id;
  assert.equal((await owner.post('/backups/runs',{source_id:source,status:'succeeded',finished_at:new Date().toISOString()})).status,303);
  const run=(await h.pg.query('select id from hub.backup_runs where source_id=$1',[source])).rows[0].id;
  assert.equal((await owner.post('/backups/restores',{backup_run_id:run,target_environment:'isolated',outcome:'partial',checks_performed:summary,evidence_ref:'SYNTHETIC-UI-1',performed_at:new Date().toISOString()})).status,303);
 }
 const history=await listRestoreVerifications(context(tech));assert.equal(history.length,1);assert.equal(history[0].outcome,'partial');
 const page=await(await tech.get('/backups')).text();assert.match(page,/UI local restore evidence/);assert.match(page,/SYNTHETIC-UI-1/);assert.doesNotMatch(page,/UI foreign restore evidence/);
});

test('changing CMS shows the matching adapter connection and its last successful check',async()=>{
 assert.equal((await owner.post(`/websites/${siteA}/connections`,{adapter_key:'wordpress',auth_type:'application_password',base_url:'https://wp.example.test'})).status,303);
 const wp=(await h.pg.query(`select id from hub.platform_connections where website_id=$1 and adapter_key='wordpress'`,[siteA])).rows[0].id;
 await h.pg.query(`insert into hub.platform_snapshots(client_account_id,connection_id,outcome,captured_at)values($1,$2,'ok','2026-10-01T12:00:00Z'),($1,$2,'failed','2026-10-02T12:00:00Z')`,[clientA,wp]);
 assert.match(await(await owner.get(`/websites/${siteA}`)).text(),/2026-10-01 12:00 UTC/);
 await h.pg.query(`update hub.managed_websites set cms_platform='shopify' where id=$1`,[siteA]);
 assert.equal((await owner.post(`/websites/${siteA}/connections`,{adapter_key:'shopify',auth_type:'admin_access_token',base_url:'https://synthetic.myshopify.com'})).status,303);
 const page=await(await owner.get(`/websites/${siteA}`)).text();assert.match(page,/synthetic.myshopify.com/);assert.doesNotMatch(page,/https:\/\/wp.example.test/);assert.match(page,/No successful check recorded/);
});

test('read-only website navigation omits sections the staff member cannot use',async()=>{
 const page=await(await viewer.get(`/websites/${siteA}`)).text();assert.doesNotMatch(page,/href="#administration"/);assert.match(page,/href="#backups"/);
});

test('removing a client assignment removes dashboard history and client-bound notifications immediately',async()=>{
 await h.pg.query('delete from hub.staff_client_assignments where staff_id=$1 and client_account_id=$2',[techId,clientA]);
 const overview=await getOverview(context(tech));assert.equal(overview.websites,0);assert.deepEqual(overview.activity,[]);assert.deepEqual(overview.notifications,[]);
 const inbox=await(await tech.get('/api/v1/notifications')).json();assert.deepEqual(inbox.notifications,[]);
 const page=await(await tech.get('/')).text();assert.doesNotMatch(page,/UI Alpha reminder|UI Alpha completed work/);
});
