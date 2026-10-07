#!/bin/bash
# Brings the VM to origin/main: code, dependencies, units, Caddy — then restarts.
# Run as root on the server: `bash /opt/mandate/app/deploy/update.sh`.
#
# Attestors restart one at a time, each waited for until its heartbeat is green
# (its startup sweep done), so the quorum never drops for the length of a deploy.
set -euo pipefail

APP=/opt/mandate/app
ATTESTORS=(1 2 3)

as_mandate() { sudo -u mandate -H -- "$@"; }

cd "$APP"
as_mandate git fetch --quiet origin main
as_mandate git merge --ff-only --quiet origin/main
as_mandate pnpm install --frozen-lockfile --reporter=silent
echo "at $(git rev-parse --short HEAD)"

install -m 644 deploy/systemd/mandate-api.service deploy/systemd/mandate-attestor@.service /etc/systemd/system/
install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --quiet mandate-api "${ATTESTORS[@]/#/mandate-attestor@}"
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload-or-restart caddy

systemctl restart mandate-api

for n in "${ATTESTORS[@]}"; do
  port=$(sed -n 's/^ATTESTOR_HEALTH_PORT=//p' "/etc/mandate/attestor-$n.env")
  systemctl restart "mandate-attestor@$n"
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port/health"; then
      echo "attestor $n green"
      continue 2
    fi
    sleep 2
  done
  echo "attestor $n not green after 120 s — stopping here, the others keep their old process" >&2
  journalctl -u "mandate-attestor@$n" -n 30 --no-pager >&2
  exit 1
done

curl -fsS -o /dev/null -w 'api /health %{http_code}\n' http://127.0.0.1:3000/health || true
