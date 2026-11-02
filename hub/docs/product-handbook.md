# CrumByte Hub — application and operator handbook

Current implementation: draft PR #6, branch `codex/hub-release-candidate`. Development began from `7ba168ce57e9bf755741b05c93e5c0271d471db0`. The final exact SHA and completed CI run are recorded in the PR and delivery certificate, not guessed here. **Local development certification is separate from hosted security/recovery acceptance.** No hosted resources, customer sites, StackLTR projects, DNS, subscriptions or public website were changed.

## 1. Architecture

One Node24/Hono application, server-rendered escaped HTML and PostgreSQL17. No second CRM or authentication product. `api/index.js` is the single Vercel function; unconfigured hosting returns503. `src/runtime.js` wires OIDC, the guarded outbound client, vault, five CMS adapters and disabled-by-default external services. Source is private function input, never a static route. Existing deployment exclusions remain.

OIDC principals (internal staff and portal-only customers) use the existing `staff_users` identity table and client assignments. A customer is constrained to viewer role and `is_customer=true`. Every request resolves current DB status and permissions. Customer sessions can reach only `/portal`, its subroutes, their account/session controls, logout and their own identity metadata; internal pages/APIs/operations are denied. Customer data services also use transaction-local `hub_app`/staff identity and RLS. No separate password/session implementation exists.

## 2. Feature inventory

| Area | Implemented local behavior | Live/hosted boundary |
| --- | --- | --- |
| Dashboard | Real website/task/update/request/finding/incident counts, measured coverage, backups/recoverability, upcoming work, activity, integration state | No invented uptime or provider update counts; unknown stays unknown |
| Customers | Directory/search/status filter, profiles, site ownership at onboarding, tenant assignments, portal-only access provisioning/revocation, operational contacts | CRM identities/billing/tickets stay in StackLTR; operational contacts do not grant access |
| Websites | Create/edit/archive/restore, customer at creation, CMS/version, hosting/owner/plan, domains, notes, checks, history | Cross-client transfer of a historical site is intentionally refused; create a new scoped record instead |
| Maintenance | Task queue, due schedules, approvals, work logs, completion evidence, cancellation/blocked retries, rollback plan/outcome records | Automatic queueing creates tasks, not unapproved CMS updates; irreversible/uncertain operations are never redispatched |
| Monitoring | HTTP latency/status, certificate trust/expiry, public A/AAAA DNS history/change notices, thresholds, deduped incidents, recovery and maintenance-window suppression | Scheduler disabled until approved; measurements only from actual probes, never mock production statistics |
| Security | Scoped findings/reviews, automated certificate findings, remediation tasks and activity | Full third-party vulnerability scanning is not claimed |
| Backups | Provider expectation/schedule/retention/encryption metadata, R2 listing, run history/failure/overdue alerts, recovery approval/evidence, encrypted local Hub DB backup/restore/pruning | Unsupported CMS backup APIs remain explicit manual workflows; provider retention and hosted DB recovery require real infrastructure |
| Reports | Maintenance HTML/CSV, monthly customer JSON with period task/uptime data and explicitly identified current snapshots | Bounded result limits are in report metadata; no SLA inferred from sparse samples |
| Portal | Curated websites/maintenance/monitoring/security/backups, reports, support requests/status/responses, contacts, explicitly shared activity | Internal notes, credentials, provider artifact references and staff-only routes excluded |
| Connectors | WordPress, Shopify, Wix, Squarespace and Joomla consistent adapter interface, safe errors, scoped requests, rotation/revocation, backoff and contracts | Implemented/simulated, **none live-verified**; see capability matrix |

No customer data is seeded by the deployed app. Tests use reserved synthetic Alpha/Bravo organizations and `.test` websites. The local dev issuer creates only synthetic staff; tests explicitly provision fixtures.

## 3. CMS capability matrix and connection onboarding

See [cms-capabilities.md](cms-capabilities.md) for provider endpoints/scopes/versions and API/manual/unsupported distinctions. WordPress core REST does not provide arbitrary software updates/backups; Shopify/Wix/Squarespace platform software is managed by the vendor. Do not invent those operations. Shopify customer access uses an authorized store's supported existing Admin token or eligible client credentials; creating a general public Shopify app/OAuth distribution is not a feature of this Hub. Squarespace API plan and Joomla mappings need approved live tests.

On a website, an administrator selects its CMS adapter and allowed HTTPS origin, then supplies a least-privilege credential only after storage/connection authorization. The adapter client pins the origin, refuses redirects and unsafe paths, drops provider error bodies and uses the SSRF-safe HTTP transport. Connection tests and inventories are separate named checks; denied permissions stay denied. Retry-After supports seconds/HTTP-date and bounded backoff. No automatic retry of an uncertain mutation occurs. Customer connections and credential storage remain off in staging.

Replace/revoke a connection credential through its existing control. Revoke at the provider too; local revocation cannot invalidate a vendor token. For master-key rotation, configure old+new KEKs securely, make the new key active, and use **Rewrap encryption key** for each active connection. This rewraps the authenticated DEK, preserving ciphertext/identity and never rendering plaintext. Audit every operation. Keep historic key versions securely through the backup retention/restore window before retiring them; backups may contain credentials wrapped under older keys. Actual KMS/binding installation is a cloud gate.

## 4. Schema and migrations

Five forward-only, checksum-recorded migrations: foundation; access control; full staff Hub; durable execution claims/revocation; portal and automation. Old applied files are unchanged. Fresh installation and repeat execution are tested. The new migration adds customer flags/constraints, operational contacts, local requests, append-only rollback records, reversible sharing metadata, DNS results/monitoring leases and unique schedule occurrences. All new tenant tables have RLS. Composite foreign keys/policy checks bind child records to the intended client/site/task.

Runtime login `hub_runtime` must not own the database/Hub objects, inherit an owner, have superuser/CREATEDB/CREATEROLE/BYPASSRLS or unsafe app roles. Runtime checks fail closed. Every business transaction uses a local role and staff context; rollback resets context. Pool max5 per instance, connection8s/query and statement15s bounds; aggregate Vercel concurrency must fit the approved pooler. Runtime URLs require `sslmode=verify-full`; host/user override parameters and TLS disabling are refused at startup, not just in preflight.

Only a separate owner applies migrations (`npm run migrate`, explicit confirmed host) after approval. One migration operator at a time. Test managed Neon role/grant/transaction-pooler behavior before acceptance. Never run local scripts against hosted resources; they reject non-loopback targets and connection-string overrides. Existing `frosty-union-75655676` and StackLTR Supabase staging/beta are never Hub targets.

## 5. Authentication and sessions

Use a dedicated confidential OIDC web client, code+S256, exact callback `https://hub-preview.crumbyte.com/auth/callback`, required `amr:mfa`, verified email and approved asymmetric signatures. Token signature/issuer/audience/azp/expiry/nonce, single-use state and browser binding are checked. Runtime discovery confines endpoints to the issuer's origin and refuses HTTP redirects, preventing credential forwarding. Verified email is checked on every login; only an administrator-provisioned identity can bind/sign in. No email auto-signup grants access.

ZITADEL candidate settings are in `staging/oidc-client-profile.example.json`; enable **User Info inside ID Token**. Auth0 is compatible where actual MFA entitlement/policy exists. No real tenant/issuer/client has been invented or configured. Signed synthetic issuer tests exercise the real flow; they do not prove real hosted MFA.

Opaque random sessions are stored hashed, Secure/HttpOnly/SameSite, with CSRF token, origin checks, idle30min/absolute8h lifetime and server-side revocation. Disablement permanently revokes old sessions; re-enabling requires a new login. Assignment removal changes access immediately. Logout ends the Hub session; upstream SSO logout is not implemented or claimed. Account page allows own-session revocation.

## 6. Security boundary and review

All writes require a valid session, same-origin CSRF and role/tenant authorization; input is validated, SQL values parameterized, HTML escaped and exports use safe content types/filenames (CSV formula escaping retained). Portal exports are curated; service history is internal until a staff member shares it. Sharing can be revoked without editing immutable service evidence. Operational contacts cannot provision identities. Request bodies are bounded; rate limits protect writes/logins/jobs.

Outbound traffic rejects private/link-local/loopback/site-local/transition addresses and unsafe schemes/ports/credentials, revalidates DNS at connect time, pins connections to validated answers, does not follow redirects, limits response sizes and has deadlines. DNS monitoring applies the same public-address rule. Hex-mapped IPv4 regression tests confirm the original Node BlockList behavior; added transition/site-local hardening must not be described as an already-proven original mapped-address bypass.

No arbitrary uploads, database-backup HTTP download, shell-execution route or unauthenticated vendor webhook endpoint exists. There is no unauthenticated file server. Backup artifacts are operator-only encrypted local files. Secrets are envelope-encrypted; plaintext is not returned, logged or placed in report/UI fields. No actual customer credential was used in development.

Known trust limits: application/runtime compromise can exercise trusted auth/worker roles; RLS is not a sandbox against arbitrary server execution. Audit chaining in the same database cannot survive a malicious database owner. Independent penetration testing, real provider/network/TLS validation and manual hosted accessibility acceptance remain gates. Existing public marketing source/schema disclosure was documented previously; it was not changed under this assignment.

## 7. Monitoring and scheduler operations

The authenticated internal scheduler endpoint is absent unless an operator job secret is installed; no cron is provisioned. Uptime is a bounded GET without redirect following; SSL is a credential-free certificate observation; DNS records public A/AAAA answers and changes. Incidents require consecutive failures, dedupe notifications and resolve on a successful measurement. Maintenance windows suppress outage alerts. Read-only probes retry at their next scheduled interval.

A worker atomically claims one due check via SKIP LOCKED and a two-minute tokenized lease. One-at-a-time claiming avoids leases expiring while queued behind other probes. A stale/disabled/reconfigured check cannot commit old results. Network failures are recorded as safe codes; private targets are configuration errors, not proof of downtime. Execution deadlines stop starting more work after the budget; unfinished due work remains queued. Operators size scheduler cadence/function limits after hosted approval.

Due maintenance schedules create durable task occurrences, unique by schedule/date. Approval is still required for disruptive work; queueing does not call a CMS. Repeated scheduler runs/restarts do not requeue a cancelled occurrence. Completing the task advances its schedule. Pause/edit schedules and monitoring in the existing screens/Automation settings. Blocked maintenance and overdue/missing backups produce deduped notices. Notification/provider retries retain their existing idempotency identifiers. No uncertain CMS execution claim is ever automatically released/retried.

## 8. Backup/recovery and local rehearsal

External website backups remain their provider's responsibility where no supported API exists. The Hub tracks schedules, retention/encryption expectations, provider/manual runs, failures, second-person recovery authorization and verification evidence; a successful listing/run is not proof of recoverability. Workflows that require a dashboard/provider operator are labelled manual, not simulated execution.

For the Hub database itself, `scripts/local-backup.mjs` supports **only local disposable PostgreSQL**:

- `HUB_LOCAL_DATABASE_URL`: operator-only local direct owner URL, no URL overrides.
- `HUB_LOCAL_RECOVERY_CONFIRM`: exact disposable database name.
- `HUB_LOCAL_SNAPSHOT_DIR`: private0700 directory outside checkout.
- `HUB_LOCAL_BACKUP_KEY`: separate base64-encoded32-byte key, securely supplied; never committed/logged.
- `HUB_PG_BIN_DIR`: optional PostgreSQL client binary directory (default `/usr/bin`).
- `HUB_LOCAL_RETENTION_DAYS`: optional pruning retention, default7.

From `hub/`: `node scripts/local-backup.mjs backup`; restore with `node scripts/local-backup.mjs restore <snapshot-id>` into a **different empty disposable DB**, with its name/URL confirmation changed; `... prune` applies authenticated retention and keeps at least the newest valid artifact. Production/customer restores are not supported by this rehearsal CLI. It pins the actual transport to loopback, preserves TLS/security checks elsewhere, streams plaintext archive bytes in memory to pg_restore, authenticates AES-256-GCM content/metadata, records a digest and appends a successful local-restore audit event after restoration. Files are0600; no persistent plaintext dump or secret key file is created. Corrupt/wrong-key archives and non-empty/remote targets are refused. Keep keys separately; loss of the key prevents restoration.

`pg-recovery.mjs` rehearses real pg_dump/encryption/restore into `hub_restore`, verifies matching counts, audit-chain integrity, preserved runtime grants/RLS and Alpha/Bravo read/write isolation. Roles exist separately in the disposable server; hosted restores require separately approved role/key provisioning, isolated target, backup storage, actual retention/RPO/RTO and managed-provider verification. A local rehearsal is not a hosted backup guarantee.

## 9. Customer onboarding and portal guide

1. Add the client organization and website in the existing staff UI. Select its rightful customer when creating the website; historical tenant transfer is prohibited.
2. In Customer requests, provision a portal customer using its approved verified OIDC email and **only the correct organization**. This creates/uses a constrained portal-only identity and assignment; it sends no email or grants provider privileges. Internal staff cannot be converted by this action.
3. A customer signs in through the same MFA-protected flow and is directed to Customer portal. It can view only assigned organizations, current website/monitoring/security/backup status, maintenance, monthly JSON reports and explicit shared history.
4. Customer requests stay local to the Hub service queue, separate from CRM tickets. Customers submit requests and review status; staff record customer-visible responses in Customer requests. Do not put internal credentials or notes in responses.
5. Operational contacts can be created/updated/retired in the portal. They do not create login identities or grant organization access. Access provisioning/revocation remains an administrator operation.
6. Use Staff assignments to revoke access; disabling the customer identity revokes all sessions. Do not promote a portal customer to an internal operator role. History sharing/unsharing is explicit and audited.

## 10. Administrator guide

Use least privilege: owner/admin global administration; assigned technicians for operations; billing/viewer for permitted reads; customer viewer identities restricted to portal. Keep provider admin, Hub owner, runtime SQL role and migration owner separate. Review client assignments and active sessions during offboarding.

Automation settings edits monitoring intervals/enabled state, backup expectations/retirement and service plans/retirement; old history is retained. Record rollback plans/outcomes/evidence from any maintenance task, including completed tasks; review them in Automation settings. Plan/outcome records do not execute a restore. Use connection controls for replacement, revocation and key rewrapping. Do not enable external operations without explicit customer/provider authorization and the independent operation approval.

## 11. Environment reference

`hub/.env.example` is the complete application variable template; `staging/neon-runtime.env.example` supplements the new dedicated Neon project. Required hosted bindings: `HUB_ENV`, HTTPS `HUB_BASE_URL`, `DATABASE_URL` with runtime-only credentials and verify-full, issuer/client/secret, `HUB_OIDC_REQUIRED_AMR=mfa`, trusted platform IP header, and independent staging database/identity pins. Supabase compatibility pin remains empty for Neon. All outbound/CMS/StackLTR/email/R2/credential flags default off; job secret stays empty. Credential KEKs are needed only after approved storage activation. No session-signing-key variable exists.

Local recovery variables above are **operator-only**, not Vercel runtime variables. Provider management keys and owner URLs never belong in the function environment. Values go through secure settings; no value is needed for current local development. Reusable cloud startup instructions should run existing checkout/dev server and tests, not create worktrees or hosted resources.

## 12. Testing and reproducibility

Node24: `npm ci`, `npm test`, `npm audit --omit=dev`, `npm run test:e2e`. Test fixtures use signed synthetic OIDC and mock HTTP CMS responses, not fake authorization middleware. Browser tests exercise real local HTTP/HTML, keyboard-safe forms, Alpha/Bravo customer isolation, report download, mobile layout and axe accessibility. All five connectors have contract fixtures. Network/transaction failures, execution claims, revocation races, role rejection, rotation, retention and tamper cases are covered.

Real disposable PostgreSQL17: create non-superuser `hub_owner` with CREATEROLE and empty databases `hub`/`hub_restore` owned by it; set local-only `HUB_PG_OWNER_URL`; run `pg-integration.mjs`, `pg-security.mjs`, `pg-frontend.mjs`, then `pg-recovery.mjs` in order. The restore script needs compatible pg_dump/pg_restore client binaries. CI executes this sequence and the official @vercel/node builder. Never point scripts at hosted databases.

Release certification pins the exact source/API/migration Git trees and unchanged dependency blobs, checks Node24/clean checkout/ancestry/public files and function-only routing. Official builder verifies zero static outputs and operator/secret/test exclusions. CI explicitly checks out the candidate SHA. Final test counts/run/certificate are in the PR/delivery report. Earlier historical reports are not current feature inventories.

## 13. Deployment preparation and rollback

Dedicated Vercel project, root `hub`, Node24, Other framework, `npm ci`, no marketing root/output, function `api/index.js`, no Git auto-deploy. Protect all immutable/alias/custom URLs before first Preview. Current public docs say Vercel Authentication All Deployments needs no paid add-on; actual team/host coverage and Jay's access still require verification. Deploy only an approved exact SHA/project ID with no production target, through the prepared validators/examples. No resources were created.

Staging Cloudflare zone `crumbyte.com`: CNAME `hub-preview`, DNS only, Auto TTL, **exact target obtained from verified Vercel project response**, plus any exact ownership TXT challenge separately approved. Future production `hub` needs its own explicit approval/project/domain validation; no target is assumed. Inspect CAA/rules/wildcards/records, verify trusted TLS/SAN/renewal and all-URL protection. No apex/www/mail/production changes. DNS rollback uses approved prior values/TTL; deployment rollback uses an approved compatible claim-aware build. Forward migrations/claims/revocation/audit history stay intact; no automatic down migration. A restore needs separate approval and isolated reconciliation.

Neon intended Free organization `org-winter-breeze-07874558` is owner-confirmed; quota/roles/plan/billing remain independently unverified. Prepare only NEW `crumbyte-hub-staging`, PostgreSQL17, direct owner/pooled runtime, TLS and backups. Free does not supply IP Allow or seven-day history; no security restriction or existing-org plan was changed. Do not upgrade the organization containing recovery. Any isolated paid placement/network/retention design needs explicit quote/approval. Current provider/cost details remain in [free-tier-staging.md](free-tier-staging.md).

## 14. Troubleshooting

-503 unconfigured: check required names, verified TLS, exact identity/database pins and disabled live flags; preflight logs no values. Never set dev mode on hosting.
-403 mutation: obtain a fresh session/CSRF token, same-origin form and authorized role. Customer internal routes are deliberately denied; use the portal.
-404 tenant record: check assignments and correct organization; never bypass RLS or expose whether a foreign record exists.
-OIDC login denied: verify nonce/state, issuer/audience/azp, actual MFA and verified email. ZITADEL must emit user info in the signed ID token. Do not weaken claims to fix a provider mismatch.
-Unknown monitoring/backup: enable only after authorized infrastructure; no sample data implies unknown, not healthy. Retired website/checks do not run. Check safe error/backoff and worker lease/deadline before retrying.
-Blocked task/uncertain mutation: review approvals and retained claim; reconcile provider outcome manually before any new authorized operation. Never clear a claim just to retry.
-Recovery failure: verify separate private key, authenticated archive, empty local target, compatible client binaries/roles and confirmation name. No destructive overwrite fallback exists.

## 15. Deferred activation and hosted acceptance

No credentials are requested during development. Remaining work is exactly the external activation boundary: securely bind authorized provider credentials; approve exact costs/resources; provision isolated DB/network/backups and identity client/MFA; approve/apply five hosted migrations and synthetic identities; configure Preview bindings/protection; approve exact-SHA deployment and exact DNS values; run real hosted tests; obtain final release approval.

Mandatory hosted evidence: real MFA/claims/session/revocation/callback failures; anonymous denial on every hostname; managed TLS/role/pooler/RLS including independent Alpha/Bravo customers; no source/static secret exposure; real scheduler lease/failure behavior under approved synthetic targets; authorized connector test sites and provider scopes/rates; actual backup storage/retention/restore with grants/isolation/audit/key recovery; inventory/maintenance/report/contact/request UX and accessibility; runtime usage/cost limits. Keep external customer operations disabled until separately authorized. `hosted-acceptance.md` and executable suites distinguish automated local simulations, approved hosted read-only checks and synthetic mutations. No production-ready claim is made before hosted acceptance.
