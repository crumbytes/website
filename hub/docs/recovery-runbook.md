# Customer website recovery runbook

The hub tracks and authorizes a recovery. **It never restores anything itself.** A person carries it out with the backup provider's tools.

## Backup requirements

- **Encrypted and access-controlled.** Encrypt before upload where the hub or CrumByte controls the process. Bucket access keys are limited to named people and systems.
- **Authorized.** Do not back up a customer's site without their written authorization.
- **Retention stated.** Each source records how long it keeps backups.
- **Cloudflare R2.** Suitable as storage, with no egress fees. The hub can read a bucket listing to report what exists, using a read-only token. It does not upload, encrypt or restore. A separate process would have to create the archives. Whether CrumByte has approved R2 for this, and its cost at expected volume, is an open decision for the owner.

What the hub can and cannot tell you:

| Hub shows | What it means |
| --- | --- |
| Backup succeeded, reported by staff | A person says so. |
| Backup succeeded, reported by provider | A non-empty object exists in storage. Its contents are not inspected. |
| Encryption as recorded | What someone wrote down. The hub does not verify it. |
| Restore verified with evidence | A person recorded a passed restore test within 90 days. |

## Recovery steps

1. **Declare it.** On the website's Backups section, choose **Request a recovery**, pick the backup and give the reason.
2. **Second person approves.** An owner or admin other than the requester approves. A real emergency still takes two people: phone someone.
3. **Before changing anything:**
   - Capture the site's current state, even if damaged, for later investigation.
   - Add a maintenance window so monitoring does not raise alerts.
   - Tell the customer what will happen and how far data will go back.
4. **Mark as started** in the hub.
5. **Restore** with the provider's tools. Test on an isolated copy first when time allows.
6. **Check** the same list as [restore-verification.md](restore-verification.md): pages, sign-in, recent content, media, forms and checkout.
7. **If the site was compromised:** a restore alone does not remove the way in. Rotate credentials, update software and record findings in the Security section.
8. **Close the recovery** with what happened and an evidence reference. Completed requires evidence. A failed recovery is recorded as failed.
9. **Tell the customer** the outcome and what data was lost, if any.

## Platform notes

| Platform | Restore route |
| --- | --- |
| WordPress | Backup plugin, or the host's panel. Restores need file and database access the hub does not have. |
| Joomla | Backup extension or the host's panel. |
| Shopify | No platform restore. Use a backup app, within what it covers. |
| Wix | Site History in the dashboard. |
| Squarespace | No general restore. Limited page and collection recovery only. Confirm with current Squarespace documentation. |

Confirm these against current platform documentation when writing a customer's plan. They have not been tested.
