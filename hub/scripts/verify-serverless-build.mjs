// Official builder verification only: no project link, deployment or migration.
import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const toolsDir=process.env.HUB_BUILDER_TOOLS_DIR;
if(!toolsDir||!path.isAbsolute(toolsDir))throw new Error('HUB_BUILDER_TOOLS_DIR must select the separately installed official builder tools');
const require=createRequire(path.join(toolsDir,'package.json'));
assert.equal(require('@vercel/node/package.json').version,'29.0.1');
assert.equal(require('@vercel/build-utils/package.json').version,'15.2.1');
const {build}=require('@vercel/node');const {glob}=require('@vercel/build-utils');
const hub=fileURLToPath(new URL('../',import.meta.url));
const rules=(await readFile(path.join(hub,'.vercelignore'),'utf8')).split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
const excluded=name=>rules.some(rule=>rule.endsWith('/')?(name===rule.slice(0,-1)||name.startsWith(rule)):rule.endsWith('*')?name.startsWith(rule.slice(0,-1)):name===rule);
const temp=await mkdtemp(path.join(tmpdir(),'hub-release-build-'));
try{
 const input=path.join(temp,'input'),workPath=path.join(temp,'output');
 await cp(hub,input,{recursive:true,filter:source=>{
  const relative=path.relative(hub,source).split(path.sep).join('/');
  return relative===''||(!relative.startsWith('node_modules')&&!excluded(relative));
 }});
 const result=await build({files:await glob('**',input),entrypoint:'api/index.js',workPath,config:{projectSettings:{installCommand:'npm ci'}},considerBuildCommand:true,meta:{isDev:false}});
 const output=result.output;
 assert.equal(output.type,'Lambda');assert.equal(output.handler,'api/index.js');assert.equal(output.runtime,'nodejs24.x');
 const files=Object.keys(output.files);
 assert.ok(files.every(name=>!name.split('/').some(part=>part.startsWith('.env')||part==='.vercel'||part==='.data')),'Secret/development file in function output');
 assert.ok(files.every(name=>!['scripts/','staging/','docs/','tests/','e2e/','hosted/'].some(prefix=>name.startsWith(prefix))),'Operator/test files must not be bundled');
 assert.ok(!files.includes('api/contact.js')&&!files.includes('api/download.js')&&!files.includes('index.html'),'Marketing application must not be bundled');
 const report={sha:execFileSync('git',['rev-parse','HEAD'],{cwd:hub,encoding:'utf8'}).trim(),builder:'@vercel/node@29.0.1',build_utils:'15.2.1',type:output.type,handler:output.handler,runtime:output.runtime,bundled_files:files.length,static_outputs:0,hosted_verified:false};
 if(process.env.HUB_BUILD_REPORT)await writeFile(process.env.HUB_BUILD_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{await rm(temp,{recursive:true,force:true})}
