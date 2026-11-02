# Neon/free-tier staging decision and release evidence

Reviewed 2026-11-02 UTC. This is the current provider decision, superseding the Supabase preference and estimates in `sprint5-activation.md`. **BLOCKED: staging is not operational.** No infrastructure, authentication tenant, hosted migration, deployment, DNS record or production setting was created/changed. Existing StackLTR projects remain untouched. Main must remain untouched; continue in draft PR #6.

## Architecture and release inventory — VERIFIED

Start point: `b80cb6fe8955ee31669d19df04f29e8b01d25f76`, exact-head [successful CI](https://github.com/crumbytes/website/actions/runs/41391640438). Baseline: 185 Node tests, 19 browser/accessibility cases, seven contact tests; SEO, production dependency audit (zero vulnerabilities), PostgreSQL 17.11 integration/security/frontend scripts and official Vercel function-only build passed. No hosted tests ran. The final updated full SHA/run are recorded in PR #6 and the delivery evidence, avoiding a self-referential SHA in this file.

| Layer | Existing implementation / evidence |
| --- | --- |
| Authoritative stack | #6 on #5 on #4 on #3 on #2 on main; all five PRs were rechecked draft/mergeable. #6 already contains the combined implementation; no merge or duplicate integration PR is needed |
| Runtime | Node 24 ESM, Hono routing, `@hono/node-server`, Vercel entry `hub/api/index.js`, one Lambda and no static outputs; existing frontend retained |
| Authentication | Provider-neutral authorization-code OIDC + S256 PKCE; `jose` verifies asymmetric ID token issuer/audience/expiry/nonce/azp and required `amr:mfa`. No Auth0-specific SDK or Neon Auth dependency |
| Sessions | Random opaque token, hash in PostgreSQL, Secure/HttpOnly/SameSite cookies, CSRF, 30-minute idle/eight-hour absolute lifetime, disabled-staff revocation; logout revokes Hub session, not upstream SSO |
| Database | `pg` pool max five per serverless instance; owner-separated runtime `hub_runtime`, transaction-local role/staff context and RLS. Four ordered checksum-recorded migrations; PGlite only for development/tests |
| Tenant model | Hub staff roles and client assignments/RLS enforce isolation. Auth0 Organizations are not required per Hub client. Keep existing references to StackLTR; no second CRM |
| External dependencies | PostgreSQL and approved OIDC provider required for hosting; Vercel/DNS for this target. Resend/R2/CMS/StackLTR/credential storage/jobs remain disabled and require no new subscription |

All runtime/migration/dependency code is preserved from the validated start point. New tests exercise Neon-style direct/pooled configuration, owner rejection, host/database pins and stale Supabase pins. These are offline compatibility tests, not a managed Neon connection. Final CI must show **187 Node tests**, 19 browser cases and all inherited checks passed on the exact final commit.

## Authentication comparison and decision

Sources retrieved: [Auth0 pricing.md](https://auth0.com/pricing.md), [Neon Managed Better Auth](https://neon.com/docs/auth/about), [supported plugins](https://neon.com/docs/auth/guides/plugins), [Neon Auth roadmap](https://neon.com/docs/auth/roadmap), [OAuth provider beta](https://neon.com/docs/auth/guides/plugins/oauth-provider).

| Requirement | Auth0 Free | Neon Managed Better Auth |
| --- | --- | --- |
| Free allowance | $0, up to 25,000 MAU, five Auth0 Organizations, one tenant, one-day log retention in public matrix | Included in Neon Free, up to 60,000 MAU/project; users/sessions branch with database |
| Existing application fit | OIDC is the least disruptive fit; verify discovery, confidential token method and AMR on actual tenant | Managed Better Auth API/session model differs. OAuth provider beta offers OIDC discovery/code+PKCE, but documents `client_secret_basic`; current app requires `client_secret_post`. Exact algorithms/ID-token claim compatibility unverified |
| Mandatory MFA | Public matrix excludes Pro/Enterprise MFA factors from Free; cannot approve required factor on Free without documented existing entitlement | Official roadmap explicitly says **MFA support: Coming soon**. Email OTP/passkeys/social login must not be treated as proof of `amr:mfa` |
| Roles/organizations | Free has five Organizations but provider role management is paid. Existing Hub authorization remains authoritative, so no provider-role rewrite needed | Organization plugin exists; mapping it to Hub membership/revocation would require integration work, not automatically preserve Hub isolation |
| Sessions/logout | Keep existing secure Hub sessions and permanent revocation. Upstream logout is a separate decision | Native sessions would need integration or an OIDC adapter/client registration plus hosted login/consent pages; MFA still blocks acceptance |
| Commercial/internal use | Reviewed pricing does not impose Vercel Hobby's personal-use restriction; internal employee/workforce licensing and account entitlement still need confirmation | Free is documented for prototypes/small teams; actual organization terms/eligibility unverified. Do not assume an existing paid org creates free projects |
| Future cost/complexity | Essentials public base: B2C $35/month or B2B $150/month at 500 MAU; classification/employee licensing/actual factors need account quote | Auth remains within MAU quota but DB/network/restore upgrades may charge; migration and security verification required |

**Decision — COMPLETE recommendation, NEEDS APPROVAL implementation:** retain the current OIDC flow and prefer an existing appropriately licensed Auth0 application/tenant with enforced MFA. Do not rewrite for Neon Auth. Neither examined Free auth option presently establishes all mandatory MFA requirements. No tenant domain is verified; never invent one. If no existing eligible license exists, approve the actual MFA-capable plan/provider quote before tenant/client changes. Do not disable `HUB_OIDC_REQUIRED_AMR=mfa`, substitute a trial for a recurring entitlement or fabricate MFA claims.

Exact registration: separate Regular Web Application, callback `https://hub-preview.crumbyte.com/auth/callback`, origin `https://hub-preview.crumbyte.com`, no wildcards, confidential client with supported asymmetric signing and `client_secret_post`. Restrict provisioned staff, enforce an approved factor for this client, verify actual signed AMR and positive/negative flows. If a logout allowlist is needed, use `https://hub-preview.crumbyte.com/login`. No hosted Auth0 changes were made. Identity-provider administrators and Hub owner are separate roles.

## Dedicated Neon database — BLOCKED on account access

Requested new project **`crumbyte-hub-staging`**, PostgreSQL 17, separate `hub_staging` database. **No project was created; no new project identifier exists.** Existing recovery project **`frosty-union-75655676`** and Supabase StackLTR staging/beta are inspection-only, never migration/connection targets.

Current runtime has no Neon key, connector, CLI profile or outbound identity. The Neon organization ID, plan, remaining quota and create permission are unverified. Optional `HUB_NEON_READ_TOKEN` → `NEON_API_KEY` for `console.neon.tech` is saved as metadata only. Supply existing authorized read-only visibility securely or a redacted owner export; do not grant broad write access merely for inspection. New credentials/permissions require their own authorization. Saved metadata does not create a credential or publish/apply the environment configuration.

Public [plans](https://neon.com/docs/introduction/plans)/[pricing](https://neon.com/pricing), checked on the review date:

- Free: **$0/month**, no card required, 100 projects, 10 branches/project, 100 CU-hours/project/month, 1 GB/project and 20 GB total, 5 GB public transfer/project, scale to zero after five minutes, up to 2 CU. Verify actual organization eligibility/quota rather than relying on marketing limits.
- Compute/transfer exhaustion suspends compute until reset/upgrade; storage-cap exhaustion makes growing operations fail. No automatic upgrade is authorized. At 0.25 CU, 100 CU-hours represents 400 active hours, so continuously active hosting can exhaust Free.
- Free recovery: up to **six hours or 1 GB of changes**, one manual snapshot. This does not meet the previously proposed seven-day recovery requirement.
- [IP Allow](https://neon.com/docs/introduction/ip-allow) is **Scale-only**; Free and Launch do not satisfy the existing SQL network-restriction requirement. No public-endpoint configuration, backup retention reduction or network exception is approved by choosing Free. Preserve these as explicit approval/design gates.

The user conditionally permits a NEW free project only after proof of zero recurring cost and no existing-resource changes. Before any creation, verify the selected organization is actually Free (an additional project in a paid usage-billed org is not automatically free), remaining project/storage quota, named permission, region, PG17 support and billing behavior. Separately resolve approval for externally accessible configuration/security gaps. Do not upgrade/downgrade the existing organization, add billing details, modify recovery or enable Neon Auth as a side effect. Populate `staging/neon-observations.example.json` from dated authenticated evidence. Nulls are unknown.

### Connection/migration procedure — COMPLETE preparation; hosted execution NEEDS APPROVAL

1. Obtain new project/branch/endpoint IDs from the approved provider response. Verify they differ from recovery and belong to the new Hub project. No endpoint/region/org is guessed in templates.
2. Use the provider-returned pooled host (`-pooler` endpoint), port 5432, database `hub_staging` and SQL-created `hub_runtime` for runtime; direct endpoint only for separately approved owner/migration operations. Both require `sslmode=verify-full`. Install secrets only in the dedicated Vercel Preview scope. Use `staging/neon-runtime.env.example` plus the full `.env.example`; leave the Supabase project pin empty.
3. Neon [Console/API-created roles inherit `neon_superuser`](https://neon.com/docs/manage/roles), including dangerous administrative privileges. Do **not** create runtime via the Console/API role shortcut. Migrations create `hub_runtime` via SQL with NOINHERIT/NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS; after approval an owner securely enables LOGIN/password out of band. Verify no owner or `neon_superuser` membership. The runtime's SQL guard must pass, never be bypassed.
4. After separate hosted-migration approval, snapshot only the new project and use its direct owner connection with `HUB_MIGRATE_CONFIRM_HOST` and `npm run migrate`. Apply `0001_foundation`, `0002_access_control`, `0003_full_hub`, `0004_execution_and_revocation` in order. Migration runner uses checksums and per-file transactions; single operator only. Required UUID support is PostgreSQL built-in `gen_random_uuid()`; no `CREATE EXTENSION` dependency was found. Confirm PG17/owner create-role and grants on actual Neon before application acceptance.
5. Provision synthetic owner and two independent synthetic clients via the existing owner tool. Keep owner/provider credentials out of runtime. Verify migrations repeat without changes, checksums, runtime rejection of admin credentials, role grants/RLS, isolation and audit/claims/revocation behavior.
6. [Neon pooling](https://neon.com/docs/connect/connection-pooling) uses transaction pooling. The Hub sets role/staff context transaction-locally; it does not rely on session `SET`, LISTEN or SQL PREPARE. Verify real pooler role behavior and aggregate five-per-instance capacity, cold wake-up/failure handling and TLS on the approved managed project. Disposable PostgreSQL proves SQL behavior but not managed pooler readiness.
7. Recovery must preserve execution claims, sessions/revocations and audit; no automatic down migration. Free snapshot/six-hour restore is not seven-day backup protection. Approve a genuinely suitable paid retention plan or separately approved encrypted export/restore design and any policy exception before hosted use. Backup metadata in the Hub is not a backup. Restores use another isolated destination and require approval; never restore over recovery/StackLTR.

## Vercel and DNS — BLOCKED / NEEDS APPROVAL

Vercel account/team, project ID, existing subscription and protection entitlement remain unverified: no credentials/profile/connector. Dedicated project `crumbyte-hub-staging`; repository `crumbytes/website`; root `hub`; Node `24.x`; Other framework; `npm ci`; no build/output overrides; `api/index.js`; no outside-root source/directory listing; automatic Git deployment and custom-domain assignment off. The unchanged exact-SHA/project deployment-request validator rejects production/moving-head requests. Prepare protection for every immutable/alias/custom URL before first deployment. No public or production deployment is authorized.

[Vercel Hobby](https://vercel.com/docs/plans/hobby) explicitly restricts use to **personal, non-commercial** projects. This business-management application must use an eligible existing commercial subscription or an approved paid plan. Do not label staging as personal use to bypass terms. Read back actual Node/protection/settings before deployment.

Read-only public DNS: **both** `hub-preview.crumbyte.com` and future `hub.crumbyte.com` returned NXDOMAIN for A and CNAME. This is not authenticated Cloudflare inventory or ownership proof. Zone read access remains absent. Proposed staging DNS: `crumbyte.com` zone, CNAME `hub-preview`, DNS only, Auto TTL, **target unknown until verified Vercel project returns it**; any exact TXT challenge is a separate record. Preserve production/apex/www/mail. Obtain exact-record approval only after deployment/project/protection verification, then verify TLS/SAN/CAA and denial across all URLs. No DNS writes occurred.

All required variable names are in `.env.example` and the Neon supplemental template. OIDC secret/runtime SQL password belong only in secure provider settings. Job secret remains empty, every live integration off. No session-signing-key variable exists: sessions are opaque DB-backed tokens. Operator-only owner/provider keys must not be installed in runtime. Cloud configuration save/publish is separate from Hub deployment approval.

## Security/acceptance — VERIFIED locally; BLOCKED hosted

Keep the existing local suite for SQL injection/authorization, CSRF, secure cookies, session expiry/revocation, owner rejection, audit integrity, two-client RLS, durable claims, inventory/maintenance/backups and connection-failure handling. The prepared [hosted suite](hosted-acceptance.md) is executable but unrun: real MFA and platform protection first; read-only cases by default (revocation skipped), 25 mutation-inclusive cases only with synthetic-mutation approval. No customer sites/credentials, CMS dispatch, monitoring jobs or StackLTR connection. Monitoring/backup UI records are not evidence of actual external jobs/backups.

Unresolved confirmed finding from prior read-only probes: the existing marketing site serves `/infra/remote-support/schema.sql` and `/tests/contact.test.mjs` (200, bodies match main). Sampled Hub source/env/migration paths were 404. No customer/credential disclosure was established; this is source/schema disclosure, and samples cannot establish all-URL safety. Live-site remediation is outside current authorization. The draft stack already excludes internal deployment inputs; no public site change was made.

## Cost and exact next gates

**VERIFIED new recurring spend incurred: $0. One-time purchases: $0. No paid resources created.** No fully secure $0 hosted configuration has been verified. Public list prices are not existing-account quotes.

| Item | Monthly public benchmark / missing evidence |
| --- | --- |
| Neon Free DB | $0 only in verified eligible Free organization/quotas; project not created; security/recovery gaps above |
| Neon paid alternative | Launch compute $0.106/CU-hour; Scale $0.222/CU-hour; storage $0.35/GB-month; change history $0.20/GB-month. IP Allow requires Scale. No fixed $15 quote: “typical spend” is usage-based, not a cap |
| Existing OIDC/Auth0 | Incremental $0 only if existing license demonstrably includes required MFA/usage. Otherwise Essentials benchmark $35 B2C or $150 B2B at 500 MAU; employee/internal classification and exact factor quote unknown |
| Vercel commercial hosting | Pro from $20/month; existing eligible subscription may reduce incremental cost; Hobby excluded |
| SQL network controls | Vercel shared-pool Static IPs lists $100/project/month if approved fixed egress is required, plus verified Neon Scale entitlement/usage; no purchase |
| Deployment protection | Verify all-URL entitlement; optional custom password add-on lists $20/project/month, not automatically required or assumed sufficient |
| DNS / jobs / other | No new DNS subscription proposed; account entitlement unverified. Jobs, external CMS, paid monitoring/log drains/SMS/object storage remain disabled; future enablement separately quoted |

Conditional arithmetic: Vercel Pro $20 + eligible Neon Free $0 + Auth0 B2B Essentials $150 = **$170/month** (B2C eligibility would make $55), plus protection/usage/tax. **These omit the unresolved database network/recovery requirements and are not deployable recommendations.** For a restricted-network illustration with continuous 0.25 CU Scale, 730 hours, 1 GB data/1 GB history: DB `0.25×730×0.222 + 0.35 + 0.20 = $41.065`; $20 hosting + $150 B2B Auth0 + $100 egress + DB ≈ **$311.07/month**, plus protection, usage/tax. B2C eligibility would make $196.07. Actual retention storage and duty cycle vary; neither figure is a quote/cap. Existing entitlements may reduce incremental cost only after verification.

| Status | Resource/action | Required evidence or exact approval | Reversal / following verification |
| --- | --- | --- | --- |
| BLOCKED — next input | Neon org, Vercel team, Cloudflare zone and Auth0 tenant | Non-secret Neon org ID and exact Auth0 domain; secure existing scoped read-only access or redacted account exports. No new paid subscription or broad token needed just for diagnostics | Revoke access; verify actual IDs/plan/permission, no secrets in evidence |
| BLOCKED — conditionally authorized free creation | NEW Neon `crumbyte-hub-staging` only | First prove selected org/project is $0 recurring, quotas available and existing resources unchanged; resolve externally accessible configuration approval. No creation against a paid org or recovery | Delete only new empty project; verify actual new ID/PG17/billing/settings |
| NEEDS APPROVAL | Actual MFA-capable Auth0 client/plan and secure Neon network/recovery design | Approve named account, factors/entitlements, exact incremental quote and monthly cap; no MFA/network/retention weakening | Revoke only new client/access; verify real MFA/AMR, SQL role/TLS/network denial and approved restoration |
| NEEDS APPROVAL | New protected Vercel project and its secure Preview variables | Exact team/project, commercial plan/protection quote and all-URL protection; no public-project changes | Delete only new empty project/config; read back settings and entitlements |
| NEEDS APPROVAL | New Hub DB migrations and synthetic provisioning | Exact new direct endpoint/database/owner and four unchanged migrations | No automatic down migration; approved isolated restore; verify history/RLS/isolation/claims |
| NEEDS APPROVAL | Exact final SHA protected Preview deployment | Certified final SHA, project/team ID and protection proof | Approved compatible rollback/delete preview; verify actual resolved SHA and anonymous denial |
| NEEDS APPROVAL | Exact Cloudflare staging CNAME/TXT | Actual Vercel destination and exact record values only | Approved record rollback subject to TTL; verify DNS/TLS/protection, production unchanged |
| NEEDS APPROVAL | Hosted acceptance / synthetic mutations | Approved deployment/database, real-MFA test identities and explicit mutation gate | Revoke test sessions/approved cleanup; record pass/fail/skip and two-client isolation |

The **first next action is account visibility and the two non-secret identifiers**, not approval of an invented paid total. Resource creation, hosted migration, external access configuration, deployment and DNS approvals remain distinct. No additional architectural rewrite is needed to proceed once these concrete gates are satisfied.
