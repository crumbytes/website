# Test and failure log

What is tested, how to run it, and every real failure found during the build, with its resolution. Exact results for a given commit are in the pull request and its CI run.

## Suites

| Suite | Command | Covers | Environment |
| --- | --- | --- | --- |
| Unit and route tests | `npm test` | Sign-in, sessions, CSRF, roles, client isolation, RLS, credentials, adapters, outbound safety, validation, audit, monitoring, backups, maintenance, StackLTR, migrations | PGlite, simulated platforms |
| Browser tests | `npm run test:e2e` | Two independent clients, end-to-end workflows, accessibility on every page, phone, tablet and desktop layouts, browser security | Real browser, real local server, local sign-in stub |
| PostgreSQL integration | `node scripts/pg-integration.mjs` | Migrations under a non-superuser owner, the real `pg` driver and pool, role switching, RLS, append-only rules | CI's throwaway PostgreSQL 17 |

## Not tested

No test here contacts a real CMS platform, identity provider, email service, R2 bucket, StackLTR, hosted database or Vercel. Accessibility is automated (axe, WCAG 2.1 A and AA). It has not been tested manually with a screen reader.

## Failures found and resolved

| # | Found by | Failure | Cause | Resolution |
| --- | --- | --- | --- | --- |
| 1 | Unit test | Oversized responses returned as a truncated success | The response's end event could still resolve after the request was destroyed | Reject as soon as the limit is passed |
| 2 | Database test | A passed restore with no evidence was accepted by the database | SQL `CHECK` treats a NULL result as passing | `coalesce(length(evidence_ref), 0)`, and the same fix for completed tasks with no notes |
| 3 | Unit test | The runtime role's escape test passed for the wrong reason | The test connection was a superuser | Added a real `hub_runtime` role and tested through a non-superuser session |
| 4 | Manual browser run | Every real form submission was refused | `Referrer-Policy: no-referrer` makes browsers send `Origin: null` | Changed to `same-origin`, with a regression test |
| 5 | Manual browser run | The page was 906px wide on a 375px screen, pushing Sign out off screen | Grid column could grow beyond the viewport | `minmax(0, 1fr)`, checked on every page by the browser suite |
| 6 | Manual browser run | Styling fixes did not reach the browser | A long cache on an unversioned stylesheet URL | Content hash in the stylesheet URL |
| 7 | Review | "Tested against recorded responses" overstated hand-written fixtures | Wording | Changed to "simulated", in the interface and the docs |
| 8 | Unit test | All staff could share one sign-in limit | Without a trusted IP header, every request used one bucket | `HUB_TRUSTED_IP_HEADER` is required outside development |
| 9 | Axe browser test | Wide tables could not be reached by keyboard | Scrollable regions were not focusable | Focusable, labelled table regions |
| 10 | Browser test | On long pages, Sign out sat at the bottom of a sidebar as tall as the page | The sidebar stretched with the content | Sticky sidebar sized to the viewport |
| 11 | Dependency audit | A moderate advisory in `@hono/node-server` 1.x | Dependency version | Upgraded to 2.x |

Test-only corrections, such as locators and timeouts, are not listed.

## Known defect outside this work

`python scripts/check-seo.py` at the repository root fails on PR #2's branch, because its `website-management.html` is `noindex` and the check does not allow that page. It was left alone to avoid conflicting with PR #2.
