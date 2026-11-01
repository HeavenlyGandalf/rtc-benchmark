#!/usr/bin/env bash
# Точка входа контейнера в multi-host-прогоне H1. Применяет netem на eth0
# (шейпинг исходящего трафика этого контейнера) и запускает роль ROLE.
# Профиль — PROFILE; каждый из трёх контейнеров шейпит свой egress на величину
# профиля, поэтому P2P (A↔B) = 2 прохода, relay (A→сервер→B→сервер→A) = 4 прохода.
set -euo pipefail
cd /app

export CHROME_PATH="${CHROME_PATH:-/usr/bin/chromium}"
IFACE="${IFACE:-eth0}"
PROFILE="${PROFILE:-lan}"

echo "[entry] role=${ROLE:?} profile=$PROFILE iface=$IFACE"
IFACE="$IFACE" yarn node experiment/netem.mjs apply "$PROFILE" || echo "[entry] netem не применился (нет NET_ADMIN?)"
trap 'IFACE="'"$IFACE"'" yarn node experiment/netem.mjs clear >/dev/null 2>&1 || true' EXIT

case "$ROLE" in
  server)
    exec yarn tsx src/server/index.ts
    ;;
  peerB)
    exec yarn node scripts/run-peer-b.mjs
    ;;
  peerA)
    yarn node scripts/run-peer-a.mjs
    yarn node scripts/aggregate-h1.mjs || true
    ;;
  *)
    echo "[entry] неизвестная роль: $ROLE"; exit 1;;
esac
