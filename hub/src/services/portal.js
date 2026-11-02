import { z } from 'zod';
import { auditStaff } from '../audit.js';
import { requirePermission } from '../authz.js';
import { forbidden, notFound, conflict } from '../errors.js';
import { parse, isUuid,schemas } from '../validation.js';
const as = (ctx,fn) => ctx.db.as('hub_app',ctx.staff.id,fn);
const text = max => z.string().trim().min(3).max(max);
const contact = z.object({client_account_id:z.string().uuid(),display_name:text(160),email:z.string().trim().toLowerCase().email().max(254),phone:z.string().trim().max(80).default(''),purpose:z.string().trim().max(500).default(''),active:z.preprocess(v=>v===true||v==='true'||v==='on',z.boolean()).default(true)});
const request = z.object({client_account_id:z.string().uuid(),website_id:z.preprocess(v=>v||null,z.string().uuid().nullable().optional()),subject:text(160),body:text(4000)});
const ensure = async (tx,id) => {if(!isUuid(id)||!(await tx.query('select id from hub.client_accounts where id=$1',[id])).rows.length)throw notFound();};
export async function clientDirectory(ctx,{search='',status='all'}={}) {
 requirePermission(ctx.staff,'client.read');
 return as(ctx,async tx=>(await tx.query(`select id,display_name,status from hub.client_accounts where display_name ilike $1 and ($2='all' or status=$2) order by display_name limit 200`,['%'+String(search).slice(0,160)+'%',status])).rows);
}
export async function contacts(ctx,clientId){return as(ctx,async tx=>{await ensure(tx,clientId);return (await tx.query('select id,display_name,email,phone,purpose,active from hub.client_contacts where client_account_id=$1 order by display_name',[clientId])).rows;});}
export async function saveContact(ctx,input,id){
 if(!ctx.staff.is_customer)requirePermission(ctx.staff,'client.write');
 const d=parse(contact,input);
 return as(ctx,async tx=>{await ensure(tx,d.client_account_id);let r;
 if(id){if(!isUuid(id))throw notFound();r=(await tx.query(`update hub.client_contacts set display_name=$3,email=$4,phone=$5,purpose=$6,active=$7,updated_at=now() where id=$1 and client_account_id=$2 returning id`,[id,d.client_account_id,d.display_name,d.email,d.phone,d.purpose,d.active])).rows[0];}
 else r=(await tx.query('insert into hub.client_contacts(client_account_id,display_name,email,phone,purpose) values($1,$2,$3,$4,$5) returning id',[d.client_account_id,d.display_name,d.email,d.phone,d.purpose])).rows[0];
 if(!r)throw notFound();await auditStaff(tx,ctx,'contact.save',{clientId:d.client_account_id,entityType:'client_contact',entityId:r.id});return r;
 });
}
export async function submitRequest(ctx,input){
 const d=parse(request,input);
 return as(ctx,async tx=>{await ensure(tx,d.client_account_id);
 if(d.website_id&&!(await tx.query('select id from hub.managed_websites where id=$1 and client_account_id=$2',[d.website_id,d.client_account_id])).rows.length)throw notFound();
 const r=(await tx.query('insert into hub.support_requests(client_account_id,website_id,requested_by,subject,body) values($1,$2,$3,$4,$5) returning id',[d.client_account_id,d.website_id??null,ctx.staff.id,d.subject,d.body])).rows[0];
 await auditStaff(tx,ctx,'request.submit',{clientId:d.client_account_id,entityType:'support_request',entityId:r.id});return r;
 });
}
export async function requests(ctx,clientId){
 if(clientId&&!isUuid(clientId))throw notFound();
 return as(ctx,async tx=>(await tx.query(`select r.id,r.client_account_id,r.website_id,r.subject,r.body,r.status,r.resolution,r.created_at,r.updated_at,c.display_name as client_name from hub.support_requests r join hub.client_accounts c on c.id=r.client_account_id where ($1::uuid is null or r.client_account_id=$1) order by r.updated_at desc limit 200`,[clientId??null])).rows);
}
export async function updateRequest(ctx,id,input){
 requirePermission(ctx.staff,'maintenance.write');if(!isUuid(id))throw notFound();
 const d=parse(z.object({status:z.enum(['open','in_progress','waiting','resolved','closed']),resolution:z.string().trim().max(4000).default('')}),input);
 return as(ctx,async tx=>{const r=(await tx.query('update hub.support_requests set status=$2,resolution=$3,updated_at=now() where id=$1 returning client_account_id',[id,d.status,d.resolution])).rows[0];if(!r)throw notFound();await auditStaff(tx,ctx,'request.update',{clientId:r.client_account_id,entityType:'support_request',entityId:id,metadata:{status:d.status}});return r;});
}
export async function inviteCustomer(ctx,clientId,input){
 requirePermission(ctx.staff,'staff.write');const d=parse(z.object({email:z.string().trim().toLowerCase().email().max(254),display_name:text(160)}),input);
 return as(ctx,async tx=>{await ensure(tx,clientId);let u=(await tx.query('select id,is_customer from hub.staff_users where email=$1',[d.email])).rows[0];
 if(u&&!u.is_customer)throw conflict('An internal staff identity cannot be converted to a customer.');
 if(!u)u=(await tx.query("insert into hub.staff_users(email,display_name,role,is_customer) values($1,$2,'viewer',true) returning id",[d.email,d.display_name])).rows[0];
 await tx.query('insert into hub.staff_client_assignments(staff_id,client_account_id,assigned_by) values($1,$2,$3) on conflict do nothing',[u.id,clientId,ctx.staff.id]);
 await auditStaff(tx,ctx,'customer.provision',{clientId,entityType:'staff_user',entityId:u.id});return u;
 });
}
// Only explicitly shared history and curated status fields leave the staff boundary.
export async function customerSummary(ctx,clientId,{from,to}={}){
 if(!isUuid(clientId))throw notFound();
 const today=new Date().toISOString().slice(0,10);from??=today.slice(0,7)+'-01';to??=today;
 const range=parse(schemas.report,{from,to});
 return as(ctx,async tx=>{await ensure(tx,clientId);
 const q=async(sql,args=[clientId])=>(await tx.query(sql,args)).rows;
 const websites=await q(`select w.id,w.display_name,w.primary_url,w.cms_platform,w.lifecycle,w.cms_version,
 (select count(*)::int from hub.security_findings f where f.website_id=w.id and f.status in ('open','in_progress')) as open_findings,
 (select r.outcome from hub.monitoring_results r join hub.monitoring_checks c on c.id=r.check_id where c.website_id=w.id and c.kind='uptime' order by r.checked_at desc limit 1) as availability,
 (select r.checked_at from hub.monitoring_results r join hub.monitoring_checks c on c.id=r.check_id where c.website_id=w.id and c.kind='uptime' order by r.checked_at desc limit 1) as availability_checked_at
 from hub.managed_websites w where w.client_account_id=$1 order by w.display_name`);
 const tasks=await q(`select id,website_id,title,kind,status,due_on,completed_at from hub.maintenance_tasks where client_account_id=$1 and (completed_at is null or completed_at >= $2::date and completed_at < $3::date+1) order by created_at desc limit 500`,[clientId,range.from,range.to]);
 const findings=await q('select website_id,title,severity,status from hub.security_findings where client_account_id=$1 order by found_at desc limit 200');
 const backups=await q(`select b.website_id,b.label,r.status,r.finished_at from hub.backup_sources b left join lateral(select status,finished_at from hub.backup_runs x where x.source_id=b.id order by finished_at desc limit 1)r on true where b.client_account_id=$1`);
 const activity=await q('select h.website_id,h.kind,h.summary,h.performed_at from hub.service_history h join hub.portal_history_shares s on s.history_id=h.id and s.active where h.client_account_id=$1 order by h.performed_at desc limit 100');
 const uptime=await q(`select c.website_id,count(*)::int as samples,count(*) filter(where r.outcome='up')::int as up,round(avg(r.response_ms))::int as average_ms from hub.monitoring_results r join hub.monitoring_checks c on c.id=r.check_id where r.client_account_id=$1 and c.kind='uptime' and not r.in_maintenance_window and r.checked_at >= $2::date and r.checked_at < $3::date+1 group by c.website_id`,[clientId,range.from,range.to]);
 return {client_id:clientId,...range,websites,tasks,findings,backups,activity,uptime,generated_at:new Date().toISOString(),report_sections:{period:['tasks','uptime'],current_snapshot:['websites','findings','backups','activity']},limits:{tasks:500,findings:200,activity:100},limitations:'Recorded application state only. Unmeasured availability and unverified backups remain unknown.'};
 });
}
