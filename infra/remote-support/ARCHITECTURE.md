# CrumByte Remote Support Platform — implementation contract

Status: **design and interactive preview only**. The database schema is not deployed; authentication, billing, clock and remote-control integration are not operational.

## Principles
- Customer-facing connection label: **Secure Internet Connection**. Do not put remote access engine product names in portal UI; accurately disclose third-party software in install notices, consent, privacy disclosures and software-license notices.
- **Customer consent is mandatory**. A request and a web login do not authorize screen access.
- Support minutes are a **ledger**, not a mutable balance in browser storage. Every credit entry is auditable; never trust client-supplied amounts or duration.
- Use an actual payment processor webhook with signature verification, idempotent event processing, purchase ownership checks and a recorded refund policy before crediting minutes.
- An authenticated customer can access only their own wallet, tickets and sessions. Technicians only their assigned tickets; supervisors require restricted role elevation. The SQL migration alone does not implement these controls.
- Ensure ledger reservations and usage debits are transactional, serialized per wallet. No negative balances unless explicitly approved policy.
- Server is source of time. Billable session starts only after consent, positive credit balance, and confirmed technician-connected state; record UTC timestamps and monotonic elapsed-time tracking per metering worker. Persist checkpoints and reconcile after failures.
- Inform both sides at 10, 5 and 1 minute remaining. At zero, stop billing, notify both, enter a **paused/expired** state. Do not promise automatic remote shutdown until a proven integration exists. Permit technician safety override for sensitive operations, with audit and customer-facing billing disclosure.
- Never store device access passwords, MFA secrets, private RustDesk identity keys, or third-party private information in support tickets.
- Technician access must be individually attributable with MFA, approval, revocation and events. Customer downloads only from a trusted, signed distribution source.
- Use explicit status timestamps, append-only event audit and retention limits.

## Planned endpoints (not implemented yet)
- GET /api/support/me — authenticated customer identity and role
- GET /api/support/dashboard — session view, wallet seconds and server timestamp
- POST /api/support/tickets — create authenticated ticket with rate limiting
- POST /api/support/sessions/:id/consent — record scoped consent
- POST /api/support/checkout — create hosted checkout for authenticated wallet
- POST /api/support/payments/webhook — verify signature and process event idempotently
- POST /api/support/sessions/:id/start — restricted technician operation with evidence of connection
- POST /api/support/sessions/:id/pause — restricted technician operation; adjust billing meter
- POST /api/support/sessions/:id/end — restricted technician operation with audit
- GET /api/support/sessions/:id/events — authorized, paginated history

## Delivery milestones
1. Frontend wire-up and mocked consent/state/timer experience (implemented in `portal.html`).
2. Choose authentication and managed PostgreSQL provider. Review SQL constraints, identity mapping and RLS/policies.
3. Implement authenticated backend and persisted wallet/ticket/session read operations.
4. Implement webhook-verified payments, reconciliation, idempotency and refunds.
5. Integrate monitored session state and test consent/timeout behavior on controlled devices.
6. Upgrade to real production enablement only after security review, payment validation and remote-access integration tests.

## Safety gates
Live checkout, real wallet credits, production session timing, support-client auto-download and auto disconnect must remain disabled in the preview. Remote access services remain independently operated and must not be represented as integrated into the portal until tested.
