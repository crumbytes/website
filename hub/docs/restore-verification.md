# Restore verification procedure

The hub only shows a backup source as verified when a person has restored a backup, checked the result, and recorded the evidence. A provider's "backup succeeded" message is not evidence that a site can be recovered.

## When

- After adding a backup source, before telling a customer that backups are in place.
- At least every 90 days. Older evidence shows as stale in the hub.
- After a major site change, such as a migration, a platform upgrade or a change of backup provider.

## Steps

1. **Pick a real backup.** Choose a recent successful run recorded in the hub, and note its provider reference.
2. **Restore somewhere isolated.** Use an environment that cannot send customer email, take payments or be indexed. Do not test by overwriting production. If production was truly restored during an incident, record that as the environment.
3. **Protect the data.** A restored copy holds real customer data. Restrict access, and do not copy it to personal machines.
4. **Check the restored site.** Record what you actually did. At minimum:
   - The home page and key pages load correctly.
   - An administrator can sign in.
   - Recent content or orders from around the backup date are present.
   - Media files load, and forms or checkout reach the point where they would submit.
   - Plugins, themes and extensions are at the expected versions.
5. **Keep the evidence.** Put screenshots and notes in a ticket or document, and get a reference to it. No passwords or customer data in the reference.
6. **Record it in the hub.** On the website's Backups section, choose **Record a restore test**. Be honest about the result:
   - **Passed:** everything checked worked. An evidence reference is required.
   - **Partial:** some parts were restored. Say what was missing.
   - **Failed:** it could not be restored. Open a maintenance task to fix this.
7. **Clean up.** Delete the restored copy and record that you did.

## Hosted platforms

Wix, Squarespace and Shopify offer no general restore test environment through their APIs, and some have no full-site restore at all. Record what is actually possible, such as a Site History restore on a duplicate Wix site or a backup app's test restore. If no restore can be tested, leave the source as unverified. **Do not record a pass.**

## What the hub enforces

- A passed result needs an evidence reference, a description of at least 10 characters and a backup run that succeeded, in the application and in the database.
- Results cannot be dated in the future, and entries cannot be edited or deleted.
- A later failed or partial test takes priority over an earlier pass.
- A pass older than 90 days stops counting as verified.

The hub cannot tell whether a recorded test really happened. It records who claimed it, and when, in a permanent log.
