# Как запустить стенд

## Требования

| Что | Версия / примечание |
|---|---|
| Node.js | **20 или новее** (проверено на 20.20.2), с поддержкой `fetch` |
| Yarn | **4.18.0** — подтягивается автоматически через Corepack (`packageManager` в `package.json`) |
| Браузер | **Chrome / Chromium** для сценария 4 и WebTransport в целом |
| openssl | нужен для генерации сертификата (есть в macOS и Linux из коробки) |
| Камера | для видеосценария нужен либо реальный девайс, либо фейковая камера Chrome |

Проверено на macOS (darwin/arm64). На Windows генерация сертификата требует
установленного `openssl` в PATH.

## Быстрый старт

```bash
corepack enable          # один раз: активировать Yarn 4 из package.json
yarn install             # установка зависимостей + нативного модуля QUIC
yarn start               # сборка клиента и запуск стенда
```

Откройте <http://localhost:8080> — в шапке должно быть
`✓ Все необходимые API поддерживаются (Chromium)`.

`yarn start` делает три вещи:

1. собирает клиентский бандл `public/app.js` из `src/client/**` (esbuild);
2. генерирует самоподписанный сертификат для WebTransport, если его нет или
   осталось меньше 12 часов;
3. поднимает два слушателя сервера.

Ожидаемый вывод:

```text
⚡ Done in 85ms
[CERT] генерирую новый ECDSA-сертификат (срок 13 дней)...
Сертификат создан: .../certs/cert.pem
sha256 Fingerprint=D0:2F:C3:...
[WT]   WebTransport (HTTP/3) слушает udp://0.0.0.0:4433, путь /echo
[HTTP] стенд доступен:    http://localhost:8080
[CERT] sha-256 отпечаток: D02FC36D...
```

Остановить стенд — `Ctrl+C` в терминале.

!!! note "Разрешения камеры"
    Камеру и микрофон браузер спросит при нажатии кнопок видеосценария — на
    localhost разрешение выдаётся автоматически.

## Команды

| Команда | Что делает |
|---|---|
| `yarn install` | Установка зависимостей. Собирает нативный модуль QUIC при первом запуске (1–2 минуты) |
| `yarn start` | Сборка клиента + запуск стенда (основная команда) |
| `yarn dev` | То же самое, но сервер перезапускается автоматически при правках в `src/server` |
| `yarn build` | Только сборка клиента: `src/client/main.ts` → `public/app.js` + sourcemap |
| `yarn typecheck` | Проверка типов всего `src/**` (tsc, без emit) |
| `yarn cert` | Принудительная перегенерация сертификата |
| `yarn test` | Smoke-тесты эха: WebRTC DataChannel, затем WebTransport (поток + дейтаграмма) |
| `yarn test:rtc` | Только WebRTC-часть |
| `yarn test:wt` | Только WebTransport-часть |
| `yarn e2e` | Полный прогон стенда в headless Chrome, делает скриншот |

!!! warning "После ручной правки `src/client/**`"
    Нужно выполнить `yarn build` (или запустить стенд через `yarn start` /
    `yarn dev` — они пересобирают бандл сами). Файл `public/app.js` лежит в
    репозитории и используется сервером как есть.

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `HTTP_PORT` | `8080` | HTTP/1.1: статика клиента, REST API, сигналинг WebRTC |
| `WT_PORT` | `4433` | HTTP/3 (QUIC, UDP): WebTransport echo |
| `CHROME_PATH` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | Путь к Chrome для `yarn e2e` |
| `BENCH_URL` | `http://localhost:8080` | Адрес стенда для `yarn e2e` |

Примеры:

```bash
HTTP_PORT=8081 WT_PORT=4434 yarn start       # другой порт, если 8080/4433 заняты
CHROME_PATH=/usr/bin/chromium yarn e2e       # нестандартный браузер
```

## Тесты

### Smoke-тесты эха

```bash
# в одном терминале — стенд
yarn start

# в другом — тесты
yarn test
```

Ожидаемый вывод:

```text
OK: data channel открыт
OK: эхо DataChannel: ping-123
OK: сессия установлена
OK: эхо потока: 000000050102030405
OK: эхо дейтаграммы: 090909
```

Тесты подключаются к стенду как обычные клиенты, но из Node, поэтому
дополнительно проверяют, что эхо-сервер работает на обоих транспортах.

### E2E-тест в браузере

```bash
yarn start     # терминал 1
yarn e2e       # терминал 2
```

Тест открывает стенд в headless Chrome с фейковой камерой, прогоняет все четыре
сценария с уменьшенными параметрами (3 повтора установления соединения,
50 сообщений RTT, 2 секунды на пропускную способность), печатает таблицу
результатов и сохраняет скриншот в `results/e2e-screenshot.png`. Камера
эмулируется флагами `--use-fake-device-for-media-stream`, отдельная установка не
нужна.

## Если что-то не запускается

| Симптом | Причина и решение |
|---|---|
| `Error: This package doesn't seem to be present in your lockfile` | Не установлены зависимости или удалён `yarn.lock`: выполните `yarn install` |
| `Cannot find module ...` при запуске | Не выполнен `yarn install`. Стирать `.pnp.cjs` вручную не нужно — его пересоздаёт установка |
| `Problem loading http3-quiche transport` | Не собран нативный модуль QUIC: `yarn install` (или `yarn rebuild @fails-components/webtransport-transport-http3-quiche`) |
| `Top-level await is currently not supported with the "cjs" output format` | В `package.json` потерян `"type": "module"` — без него tsx считает `.ts` CommonJS |
| `yarn tsc` не находит файлы | В `tsconfig.json` должен быть `"include": ["src/**/*.ts"]`, а не несуществующий каталог |
| Порт 8080 или 4433 занят | `HTTP_PORT=8081 WT_PORT=4434 yarn start` либо освободите порт |
| `EADDRINUSE: udp 4433` | Занят QUIC-порт, аналогично: смените `WT_PORT` |
| `Стенд не отвечает` при `yarn e2e` | Стенд не запущен: откройте `yarn start` в другом терминале |
| `Failed to launch the browser process` в e2e | Chrome не найден: укажите `CHROME_PATH=/путь/к/chrome` |
| WebTransport не подключается, а HTTP работает | Проверьте, что UDP-порт 4433 не заблокирован файрволом; попробуйте другой `WT_PORT` |
| В шапке страницы список unsupported API | Открыли не в Chromium либо браузер блокирует камеру вне HTTPS/localhost |
| `Chrome: invalid certificate` | Удалите `certs/`, затем `yarn cert` — сертификат пересоздастся |
| Метрики suspiciously быстрые, RTT < 1 мс | Это нормально для loopback: смотрите [Ограничения](limitations.md) |

## Сборка этого сайта

Сайт документации собирается отдельно от стенда, своим Python-окружением.
Сайт — производный артефакт: он читает код стенда, но никак его не меняет.

```bash
python3 -m venv .venv-docs                 # один раз: создать окружение
.venv-docs/bin/pip install -r requirements.txt

.venv-docs/bin/mkdocs serve                # предпросмотр на :8000
.venv-docs/bin/mkdocs build --strict       # строгая сборка в каталог site/
```

!!! warning "На macOS бинарник называется `pip3`, а не `pip`"
    В Homebrew-установленном Python команда `pip` в `PATH` отсутствует.
    Работают `pip3` и `python3 -m pip`. Отдельная установка `virtualenv` не
    требуется: состав зависимостей полностью зафиксирован в
    `requirements.txt`, поэтому достаточно встроенного `python3 -m venv`.

Требования зафиксированы в `requirements.txt` с точными версиями, конфигурация —
в `mkdocs.yml`, исходники страниц — в `docs/`. Каталоги `site/` и `.venv-docs/`
в репозиторий не попадают.

### Почему `--strict`

Строгая сборка падает на битую ссылку и на страницу, не попавшую в `nav`.
Это осознанно: молча потерянная страница хуже явной ошибки в CI. Локально
`--strict` стоит запускать всегда, а не только в пайплайне.

### Базовый адрес

Адрес публикации задаётся единственным полем в `mkdocs.yml`:

```yaml
site_url: "https://heavygendalf.github.io/rtc-benchmark/"
```

Отдельного поля `base_url` в MkDocs 1.6 нет — его попытка задать приводит к
ошибке `Unrecognised configuration name: base_url` и обрывает `--strict`.
Базовый путь выводится MkDocs из `site_url`.

Пока `site_url` не задан, `sitemap.xml` собирается **пустым** — это верный
признак неверной настройки, а не пустая сборка.

## Публикация сайта

Публикация выполняется автоматически: при каждом пуше в ветку `main` workflow
`.github/workflows/deploy.yml` собирает сайт и выкладывает его в GitHub Pages.

Обязательная разовая настройка в репозитории:
**Settings → Pages → Source = GitHub Actions**. Без неё сборка проходит, но
публикация не происходит.

Проверка после первого деплоя:

```bash
curl -sS -o /dev/null -w "главная → HTTP %{http_code}\n" \
  https://heavygendalf.github.io/rtc-benchmark/
curl -sS https://heavygendalf.github.io/rtc-benchmark/ | grep -c 'Сравнительный анализ'
curl -sS -o /dev/null -w "поиск → HTTP %{http_code}\n" \
  https://heavygendalf.github.io/rtc-benchmark/search_index.json
```

Полный разбор ошибок публикации — в [Отчёте об отладке](debugging.md).

