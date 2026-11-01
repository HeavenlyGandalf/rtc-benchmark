#!/usr/bin/env bash
# Полный прогон эксперимента внутри Docker-контейнера:
#   стенд (bg) → для каждого профиля {netem apply → run-series → netem clear} → aggregate.
# Профили задаются env PROFILES (через пробел), по умолчанию — все из profiles.json.
set -euo pipefail
cd /app

PROFILES="${PROFILES:-lan wifi 4g 5g lossy limited}"
export CHROME_PATH="${CHROME_PATH:-/usr/bin/chromium}"
export BENCH_URL="${BENCH_URL:-http://127.0.0.1:8080}"
mkdir -p results/raw

echo "[run-all] запуск стенда..."
yarn tsx src/server/index.ts &
SERVER_PID=$!
trap 'yarn node experiment/netem.mjs clear || true; kill "$SERVER_PID" 2>/dev/null || true' EXIT

echo "[run-all] ожидание готовности стенда..."
for _ in $(seq 1 60); do
  if curl -sf "$BENCH_URL/api/info" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf "$BENCH_URL/api/info" >/dev/null || { echo "[run-all] стенд не поднялся"; exit 1; }

for p in $PROFILES; do
  echo "[run-all] ===== профиль: $p ====="
  yarn node experiment/netem.mjs apply "$p"
  PROFILE="$p" yarn node scripts/run-series.mjs
  yarn node experiment/netem.mjs clear
done

echo "[run-all] агрегация..."
yarn node scripts/aggregate.mjs
echo "[run-all] готово. Результаты в results/"
