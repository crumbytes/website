// Read-only release-input certificate. This does not claim tests or provider
// settings have been verified; exact-commit CI and hosted evidence are separate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args) => execFileSync('git', args, {cwd:root,encoding:'utf8'}).trim();
const read = async name => JSON.parse(await readFile(new URL(name,import.meta.url),'utf8'));
const policy = await read('../staging/release-policy.json');
assert.equal(Number(process.versions.node.split('.')[0]),24,'Node 24 required');
git('merge-base','--is-ancestor',policy.source_baseline,'HEAD');
assert.equal(git('rev-parse','refs/remotes/origin/main'),policy.marketing_baseline,'Review main drift before certification');
const dirty = git('status','--porcelain');
assert.equal(dirty,'','Commit or preserve outstanding work before certifying an exact candidate');
const changed = git('diff','--name-only',policy.marketing_baseline+'...HEAD').split('\n').filter(Boolean);
const allowed = new Set(['.github/workflows/hub.yml','.vercelignore','vercel.json','README.md']);
assert.ok(changed.every(name=>name.startsWith('hub/')||allowed.has(name)),'Unexpected marketing-site file change');
const current = await read('../../vercel.json');
const original = JSON.parse(git('show',policy.marketing_baseline+':vercel.json'));
delete current.git;delete original.git;
assert.deepEqual(current,original,'Public Vercel behavior must remain unchanged');
const approvedRoot=JSON.parse(git('show',policy.source_baseline+':vercel.json'));
const releaseRoot=await read('../../vercel.json');
delete releaseRoot.git.deploymentEnabled['codex/hub-release-candidate'];
assert.deepEqual(releaseRoot,approvedRoot,'Existing branch and marketing settings must remain unchanged');
for(const directory of ['hub/src','hub/api','hub/db']) {
 assert.equal(git('rev-parse','HEAD:'+directory),policy.reviewed_application_trees?.[directory],'Application/API/migration tree differs from the reviewed product candidate: '+directory);
}
assert.equal(git('diff','--name-only',policy.source_baseline+'...HEAD','--','hub/package.json','hub/package-lock.json'),'','Dependency changes require a new reviewed dependency baseline');
assert.equal(await readFile(new URL('../../.vercelignore',import.meta.url),'utf8'),git('show',policy.source_baseline+':.vercelignore')+'\n','Marketing exclusion policy must remain unchanged');
const branchPolicy = (await read('../../vercel.json')).git?.deploymentEnabled;
assert.equal(branchPolicy?.['codex/hub-release-candidate'],false,'Release branch auto-deployment must be disabled');
const hub = await read('../vercel.json');
assert.equal(hub.git.deploymentEnabled,false);
assert.deepEqual(hub.builds,[{src:'api/index.js',use:'@vercel/node'}]);
assert.deepEqual(hub.routes,[{src:'/(.*)',dest:'/api/index.js'}]);
const ignore = await readFile(new URL('../../.vercelignore',import.meta.url),'utf8');
for(const name of ['hub/','.github/','infra/','scripts/','tests/']) assert.ok(ignore.split('\n').includes(name),name+' must be excluded');
const hubIgnore=await readFile(new URL('../.vercelignore',import.meta.url),'utf8');
for(const name of ['.env','.env.*','.vercel/','.data/','scripts/','staging/','tests/']) assert.ok(hubIgnore.split('\n').includes(name),'Local-only input must be excluded: '+name);
const pkg=await read('../package.json');
assert.equal(pkg.engines.node,'>=24 <25');
for(const name of ['preinstall','install','postinstall','prepare','build','vercel-build','now-build']) {
  assert.equal(pkg.scripts?.[name],undefined,'Unexpected automatic build/install hook requires review: '+name);
}
console.log(JSON.stringify({status:'local-release-inputs-certified',sha:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),source_baseline:policy.source_baseline,marketing_unchanged:true,build_scope:'Hub function only',hosted_verified:false},null,2));
