# Protected hosted acceptance procedure

Do not run until the release owner approves the exact candidate SHA and protected staging deployment. This procedure never creates a Vercel project, changes DNS, applies migrations or enables integrations. Hostname must be `https://hub-preview.crumbyte.com`. No customer data or production StackLTR.

## Prepare identities and short-lived browser state

A staging administrator configures the separate IdP client, mandatory MFA and exact callback, then provisions synthetic staff. A tester must actually complete real MFA in a browser and record success plus denied missing-MFA/unprovisioned/disabled cases; imported cookies alone do not prove the provider challenged for MFA.

Prepare separate browser contexts and export Playwright `storageState` into restricted files under `/tmp` with mode 0600:

- `HUB_HOSTED_PROTECTION_STATE`: Vercel protection access only; **no** Hub session cookie.
- `HUB_HOSTED_OWNER_STATE`: synthetic owner (display name `Local Owner`) after real MFA and Vercel protection.
- `HUB_HOSTED_TECH_A_STATE`: synthetic technician `Local Technician` after MFA, assigned to synthetic client A only.
- `HUB_HOSTED_TECH_B_STATE`: second synthetic technician after MFA, assigned to synthetic client B only.
- `HUB_HOSTED_SYNTHETIC_FIXTURE`: JSON `{"syntheticOnly":true,"siteA":"<UUID>","siteB":"<UUID>","staffB":"<second technician UUID>"}`. Populate actual approved synthetic identifiers; never use customer IDs.

Storage state contains authentication cookies. Do not commit it, print it, attach it to PRs or store it in repository artifacts. Disable traces/video/screenshots for these runs. Delete files and revoke test sessions afterward. No production IdP account or customer credential is needed.

## Read-only automation

From `hub/`, set `HUB_HOSTED_TEST_ORIGIN` and `HUB_HOSTED_TEST_APPROVED` to the exact preview origin, and set the five file-path variables above. Run:

```bash
npx playwright test --config=playwright.hosted.config.mjs
```

The config fails before network work if the exact origin and approval do not match. It starts no local server. Six cases are discovered; the staff mutation case is skipped unless separately authorized. Read-only tests cover fresh browser protection, app denial after platform access, protected routes and security headers, internal source denial, independent two-client isolation, layout and accessibility. Audit the requested target before running. Do not describe the deliberately skipped revocation case as passed.

Repeat the unauthenticated and app-protected checks on **every** deployment-specific URL and alias from the Vercel project. The automated config deliberately allows only the proposed hostname; an operator must independently record other host coverage. Verify redirect destinations lead to the approved platform/application login and never return source/customer data. If the Vercel plan leaves a custom domain or alias unprotected, do not accept the deployment.

## Explicit synthetic mutation automation

Only after separate authorization to change synthetic records, set `HUB_HOSTED_MUTATIONS_APPROVED` to the same exact origin and rerun the command. This includes the existing browser workflow and the hosted revocation case. The workflow adds new synthetic clients/websites/tasks/backups/findings, edits and archives/restores inventory, assigns the synthetic technician, records maintenance and second-person approval, and exercises validation/errors/responsive/accessibility/security behavior. All site URLs use reserved `.example.test` names. It must never enable integrations or perform CMS maintenance.

The expected staged identities must have the display names above. The browser workflow creates its own uniquely named A/B client pair and assigns `Local Technician` only to A; preseeded fixture records are used separately by the read-only isolation checks. Existing synthetic records remain for review; there is no destructive cleanup. Failure or a skipped serial test is a failed/incomplete acceptance run, not success.

The final revocation case disables fixture `staffB`, verifies its session returns 401, re-enables it in `finally`, and verifies the same session remains invalid. It deliberately consumes that state file; perform fresh real MFA/export before another full run. Recheck that the fixture marks synthetic records and the staff UUID belongs to the approved synthetic technician before authorizing mutations.

## Acceptance evidence matrix

| Requirement | Automated evidence / remaining manual gate |
| --- | --- |
| Staff login with MFA | Signed-token AMR tests locally; tester completes and records real IdP challenge, recovery and denied no-MFA cases |
| Unauthorized denial | Fresh and platform-only browser contexts; API 401; direct routes |
| Inventory create/edit/archive | Reused browser workflow with synthetic mutation approval |
| Tasks and approval | Browser second-person task approval plus Node/API authorization tests; no live CMS dispatch |
| Findings / backup records | Browser synthetic records and recovery evidence validation |
| Two-client isolation | Independent technician states and hidden foreign IDs; database RLS locally |
| Revocation / disablement | Explicit hosted mutation case; real PostgreSQL login/disable race locally |
| Error handling | Invalid input and unavailable credentials in browser; provider/network failure tests locally; controlled hosted provider-outage exercise still manual |
| Layout/accessibility | Browser phone/tablet/desktop, axe serious/critical, keyboard checks |
| Serverless route protection | Unauthenticated/platform-only/authenticated file paths; runtime no-store/CSP; official function-only build locally |
| No production credentials/integrations | Pin/flag tests plus operator review of provider secret scopes, DB owner/grants and IdP client identity |

Record approved SHA, domain, deployment ID, test counts, passed/failed/skipped cases, real MFA evidence and operator. Run `npm run preflight` with the actual secure staging configuration and separately verify runtime privileges/TLS. Report access problems or unavailable services; never weaken MFA or disable protection to make a test pass.

The suite is prepared, not proof that hosting, callbacks, TLS or protection already works. Hosted runs remain blocked until the infrastructure approvals and configuration in [the approval packet](sprint2-approval.md) are complete.

## Customer portal addition

Current implementation/guide: [product-handbook.md](product-handbook.md). Three additional read-only hosted cases in `hosted/portal.spec.mjs` require separately provisioned Alpha and Bravo **customer** identities that actually completed MFA and platform protection. Set protected `/tmp` paths `HUB_HOSTED_CUSTOMER_A_STATE` and `HUB_HOSTED_CUSTOMER_B_STATE`; add approved `clientA`/`clientB` UUIDs to the synthetic fixture alongside its existing fields. Without these inputs the three cases are explicitly skipped, not passed. They verify reciprocal portal/report denial, staff API denial, curated exports and mobile/axe accessibility. No customer mutation or credential is embedded in tests.

Local `e2e/product.spec.mjs` additionally tests customer provisioning, requests/responses, contacts and report download against a controlled local test issuer. It is not included in hosted mutation runs; after separate hosted mutation approval, follow the same synthetic workflow manually and capture pass/fail evidence without cookies/secrets/screenshots. Default existing hosted case counts in earlier sections describe the pre-portal suite; report actual discoveries/passes/skips including these three additional cases. Real backup storage/restore, managed pooling and provider claims remain mandatory hosted gates.
