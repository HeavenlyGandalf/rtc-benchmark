#!/usr/bin/env bash
# Точка входа контейнера server в compose-router.yml: маршрут к сети клиента
# через router, калибровочное UDP-эхо и сам стенд.
set -euo pipefail
cd /app

ip route replace "${ROUTE_TO:?}" via "${ROUTE_VIA:?}"
node scripts/udp-echo.mjs &
exec yarn tsx src/server/index.ts
