# Remaining integration and deployment requirements

Nothing here has been done. Each item needs the owner's decision, an external account, or credentials that were deliberately not requested during development.

## Decisions for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | Identity provider for staff | A workforce provider with MFA that CrumByte already has, such as Google Workspace or Microsoft Entra. |
| 2 | Database host | Separate from StackLTR's projects. Needs a role setup where `hub_runtime` is not an administrator, and backups. |
| 3 | Scheduler for monitoring | Vercel Hobby cron is daily only, so uptime needs Pro or an external scheduler. **Either may cost money and needs approval.** |
| 4 | Secrets manager or KMS for the credential key | Required before storing any real credential. |
| 5 | Repository visibility | `crumbytes/website` is public. Consider a private repository for the hub. |
| 6 | Shopify access model for customer-owned stores | Client credentials only reach CrumByte's own organization. |
| 7 | Hub hostname | For example `hub.crumbyte.com`, plus DNS at Cloudflare. |

## Before any hosted environment

- [ ] Create a separate Vercel project with root directory `hub/`. Do not reuse `crumbyte-site`.
- [ ] Turn on Vercel Deployment Protection for it. **Automatic Git deployment is off in `hub/vercel.json`.**
- [ ] Confirm `.vercelignore` keeps `hub/` out of the `crumbyte-site` deployment. This could not be tested without deploying.
- [ ] Review migrations `0001` and `0002` against the chosen host. Test them on real PostgreSQL and on a non-superuser owner, not only PGlite.
- [ ] Create the database owner, and grant `hub_runtime` login and a password from the secrets manager.
- [ ] Provision the first owner by inserting one `staff_users` row. There is no script for this yet.
- [ ] Write a backup and restore plan for the hub's own database, and test it.
- [ ] Run the app on Vercel's runtime. `api/index.js` has **never been run on Vercel**.

## Before storing real credentials

- [ ] Independent security review, including the OIDC flow, RLS and credential handling.
- [ ] Move the key-encryption key to a KMS or secrets manager.
- [ ] Build credential re-wrapping for key rotation.
- [ ] Write the customer authorization process: written consent, what is stored, and revocation on offboarding.
- [ ] Add sign-in rate limiting and Vercel Firewall rules.
- [ ] Add audit log export to separate storage, and set retention.

## Live adapter verification

Each needs an authorized test site or store, and its own least-privilege credential. **None has been run against a real platform.** The result of each should be recorded in `cms-capabilities.md`.

- [ ] WordPress: test site with a service user and an Application Password.
- [ ] Shopify: development store, with confirmation that the pinned API version and these fields work.
- [ ] Wix: test site and a scoped API key.
- [ ] Squarespace: a site on Commerce Advanced. **The plan is a paid requirement, so it needs approval.**
- [ ] Joomla: test site, with confirmation of the `files_joomla` version mapping.
- [ ] Monitoring: confirm real uptime and TLS probes from Vercel's network.

## Not built yet

- Email or other delivery of reminders. Reminders only appear on the Overview page.
- Backup provider API integrations. Backup runs and restore tests are recorded by staff, though the schema allows provider-reported runs.
- Automated security scanning. Security reviews are records made by people.
- Editing or retiring schedules, plans and monitoring checks in the interface.
- StackLTR's side of the integration, and lookup instead of pasted IDs.
- Automated browser tests. The interface was exercised by hand in a browser, and the route tests run without one.

## Related findings outside this work

- **PR #2's prototype is reachable when deployed.** `website-management.html` is a static page on the public project. It was already deployed to a preview. It holds no data, but it should be removed or kept out of `main`, since the real hub now lives in `hub/`.
- **The public site serves repository files.** `https://crumbyte.com/infra/remote-support/schema.sql` returned 200 on 2026-11-01, and `tests/` and `scripts/` are likely served too. They hold no secrets that were seen, but `.vercelignore` should exclude them. This was left alone to preserve existing site behaviour.
- **The branch deployment rule is temporary.** The `git.deploymentEnabled` entry in the root `vercel.json` only names this branch and can be removed when the branch merges or closes. It does not affect other branches, so a new hub branch needs its own entry in its first commit.
