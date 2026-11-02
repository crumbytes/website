// Offline review only. No provider request, deployment, or credential is sent.
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateDeploymentRequest} from '../staging/validate.js';
try {
  if(!process.argv[2])throw new Error();
  const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8'}).trim();
  if(process.env.HUB_APPROVED_RELEASE_SHA!==sha)throw new Error();
  const result=validateDeploymentRequest(JSON.parse(await readFile(process.argv[2],'utf8')),{projectId:process.env.HUB_APPROVED_PROJECT_ID,sha});
  console.log(JSON.stringify({...result,sha},null,2));
}catch{
 console.error('Deployment request is not valid for this approved staging project and checkout. This offline command never deploys; approval metadata does not itself grant authorization.');process.exitCode=1;
}
