# Deploying on a continuously running server

The app is two processes sharing one Postgres database and one private storage volume:

- **web**: `npm start` (Next.js on port 3000), behind HTTPS.
- **worker**: `npm run worker`, places calls, sends texts, retries, retention cleanup. Runs 24/7; safe to restart; several workers may run at once.

## Quick install on the Hetzner server (Ubuntu)
1. Push this code to a GitHub repository.
2. Log in to the server as root (`ssh root@<server-ip>`) and run:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/deploy/install.sh -o install.sh
   bash install.sh https://github.com/<owner>/<repo>.git [your-domain]
   ```
   For a private repo, use a URL with a read-only GitHub token, or a deploy key.
3. Without a domain the app runs at `https://<server-ip>.sslip.io` with a real certificate. To add a domain later, point its DNS A record to the server IP, set `DOMAIN` and `APP_URL` in `/opt/molly-recruiter/.env`, and run `deploy/update.sh`.
4. The script installs Docker, opens only ports 22/80/443, adds swap, writes `.env` with random secrets, starts Postgres, web, worker and Caddy (HTTPS), and prints the admin password once.
5. Updates: `bash /opt/molly-recruiter/deploy/update.sh`.
6. It starts in demo mode. Nothing can call or text a real person until live mode is configured.

The public privacy policy for the lead form is at `https://<domain>/privacy`.

## Recommended: one Linux VM with Docker Compose
1. A small VM (2 vCPU, 4 GB RAM) at any cloud provider, with an **encrypted disk**, automatic security updates and daily backups.
2. Install Docker. Copy the project, then `cp .env.example .env` and set:
   - `APP_MODE=demo` at first; `APP_URL=https://recruiting.yourcompany.com`
   - `SESSION_SECRET` (`openssl rand -base64 48`), `POSTGRES_PASSWORD`, `WEBHOOK_SIGNING_SECRET`, `LEAD_WEBHOOK_SECRET`
   - `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` (12+ characters), `ORG_NAME`
3. `docker compose up -d --build`. All services restart automatically.
4. Put a TLS reverse proxy in front (Caddy is simplest: `recruiting.yourcompany.com { reverse_proxy localhost:3000 }`). Do not expose Postgres.
5. Monitoring: poll `GET /api/health` (returns `overdueJobs`; a growing number means the worker is down). Check **Background jobs** in the app for failures.
6. Backups: `pg_dump` nightly plus the `storage` volume. CDL files are auto-deleted after the retention period set in Controls.

Managed alternative: any host for a Next.js server + a separate always-on worker (e.g. Render/Railway/Fly.io services) with managed Postgres and a persistent private disk. Serverless-only hosting is not suitable for the worker.

## Going from demo to live
Follow [PRODUCTION-CHECKLIST.md](PRODUCTION-CHECKLIST.md). In short: set `APP_MODE=live`, add provider credentials, publish a real (non-synthetic) offer, record contact permissions, confirm the contact policy in **Controls & policy**, then enable production contact. Each step is enforced in code; skipping one keeps leads queued with the reason shown.

Demo records stay labelled and are never dialed in live mode. For a clean start, use a fresh database for production.

## Notes
- Docker images were written and reviewed but could not be built in the development sandbox (its network proxy blocks the Debian package mirror). The app itself was built and run natively (`next build`, web + worker) and tested in a browser.
- `npm audit` reports advisories in dev-only test tooling (vitest's dependencies) and in Next's bundled postcss; review and update dependencies before go-live.
