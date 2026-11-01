#!/usr/bin/env bash
# Прогон P2P-сценария (H1) в контейнере: стенд (bg) → для каждого профиля
# {netem apply → run-p2p.mjs → netem clear}. Профили: env PROFILES.
set -euo pipefail
cd /app

PROFILES="${PROFILES:-lan 4g lossy}"
export CHROME_PATH="${CHROME_PATH:-/usr/bin/chromium}"
export BENCH_URL="${BENCH_URL:-http://127.0.0.1:8080}"
mkdir -p results/raw

echo "[p2p] запуск стенда..."
yarn tsx src/server/index.ts &
SERVER_PID=$!
trap 'yarn node experiment/netem.mjs clear || true; kill "$SERVER_PID" 2>/dev/null || true' EXIT

echo "[p2p] ожидание готовности стенда..."
for _ in $(seq 1 60); do
  if curl -sf "$BENCH_URL/api/info" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf "$BENCH_URL/api/info" >/dev/null || { echo "[p2p] стенд не поднялся"; exit 1; }

for p in $PROFILES; do
  echo "[p2p] ===== профиль: $p ====="
  yarn node experiment/netem.mjs apply "$p"
  PROFILE="$p" yarn node scripts/run-p2p.mjs
  yarn node experiment/netem.mjs clear
done

echo "[p2p] готово. Результаты в results/raw/p2p-*.json"
