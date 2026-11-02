# Deployment and environments

For the current staging sprint, use [Protected staging readiness review](staging-readiness.md). It supersedes historical observations and specifies `hub-preview.crumbyte.com`; the account settings below were not reverified. Hosted config now requires `HUB_OIDC_REQUIRED_AMR`.

**Nothing here has been done.** No Vercel project, DNS record, database, secret or deployment exists for the hub. Every step needs the owner's separate approval. This is the plan to follow once approved.

## Current architecture (checked 2026-11-01)

| Item | What was observed | How |
| --- | --- | --- |
| Public site host | Vercel project `crumbyte-site` (team `crum-byte`), static HTML plus `api/contact.js` and `api/download.js` | PR status from Vercel; `server: Vercel` response header |
| `crumbyte.com` address | `76.76.21.21`, a Vercel address | Public DNS lookup |
| Cloudflare proxy | **Not in the request path.** No `cf-ray` header, so DNS is not proxied | Response headers |
| Cloudflare DNS | Stated in the repo README. Nameservers could not be confirmed from this machine | README only |
| Preview deployments | Every branch of `crumbytes/website` deploys unless suppressed | Vercel status on PR #2 |
| Exposed repo files | `/infra/remote-support/schema.sql`, `/tests/contact.test.mjs` and `/scripts/check-seo.py` all return 200 | Direct requests |

The Vercel project settings and Cloudflare account were not read, because neither connector has access. Confirm both before relying on this table.

## Separation from the public site

| | Public site | Hub |
| --- | --- | --- |
| Vercel project | `crumbyte-site` | New, separate project |
| Root directory | Repository root | `hub/` |
| Hostname | `crumbyte.com` | `hub.crumbyte.com` |
| Cookies | None | `__Host-` cookies, bound to the hub's own hostname |
| Source | Excludes `hub/` by `.vercelignore` | Excludes everything outside `hub/` |

Separate hostnames mean a flaw on the public site cannot read the hub's cookies. Do not serve the hub under a path on `crumbyte.com`.

## Environments

| | Development | Test | Staging | Production |
| --- | --- | --- | --- | --- |
| `HUB_ENV` | `development` | `test` | `staging` | `production` |
| Runs on | Laptop, localhost | Node, CI | Vercel, protected | Vercel |
| Database | PGlite in memory | PGlite and CI PostgreSQL 17 | Separate hosted database | Separate hosted database |
| Sign-in | Local stub | Fake provider | Real provider, separate client | Real provider |
| HTTPS required | No | No | Yes | Yes |
| Rate limits | Off | Off, on in its own tests | Always on | Always on |
| Banner on every page | Yes | Yes | Yes | No |
| Data | Typed by hand | Synthetic | Synthetic only | Real |

An unset `HUB_ENV` means production, the strictest setting. A missing or unsafe setting serves a plain 503 rather than a partly configured app. The app refuses `staging` or a development value on a `VERCEL_ENV=production` host.

## Environment variables

Run `npm run preflight` in an environment to check these without printing values.

| Variable | Needed | Secret | Purpose |
| --- | --- | --- | --- |
| `HUB_ENV` | Yes | No | Environment name |
| `HUB_BASE_URL` | Yes | No | Public address, for example `https://hub.crumbyte.com` |
| `DATABASE_URL` | Yes | **Yes** | PostgreSQL, connecting as `hub_runtime` |
| `HUB_OIDC_ISSUER` | Yes | No | Identity provider issuer |
| `HUB_OIDC_CLIENT_ID` | Yes | No | OIDC client |
| `HUB_OIDC_CLIENT_SECRET` | If confidential client | **Yes** | OIDC client secret |
| `HUB_OIDC_REQUIRED_AMR` | Recommended | No | Require this value in the `amr` claim, such as `mfa` |
| `HUB_TRUSTED_IP_HEADER` | Yes | No | `x-vercel-forwarded-for` on Vercel. Without it everyone shares one sign-in limit. |
| `HUB_JOB_SECRET` | For scheduled jobs | **Yes** | At least 32 characters |
| `HUB_LOG_LEVEL` | No | No | Default `info` |
| `HUB_OUTBOUND_ENABLED` | Off until approved | No | Monitoring and platform requests |
| `HUB_CREDENTIAL_STORAGE_ENABLED` | Off until approved | No | Storing platform credentials |
| `HUB_CREDENTIAL_KEKS`, `HUB_CREDENTIAL_ACTIVE_KEY` | With credential storage | **Yes** | Encryption keys. Must not be stored with the database. |
| `HUB_OPERATIONS_ENABLED` | Off until approved | No | Running approved site changes |
| `HUB_EMAIL_ENABLED`, `HUB_RESEND_API_KEY`, `HUB_EMAIL_FROM` | Off until approved | Key is secret | Alert email |
| `HUB_R2_ENABLED`, `HUB_R2_ACCOUNT_ID`, `HUB_R2_BUCKET`, `HUB_R2_ACCESS_KEY_ID`, `HUB_R2_SECRET_ACCESS_KEY` | Off until approved | Keys are secret | Read-only backup listing |
| `HUB_STACKLTR_ENABLED`, `HUB_STACKLTR_BASE_URL`, `HUB_STACKLTR_TOKEN` | Off until approved | Token is secret | StackLTR integration |

Use a read-only, bucket-scoped R2 token. Use separate secrets in each environment.

## Vercel project

1. Create a new project from `crumbytes/website` with **Root Directory** `hub`. Do not reuse `crumbyte-site`.
2. Framework preset: Other. No build command. Node 24.
3. Automatic Git deployment is off through `hub/vercel.json`. Deploy deliberately, or change that setting as an approved decision.
4. Turn on **Deployment Protection** for all deployments, including previews, before the first deploy. On some plans production protection is a paid feature. Check before relying on it.
5. Add environment variables per environment. Mark secrets as Sensitive.
6. Confirm `crumbyte-site` deployments do not contain `/hub/`. This could not be tested without deploying.

**Cost check:** Vercel Hobby is for non-commercial use, and its cron runs only daily. An internal business tool may need Pro. **This needs the owner's decision before provisioning.**

## Identity provider

| Setting | Value |
| --- | --- |
| Application type | Web, authorization code with PKCE |
| Redirect URI, production | `https://hub.crumbyte.com/auth/callback` |
| Redirect URI, staging | The staging hostname plus `/auth/callback` |
| Scopes | `openid email profile` |
| Token signing | RS256, ES256 or PS256 |
| MFA | Required by policy for everyone who can reach this app |

Use separate clients for staging and production. Test whether your provider reports `amr` before setting `HUB_OIDC_REQUIRED_AMR`, because some do not, and that setting then blocks every sign-in.

## Cloudflare DNS (do not create yet)

| Type | Name | Target | Proxy |
| --- | --- | --- | --- |
| CNAME | `hub` | The value Vercel shows when the domain is added | DNS only, matching how `crumbyte.com` runs today |

Add the domain in the Vercel project first and copy the exact target. If proxying is ever turned on, also check that `HUB_TRUSTED_IP_HEADER` still identifies clients and that Cloudflare caching cannot store staff pages. Pages already send `no-store`.

## Database

1. Create a dedicated PostgreSQL 17 database, separate from all StackLTR projects.
2. Create a migration owner that is **not** a superuser and holds `CREATEROLE`.
3. Apply after approval:
   ```bash
   DATABASE_URL=<owner connection> HUB_MIGRATE_CONFIRM_HOST=<database host> npm run migrate
   ```
4. Give the runtime role a login, with a password from the secrets manager:
   ```sql
   alter role hub_runtime login password '<from secrets manager>';
   ```
5. Set `DATABASE_URL` to connect as `hub_runtime`. It must never connect as the owner. The app only uses transaction-local settings, so a transaction-mode pooler should work, but test this on the chosen host.
6. Create the first owner:
   ```bash
   DATABASE_URL=<owner connection> HUB_MIGRATE_CONFIRM_HOST=<database host> node scripts/provision-owner.mjs you@crumbyte.com "Your Name"
   ```
7. Turn on the host's automatic backups and test a restore before storing real data.

The migrations ran on CI's PostgreSQL 17 under a non-superuser owner. Hosted platforms can restrict `CREATE ROLE` and `SET ROLE`, so run them on the chosen host's staging database first.

## Scheduled jobs

`POST /internal/jobs/run` with `Authorization: Bearer <HUB_JOB_SECRET>` runs monitoring, domain expiry, backup listing, reminders, StackLTR delivery and email. Run it every 5 minutes for meaningful uptime data. Options: Vercel cron on a paid plan, or a free external scheduler that can send the header. **Neither is set up.**

## Monitoring the hub itself

- Point an uptime check at `GET /healthz`. It says only that the process runs.
- Logs are JSON lines on stdout. Alert on `hub.request_failed`, `hub.job_failed` and repeated `hub.rate_limited`.
- Audit log: the Audit page reports whether the hash chain verifies.

## Staging

1. Provision per the above with synthetic data only. Protection must be on, and it is not public.
2. Run `npm run preflight`.
3. Check sign-in with a real provider account, MFA, and a denied unprovisioned account.
4. Run live adapter tests against authorized test sites only. Record results in [acceptance.md](acceptance.md).

## Production checklist

Each needs the release owner's explicit approval and the exact commit recorded.

- [ ] Every "Required" row in [acceptance.md](acceptance.md) has evidence.
- [ ] Independent security review finished, or its absence explicitly accepted.
- [ ] Exact release commit SHA recorded, with CI green on that commit.
- [ ] Deployment Protection confirmed. Staging tested at this commit.
- [ ] Database backups on, and a restore tested.
- [ ] Encryption key in a secrets manager, with an offline recovery copy and a named holder.
- [ ] Migrations reviewed, with the forward-recovery plan in [operations.md](operations.md).
- [ ] DNS created only after the hub answers correctly on its Vercel address.
- [ ] Unauthenticated check: `/`, `/websites` and `/api/v1/websites` show no client information.
- [ ] First owner provisioned, MFA confirmed, then other staff added.
- [ ] Customer written authorization on file before any credential is stored or any site is contacted.
- [ ] Rollback steps rehearsed.
- [ ] The prototype page from PR #2 is not on the public site.
