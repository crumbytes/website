# Operations runbook

Current product completion, portal/automation/recovery additions and operator instructions: [product-handbook.md](product-handbook.md). Earlier dated details below describe their original implementation/review scope.


Status: written from the design. **None of this has been rehearsed on real infrastructure.** Rehearse each on staging before production.

## Rolling back a release

1. In Vercel, promote the previous good deployment. Application code rolls back immediately.
2. If the release included a migration, see below before rolling back. Old code must work with the newer schema.
3. Record the release commit, what was rolled back and why.

## Migrations: forward recovery

Migrations go forward only, with no down scripts. Dropping a column cannot restore its data, and a reverse script tested once is worse than a plan.

| Situation | What to do |
| --- | --- |
| A migration fails | It ran in one transaction and rolled back completely. Earlier files stay applied. Fix it and run again. |
| A migration applied, but the code has a bug | Roll back the code if it works with the new schema. Otherwise add a new migration that corrects it. |
| An applied migration needs changing | Never edit the file: the runner compares checksums and stops. Add a new file. |
| A migration destroyed or corrupted data | Stop writes by putting up the 503 (remove `HUB_OIDC_ISSUER`), restore the database backup to a new database, compare, and repoint. |

Before any production migration: take a backup and confirm it restores. Prefer changes old code tolerates, such as adding before removing, in separate releases.

## Backing up the hub's own database

Use the host's automatic backups, plus a scheduled encrypted dump if the host's plan is limited. The dump contains encrypted credentials, and those stay unreadable without the key. **The key is needed to restore credentials, so it needs its own recovery plan.** Losing it means re-entering every platform credential. It does not lose other data.

Restore test, at least quarterly:

1. Restore to a new database, never over production.
2. Run `hub.verify_audit_chain()` and expect null.
3. Compare row counts against production for key tables.
4. Point a staging app at it and sign in.
5. Record the result. This is the same standard the hub applies to customer backups.

## Incident: suspected unauthorized access

1. Contain: set the affected staff member to disabled, which ends their sessions on their next request. To end all sessions: `update hub.staff_sessions set revoked_at = now() where revoked_at is null`.
2. Preserve: export `hub.audit_log` and logs before changing anything else.
3. Verify the audit chain on the Audit page.
4. Assess: search the audit log for `credential.use`, and `request.denied`.
5. If credentials may be exposed, rotate them **at each platform**, starting with the customers affected. Revoking in the hub does not revoke at the platform.
6. Assess customer notification duties with the owner.

## Rotating secrets

| Secret | How |
| --- | --- |
| Encryption key | Add the new key to `HUB_CREDENTIAL_KEKS`, set `HUB_CREDENTIAL_ACTIVE_KEY` to it, redeploy. New credentials use it and old ones still decrypt. **Re-wrapping old rows is not built:** re-enter credentials to move them, and only then remove the old key. |
| `DATABASE_URL` password | `alter role hub_runtime password`, update the environment variable, redeploy. |
| `HUB_JOB_SECRET` | Change in the scheduler and the environment together. |
| OIDC client secret | Add a new secret at the provider, update, redeploy, remove the old one. |
| A platform credential | Create it at the platform, enter it in the hub, then revoke the old one at the platform. |

## Staff changes

- **Leaving:** set to disabled in the hub, and disable at the identity provider. Rotate any platform credential they could have seen outside the hub.
- **Role change:** applies on the next request.
- **Client reassignment:** applies on the next request. Tasks assigned to them stay until reassigned.

## Customer offboarding

1. Archive the website. Monitoring stops and records stay.
2. Revoke its credential in the hub **and** at the platform.
3. Confirm what happens to backups under the retention terms.

## Handling a monitoring incident

An incident means consecutive checks from the hub failed. Check from another network before telling a customer their site is down, because the fault can be at the hub's side. Acknowledge it so others know it is being handled. It resolves itself on the next successful check. Add a maintenance window before planned work, so that work does not raise alerts.

## Common failures

| Symptom | Likely cause |
| --- | --- |
| All pages return a plain 503 | Configuration missing or unsafe. Run `npm run preflight` with the same settings. |
| Everyone gets "sign in was not completed" | `HUB_OIDC_REQUIRED_AMR` set, but the provider does not send it. Or a redirect URI mismatch. Check `auth.login` entries in the audit log for the reason. |
| Form posts all fail verification | `HUB_BASE_URL` does not match the address in the browser. |
| Everyone is rate limited at once | `HUB_TRUSTED_IP_HEADER` is wrong, so they share a limit. |
| Monitoring stays unknown | `HUB_OUTBOUND_ENABLED` is off, or the scheduler is not calling the job. |
| Connection shows "the platform asked the hub to wait" | The platform rate limited the hub. It clears by itself. |
| Audit page reports a failed chain | Treat as a security incident. See above. |
