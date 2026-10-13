#!/usr/bin/env bash
# One CanyonOS deploy per machine: review sessions take this lock before
# `canyonos deploy` and release it after `canyonos quit`.
#
# Usage: deploy-lock.sh acquire <tag>   # exits 1 and names the holder if taken
#        deploy-lock.sh release         # removes the lock, whoever holds it
#        deploy-lock.sh status
set -euo pipefail

LOCK_DIR="${CANYONOS_REVIEW_LOCK:-/tmp/canyonos-review-deploy.lock}"

case "${1:-}" in
  acquire)
    tag="${2:?usage: deploy-lock.sh acquire <tag>}"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      printf '%s pid=%s %s\n' "$tag" "$$" "$(date '+%Y-%m-%dT%H:%M:%S')" >"$LOCK_DIR/holder"
      echo "deploy lock taken by $tag"
    else
      echo "deploy lock held by: $(cat "$LOCK_DIR/holder" 2>/dev/null || echo unknown)" >&2
      exit 1
    fi
    ;;
  release)
    rm -rf "$LOCK_DIR"
    echo "deploy lock released"
    ;;
  status)
    if [ -d "$LOCK_DIR" ]; then
      echo "held by: $(cat "$LOCK_DIR/holder" 2>/dev/null || echo unknown)"
    else
      echo "free"
    fi
    ;;
  *)
    echo "usage: deploy-lock.sh acquire <tag> | release | status" >&2
    exit 2
    ;;
esac
