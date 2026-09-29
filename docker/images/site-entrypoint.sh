#!/bin/sh
# Serves the release that <releases>/current points at (E12.2); without a release, the site
# baked into the image. The worker switches the pointer on a release or a rollback: this script
# notices within a second and restarts the server on the new artifact.
RELEASES="${RELEASES_DIR:-/data/releases}"

current() { readlink "$RELEASES/current" 2>/dev/null || true; }

start() {
  if [ -n "$1" ] && [ -f "$RELEASES/$1/SERVER" ]; then
    server="$(cat "$RELEASES/$1/SERVER")"
    echo "site: release $1 ($server)"
    (cd "$RELEASES/$1" && exec node "$server") &
  else
    echo "site: no release yet, serving the image build"
    (cd /app && exec node templates/site/server.js) &
  fi
  pid=$!
}

stop() {
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
}

trap 'stop; exit 0' TERM INT

active="$(current)"
start "$active"
while sleep 1; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "site: the server stopped" >&2
    exit 1
  fi
  now="$(current)"
  if [ "$now" != "$active" ]; then
    stop
    active="$now"
    start "$active"
  fi
done
