import { writeAudit, auditStaff } from '../audit.js';
import { requirePermission } from '../authz.js';
import { notFound } from '../errors.js';
import { parse,isUuid } from '../validation.js';
import { z } from 'zod';
// The durable maintenance queue creates work; it never dispatches a CMS operation.
// A unique schedule/date key survives retries, restarts and multiple schedulers.
export async function enqueueDueMaintenance({db,now=()=>new Date(),limit=50}){
 return db.as('hub_worker',null,async tx=>{
  const rows=(await tx.query(`select s.*,s.next_due_on::text as due from hub.maintenance_schedules s join hub.managed_websites w on w.id=s.website_id
    where s.active and w.lifecycle='active' and s.next_due_on <= $1::date
    and not exists(select 1 from hub.maintenance_tasks t where t.schedule_id=s.id and t.status in ('open','in_progress','blocked'))
    order by s.next_due_on for update of s skip locked limit $2`,[now(),Math.min(50,limit)])).rows;
  let created=0;
  for(const s of rows){
   const r=await tx.query(`insert into hub.maintenance_tasks(client_account_id,website_id,schedule_id,schedule_due_on,title,kind,requires_approval,assignee_id,due_on,created_by)
    values($1,$2,$3,$4,$5,$6,$7,$8,$4,$9) on conflict do nothing returning id`,[s.client_account_id,s.website_id,s.id,s.due,s.title,s.kind,['software_update','plugin_update'].includes(s.kind),s.default_assignee_id,s.created_by]);
   created+=r.rows.length;
   if(r.rows.length)await writeAudit(tx,{action:'schedule.enqueue',clientId:s.client_account_id,entityType:'maintenance_task',entityId:r.rows[0].id});
  }
  return {created};
 });
}
export async function recordRollback(ctx,taskId,input){
 requirePermission(ctx.staff,'maintenance.write');if(!isUuid(taskId))throw notFound();
 const d=parse(z.object({plan:z.string().trim().min(10).max(4000),status:z.enum(['planned','completed','failed']),evidence_ref:z.string().trim().max(500).default('')}).refine(d=>d.status==='planned'||d.evidence_ref.length>=3),input);
 return ctx.db.as('hub_app',ctx.staff.id,async tx=>{
  const t=(await tx.query('select id,client_account_id from hub.maintenance_tasks where id=$1',[taskId])).rows[0];if(!t)throw notFound();
  const r=(await tx.query('insert into hub.task_rollbacks(task_id,client_account_id,plan,status,evidence_ref,recorded_by) values($1,$2,$3,$4,$5,$6) returning id',[taskId,t.client_account_id,d.plan,d.status,d.evidence_ref||null,ctx.staff.id])).rows[0];
  await auditStaff(tx,ctx,'rollback.record',{clientId:t.client_account_id,entityType:'task_rollback',entityId:r.id,metadata:{status:d.status}});return r;
 });
}
export async function shareHistory(ctx,id,active=true){
 requirePermission(ctx.staff,'maintenance.write');if(!isUuid(id))throw notFound();
 return ctx.db.as('hub_app',ctx.staff.id,async tx=>{
  const r=(await tx.query('select client_account_id,website_id from hub.service_history where id=$1',[id])).rows[0];if(!r)throw notFound();
  await tx.query('insert into hub.portal_history_shares(history_id,client_account_id,shared_by,active) values($1,$2,$3,$4) on conflict(history_id) do update set active=excluded.active,shared_by=excluded.shared_by,updated_at=now()',[id,r.client_account_id,ctx.staff.id,active]);
  await auditStaff(tx,ctx,active?'history.share':'history.unshare',{clientId:r.client_account_id,entityType:'service_history',entityId:id});return r;
 });
}
