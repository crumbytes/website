# Hub API contract (for frontend work)

For Cursor or anyone building interface work against the hub. Base path `/api/v1`. All responses are JSON and `no-store`. Tested by `tests/` unless noted.

## Coordination

- **Stack today:** server-rendered HTML with no client JavaScript, in `src/ui/`. Visual changes can go straight into `src/ui/styles.js` and the page templates.
- **Files:** frontend work should touch `src/ui/` or a new package. Please avoid `src/services/`, `src/app.js` routes and `db/` without coordinating, or open a PR against `feat/website-hub-foundation-20261101`.
- **If adding client JavaScript or a React app:** the Content-Security-Policy in `src/app.js` is `default-src 'none'`, which blocks all scripts and `fetch`. Changing it is a security decision for the owner. It must never allow `unsafe-inline` or `unsafe-eval`, and credentials must never reach browser code or storage.
- **Keep:** the states that say something is unknown or unverified. Do not replace them with friendlier wording that implies health.
- **Tests that guard the UI:** `e2e/hub.spec.mjs` covers accessibility and screen sizes on every page.

## Authentication

Same-origin session cookie, set by the sign-in flow at `/auth/start`. There are no API keys.

| Situation | Response |
| --- | --- |
| No session | `401` `{ "error": { "code": "unauthenticated" } }` |
| Missing or wrong CSRF token, or a foreign origin | `403` `csrf_failed` |
| Role lacks permission | `403` `forbidden` |
| Another client's record, or one that does not exist | `404` `not_found`, identical in both cases |
| Validation | `422` `validation_failed`, with `fields` |
| Duplicate or wrong state | `409` `conflict` |
| Bad JSON | `400` `invalid_json` |
| Rate limited | `429` `rate_limited`, with `Retry-After` |
| Feature off here | `503` `not_configured` |

Writes need the `X-CSRF-Token` header. `GET /api/v1/me` returns it. Errors look like:

```json
{ "error": { "code": "validation_failed", "message": "Please correct the highlighted fields.", "fields": { "primary_url": "Enter a full web address" }, "request_id": "abc" } }
```

## Endpoints

| Method and path | Purpose | Permission |
| --- | --- | --- |
| `GET /me` | Staff identity and CSRF token | Any |
| `GET /clients` | Clients you can access | Any |
| `POST /clients` | Create a client | Owner, admin |
| `GET /websites?q=&client=&platform=&hosting=&monitoring=&lifecycle=` | Inventory with management profile | Any |
| `POST /websites` | Create a website | Technician and above |
| `GET /websites/:id` | One management profile | Any |
| `POST /websites/:id/archive` | Archive | Technician and above |
| `GET /websites/:id/domains`, `POST /websites/:id/domains` | Domains | Read: any. Write: technician and above |
| `GET /websites/:id/connections` | Connection status. Never includes credentials | Any |
| `GET /tasks?scope=open\|all`, `POST /tasks` | Maintenance tasks | Read: any. Write: technician and above |
| `POST /tasks/:id/complete` | Complete, with `completion_notes` | Technician and above |
| `GET /monitoring/checks`, `GET /monitoring/incidents` | Monitoring | Any |
| `GET /security/findings`, `GET /security/websites` | Findings, and risk per website | Any |
| `GET /backups/sources` | Backup sources with `recoverability` | Any |
| `GET /notifications` | Your notifications | Any |
| `GET /hosting-providers` | Hosting providers | Any |
| `GET /adapters` | Platform capabilities, with `live_verified: false` | Any |

Everything else, such as recording restores or approving operations, is available as form routes in `src/app.js`. Ask if a JSON version is needed.

## Website profile

```json
{
  "id": "uuid", "client_account_id": "uuid", "client_name": "text", "display_name": "text",
  "primary_url": "https://…", "primary_domain": "example.com or null",
  "cms_platform": "wordpress|shopify|wix|squarespace|joomla|other", "cms_other_name": "text or null",
  "cms_version": "text or null", "cms_version_source": "api|manual|null",
  "hosting_provider": "text or null", "plan_name": "text or null", "account_owner_name": "text or null",
  "lifecycle": "active|paused|offboarded|archived",
  "uptime_outcome": "up|down|error|null", "uptime_checked_at": "timestamp or null", "open_incidents": 0,
  "recoverability": { "state": "no_backups|unverified|verified|evidence_stale|restore_failed", "label": "text", "verified": false },
  "risk": { "level": "unassessed|stale|none_open|info|low|medium|high|critical", "label": "text", "basis": "text" },
  "open_tasks": 0, "last_maintenance_at": "timestamp or null", "next_maintenance_on": "date or null"
}
```

## How to display status

| Value | Must show as |
| --- | --- |
| `uptime_outcome: null` | Unknown, not checked. **Never healthy.** |
| `uptime_outcome: "down"` | Not reachable from the hub. Not necessarily down for everyone. |
| `recoverability.verified: false` | Not verified, using the `label` provided. |
| `risk.level: "unassessed"` | Not assessed. **Never low risk.** |
| `risk.level: "none_open"` | No open findings, not secure. |
| Finding `source` | Always show whether it was automated or manual. |
