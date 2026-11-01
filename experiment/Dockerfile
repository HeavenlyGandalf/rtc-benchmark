# Linux-образ для воспроизводимых замеров с эмуляцией сети (tc netem).
# Содержит стенд + headless Chromium. Запускается с cap NET_ADMIN, чтобы
# применять netem на интерфейсе lo. Контекст сборки — корень репозитория.
#
# Базовый образ — Debian 13 (Trixie, glibc 2.41): предсобранный нативный
# QUIC-модуль @fails-components/webtransport-transport-http3-quiche требует
# GLIBC_2.38, которого нет в bookworm (2.36).
FROM node:22-trixie

# chromium — для headless-раннера; iproute2 — tc netem; curl — проверка готовности;
# build-essential/python3/cmake — на случай пересборки нативного QUIC-модуля.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      iproute2 \
      curl \
      ca-certificates \
      fonts-liberation \
      build-essential \
      python3 \
      cmake \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*

# YARN_ENABLE_GLOBAL_CACHE=false — PnP и кэш генерируются локально в /app,
# иначе хостовый .pnp.cjs ссылался бы на несуществующий глобальный кэш.
# Хостовые .pnp.cjs/.pnp.loader.mjs исключены через .dockerignore — Yarn
# создаёт их заново под linux при install.
ENV CHROME_PATH=/usr/bin/chromium \
    BENCH_URL=http://127.0.0.1:8080 \
    YARN_ENABLE_GLOBAL_CACHE=false

WORKDIR /app
RUN corepack enable

COPY . .
RUN yarn install && yarn build

CMD ["bash", "experiment/run-all.sh"]
