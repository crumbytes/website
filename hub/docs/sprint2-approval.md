# Sprint 2 deployment approval packet

Review date: 2026-11-01 (Pacific/Honolulu). Draft PR: https://github.com/crumbytes/website/pull/4. Base: `feat/website-hub-foundation-20261101` (PR #3). Head branch: `codex/hub-staging-review`. This packet supersedes the open execution/session findings in the first [staging review](staging-readiness.md).

**Decision: locally validated candidate; hosted deployment is not approved or verified.** No public-site content, main, hosted database, DNS, paid resource, customer website, real customer credential or production StackLTR record was changed in Sprint 2. No Hub deployment was made.

## Candidate and evidence

The sprint starts at `8cd4ea66f6fd852d47558ee52387db476f3605f8`. PR #3 remains `a4bf7a1f7340e7f9c2fdaafc6f70b8d6da668c6e`. GitHub confirmed PR #3's Website Hub check succeeded on that commit (run `41304789288`). The opening PR #4 check succeeded on the pre-Sprint-2 head (run `41378057933`); that result must not be confused with checks on the new head.

The security implementation commit is `f5c882d5145b74874fc550ee6b508da2618a3d19`; its exact-commit CI run [41379305514](https://github.com/crumbytes/website/actions/runs/41379305514) passed. The exact final candidate, including documentation updates, is the full SHA shown in PR #4 and the delivery report. Obtain it with `git rev-parse HEAD`; approval must record the full SHA, not a branch name. Later documentation revisions must not silently change the deployed candidate.

Local validation:

- Baseline: 161 Hub tests passed before Sprint 2.
- Updated Node suite: 167 tests, no failures or skips. Includes duplicate dispatch, eight concurrent retries while an upstream call is paused, uncertain connection failure, simulated crash, permanent multi-session revocation staging pin/feature-flag checks, and completion-write failure without redispatch.
- Expanded browser suite: 16 cases covering inventory, editing/archiving, maintenance and second-person approval, findings, backups, two-client isolation, failures, responsive layouts, keyboard access, accessibility and security headers. Final run evidence is attached to the handoff; no hosted result is implied.
- PostgreSQL 17.11: fresh non-superuser migration owner; all four migrations in order and idempotently; real `pg` pool, two-client RLS, transaction-local isolation, rollback, audit append-only, credential column grants, eight concurrent execution losers, permanent revocation, login/disable lock race, runtime owner rejection, and denial when a technician tries `row_security=off`.
- Contact handler: seven tests passed without sending email. SEO: 12 public and two noindex pages passed. Lockfile and dependency declarations unchanged; production audit has zero known vulnerabilities.
- Official local `@vercel/node@29.0.1` build: one `nodejs24.x` Lambda, `api/index.js`, 394 bundled files, zero static outputs. It used a temporary source copy and `npm ci`; no Vercel deployment/project was created. An unconfigured handler fails closed.
- Hosted acceptance discovery/configuration is checked locally. Hosted tests, actual IdP MFA, TLS issuance, Vercel protection and hosted migrations have **not** run.

Machine-local evidence: `/tmp/hub-sprint2-baseline.log`, `/tmp/hub-sprint2-tests-final.log`, `/tmp/hub-sprint2-browser-complete.log`, `/tmp/hub-sprint2-build.log`, `/tmp/hub-sprint2-build-summary.json`. CI runs both `scripts/pg-integration.mjs` and `scripts/pg-security.mjs` as well as Node/browser/SEO/contact/audit checks. Verify its exact head SHA before release.

## Completed security changes

`0004_execution_and_revocation.sql` adds a one-row-per-operation execution claim with a unique claim token. The executor locks the approval row, commits the claim plus audit entry, then contacts the adapter. Concurrent requests and later retries receive 409. Claims have no app UPDATE/DELETE privilege and remain after failure/crash. Completion checks both claim ownership and approved status in the history/audit transaction. A second-person decision is also serialized. The UI receives `executing` for a claimed, unfinished request.

This is **at most one adapter dispatch per approved request**, not an exactly-once guarantee from external CMS systems. No CMS request was sent in tests. A crash before dispatch may leave work unperformed; a timeout or completion-write failure may leave its external outcome unknown. Never delete a claim or retry the original request. Reconcile it manually using independent evidence; any replacement request requires a separately reviewed approval. Do not enable live operations as part of this deployment approval.

A database trigger revokes every active session when staff transition to disabled, including direct administrative SQL updates; migration backfills previously disabled accounts. Session creation locks the staff row through binding and insertion, serializing it with disablement. The real PostgreSQL race test verifies the login blocks, then fails as disabled. Re-enabling permits a fresh login and never restores revoked tokens. Existing logout/expiry/CSRF/audit behavior is preserved. Already executing requests cannot be retroactively cancelled by revoking a session.

Runtime connections reject any role other than `hub_runtime`, database/object ownership, owner membership, superuser/BYPASSRLS/CREATEROLE/CREATEDB privileges and unsafe attributes on Hub worker/app/auth roles. These checks run once per new pooled connection; operational privilege drift still requires monitoring. RLS isolates ordinary staff, but the server remains trusted: arbitrary server execution can assume auth/worker roles. Do not use owner credentials in runtime or expose arbitrary SQL.

Staging requires approved database-host/name and issuer/client-ID pins independently of connection/client values. It rejects mismatches, a non-runtime DB username, the production Hub origin and **every** live-integration flag. This catches accidental copied bindings; it cannot determine whether a human incorrectly labels a production resource as staging. Separate provider projects, scoped secrets and review remain mandatory.

## Proposed Vercel project

| Setting | Requirement |
| --- | --- |
| Team | Verify authorized commercial team; prior docs name `crum-byte`, not reverified through account API |
| New project | `crumbyte-hub-staging` |
| Repository / root | `crumbytes/website` / `hub` |
| Framework / runtime | Other / Node 24 |
| Install | `npm ci` |
| Build | Checked-in functions-only `hub/vercel.json`; no static output directory override |
| Entry / routing | `api/index.js`; every request goes to the function |
| Deployment | Preview only, exact approved SHA |
| Production | No production deployment; Git auto-deployment remains disabled; staging runtime rejects `VERCEL_ENV=production` |
| Host | `hub-preview.crumbyte.com`, after approved protected Preview association |
| Protection | Vercel Deployment Protection plus mandatory application OIDC/MFA, covering custom domain, preview aliases and immutable deployment URLs |
| Migrations | Never run during install/build/startup on Vercel |

No Vercel credential, linked project or connector is available in this session. Existing project settings, plan coverage and target domain association cannot be authenticated or changed. Obtain read-only access first. Do not reuse or change the public project's root/domain. Repository routing/build checks do not establish hosted protection coverage.

## Required staging variables and secure values

Preview scope only; no shared production bindings. Environment values containing credentials must be entered securely in the deployment provider, never chat, Git, browser JS, command logs or this packet.

| Variable | Value / source |
| --- | --- |
| `HUB_ENV` | `staging` |
| `HUB_BASE_URL` | `https://hub-preview.crumbyte.com` |
| `DATABASE_URL` | Secret; dedicated PostgreSQL cluster/project, `hub_runtime`, verified TLS |
| `HUB_STAGING_DATABASE_HOST`, `HUB_STAGING_DATABASE_NAME` | Independently reviewed staging endpoint/database, matching the URL exactly |
| `HUB_OIDC_ISSUER`, `HUB_OIDC_CLIENT_ID` | Dedicated staging issuer/client |
| `HUB_STAGING_OIDC_ISSUER`, `HUB_STAGING_OIDC_CLIENT_ID` | Independently reviewed identity pins, matching exactly |
| `HUB_OIDC_CLIENT_SECRET` | Separate confidential web-client secret; current implementation uses `client_secret_post` |
| `HUB_OIDC_REQUIRED_AMR` | `mfa`; verified ID token must report it |
| `HUB_TRUSTED_IP_HEADER` | `x-vercel-forwarded-for`, after platform verification |
| `HUB_LOG_LEVEL` | `info` |
| `HUB_OUTBOUND_ENABLED`, `HUB_OPERATIONS_ENABLED`, `HUB_CREDENTIAL_STORAGE_ENABLED`, `HUB_STACKLTR_ENABLED`, `HUB_EMAIL_ENABLED`, `HUB_R2_ENABLED` | All `false`; staging refuses true |
| Job/CMS/KEK/StackLTR/Resend/R2 secrets | Unset; no integration credentials needed |

Run `npm run preflight` with approved secure injections, then validate real DB-role safety and provider reachability. Syntax/configuration success does not establish live service readiness.

## Authentication plan

Recommend a dedicated Auth0 staging Regular Web Application with Universal Login, authorization code + S256 PKCE, RS256, restricted provisioned staff and provider-enforced MFA. Verify current plan entitlement before creation; prefer WebAuthn/security keys or TOTP with recovery codes. An existing equivalent OIDC service is possible if its issuer, AMR contract, token endpoint authentication and MFA policy match. No identity tenant or administrator account was created or modified.

Exact callback: `https://hub-preview.crumbyte.com/auth/callback`. No wildcard callbacks. Login/application origin: `https://hub-preview.crumbyte.com`. If a provider logout allowlist is required, `https://hub-preview.crumbyte.com/login`; the current app logs out its local session rather than terminating the upstream SSO session. Do not represent local logout as federated logout. A later production client has its own callback and secret.

A named staging administrator must enroll MFA and provision synthetic staff before testing. Verify successful MFA, denied missing-MFA/unprovisioned/disabled accounts, issuer/audience/signature/azp/nonce/state enforcement, callback exactness, CSRF, session expiry, revocation and audit entries. Unit tests verify the protocol with signed synthetic tokens; real MFA remains a hosted release gate.

## Database migration / recovery plan

Provisioning and hosted migration approval are separate prerequisites. Use an isolated PostgreSQL 17 cluster/project, not StackLTR production and not a database sharing existing Hub global role names. Confirm CREATEROLE and SET ROLE support; use a non-superuser migration owner, securely generated runtime password and verified TLS. Never grant owner memberships or BYPASSRLS to runtime/app/auth/worker roles.

Apply `0001_foundation.sql`, `0002_access_control.sql`, `0003_full_hub.sql`, then additive `0004_execution_and_revocation.sql`. Earlier files/checksums remain unchanged. With explicit host approval, a named operator sets the separate owner connection plus `HUB_MIGRATE_CONFIRM_HOST=<exact approved host>` and runs `npm run migrate`. No concurrent migration runners. Enable LOGIN/password for `hub_runtime` out of band. Provision the first owner with the separate approved owner connection and `scripts/provision-owner.mjs`; runtime receives only `hub_runtime` credentials. The local developer runner applies all pending migrations idempotently to retained PGlite data; that behavior does not run on Vercel.

Take a backup first, rehearse restoration into a separate isolated cluster, and verify role grants/RLS/checksums/audit/session revocation there. There is no automatic down migration. Keep claims and revocation records intact. Roll back to a compatible claim-aware build; do not roll back to an executor that ignores claims. If emergency rollback predates these fixes, keep all external operations disabled and block access pending review. Restore from backup only after explicit approval and reconciliation of session and operation state.

## Cloudflare DNS / TLS

Read-only Cloudflare DNS-over-HTTPS observations: nameservers `harvey.ns.cloudflare.com` and `paislee.ns.cloudflare.com`; apex A `76.76.21.21`; `hub-preview.crumbyte.com` CNAME and A return NXDOMAIN. These are public resolver observations, not an authenticated zone inventory. No Cloudflare credential/connector is available; unpublished records, account rules, CAA and wildcard/conflict state still require account inspection.

Proposed record: zone `crumbyte.com`, **CNAME** name **`hub-preview`**, DNS only, Auto TTL. Target must be copied from Vercel's approved `crumbyte-hub-staging` domain association. **The exact project-specific target is not yet known.** Do not substitute a guessed generic target. Record any Vercel-required ownership TXT challenge separately. Leave apex/www/mail and future `hub.crumbyte.com` unchanged.

After protected deployment approval and before DNS approval, inspect the returned domain target, conflicts, zone CAA and verification requirements. Following DNS approval, verify Vercel provisions a valid HTTPS certificate with `hub-preview.crumbyte.com` in SANs, trusted chain and automatic renewal. Test protection on this hostname and every alternate Vercel URL; a valid TLS certificate alone is not authorization.

## Hosted acceptance and approvals

Use [hosted acceptance instructions](hosted-acceptance.md). Default hosted tests are read-only and require the exact hostname approval. A separate explicit mutations gate is needed to reuse the browser workflow against synthetic staged records. Test state files contain live session credentials and must remain protected under `/tmp`, never committed or logged.

Remaining external blockers: read-only Vercel/Cloudflare account access; approved provider plans/monthly cap; isolated database/role setup approval; staging IdP/admin/MFA setup; secure values; hosted migration approval; protected Preview deployment approval; exact DNS target/verification details; DNS change approval; hosted acceptance at the approved SHA. The code and configuration templates do not substitute for these steps.

No paid infrastructure or new vendor subscription was created. Existing cloud execution and CI usage remain subject to the current plans; their charges were not inspected. Expected hosted costs depend on the commercial Vercel plan and protection/custom Preview domain coverage, Auth0 MFA/active staff entitlement, and PostgreSQL compute/storage/pooling/backups. Cloudflare DNS may be covered by the existing zone plan. Obtain current quotes and a spending cap before provisioning; no paid plan or cost estimate is silently approved.

Next actions, in order: review draft PR/checks and exact SHA; obtain account visibility; approve provider configuration and budget; prepare identity/DB and approve migrations; approve Preview deployment; verify access protection on Vercel URLs; approve exact DNS changes; validate TLS and run hosted acceptance with synthetic data. Main, production hosting and all live CMS operations remain untouched.
