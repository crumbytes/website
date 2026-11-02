// Local/disposable database rehearsal only. Hosted storage/restore is not enabled.
import { randomBytes,randomUUID,createCipheriv,createDecipheriv,createHash } from 'node:crypto';
import { mkdir,writeFile,readFile,readdir,unlink,lstat } from 'node:fs/promises';
import path from 'node:path';
const idPattern=/^[a-f0-9-]{36}$/;
const keyOf=k=>{const b=Buffer.from(k,'base64');if(b.length!==32)throw new Error('Recovery key must be 32 bytes');return b;};
export function assertLocalDatabaseUrl(value){
 const u=new URL(value);
 if(!['postgres:','postgresql:'].includes(u.protocol)||!['localhost','127.0.0.1'].includes(u.hostname)||u.search||u.hash)throw new Error('Only a direct local disposable database URL without overrides is allowed');
 return u;
}
export function sealSnapshot(bytes,key,{id=randomUUID(),createdAt=new Date().toISOString()}={}){
 if(!idPattern.test(id)||!Number.isFinite(Date.parse(createdAt)))throw new Error('Invalid snapshot metadata');
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyOf(key),nonce);cipher.setAAD(Buffer.from(`hub-snapshot-v1:${id}:${createdAt}`));
 const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);return {version:1,id,createdAt,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
}
export function openSnapshot(s,key){
 if(s.version!==1||!idPattern.test(s.id)||!Number.isFinite(Date.parse(s.createdAt)))throw new Error('Invalid snapshot');
 const c=createDecipheriv('aes-256-gcm',keyOf(key),Buffer.from(s.nonce,'base64'));c.setAAD(Buffer.from(`hub-snapshot-v1:${s.id}:${s.createdAt}`));c.setAuthTag(Buffer.from(s.tag,'base64'));
 const bytes=Buffer.concat([c.update(Buffer.from(s.ciphertext,'base64')),c.final()]);if(createHash('sha256').update(bytes).digest('hex')!==s.sha256)throw new Error('Snapshot digest mismatch');return bytes;
}
export async function localSnapshotStore(directory,key){
 keyOf(key);await mkdir(directory,{recursive:true,mode:0o700});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))throw new Error('Snapshot directory must be private (0700), not a symlink');
 const file=id=>{if(!idPattern.test(id))throw new Error('Invalid snapshot ID');return path.join(directory,`hub-snapshot-${id}.json`);};
 const load=async id=>{const f=file(id),st=await lstat(f);if(!st.isFile()||st.isSymbolicLink()||st.size>200*1024*1024)throw new Error('Unsafe snapshot file');return JSON.parse(await readFile(f,'utf8'));};
 return {
  async save(bytes,options){const s=sealSnapshot(bytes,key,options);await writeFile(file(s.id),JSON.stringify(s),{flag:'wx',mode:0o600});return {id:s.id,createdAt:s.createdAt,sha256:s.sha256};},
  async restore(id){return openSnapshot(await load(id),key);},
  async prune({retentionDays=7,now=new Date()}={}){
   if(!Number.isInteger(retentionDays)||retentionDays<1)throw new Error('Invalid retention');
   const candidates=[];for(const f of await readdir(directory)){const m=/^hub-snapshot-([a-f0-9-]{36})\.json$/.exec(f);if(!m)continue;const s=await load(m[1]);openSnapshot(s,key);candidates.push(s);}
   candidates.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));let removed=0;
   // Keep at least the latest authenticated artifact, even if everything is old.
   for(const s of candidates.slice(1))if(Date.parse(s.createdAt)<now.getTime()-retentionDays*86400000){await unlink(file(s.id));removed++;}
   return {removed,retained:candidates.length-removed};
  }
 };
}
