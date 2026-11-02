# Sprint 3: frontend integration and protected staging readiness

Review date: 2026-11-01 (Pacific/Honolulu). Integration branch: `codex/hub-frontend-integration`, stacked on `codex/hub-staging-review` / PR #4. The final full commit SHA and draft PR URL are recorded in the delivery report and PR metadata. Approve an exact SHA, never a moving branch name.

## Scope and reconciliation

PR #2 (`0ff480ec8f31b7923fb201b874b708ee3294f73a`) is the original HTML prototype. PR #3 (`a4bf7a1f7340e7f9c2fdaafc6f70b8d6da668c6e`) implements the server-rendered Hono/PostgreSQL application and depends on #2. PR #4 (`95689982ad899f10a4dc5d9dcbedb34f2cc154d4`) adds security and staging fixes and depends on #3; its exact-head CI run `41379556107` passed. Sprint 3 descends directly from that verified head. No other Cursor branch was present among the remote heads inspected, so existing application/frontend code was integrated in place without a framework replacement.

The dependency chain is #2 → #3 → #4 → the Sprint 3 draft PR. No PR was merged. Main remains `a2ecbdbf4c75caa21cfbffe51b020e4742426601`. Public HTML, contact functions, scripts, sitemap and robots content are unchanged in this sprint. The only root application configuration edit suppresses automatic public-site deployment for the new integration branch; the dedicated Hub already disables Git deployment.

## Completed interfaces

- Blue CrumByte workspace styling, clearer sidebar/current section, compact environment identification, actionable metric links, structured cards/panels, two-column desktop forms and single-column mobile forms. Native server-rendered submission/navigation remains in use; no JavaScript loading layer, remote fonts or new client dependencies were added.
- Record-backed overview: website/work/finding/incident statistics, upcoming work and approvals, enabled monitoring coverage, recorded backup-source coverage, current connection records, unread notifications, service-history activity and certificate expiry. Zero/unknown/unverified states remain explicit. Disabled checks no longer inflate enabled-check coverage.
- Existing website creation/editing, immutable client association, domains, hosting providers, plan assignment, search/filters, archive/restore, management profile and service history are retained and browser-tested. Read-only staff no longer see a dead Administration link.
- Maintenance scheduling, assignments, approvals, work logs, evidence and reports are retained. Recurring schedules now support editing title/type/interval/next due/default assignee plus pause/resume. Paused schedules stay visible to manage but cannot create new tasks. Updating a schedule never moves its client/website or rewrites existing work.
- Findings/risk labels, SSL tracking, monitoring incident history, backup sources/schedules and recovery workflows are retained. Complete restore-verification history now shows passed/partial/failed records, environment, checks, actor/time and evidence. Recording a backup alone still does not imply recoverability.
- WordPress, Shopify, Wix, Squarespace and Joomla interfaces show capabilities, permission/plan requirements, connection status/errors and genuine last-success timestamps. Selecting a new website CMS uses the matching adapter record rather than the first historical connection; approved-operation controls belong to that matching connection. No secret is returned to the browser. No live site was contacted.
- New summaries and notifications respect current client assignments. Removing an assignment immediately removes that client's history/notification content from overview and inbox. Staff-only data stays behind existing authenticated routes and RLS.

The Hub remains a website management system. No contact, invoice, ticket or other second CRM was added; production StackLTR remains disconnected.

## Backend compatibility

Existing JSON endpoint paths and shapes are retained; connection DTOs add the nullable `last_successful_at` projection. Existing authenticated form routes perform all writes with the original CSRF/origin/role checks. One additive form action, `POST /maintenance/schedules/:id/update`, validates schedule fields, locks the schedule, checks client access and assignee eligibility, and records `schedule.update` in the audit log. Its validated fields are title, kind, interval_days, next_due_on, default_assignee_id and active. Client/website identity is read from the record and cannot be supplied by the form.

`listSchedules` defaults to active schedules for existing callers, with `includeInactive` enabled only in the management screens. Restore-history and overview projections use the same runtime database/RLS boundary. No schema migration, dependency or lockfile change was required. Migrations 0001–0004 remain byte-for-byte unchanged.

Security from #4 is retained: OIDC issuer/audience/signature/nonce/state/azp/MFA validation, server sessions, permanent disablement revocation and login-row locking, CSRF, trusted IP rate limits, runtime-role rejection, durable operation claims, append-only audit, source isolation and strict CSP. The executor/claim/revocation logic is unchanged. Staging still rejects all live-integration flags. Checks and screenshots use local synthetic records only; adapter tests use fakes, not customer connections.

## Validation and screenshots

- Baseline: 167 application tests passed.
- Updated application suite: **175 passed**, zero failed/skipped. Eight new cases cover overview/client isolation, coverage denominators, schedule edit/assignment/pause/resume/validation, foreign identifiers, restore evidence, CMS selection/success history, role-appropriate navigation and assignment removal.
- Expanded browser suite: **19 passed**, including all five CMS screens, schedule management, restore evidence, dashboard navigation, inventory/edit/archive, work/approval flows, backups/findings, security headers, keyboard access, phone/tablet/desktop and axe serious/critical WCAG A/AA checks. Axe uses a dedicated bypassCSP context for inspection; application CSP remains unchanged and is separately verified.
- PostgreSQL 17.11: existing migration/security scripts and new `scripts/pg-frontend.mjs` passed on an isolated database through non-owner runtime roles. This includes migrations/order/checksums/idempotency, transaction isolation, grants/RLS, concurrent dispatch, login/disable race, permanent revocation and new overview/schedule/restore queries.
- Marketing regressions: seven contact tests and SEO checks passed. Production dependency audit: zero known vulnerabilities.
- Official `@vercel/node@29.0.1` local build: one `nodejs24.x` Lambda at `api/index.js`, 394 bundled files, zero static outputs. No Vercel deployment was performed.
- Hosted test discovery is verified locally; hosted acceptance and real IdP MFA have **not** run. Read-only/default and explicitly approved synthetic mutation gates from Sprint 2 remain. The expanded hosted suite contains 25 cases when mutations are explicitly approved (six protected checks plus 19 reused workflow cases); one revocation mutation remains gated in default mode.

Reproducible screenshot command from `hub/`:

```bash
HUB_BROWSER_EXECUTABLE=/usr/bin/chromium \
HUB_SCREENSHOT_DIR=/workspace/artifacts/hub-sprint3 \
node scripts/capture-ui.mjs
```

Use an installed Playwright Chromium by omitting the executable override where appropriate. The runner refuses hosted/production mode, starts a private loopback development server, forces a fresh in-memory database rather than reusing `HUB_DEV_DB`, creates explicitly named synthetic records through the UI, captures, and stops its server/browser. No sample data is added to application startup or production code.

Sixteen PNGs cover overview, inventory, website detail, maintenance, findings/security, backups, monitoring, integrations, notifications, two mobile layouts and five CMS panels. Output includes `gallery.md` and `manifest.json` with Git SHA/dirty state. Delivered artifacts are under `/workspace/artifacts/hub-sprint3`. Screenshots are actual browser captures; no result, chart, customer statistic or live connection was manufactured. The final capture must identify the final clean commit.

Local logs: `/tmp/hub-sprint3-tests-final.log`, `/tmp/hub-sprint3-browser-complete.log`, `/tmp/hub-sprint3-build.log`; final exact-head CI is linked in the delivery report. A known intermediate sidebar viewport failure was corrected before the passing suite; failed/interrupted intermediate runs are not represented as passed.

## Protected staging configuration and remaining gates

The [Sprint 2 approval packet](sprint2-approval.md) and [hosted acceptance procedure](hosted-acceptance.md) remain the detailed configuration inventory. No new secret or provider is required by the frontend. No provider account/paid resource, hosted database, DNS or deployment was created or modified.

| Area | Required configuration / action |
| --- | --- |
| Vercel | Dedicated `crumbyte-hub-staging`, repository `crumbytes/website`, root `hub`, Node 24, Other framework, `npm ci`, existing functions-only `hub/vercel.json`, Preview only; no build-time migration or production deployment |
| Protection | Require Vercel Deployment Protection on custom hostname, aliases and immutable deployment URLs, plus application OIDC/MFA. Confirm plan/domain coverage through authenticated project settings |
| PostgreSQL | Isolated PostgreSQL 17 project/cluster supporting the documented roles; separate non-superuser migration owner and `hub_runtime`; verified TLS; backups/restore rehearsal; do not reuse production StackLTR |
| Identity | Dedicated Auth0 or equivalent staging confidential web client, provider-enforced MFA, restricted staff, exact callback `https://hub-preview.crumbyte.com/auth/callback`, verified AMR and separate staging secret |
| Environment | Preview-scoped HUB_ENV=staging, HUB_BASE_URL, runtime DATABASE_URL, staging host/database and issuer/client pins, OIDC issuer/client/secret, required AMR, trusted IP header; all six integration flags false. Full variable inventory is in the Sprint 2 packet |
| DNS/TLS | `hub-preview` CNAME in `crumbyte.com`, DNS only, Auto TTL; copy exact target and any TXT challenge from approved Vercel association. Target remains unresolved without account access. Verify CAA, conflicts, trusted hostname certificate/renewal and all protection paths |
| Hosted acceptance | Run only after deployment approval, with synthetic identities/records and actual MFA. Repeat source denial, two-client access, revocation, forms and protection on the deployed SHA |
| Rollback | Redeploy an approved compatible claim-aware build with integrations off; do not remove claim/revocation tables or downgrade to an executor that ignores claims. No Sprint 3 schema rollback is needed. Hosted data restore/migrations still need separate approval |

Public DNS was previously observed to use Cloudflare nameservers and to return NXDOMAIN for the preview hostname. This is not an authenticated zone inventory. Vercel/Cloudflare account settings, exact project-specific DNS target and current account plan coverage remain inaccessible through configured tools/credentials. No missing secret is requested in chat; use approved secure provider settings/integrations.

### Cost allowance and approvals

Public pricing pages were read during this sprint, without provisioning. [Vercel](https://vercel.com/pricing) advertises Pro from **$20/month**; team seats, usage and protection features require a specific quote. Its comparison lists custom password protection as an additional **$20/project/month** if that option is chosen. Do not assume password protection or another paid add-on is required when an approved Vercel authentication option already covers every hostname.

[Neon](https://neon.com/pricing) advertises a free tier and usage-based Launch compute at **$0.106/CU-hour**, storage **$0.35/GB-month**; provider role/grant compatibility must be verified before selecting it. A small synthetic staging DB planning allowance of **$0–25/month** is an estimate, not a fixed price or spending cap. Combined base hosting/database planning allowance: **$20–45/month**, before IdP MFA, any protection add-on, extra seats, usage, taxes and backup requirements. [Auth0](https://auth0.com/pricing) MFA entitlement/plan fit still needs a verified quote; the public page did not expose a reliable complete price for the needed configuration. Existing organizational identity may be suitable if its enforced-MFA contract fits, but no existing license is assumed.

No paid infrastructure or subscription was created. Existing cloud/CI usage charges were not inspected. Obtain an approved monthly cap and vendor quotes before paid setup.

Explicit approvals needed, in sequence:

1. Review the draft integration PR and exact SHA; do not merge into main.
2. Provide authorized read-only Vercel/Cloudflare visibility and confirm provider plans/budget.
3. Approve the isolated staging IdP/admin/MFA and database setup, secure Preview-scoped values and any costs.
4. Separately approve hosted migrations/provisioning and the protected **Preview** deployment of that exact SHA.
5. Confirm protection on every deployment hostname, then approve the exact DNS/TXT changes Vercel supplies.
6. Verify TLS and run hosted acceptance with synthetic data. Keep CMS operations, customer connections and production StackLTR disabled.

The local candidate is validated and the deployment package is prepared. Hosted operational readiness cannot be claimed until these gates and hosted checks are complete. Independent penetration testing, manual screen-reader testing, provider-specific MFA and backup restoration remain outside the automated local evidence.
