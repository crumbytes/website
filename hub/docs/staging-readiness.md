# Protected staging readiness review

Review date: 2026-11-01 (Pacific/Honolulu). No deployment, hosted database change, DNS write, paid resource, real customer credential or production StackLTR connection was performed.

## Decision

The local integration candidate passes its automated checks. **Hosted staging is not approved or verified.** Keep it synthetic-only, protected by both Vercel Deployment Protection and application OIDC/MFA. Do not merge into main or deploy production. Preserve the existing Hub; client account records scope website operations and are not a second CRM. Contacts, tickets and invoices remain in StackLTR, which stays disconnected.

## Commit and PR evidence

- PR #2 head reviewed: `0ff480ec8f31b7923fb201b874b708ee3294f73a` (branch `feat/client-website-management-hub-20261101`). It is a standalone HTML/navigation prototype with no authentication or backend. No client records were found. `noindex` does not protect access.
- PR #3 head reviewed and tested before changes: `a4bf7a1f7340e7f9c2fdaafc6f70b8d6da668c6e` (branch `feat/website-hub-foundation-20261101`). It includes PR #2's unchanged prototype and the Hono/PostgreSQL Hub implementation.
- Fix implementation commit: `ed4756b` (resolve with `git rev-parse ed4756b^{commit}`). The documentation commit following it changes only review documentation. Record the full final branch HEAD from Git before any staging approval.
- Fix branch: `codex/hub-staging-review`. Intended draft PR base is PR #3's branch, not main, so the review isolates these fixes. Neither main nor either implementation PR branch was changed locally.
- Native Git access works. GitHub REST and GraphQL requests were denied at the proxy CONNECT layer for `api.github.com`; hosted CI/check status, PR discussions, and draft PR creation could not be read or confirmed. The original implementation's claimed checks are not substituted for this review's local runs.

## Verified results

| Check | Original PR #3 | Fixed candidate |
| --- | --- | --- |
| Node Hub suite | 157 passed, zero failed/skipped | 161 passed, zero failed/skipped |
| Browser suite | 13 passed | 13 passed |
| Accessibility | Included in browser suite; no serious/critical violations on selected WCAG A/AA pages | Same; axe requires bypassCSP in its dedicated context only |
| Phone/tablet/desktop and keyboard | Passed | Passed |
| Contact handler | 7 passed; delivery mocked, no emails sent | 7 passed |
| SEO | Failed on `website-management.html` | Passed: 12 public, 2 noindex pages, sitemap, metadata, JSON-LD, links and images |
| Production dependency audit | Zero known vulnerabilities | Dependency declarations and lockfile unchanged |
| PostgreSQL 17.11 | All 3 unchanged migrations and real-pool integration passed | Same checks passed in a second fresh database |
| Serverless build | Not run for original configuration | Official `@vercel/node` 29.0.1: one Lambda, `api/index.js`, `nodejs24.x`, 393 bundled files, zero static outputs |
| Unconfigured handler | Not separately checked | 503, `no-store`, plain generic error, no client data |

Tests used Node 24.19.0, Python 3.12.14, Chromium 154.0.8037.57 and a disposable Docker PostgreSQL 17.11. Browser tests used the installed `/usr/bin/chromium` through a temporary config importing the checked-in config; application tests were unchanged. They exercise a fake local OIDC provider, not Auth0 or Vercel. Local artifacts are in `/tmp/hub-candidate-tests.log`, `/tmp/hub-candidate-browser.log`, `/tmp/hub-candidate-audit.json`, `/tmp/hub-fixed-tests.log`, `/tmp/hub-fixed-browser.log`, and `/tmp/hub-vercel-build-summary.json`. These machine-local logs are not a hosted CI result.

Two synthetic clients and separately assigned technicians are exercised in API/RLS tests. Browser tests create two clients, assign a technician to A, and deny B's records by direct URL and API. This is a staff-only Hub; these are not customer-login accounts. Owners/admins intentionally see all clients. Maintenance creation, work logs, completion, inventory, backups, invalid input, CSRF, disabled accounts, expiry, logout, outages, connection failures, SSRF guards and disabled external operations are covered. Automated tests are not an independent penetration test.

## Security findings and fixes

| Severity | Finding | Resolution |
| --- | --- | --- |
| High | Root prototype was publicly deployable, unauthenticated, and caused the SEO failure | Preserved byte-for-byte at `hub/docs/original-dashboard.html`, under the excluded internal tree. Public pages and sitemap unchanged. |
| High | Hub project had only rewrites, leaving no explicit function-only build boundary for source, migrations and docs | Functions-only `builds` plus a catch-all route. Official local build contains no static outputs. All source-like routes are denied anonymously and return 404 when authenticated in router tests. Hosted origin verification remains required. |
| High | Hosted preview could use development/test configuration | Development/test config now rejects any Vercel environment marker, as well as production Node mode. Local stub already refuses hosted startup. |
| High | MFA claim enforcement was optional outside local development | Hosted config requires `HUB_OIDC_REQUIRED_AMR`; verified ID tokens must include it before a session opens. IdP must separately require MFA. |
| Medium | Client ID was validated after the error check, so omission did not fail startup | Required client ID now validates before returning config. |
| Medium | Base URL accepted credentials/path/query/fragment; issuer used only a string prefix check | Strict URL parsing and origin validation; issuer rejects credentials/query/fragment and non-HTTPS hosted values. |
| Medium | OIDC did not validate authorized party for multi-audience tokens | Reject mismatched `azp` and multi-audience ID tokens without `azp`; regression tests added. |
| Medium | Internal non-Hub repository files could remain public-site build inputs | `.vercelignore` additionally excludes infra, scripts, tests and README. Confirm exclusions on the approved hosted artifact. |
| Operational | Public project branch deployment suppression covered only PR #3's branch | Added the exact fix branch to suppression. Dedicated Hub Git deployment remains disabled. Confirm dashboard settings before pushing any other branch. |

Existing strengths: default-deny routes; signed ID tokens verified for issuer/audience/expiry/signature/nonce; PKCE; browser-bound, single-use state; hashed random server sessions; HttpOnly/SameSite and hosted `__Host-` Secure cookies; CSRF token/origin checks; per-staff authorization plus RLS; transaction-local role/staff context; sensitive-column grants; no inline scripts in Hub pages; CSP/no-store; SSRF filtering; encrypted credential design; external integrations off by default.

Remaining findings: the runtime can assume `hub_auth` and `hub_worker`, so RLS limits ordinary staff requests but does not contain arbitrary server execution/SQL injection. Runtime must never be the owner, superuser, or BYPASSRLS role. Session access is checked against active staff on every request, but disabling then re-enabling staff can reactivate a previously unexpired session; explicitly revoke sessions during offboarding. The live-operation executor reads approval before an external call without an atomic execution claim; concurrent requests could duplicate an operation. Keep live operations disabled pending a separate locking/idempotency fix and authorized adapter tests. Audit chaining lives in the same database, so owner compromise is outside its tamper boundary. Retention/cleanup of sessions/login states/rate buckets and pool capacity require an operations decision. These limitations preclude enabling live customer operations based on this sprint alone.

## Required Vercel configuration

Existing docs name `crumbyte-site` in team `crum-byte`; this is historical evidence, **not an authenticated inspection in this sprint**. No Vercel token, linked project, or connector was available. Obtain read-only project/settings access and confirm public root, production branch, domains, auto-deploy policy and protection before approval.

Prepare a separate project, proposed name `crumbyte-hub-staging`, in the approved commercial team. Link `crumbytes/website`, root `hub`, Node 24, framework Other. Use checked-in `hub/vercel.json`: `api/index.js` is the only build entry, `@vercel/node` is the builder, all requests route to `/api/index.js`. Do not override with a static output directory or expose source files. Dependencies use `npm ci`; there is no frontend compilation. Runtime uses `pg`, never PGlite. Migrations and owner provisioning run separately, not during builds or requests.

Keep Git auto-deploy disabled. Do not invoke `--prod`. After explicit staging deployment approval, deploy the exact recorded SHA as a Preview, attach `hub-preview.crumbyte.com` to that preview/branch through the supported project domain flow. `HUB_ENV=staging` intentionally fails with `VERCEL_ENV=production`: do not weaken this guard to attach a custom domain. If the chosen Vercel plan cannot attach this hostname to a protected Preview, resolve the plan/routing requirement before deploying.

Require Deployment Protection on every preview address, the custom hostname, alternate `*.vercel.app` hostnames and deployment-specific URLs. Use Vercel team authentication or an approved equivalent protection policy; verify custom-domain coverage on the selected plan. Do not put bypass tokens in browser URLs, repository files or logs. App authentication is still mandatory. Validate separately with an unauthenticated browser and an approved staff browser. No customer data in staging.

Set these for Preview only:

| Name | Value / handling |
| --- | --- |
| `HUB_ENV` | `staging` |
| `HUB_BASE_URL` | `https://hub-preview.crumbyte.com` |
| `DATABASE_URL` | Secret: isolated staging database runtime role, verified TLS, never migration owner |
| `HUB_OIDC_ISSUER` | Exact staging issuer from discovery, including trailing slash if present |
| `HUB_OIDC_CLIENT_ID` | Separate confidential web client ID |
| `HUB_OIDC_CLIENT_SECRET` | Secret, configure token endpoint auth as `client_secret_post` for current implementation |
| `HUB_OIDC_REQUIRED_AMR` | `mfa`, after verifying provider emits it |
| `HUB_TRUSTED_IP_HEADER` | `x-vercel-forwarded-for`; verify actual trusted platform header before use |
| `HUB_LOG_LEVEL` | `info` |
| `HUB_OUTBOUND_ENABLED`, `HUB_OPERATIONS_ENABLED`, `HUB_CREDENTIAL_STORAGE_ENABLED`, `HUB_STACKLTR_ENABLED`, `HUB_EMAIL_ENABLED`, `HUB_R2_ENABLED` | All `false` |
| `HUB_JOB_SECRET`, encryption keys, CMS keys, StackLTR token, Resend/R2 keys | Leave unset; jobs and integrations remain disabled |

Run `npm run preflight` with secure injected values. A valid configuration does not prove provider reachability, migration readiness or protection settings. Pool maximum is five per serverless instance: size the database/pooler for aggregate concurrency, not five connections total. Verify transaction pooling with real staging sessions and RLS.

## Authentication configuration plan

Recommend a dedicated Auth0 staging Regular Web Application using Universal Login, authorization code + S256 PKCE and RS256. This fits existing OIDC without replacing the application. Prefer WebAuthn/security keys or TOTP with recovery codes; enforce MFA for all Hub staff at the provider. Provider factor availability and mandatory MFA costs must be checked before selecting a plan. Existing corporate identity with equivalent enforced MFA is also viable, but its issuer, token auth method and claim contract must match this implementation.

Allowed callback: **`https://hub-preview.crumbyte.com/auth/callback`**, exact, no wildcard. Application/login origin: `https://hub-preview.crumbyte.com`. If configuring a provider logout allowlist, use `https://hub-preview.crumbyte.com/login`; the app currently performs local session logout, not federated logout. Use separate production client later for `https://hub.crumbyte.com/auth/callback`. No production provider changes are authorized.

Provision only synthetic staging staff. Require verified email for initial binding and confirm the resulting issuer/subject. Test MFA success, missing MFA denial, unprovisioned/disabled account denial, state replay, nonce/audience/azp/signature failures, provider outage, session expiry, CSRF and logout. Never remove required MFA just to make login succeed. Hosted MFA and IdP logout behavior remain untested.

## Database migration and recovery plan

Use a dedicated PostgreSQL 17 cluster or provider-supported isolated project. Database roles are cluster-wide (`hub_auth`, `hub_app`, `hub_worker`, `hub_runtime`), so a second database on a shared cluster with existing Hub role names is not adequate role isolation. Confirm provider CREATEROLE/role-membership restrictions first. No hosted database was contacted.

Order is `0001_foundation.sql`, `0002_access_control.sql`, `0003_full_hub.sql`. All are unchanged. The migration runner records checksums, wraps each file in a transaction, skips matching applied files, and refuses edited history. Local checks exercised repeated migration, runtime login restrictions, RLS isolation for two clients, transaction rollback, credential column grants and audit append-only behavior using a real `pg` pool and non-superuser owner. Do not run concurrent migrations: this runner has no deployment lock.

After database creation/migration approval, a named operator uses a separate owner connection, `DATABASE_URL` and `HUB_MIGRATE_CONFIRM_HOST=<exact approved host>` with `npm run migrate`. Confirm host visually before running; setting the confirmation variable is not approval itself. Grant LOGIN and a securely generated password to `hub_runtime` out of band. Use provider-verified TLS/CA, no disabled certificate checks. Provision the first owner using `scripts/provision-owner.mjs` under the same approved owner connection and host confirmation. Runtime receives only the runtime connection string. Test target provider grants and pooling before exposing any app.

Take a backup before subsequent migrations and rehearse restoring into a separate disposable staging cluster. Recheck all migrations, RLS and audit integrity there. Recovery is forward-fix or restore/redeploy the previous compatible build; there are no down migrations. No hosted backup/restore has been performed.

## Required Cloudflare DNS configuration

No Cloudflare connector/credential was present. System resolver requests for the zone NS/A and proposed hostname CNAME/A returned `ECONNREFUSED`; no authoritative zone inventory or existing record conflict was established. Do not infer that the hostname is available.

Intended record after deployment approval:

| Field | Required setting |
| --- | --- |
| Zone | `crumbyte.com` |
| Type | CNAME |
| Name | `hub-preview` |
| Full hostname | `hub-preview.crumbyte.com` |
| Target | **Copy the exact project-specific DNS target Vercel returns when associating this hostname with `crumbyte-hub-staging`** |
| Proxy | DNS only initially |
| TTL | Auto |

The exact CNAME target is unresolved; no generic Vercel target is asserted. Inspect existing A/AAAA/CNAME conflicts, wildcard records and CAA before creating it. If Vercel requests a domain-ownership TXT record, document its exact challenge separately. Leave apex, www, mail and future `hub` records unchanged. A later production hostname uses a separately approved association. Do not create DNS until protected staging deployment and domain association are approved.

## Costs and approval gates

No paid resources were created. Local PGlite, disposable PostgreSQL, tests and browser tools require no external subscription. Hosted commercial use may require a paid Vercel team; protection/custom Preview domains can depend on plan. Auth0 enforced MFA/factors, active staff count and custom domains may require paid features. Managed PostgreSQL charges depend on compute, storage, pooling, backups and retention. Cloudflare DNS is often covered by the current zone plan, but that account was not inspected. Future monitoring, Resend, R2 and StackLTR usage are outside this disabled-integration staging budget. Obtain current vendor quotes and a monthly cap before provisioning; no stale numeric price is represented as verified.

Release-owner actions needed, in order:

1. Save/review the environment draft's `api.github.com` network addition so GitHub PR/check APIs can work. The draft alone does not update runtime policy. Recheck access; native Git read success does not establish API or push permission.
2. Open the prepared fixes as a **draft**, stacked on PR #3; obtain hosted checks for that exact head. No merge.
3. Provide approved read-only Vercel/Cloudflare account access through secure integrations/settings; confirm project association, zone records and plan coverage. Never send secrets in chat.
4. Approve the specific staging IdP client, isolated database, costs and migration plan. Supply secrets securely.
5. Approve the protected Preview deployment of the recorded SHA. Verify both Vercel protection and app authentication across every hostname; test two synthetic client assignments on hosted staging.
6. Only then approve the DNS change using Vercel's exact target. Keep production and all external operations off.

The saved cloud draft contains Hub install/start instructions and the GitHub API allowlist addition. Review/save those settings and publish the **cloud development environment snapshot** when desired; this is separate from authorizing or deploying the hosted Hub.
