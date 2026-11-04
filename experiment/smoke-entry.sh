#!/usr/bin/env bash
# Точка входа make smoke: маршрут через router, ожидание сервисов и дымовая
# проверка стенда (scripts/smoke.mjs). Результат — results/smoke-check/.
set -euo pipefail
cd /app

ip route replace "${ROUTE_TO:?}" via "${ROUTE_VIA:?}"
export CHROME_PATH="${CHROME_PATH:-/usr/bin/chromium}"
for _ in $(seq 1 60); do
  if curl -sf "$NETEM_AGENT/health" >/dev/null 2>&1 && curl -sf "$BENCH_URL/api/info" >/dev/null 2>&1; then break; fi
  sleep 1
done
trap 'if [ -n "${HOST_UID:-}" ]; then chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" results/smoke-check 2>/dev/null || true; fi' EXIT
yarn node scripts/smoke.mjs  # yarn node: PnP-резолвер наследует run-series.mjs
