#!/usr/bin/env bash
# Crashes the stack at arbitrary moments: every 5-15 s, SIGKILL the node process of a random worker
# (10% of the time: the API). The process dies mid-work, the container exits and Docker's
# restart policy brings it back, exactly like a crash in production. Stop with Ctrl-C.
#
# The process is killed from inside the container on purpose: `docker kill` counts as a manual
# stop, and Docker then does not apply the restart policy.
set -euo pipefail
cd "$(dirname "$0")/.."

while true; do
  sleep $((5 + RANDOM % 11))
  if ((RANDOM % 10 == 0)); then service=api; else service=worker; fi
  containers=($(docker compose ps -q "$service"))
  if ((${#containers[@]} == 0)); then continue; fi
  target=${containers[RANDOM % ${#containers[@]}]}
  name=$(docker inspect -f '{{.Name}}' "$target")
  if docker exec "$target" sh -c 'kill -KILL $(pidof node)' 2>/dev/null; then
    echo "$(date +%T) SIGKILL ${name#/}"
  fi
done
