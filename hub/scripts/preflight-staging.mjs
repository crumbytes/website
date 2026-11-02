// Values must be securely injected by the operator; nothing is written or sent.
import { validateStagingEnvironment } from '../staging/validate.js';
try {
  console.log(JSON.stringify(validateStagingEnvironment(process.env), null, 2));
} catch {
  console.error('Staging preflight failed. Check required names, preview identity pins, verified TLS, dedicated runtime credentials and disabled jobs/integrations against docs/sprint4-approval.md. No values were logged.');
  process.exitCode = 1;
}
