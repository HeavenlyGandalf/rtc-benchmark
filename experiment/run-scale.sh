#!/usr/bin/env bash
# Прогон сценария масштабируемости (К8) в контейнере: стенд (bg) → для каждого
# профиля и канала {netem apply → run-scale.mjs → netem clear}.
# Профили: env PROFILES (по умолч. "lan 4g"); каналы: env MODES.
set -euo pipefail
cd /app

PROFILES="${PROFILES:-lan 4g}"
export CHROME_PATH="${CHROME_PATH:-/usr/bin/chromium}"
export BENCH_URL="${BENCH_URL:-http://127.0.0.1:8080}"
mkdir -p results/raw

echo "[scale] запуск стенда..."
yarn tsx src/server/index.ts &
SERVER_PID=$!
trap 'yarn node experiment/netem.mjs clear || true; kill "$SERVER_PID" 2>/dev/null || true' EXIT

echo "[scale] ожидание готовности стенда..."
for _ in $(seq 1 60); do
  if curl -sf "$BENCH_URL/api/info" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf "$BENCH_URL/api/info" >/dev/null || { echo "[scale] стенд не поднялся"; exit 1; }

for p in $PROFILES; do
  echo "[scale] ===== профиль: $p ====="
  yarn node experiment/netem.mjs apply "$p"
  for m in ${MODES:-wt-stream rtc-reliable}; do
    PROFILE="$p" MODE="$m" yarn node scripts/run-scale.mjs
  done
  yarn node experiment/netem.mjs clear
done

echo "[scale] готово. Результаты в results/raw/scale-*.json"
