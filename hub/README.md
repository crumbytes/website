# CrumByte Website Management Hub

Internal staff platform for managing customer websites. **Development foundation: not deployed, and never connected to a live site, hosted database or StackLTR.**

- [Architecture](docs/architecture.md)
- [Security design](docs/security.md)
- [CMS capabilities and adapter framework](docs/cms-capabilities.md)
- [StackLTR integration design](docs/stackltr-integration.md)
- [Restore verification procedure](docs/restore-verification.md)
- [Remaining requirements](docs/remaining-requirements.md)

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

## Safety switches

All of these default to off. See [.env.example](.env.example).

| Setting | Controls |
| --- | --- |
| `HUB_OUTBOUND_ENABLED` | Any request to a staff-supplied address, including monitoring |
| `HUB_CREDENTIAL_STORAGE_ENABLED` | Storing and decrypting platform credentials |
| `HUB_OPERATIONS_ENABLED` | Running approved changes on customer sites |
| `HUB_STACKLTR_ENABLED` | Sending events to StackLTR |

Do not put real customer credentials in any development environment.
