# Final acceptance status

**Not ready for deployment approval.** Most code is built and tested, but several required criteria depend on real accounts and approvals that do not exist yet.

Key: **Tested** means passing automated tests. **Simulated** means tested only against fakes. **Blocked** means it needs something external. **Partial** means part of it is missing, as stated.

## Phase 14 criteria

| Required | Status | Evidence, and what is left |
| --- | --- | --- |
| Staff authentication works | **Simulated** | Full OIDC flow passes against a fake provider and local stub. **Blocked:** no real identity provider chosen. |
| Unauthorized users cannot access client information | **Tested** | `tests/auth`, `tests/isolation`, `e2e/hub.spec.mjs`. Needs repeating on hosted infrastructure. |
| Website inventory persists records | **Tested** | PGlite in tests and browser runs. Migrations and core checks ran on PostgreSQL 17 in CI. No hosted database. |
| Maintenance workflows function | **Tested** | Tasks, schedules, plans, approvals, work logs, reports, in tests and in a browser. |
| Supported CMS integrations pass connection tests | **Blocked** | Simulated only. No authorized test sites or credentials. See below. |
| Monitoring results are genuine | **Blocked** | The logic is tested: no probe means no result. Real probes have never run. |
| Backup status is accurate | **Tested, for what it records** | Verified only with restore evidence. **Partial:** no real provider connected, and R2 is simulated. |
| StackLTR integration is verified | **Blocked** | The StackLTR API does not exist, and production connection needs approval. |
| Automated tests pass | **Tested** | See [test-log.md](test-log.md). |
| Security tests pass | **Partial** | Automated security tests pass. **No independent review or penetration test.** |
| Exact release commit identified | **Blocked** | There is no release yet. |
| Rollback and recovery documented | **Partial** | [operations.md](operations.md), [recovery-runbook.md](recovery-runbook.md). Written, but not rehearsed. |

## By capability

| Capability | Implemented | Tested | Real-world verified |
| --- | --- | --- | --- |
| Sign-in, sessions, CSRF, headers, rate limits | Yes | Yes | No |
| MFA | Delegated to the provider, can be required by `amr` | Simulated | No |
| Roles, RLS, client isolation | Yes | Yes, on PGlite and CI PostgreSQL | No hosted test |
| Encrypted credentials | Yes, off by default | Yes | No KMS. No real credential was ever stored. |
| Audit log | Yes | Yes | Export not built |
| Website inventory, domains, hosting, plans, archive, filters | Yes | Yes | n/a |
| WordPress adapter | Connection, health, plugins, themes, plugin activation | Simulated | No |
| Shopify adapter | Store, scopes, themes, redirects | Simulated | No |
| Wix adapter | Properties, site record | Simulated | No |
| Squarespace adapter | Site info, stock | Simulated | No |
| Joomla adapter | Connection, version, extensions | Simulated | No |
| Uptime, TLS, incidents, windows, thresholds, uptime reports | Yes | Yes, with fake probes | Never run for real |
| Domain expiry via RDAP | Yes | Simulated | No |
| Email alerts | Yes, off by default | Simulated | No |
| Security dashboard, findings, risk, remediation | Yes | Yes | No scanner connected |
| Backup records, schedules as recorded, alerts | Yes | Yes | Provider runs backups, not the hub |
| R2 listing | Yes, off by default | Simulated | Signature not checked by R2 |
| Restore evidence, recovery workflow | Yes | Yes | People carry out recoveries |
| StackLTR hub side | Yes, off by default | Simulated | Other side not built |
| Accessibility and responsive layouts | Yes | Automated axe checks on every page at desktop, plus phone, tablet and desktop width | No manual screen-reader test |

## Clearly unsupported

Not built, or not possible through official APIs. These are not defects:

- WordPress core version, update availability and applying updates, through core REST routes.
- CMS version, extensions and updates on Wix, Squarespace and Shopify, which are hosted platforms.
- Squarespace content, and API keys below the Commerce Advanced plan.
- Vulnerability scanning. **No scanner is connected.**
- Automatic updates. Deliberately not done until authorization, rollback and recovery checks exist.
- The hub starting or restoring any backup.
- Browser scraping or credential workarounds. Deliberately refused.

## Deviation from the recommended stack

The brief recommends React/Next.js. The hub uses server-rendered pages with Hono and no client JavaScript. This was kept because it allows the strictest browser security policy and means credentials cannot reach browser code, and because all logic is in `src/services/` behind a JSON API, so a React frontend can still be added later without changing the backend. **This is the owner's call.** See [api-contract.md](api-contract.md).
