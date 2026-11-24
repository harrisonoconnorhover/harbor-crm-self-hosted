#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
compose() { docker compose --profile build -f deploy/demo/compose.yaml "$@"; }
case "${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}" in
  unix://*|npipe://*) ;;
  *) echo "Use a local Docker engine to run the Harbor demo." >&2; exit 1 ;;
esac
case "${1:-start}" in
  start)
    running=$(compose ps --status running -q entrance)
    if [ -n "$running" ]; then
      binding=$(docker port "$running" 8788/tcp)
      if [ "$binding" != "127.0.0.1:${HARBOR_DEMO_PORT:-8793}" ]; then
        echo "A Harbor demo is already running on $binding. Stop that demo before changing its port." >&2
        exit 1
      fi
    else
      compose up --build --wait entrance
    fi
    echo "Open http://127.0.0.1:${HARBOR_DEMO_PORT:-8793}/demo"
    echo "Return to /demo to switch roles. Stop and discard the fictional workspace with: sh scripts/demo.sh stop"
    ;;
  stop) compose down --volumes ;;
  *) echo "Usage: sh scripts/demo.sh [start|stop]" >&2; exit 2 ;;
esac
