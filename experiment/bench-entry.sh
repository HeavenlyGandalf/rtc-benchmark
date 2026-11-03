#!/usr/bin/env bash
# Точка входа контейнера bench в compose-router.yml: маршрут к сети сервера
# через router, ожидание готовности, прогон плана и анализ.
set -euo pipefail
cd /app

ip route replace "${ROUTE_TO:?}" via "${ROUTE_VIA:?}"
export CHROME_PATH="${CHROME_PATH:-/usr/bin/chromium}"

echo "[bench] ожидание router и server..."
for _ in $(seq 1 60); do
  if curl -sf "$NETEM_AGENT/health" >/dev/null 2>&1 && curl -sf "$BENCH_URL/api/info" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf "$NETEM_AGENT/health" >/dev/null || { echo "[bench] router не отвечает"; exit 1; }
curl -sf "$BENCH_URL/api/info" >/dev/null || { echo "[bench] стенд не отвечает"; exit 1; }

NAME="$(node -p "require('./$PLAN').name")"
status=0
yarn node scripts/run-plan.mjs || status=$?  # yarn node: PnP-резолвер наследуют дочерние раннеры
# анализ — даже если часть прогонов упала: по сводке видно, каких данных нет
if [ -d "results/$NAME/raw" ]; then node scripts/analyze.mjs "results/$NAME" || status=$?; fi
exit "$status"
