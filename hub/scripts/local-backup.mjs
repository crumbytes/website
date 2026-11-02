// A deliberate local PostgreSQL rehearsal. Cannot target hosted infrastructure.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { localSnapshotStore,assertLocalDatabaseUrl } from '../src/local-recovery.js';
const exec=promisify(execFile);
async function main(){
const [operation,id]=process.argv.slice(2),url=process.env.HUB_LOCAL_DATABASE_URL;
if(!['backup','restore','prune'].includes(operation))throw new Error('Use backup, restore <id>, or prune');
assertLocalDatabaseUrl(url);
if(process.env.HUB_LOCAL_RECOVERY_CONFIRM!==new URL(url).pathname.slice(1))throw new Error('Repeat the disposable database name in HUB_LOCAL_RECOVERY_CONFIRM');
const transportUrl=new URL(url);transportUrl.searchParams.set('hostaddr','127.0.0.1');
const store=await localSnapshotStore(process.env.HUB_LOCAL_SNAPSHOT_DIR,process.env.HUB_LOCAL_BACKUP_KEY);
const bin=process.env.HUB_PG_BIN_DIR||'/usr/bin';
const client=new pg.Client({connectionString:url});await client.connect();
try{
 if(operation==='backup'){
  const r=await exec(`${bin}/pg_dump`,['--format=custom','--schema=hub','--schema=hub_meta',transportUrl.href],{encoding:'buffer',maxBuffer:128*1024*1024});
  console.log(JSON.stringify(await store.save(r.stdout)));
 }else if(operation==='restore'){
  const count=(await client.query("select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and c.relkind in ('r','p','v','m')")).rows[0].n;
  if(count)throw new Error('Restore target must be an empty disposable database');
  const bytes=await store.restore(id);
  // No persistent plaintext file. pg_restore receives the authenticated archive on stdin.
  const {spawn}=await import('node:child_process');
  await new Promise((ok,fail)=>{const p=spawn(`${bin}/pg_restore`,['--no-owner','--exit-on-error','--single-transaction','--dbname='+transportUrl.href],{stdio:['pipe','ignore','pipe']});p.stderr.resume();p.on('error',fail);p.on('close',code=>code===0?ok():fail(new Error('Local restore failed')));p.stdin.on('error',fail);p.stdin.end(bytes);});
  await client.query("insert into hub.audit_log(actor_type,action,entity_type,entity_id,metadata,prev_hash,entry_hash) values('system','database.local_restore','backup',$1,'{}','','')",[id]);
  console.log(JSON.stringify({restored:true,snapshot_id:id,audit_event:'database.local_restore',hosted_verified:false}));
 }else console.log(JSON.stringify(await store.prune({retentionDays:Number(process.env.HUB_LOCAL_RETENTION_DAYS||7)})));
}finally{await client.end();}

}
main().catch(()=>{console.error('Local recovery failed. Check private settings, PostgreSQL tools and the empty disposable target. No values logged.');process.exitCode=1;});
