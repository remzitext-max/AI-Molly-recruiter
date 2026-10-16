#!/usr/bin/env bash
# Pull the latest code and restart. Data (database, uploaded CDLs, certificates) is kept.
set -euo pipefail
cd /opt/molly-recruiter
git pull --ff-only
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker image prune -f >/dev/null
echo "Updated."
