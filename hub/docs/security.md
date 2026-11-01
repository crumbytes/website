# Website Management Hub: security design

Status: implemented and tested locally and in CI, on in-process PostgreSQL and a throwaway PostgreSQL 17 server. It has **not** had an independent security review, and has never run on hosted infrastructure.

## Authentication

- OpenID Connect authorization code flow with PKCE, a nonce, and single-use state tied to the starting browser through a short-lived cookie.
- ID tokens are verified for signature (RS256, ES256 or PS256 only), issuer, audience, expiry and nonce.
- **Only provisioned staff can sign in.** The first sign-in binds the provider's `issuer` and `subject` to a record an admin created, and requires `email_verified: true`. Later sign-ins use the bound identity, so a changed email address cannot take over an account.
- MFA is enforced at the identity provider. Set `HUB_OIDC_REQUIRED_AMR` to also check for it here, where the provider reports it reliably.
- Session tokens are random, stored only as SHA-256 hashes, and sent in `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` cookies.
- Unknown users, disabled staff and invalid tokens all get the same response. The specific reason goes to the audit log.

## Authorization

Roles match StackLTR's `workspace_memberships`: `owner`, `admin`, `technician`, `billing`, `viewer`.

| Capability | owner / admin | technician | billing / viewer |
| --- | --- | --- | --- |
| See clients | All | Assigned only | Assigned only |
| Websites, maintenance, security reviews, backup records | Write | Write, assigned only | Read, assigned only |
| Connections and credentials | Write | Run checks only | See status only |
| Request a maintenance operation | Yes | Yes | No |
| Approve or run an operation | Yes, not your own | No | No |
| Staff, assignments, audit log | Yes | No | No |

Only an owner can create or change an owner. Nobody can change their own role or status.

### Enforcement in the database

The app connects as `hub_runtime`, which has no rights of its own. Each transaction picks a role with transaction-local settings, so nothing leaks across pooled connections:

| Role | Used for | Can reach |
| --- | --- | --- |
| `hub_auth` | Sign-in and session lookup | Sessions, login state, identity columns. No client data. |
| `hub_app` | Every staff request | Rows permitted by RLS for `hub.staff_id`. **Cannot read encrypted credential columns.** |
| `hub_worker` | Probes and decryption inputs | Credential ciphertext, monitoring and delivery. Only reached after authorization under `hub_app`. |

No application role has `DELETE` on business records, except for removing a staff assignment. None has `BYPASSRLS` or superuser. Another client's record returns the same 404 as one that does not exist.

**Known limit:** `hub_runtime` can switch between its three roles, so SQL injection combined with multi-statement execution could reach `hub_worker`. All queries are parameterized and the driver's extended protocol runs one statement at a time. Ciphertext alone is still useless without the key, which is outside the database.

## Credential protection

**Development rule:** credential storage is off by default (`HUB_CREDENTIAL_STORAGE_ENABLED`), and no real customer credential has been requested, entered or stored.

- **Envelope encryption.** Each credential gets a random AES-256-GCM data key, wrapped by a key-encryption key held in the environment and **never in the database**.
- **Bound to its record.** Additional authenticated data names the connection and credential, so a row copied onto another connection will not decrypt.
- **Rotation.** Each row records its `key_id`. Several keys can be active for decryption while one is used for encryption. Re-wrapping old rows after a rotation is not built yet.
- **Never returned.** No query behind a page or API selects credential columns, and `hub_app` is denied them by column grant. Password inputs are never refilled after a failed submission.
- **Short-lived in memory.** Decrypted values sit in a `Secret` wrapper that prints as `[secret]` in logs, JSON and inspection.
- **Used only at the source.** The adapter client takes paths rather than URLs, so a credential can only go to that connection's own origin. Redirects are refused, not followed.
- **Audited.** Each decryption writes a `credential.use` entry with its purpose and no value.
- **Least privilege guidance.** Each platform's connection form says what to create and which scopes to grant.

**Before production:** move the key-encryption key to a managed KMS or secrets manager. An environment variable is only acceptable for development.

## Outbound requests (SSRF)

Staff supply URLs, so every outbound request goes through `safe-http.js`:

- Only `https`, except uptime checks, which may use `http`. Only ports 80 and 443. Embedded usernames and passwords are refused.
- Addresses are checked at connect time, on the actual DNS answer. Private, loopback, link-local, carrier-grade NAT, metadata (`169.254.169.254`), multicast, reserved and IPv4-mapped forms are all refused. If any one answer is internal the request is refused.
- Redirects are never followed. Responses have a size limit and a timeout.
- Off entirely unless `HUB_OUTBOUND_ENABLED` is on.

## Web protections

- CSP `default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`. The pages have no scripts.
- CSRF: a per-session token, plus an Origin and `Sec-Fetch-Site` check on every state-changing request.
- `Referrer-Policy: same-origin`. **Do not change this to `no-referrer`:** browsers then send `Origin: null` on form posts, and the CSRF check refuses them. This was found in browser testing and has a regression test.
- Output is escaped by default, input is validated on the server with Zod, and bodies are limited to 128 KB.
- `no-store` on all staff responses, `noindex` throughout, HSTS outside development. Return paths are restricted to same-site paths.
- Errors show a generic message and a reference. Logs carry the error type and code only, because database messages can contain values.

## Rate limiting

Counters live in the database, because serverless instances share nothing. Keys are hashed, so no address is stored. Sign-in allows 30 requests per address in 5 minutes, writes allow 120 per person per minute, and the jobs route allows 12 per minute. Addresses come only from `HUB_TRUSTED_IP_HEADER`, which is required outside development, because a client could forge any other header.

## Logging

Structured JSON lines with a request ID, route pattern, status and duration. Request bodies, query strings and record IDs in paths stay out. Fields pass through the same redactor as the audit log.

## Audit logging

- `audit_log` receives an entry for sign-ins and denials, every change, every credential use, connection checks, operations, and refused requests.
- Entries are written **in the same transaction** as the change, so neither can commit without the other.
- Application roles have insert only. Triggers refuse `UPDATE`, `DELETE` and `TRUNCATE` from everyone, including the owner. `hub_app` can only write entries in the signed-in person's name.
- Each entry hashes the one before it. `verify_audit_chain()` finds the first altered entry, and the Audit page shows the result. The chain detects tampering; it does not prevent it for someone with full database control, so **export to separate storage is still needed** before production.
- Metadata passes through a redactor that masks secret-like keys.

## Known gaps

1. No independent security review or penetration test.
2. Audit log export and retention are not built.
3. The key-encryption key is an environment variable until a KMS is chosen.
4. Re-wrapping credentials after key rotation is not built.
5. Rate limits are a fixed window in the database, which is enough to stop abuse but not a defence against a distributed attack. Vercel Firewall rules are not configured.
6. The repository is **public**. No secrets are stored in it, but the schema and code are readable by anyone, so consider a private repository.
