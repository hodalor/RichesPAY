#!/bin/sh
set -eu

# Rolling restart. The previous release keeps serving /health until the new
# process is ready. Migrations already applied must still work for the old
# release.
services="richespay-api richespay-worker richespay-dashboard richespay-admin richespay-checkout richespay-docs"

for service in $services; do
  docker compose up -d --no-deps --force-recreate "$service"
  if [ "$service" = "richespay-api" ]; then
    until wget -qO- http://127.0.0.1:3000/health >/dev/null; do
      sleep 2
    done
  fi
done
