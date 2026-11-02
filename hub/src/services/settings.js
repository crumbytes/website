import { z } from 'zod';
import { requirePermission } from '../authz.js';
import { auditStaff } from '../audit.js';
import { notFound } from '../errors.js';
import { parse,isUuid,schemas } from '../validation.js';
const active=z.preprocess(v=>v===true||v==='true'||v==='on',z.boolean());
const txOf=(ctx,fn)=>ctx.db.as('hub_app',ctx.staff.id,fn);
export async function updateCheck(ctx,id,input){
 requirePermission(ctx.staff,'monitoring.write');if(!isUuid(id))throw notFound();
 const d=parse(z.object({enabled:active,interval_minutes:z.coerce.number().int().min(5).max(10080),failure_threshold:z.coerce.number().int().min(1).max(20)}),input);
 return txOf(ctx,async tx=>{const r=(await tx.query(`update hub.monitoring_checks m set enabled=$2,interval_minutes=$3,failure_threshold=$4,next_run_at=now(),lease_token=null,lease_until=null,target_url=w.primary_url
 from hub.managed_websites w where m.id=$1 and w.id=m.website_id and w.lifecycle='active' returning m.client_account_id`,[id,d.enabled,d.interval_minutes,d.failure_threshold])).rows[0];if(!r)throw notFound();await auditStaff(tx,ctx,'monitoring.configure',{clientId:r.client_account_id,entityId:id,entityType:'monitoring_check',metadata:{enabled:d.enabled}});return r;});
}
export async function updateBackupSource(ctx,id,input){
 requirePermission(ctx.staff,'backup.write');if(!isUuid(id))throw notFound();
 const d=parse(schemas.backupSource,input),enabled=parse(active,input.active);
 return txOf(ctx,async tx=>{const r=(await tx.query(`update hub.backup_sources set provider=$2,label=$3,expected_interval_hours=$4,schedule_description=$5,retention_days=$6,encryption_method=$7,active=$8 where id=$1 and website_id=$9 returning client_account_id`,[id,d.provider,d.label,d.expected_interval_hours??null,d.schedule_description??null,d.retention_days??null,d.encryption_method??null,enabled,d.website_id])).rows[0];if(!r)throw notFound();await auditStaff(tx,ctx,'backup.configure',{clientId:r.client_account_id,entityType:'backup_source',entityId:id});return r;});
}
export async function updatePlan(ctx,id,input){
 requirePermission(ctx.staff,'plan.write');if(!isUuid(id))throw notFound();const d=parse(schemas.plan,input),enabled=parse(active,input.active);
 return txOf(ctx,async tx=>{const r=(await tx.query('update hub.service_plans set name=$2,description=$3,maintenance_interval_days=$4,active=$5 where id=$1 returning id',[id,d.name,d.description,d.maintenance_interval_days??null,enabled])).rows[0];if(!r)throw notFound();await auditStaff(tx,ctx,'plan.configure',{entityId:id,entityType:'service_plan'});return r;});
}
export async function workflowRecords(ctx){requirePermission(ctx.staff,'maintenance.read');return txOf(ctx,async tx=>({sources:(await tx.query('select b.*,w.display_name as website_name from hub.backup_sources b join hub.managed_websites w on w.id=b.website_id order by b.label')).rows,rollbacks:(await tx.query('select r.id,r.task_id,r.plan,r.status,r.evidence_ref,r.recorded_at,t.title from hub.task_rollbacks r join hub.maintenance_tasks t on t.id=r.task_id order by recorded_at desc limit 100')).rows,plans:(await tx.query('select id,name,description,maintenance_interval_days,active from hub.service_plans order by name')).rows}));}
