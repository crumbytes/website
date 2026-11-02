# CrumByte Website Management Hub

Current feature inventory and all operator/customer/deployment guides: [Product handbook](docs/product-handbook.md). Provider credentials and cloud activation are deferred; no hosted operations are authorized by local setup.

Internal staff platform for managing customer websites. **Built and tested locally. Not deployed, and never connected to a live site, hosted database or StackLTR.**

- [Sprint 4 hosted-staging approval package](docs/sprint4-approval.md)
- [Sprint 3 frontend integration and release report](docs/sprint3-release.md)
- [Sprint 2 deployment approval packet](docs/sprint2-approval.md)
- [Hosted acceptance procedure](docs/hosted-acceptance.md)
- [Protected staging readiness review](docs/staging-readiness.md)
- [Architecture](docs/architecture.md)
- [Security design](docs/security.md)
- [CMS capabilities and adapter framework](docs/cms-capabilities.md)
- [StackLTR integration design](docs/stackltr-integration.md)
- [Restore verification procedure](docs/restore-verification.md)
- [Remaining requirements](docs/remaining-requirements.md)
- [Final acceptance status](docs/acceptance.md)
- [Deployment and environments](docs/deployment.md)
- [Operations runbook](docs/operations.md)
- [Customer recovery runbook](docs/recovery-runbook.md)
- [API contract for frontend work](docs/api-contract.md)
- [Test and failure log](docs/test-log.md)

## Run locally

Needs Node 24.

```bash
npm ci
npm run dev
```

Open http://localhost:4310. This uses an in-memory PostgreSQL and a local sign-in stub bound to localhost, with test staff logins and no client records. Add `HUB_DEV_DB=.data/dev` to keep data between runs. Outbound connections, credential storage and live operations are all off, and it refuses to start on a hosted or production environment.

## Test

```bash
npm test
```

Tests run on real PostgreSQL through PGlite, with row level security enforced, and contact no external service.

Browser tests start the local server themselves. They need a browser: either `npx playwright install chromium`, or an installed Chrome with `PLAYWRIGHT_CHANNEL=chrome`.

```bash
npm run test:e2e
```

CI also runs `scripts/pg-integration.mjs` on a throwaway PostgreSQL 17 server, as a non-superuser owner.

## Safety switches

All of these default to off. See [.env.example](.env.example).

| Setting | Controls |
| --- | --- |
| `HUB_OUTBOUND_ENABLED` | Any request to a staff-supplied address, including monitoring |
| `HUB_CREDENTIAL_STORAGE_ENABLED` | Storing and decrypting platform credentials |
| `HUB_OPERATIONS_ENABLED` | Running approved changes on customer sites |
| `HUB_STACKLTR_ENABLED` | Reading from and sending events to StackLTR |
| `HUB_EMAIL_ENABLED` | Alert emails |
| `HUB_R2_ENABLED` | Reading the Cloudflare R2 backup listing |

Do not put real customer credentials in any development environment.
