# CrumByte Remote Support — cloud pilot

**Status:** configuration prepared, server not yet provisioned. Keep the customer-facing website in request-only mode until a consent-based end-to-end test passes.

## Provider and sizing
- DigitalOcean Basic Droplet (regular shared CPU), 1 vCPU, 1 GiB RAM, 25 GiB disk (~$6/month before optional backups, applicable taxes and transfer overages).
- Ubuntu Server 24.04 LTS, US West/SFO3 region if available.
- Public IPv4 and SSH key login; disable password SSH authentication after verifying key access.
- Hostname: `remote.crumbyte.com` (create an unproxied DNS-only A record once the Droplet IP is known; RustDesk traffic is not proxied by Cloudflare's ordinary orange-cloud HTTP proxy).

## Deployment
1. Create the Droplet with SSH-key access, provider firewall, and automatic security updates.
2. Provider firewall: allow SSH/TCP 22 only from administrator's current trusted IP. Allow RustDesk **TCP 21115, 21116, 21117; UDP 21116** from client networks. Deny other inbound traffic. Keep TCP 21114, 21118, 21119 closed (no Pro API or web client). Apply equivalent host firewall rules after verifying connectivity.
3. Install Docker Engine and Compose plugin using Docker's official Ubuntu repository and verify `docker compose version`.
4. Place the included `compose.yaml` in `/opt/crumbyte-rustdesk/` with the persistent `data/` directory. Create a `.env` file **on the server only** containing `RUSTDESK_HOST=remote.crumbyte.com` (do not commit this file).
5. Launch `docker compose up -d`. Inspect logs with `docker compose logs --tail=100`.
6. Find the *public* server key from `/opt/crumbyte-rustdesk/data/id_ed25519.pub`. Never share `id_ed25519` (private key).
7. Configure an approved RustDesk technician client and test customer client to use ID server `remote.crumbyte.com`, relay `remote.crumbyte.com`, and the displayed public key; conduct a customer-consented test from a second network.
8. Document session consent, termination, technician verification and access logging. Avoid unattended access during pilot.
9. Pin the tested Docker image version or digest before production, configure backup for persistent server keys, regular updates, transfer monitoring and cloud budget alerts.

## Boundaries
- This Compose config provisions only the open-source RustDesk ID/signaling and relay infrastructure (`hbbs` and `hbbr`). It does **not** furnish a browser remote-control app, technician dashboard, API, client installers, or ticketing integration.
- Do not enable `/support.html` live-connect buttons until both server and customer-side session workflows are tested.
- If relay bandwidth or demand increases, reassess instance size and provider transfer allowance.
- Website support form continues using FormSubmit; no change to that route is required.

References: https://rustdesk.com/docs/en/self-host/rustdesk-server-oss/docker/ and https://www.digitalocean.com/pricing/droplets
