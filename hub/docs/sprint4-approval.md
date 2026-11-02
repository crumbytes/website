# Sprint 4: release candidate and hosted-staging approval package

Review date: 2026-11-01 (Pacific/Honolulu). Target: **https://hub-preview.crumbyte.com**. Future production `hub.crumbyte.com` is outside this authorization.

**Disposition:** local release preparation and testing are complete; provider configuration and hosted acceptance remain blocked on access, costs and explicit approvals. No project, deployment, subscription, hosted database, DNS record or live integration was created or changed. Do not interpret a locally consistent plan as an operational hosted environment.

## Authoritative candidate and dependencies

The final full SHA, integration PR URL, certificate and exact-head CI result are in the delivery report/PR. The new branch `codex/hub-release-candidate` descends directly from verified PR #5 and contains the complete application, security hardening and frontend. All changes in this sprint are release tooling, deployment-input exclusions, configuration examples, CI and documentation. Application code, migrations, dependencies and existing Hub function routing are unchanged from #5.

| PR | Head reviewed | Base | Observed GitHub state |
| --- | --- | --- | --- |
| #3 | `a4bf7a1f7340e7f9c2fdaafc6f70b8d6da668c6e` | PR #2 branch | Draft, MERGEABLE/CLEAN, successful check |
| #4 | `95689982ad899f10a4dc5d9dcbedb34f2cc154d4` | PR #3 branch | Draft, MERGEABLE/CLEAN, successful check |
| #5 | `cf90c7a5f811f5f9acce1f8af8fba59da56cbd5b` | PR #4 branch | Draft, MERGEABLE/CLEAN, successful check |

These observations apply to the recorded heads and intended bases, not a future merge. No merge was performed. Public main remains `a2ecbdbf4c75caa21cfbffe51b020e4742426601`. The only root Vercel edit adds the release branch to automatic-deployment suppression; public routing and existing branch settings are preserved.

CI now checks out `github.event.pull_request.head.sha` explicitly, with full history, instead of relying on a generated PR merge commit. `node scripts/certify-release.mjs` requires Node 24, a clean exact checkout, ancestry from #5, unchanged runtime/migrations/dependencies, unchanged public-site files/settings and function-only Hub routing. It prints the exact commit and tree. Its certificate deliberately says `hosted_verified: false`; tests and provider observations are separate evidence.

## Current verified capabilities and limits

Local results: **181 application/release tests passed**, **19 browser cases passed**, **seven contact cases passed**, SEO and production dependency audit passed (zero known vulnerabilities). All three PostgreSQL 17.11 integration scripts passed. Hosted acceptance remains unrun. Coverage includes the complete application/authentication/authorization/client-isolation/security suite; browser/accessibility/phone/tablet/desktop suite; real PostgreSQL 17 migrations/RLS/runtime roles, race handling and frontend data operations; marketing SEO/contact checks; dependency audit; official Vercel Node builder. Final counts and exact-head CI are in the delivery report. New release tests cover TLS, database query overrides, confidential identity, disabled jobs, OIDC protocol/endpoint compatibility and refusal of production/unpinned deployment requests.

Runtime security from #4 remains: mandatory hosted MFA claim verification, issuer/audience/signature/state/nonce/azp validation, secure server sessions and CSRF, permanent revocation on disablement, login-row locking, per-client authorization/RLS, runtime-role rejection, durable execution claims and append-only audit. All six integrations remain off in staging. No customer or StackLTR production/staging system was accessed.

The official function-only build has zero static outputs. `scripts/verify-serverless-build.mjs` applies the Hub exclusion rules in a temporary copy and rejects marketing, operator/test and local-secret files in the Lambda; it never creates or deploys a provider project. Root marketing deployment excludes `hub/`. New `hub/.vercelignore` excludes `.env*`, local Vercel metadata, development data, docs, tests and operator scripts from Hub upload inputs; `hub/.gitignore` now excludes `.vercel/` and its pulled environment files. Private source necessarily exists inside the function bundle but is not a static asset or download route. Hosted source denial still must be tested.

## Access inspection and external blockers

The environment reports no provider capabilities, secret bindings, runtime variables or outbound identity aliases. Only the existing GitHub binding name was present in the process. No Vercel/Auth0 CLI, authenticated CLI profile, linked `.vercel/project.json`, or Vercel/Cloudflare/Auth0 connector is available. Credential values/files were not read or printed. GitHub read/PR access works; it does not imply access to other providers.

Consequently the existing Vercel projects/plan, Cloudflare zone settings, IdP tenant entitlement and database provider cannot be authenticated or modified. Historical project/team names (`crumbyte-site`, `crum-byte`) are unverified account references. Obtain scoped read-only provider access first through approved secure settings/integrations; never paste secret values into chat. Installation or login to a new account would not establish authorization to create resources.

Public read-only DNS currently reports Cloudflare NS `harvey.ns.cloudflare.com` and `paislee.ns.cloudflare.com`; apex CAA query has no answer; preview A and CNAME return NXDOMAIN. This is a resolver observation, not authoritative account inventory or proof that no wildcard/zone rule exists.

## Prepared Vercel configuration

`staging/release-policy.json` records desired policy, not applied state. `staging/vercel-project-patch.example.json` is an API-shaped settings example. Its keys were checked against the public Vercel OpenAPI schema: PATCH `/v9/projects/{idOrName}` supports Node `24.x`, root `hub`, framework `null` (Other), install `npm ci`, null build/output overrides, source outside root disabled, directory listing disabled, automatic custom-domain assignment disabled and `ssoProtection.deploymentType=all`.

Require a separate **crumbyte-hub-staging** project in the approved team; no reuse of the public project. Repository is `crumbytes/website` (GitHub repository ID **1432611751**, read from GitHub). Git auto-deployment is disabled by checked-in `hub/vercel.json`. No cron or build-time migration is configured. Every request goes to `api/index.js` on Node 24; only that function is built.

Require authenticated protection on **all** deployment URLs, including the custom hostname, branch aliases and immutable Vercel URLs. The API enum also offers `all_except_custom_domains`; it does not meet this requirement and must not be used as a fallback. Verify plan entitlement and settings by read-back and fresh-browser tests. Application OIDC/MFA is still mandatory after Vercel protection. Do not use bypass tokens or expose a first unprotected deployment while setting up protection. The deprecated `publicSource` API field is ignored by Vercel and is not a security control.

The public API schema confirms POST `/v13/deployments` defaults to **Preview when target is omitted**. The example `staging/vercel-deployment-request.example.json` intentionally omits target, pins the repository/branch/full SHA, sets `withLatestCommit=false`, and requires an approved staging project ID. `check-deployment-request.mjs` refuses production/staging target overrides, other projects/repositories/branches, stale SHA or moving-latest resolution. It never sends a provider request and cannot grant approval.

## Runtime variables and secrets

Preview scope only. Do not inherit public-site or StackLTR credentials. No owner connection, migration tool secret, CMS key, job secret or production identity belongs in the runtime environment.

| Name | Required value or secure source |
| --- | --- |
| `HUB_ENV` | `staging` |
| `HUB_BASE_URL` | `https://hub-preview.crumbyte.com` |
| `DATABASE_URL` | Secret; dedicated `hub_runtime` login on the isolated staging DB, password and `sslmode=verify-full` |
| `HUB_STAGING_DATABASE_HOST`, `HUB_STAGING_DATABASE_NAME` | Independently reviewed endpoint/database pins |
| `HUB_OIDC_ISSUER`, `HUB_OIDC_CLIENT_ID` | Separate approved staging identity |
| `HUB_STAGING_OIDC_ISSUER`, `HUB_STAGING_OIDC_CLIENT_ID` | Independently reviewed matching staging pins |
| `HUB_OIDC_CLIENT_SECRET` | Separate confidential web-client secret, secure Preview binding |
| `HUB_OIDC_REQUIRED_AMR` | `mfa` after real provider claim verification |
| `HUB_TRUSTED_IP_HEADER` | `x-vercel-forwarded-for`, verify platform ownership |
| `HUB_LOG_LEVEL` | `info` |
| `HUB_OUTBOUND_ENABLED`, `HUB_OPERATIONS_ENABLED`, `HUB_CREDENTIAL_STORAGE_ENABLED`, `HUB_STACKLTR_ENABLED`, `HUB_EMAIL_ENABLED`, `HUB_R2_ENABLED` | All `false` |
| Job, encryption/KEK, CMS, StackLTR, Resend and R2 values | Unset; features remain disabled |

`node scripts/preflight-staging.mjs` validates securely injected configuration without opening a connection or logging values. It additionally requires the exact origin/Preview scope, confidential client secret, `mfa`, one `sslmode=verify-full`, dedicated runtime authentication, no owner URL, no disabled TLS verification, no unreviewed URL query overrides and no job secret. Existing `npm run preflight` remains useful for runtime config consistency. Passing either is not proof of provider identity, TLS handshake, protection or real MFA.

## Isolated PostgreSQL 17 plan

Use a dedicated project/cluster separate from **both** StackLTR production and staging. Hub roles are cluster-wide; a second database on the StackLTR cluster does not provide the required role isolation. Confirm provider support for non-superuser CREATEROLE and membership/SET ROLE before selection. Runtime is `hub_runtime`, NOINHERIT, no ownership/superuser/BYPASSRLS/CREATEROLE/CREATEDB. Migration owner is a separate, non-superuser identity; store it only in the operator secret manager, never Vercel runtime. Keep auth/app/worker roles nonprivileged and RLS on every Hub table.

Use verified TLS with server-name checking and public or approved CA trust. Never disable certificate verification. Restrict provider ingress to approved Vercel egress and a time-limited operator source; if the selected serverless plan has no stable egress, obtain an approved fixed-egress/private-network design and quote. A publicly reachable DB plus a password is not evidence of the requested network restriction. The task's outbound network policy is unrelated to database-provider inbound controls.

Migrations, unchanged: 0001 foundation → 0002 access control → 0003 full Hub → 0004 execution/revocation. Each file is transactional and checksummed; history edits fail. Only one operator/runner may migrate at a time. After explicit hosted-migration approval, inject the separate owner URL as `DATABASE_URL` in a short-lived operator process and set `HUB_MIGRATE_CONFIRM_HOST` to the reviewed host, then run `npm run migrate` from `hub/`. The confirmation variable is an interlock, not permission itself. Enable runtime LOGIN/password out of band, inject runtime-only URL in Preview, and provision the first synthetic owner through `scripts/provision-owner.mjs` under the separate approved owner connection.

Before migration, take a provider snapshot and approve backup retention (proposed minimum seven days), encrypted storage, access roles and budget. Rehearse restoration into another isolated project, verify checksums/RLS/grants/audit and document recovery time/data loss. The provider restore procedure and credentials must be verified on the selected account before acceptance; no hosted restore was performed. Backup-run records in the Hub are not a backup of the Hub database.

## Dedicated OIDC/Auth0 plan

Use a separate staging Auth0 Regular Web Application (or an existing licensed equivalent with verified compatibility), authorization code + S256 PKCE, RS256/ES256/PS256 and `client_secret_post` for the current implementation. Exact callback: **https://hub-preview.crumbyte.com/auth/callback**; no wildcard. Exact app origin is the same hostname; if a logout allowlist is required, use `/login`. Current logout revokes the Hub session, not the upstream SSO session; do not claim federated logout.

A named tenant administrator must configure allowed staff, enable an approved factor (prefer TOTP or WebAuthn/security key with recovery codes) and then enforce MFA for this client. Factor enablement alone is insufficient. Verify the signed ID token reports `amr: ["mfa", ...]`; do not remove the requirement to work around a provider mismatch. Never reuse production StackLTR authentication credentials. The Hub first owner and the identity-provider tenant administrator are separate responsibilities.

`staging/validate.js` can check approved discovery metadata for exact HTTPS issuer, same-origin endpoints, code, S256, supported signature and token auth method. It deliberately cannot verify tenant policy, client registration or real MFA. If metadata omits a capability, obtain official provider evidence and a real-flow test before changing the validator. Provider plan/factor entitlement, administrator setup, positive/negative MFA flows, expiry/revocation, callback validation and provider/Hub event logs remain hosted gates. Local signed-token/race tests passed; no real tenant was created or tested.

## DNS, domain association and TLS

Proposed Cloudflare zone `crumbyte.com`: CNAME **hub-preview**, DNS only, Auto TTL. **Exact target remains unknown** until the approved Vercel project/domain association returns its project-specific destination. Never substitute a guessed generic target. Record any exact ownership TXT challenge returned by Vercel separately. Review existing A/AAAA/CNAME/wildcard/CAA/zone rules through authenticated access; leave apex, www, mail and future production hub unchanged.

Before any DNS write, verify the intended project ID, approved deployment SHA, protection on its Vercel URLs, plan coverage of the custom hostname, and the domain association/verification response. DNS changes need separate approval of the exact record values. Afterwards verify a trusted certificate with `hub-preview.crumbyte.com` in SANs, the full chain, expiration/renewal, effective CAA and protected behavior on every hostname. Current resolver NXDOMAIN and no CAA answer are not proof that those settings are ready.

## Reproducible operator sequence after approval

1. Obtain read-only account visibility. Populate `staging/observations.example.json` with dated, non-secret evidence and named reviewer; nulls remain unknown. Inspect existing infrastructure/license capacity before proposing incremental charges.
2. Present exact vendor quotes, network/protection design, monthly cap and resource identities. Obtain permissions and cost approval before creating even the empty project or database.
3. After approval, create the empty Vercel project without a deployment or initial Git import. API POST `/v11/projects` supports name/root/framework/install and `ssoProtection: {deploymentType:"all"}` at creation; do not include Git source at this step. Read back protection; unsupported entitlement is a blocker, not a reason to weaken it.
4. Apply/review `vercel-project-patch.example.json` with approved IDs/team scope through PATCH `/v9/projects/{idOrName}`. Read back every required field. Connect the approved repository only after root/protection and checked-in Git-deployment suppression are confirmed. Do not alter the public project.
5. Prepare the approved isolated DB, network controls, backups and identity client. Obtain hosted migration approval, execute the procedure above, and securely configure Preview variables. Validate config and actual runtime-role/TLS/provider reachability. Never pull or print secret values into logs.
6. Use a full-history checkout and refresh `origin/main`; on the exact clean release checkout run `node scripts/certify-release.mjs`, `npm test`, all documented PostgreSQL checks on a **local disposable** DB, browser/public checks and the official build verification. The pipeline performs these checks on the exact head, including the official builder with @vercel/node 29.0.1 and build-utils 15.2.1 installed outside the application checkout.
7. Fill the deployment request example with the exact approved `prj_...` ID and full SHA. In `hub/`, `HUB_APPROVED_PROJECT_ID` and `HUB_APPROVED_RELEASE_SHA` must match the approval/checkout, then run `node scripts/check-deployment-request.mjs /tmp/reviewed-deployment-request.json`. These public guard inputs do not authorize a deployment.
8. Only after explicit protected-Preview deployment approval, an authorized operator submits the reviewed request via authenticated POST `/v13/deployments` in the approved team. No `target` field. The request uses Git source plus root `hub`, avoiding a CLI upload from the marketing root or an accidental `hub/hub` working directory. Verify the resulting deployment's resolved SHA and project before assigning any hostname.
9. Test platform protection on every Vercel URL without bypass tokens. Approve domain association and the exact DNS/TXT values, then obtain the separate DNS-write approval. No first unprotected application is permitted.
10. Verify TLS/domain protection and execute [hosted acceptance](hosted-acceptance.md), recording the exact deployed SHA, real MFA, identities and passed/failed/skipped results. Default hosted cases are read-only; synthetic mutations need the separate existing approval gate. Never use live customer records/sites.

No mutation command in this procedure was executed against a provider. Example JSON is review material, not an auto-apply script.

## Hosted acceptance coverage and rollback

The prepared suite covers platform/app denial, two independent client assignments, internal file paths, session revocation, inventory create/edit/archive, schedules, approvals, findings, backup/restore records, errors, headers, responsiveness and accessibility. Real staff complete MFA before supplying short-lived protected state; imported sessions are not proof that MFA challenged. Repeat protection checks on every alias/immutable URL, not only the custom hostname. Do not use a protection bypass token or weaken MFA to run tests. Hosted cases have not run because the destination/resources are unapproved and unavailable.

Rollback uses a previously approved **claim-aware** compatible build with every integration off. Do not remove execution claims, revocation triggers or migration history; there is no automatic down migration. Keep network access/protection in force while investigating. A DB restore needs separate approval and reconciliation of sessions/claims/audit against external outcomes; never auto-retry an uncertain CMS operation. If a domain is misrouted, disable access/protection/deployment through the approved provider procedure; DNS rollback changes require authorization too. No Sprint 4 schema or application change needs a new migration.

## Recurring cost model and approval request

These public prices are reference inputs, not account quotes, entitlements or an approved budget. Current billing, existing licenses, seats and usage were not inspected.

| Component | Staging estimate / unresolved quote |
| --- | --- |
| Vercel hosting | Public Pro starts **$20/month**. Incremental cost may be lower on an already licensed approved team, but no existing capacity is assumed. Additional seats/usage/tax are extra |
| Authentication | **A = verified MFA-capable provider quote, unresolved.** Existing licensed identity could reduce incremental cost only after entitlement/compatibility verification. Auth0 public page did not expose a reliable complete price for this specific configuration |
| PostgreSQL | Planning **$0–25/month** for small synthetic staging, subject to provider roles/network/backup compatibility. Public Neon reference rates: $0.106/CU-hour and $0.35/GB-month |
| Database backup history | Public Neon reference **$0.20/GB-month of retained changes**. One GB of history is $0.20/month in the illustrative DB estimate, not a guaranteed seven-day backup/restore entitlement. Additional snapshots/restore compute/egress may cost more |
| Restricted DB networking | **N = required network quote.** If fixed Vercel egress is necessary, the public pricing page lists shared-pool Static IPs at **$100/project/month**. Private connectivity/other architectures need their own quote. Network restriction is not optional merely because this increases cost |
| Deployment protection | **P = confirmed entitlement/add-on quote.** Public custom password protection is **$20/project/month** if selected; do not buy it if an approved existing authentication option already protects all URLs. The needed all-domain protection entitlement remains unverified |
| Monitoring and scheduled functions | Disabled: no new scheduler/probe/email/R2 subscription or job execution is provisioned. UI requests remain subject to normal Vercel function usage; later monitoring/jobs need a separate cost and authorization review |
| Storage/other security | No separate backup object store, WAF premium, log drain, SMS MFA, customer CMS or StackLTR plan was provisioned. Add any chosen feature's quote before approval; existing execution/CI charges are not estimated here |

Illustration, **not a cap or quote**: 0.25 CU continuously for 730 hours plus 1 GB data and 1 GB history gives `(0.25 × 730 × $0.106) + $0.35 + $0.20 ≈ $19.90/month`, before provider extras. Base hosting/DB planning allowance is **$20–45/month**. Total is **$20–45 + A + N + P + additional seats/usage/taxes**. If the $100 fixed-egress option is required, that becomes **$120–145 + A + P**; adding the optional $20 password feature would make **$140–165 + A**, still before usage/tax. This avoids quoting an unsecured cheap configuration as satisfying network/protection requirements.

A final approved monthly total cannot be given until A/N/P, seats, backup retention and current account entitlements are quoted. No paid infrastructure/subscription was created. Prefer approved existing CrumByte capacity where it meets isolation and protection; never reuse StackLTR databases/credentials to lower the estimate.

## Precise decisions still needed

- **Access:** approve/provide scoped read-only Vercel team/project, Cloudflare zone, identity and candidate DB-provider visibility through secure integrations/settings.
- **Cost/design:** approve the named team, isolated DB/project, MFA plan/factors, backup retention, restricted-network and all-URL protection design, vendor quotes, monthly cap and spending alerts. This is required before resource creation.
- **Provisioning:** authorize creation/configuration of the specifically reviewed empty staging project, dedicated identity client/admin and isolated database/network/backups. No production resources or customer connections.
- **Migration:** separately authorize the reviewed owner/host and four migrations plus synthetic owner provisioning; owner credentials must never be runtime credentials.
- **Deployment:** separately authorize exactly the certified full SHA as a protected Preview in the approved project/team; no production target or unprotected first deployment.
- **DNS:** after destination verification, approve the exact CNAME/TXT values returned by Vercel; do not approve a guessed target.
- **Acceptance:** authorize the named synthetic accounts/fixtures and any hosted mutation tests after MFA/protection/TLS are verified.

Remaining risks/limits: no authenticated provider inspection or live TLS/MFA/network/backup proof; IdP/protection/network quote unresolved; no hosted acceptance, independent penetration test or manual screen-reader certification; same-database audit does not withstand owner compromise; at-most-once dispatch is not an exactly-once upstream guarantee; migration runner needs a single operator. Existing security controls remain in place. These are explicit external gates, not silently passed checks.
