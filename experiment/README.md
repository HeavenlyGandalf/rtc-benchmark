# Эксперимент: замеры с эмуляцией сети

Инфраструктура Этапа 1 (см. [`docs/experiment-plan.md`](../docs/experiment-plan.md)):
воспроизводимый прогон сценариев 1–3 для WebRTC и WebTransport под
контролируемыми сетевыми профилями.

## Состав

| Файл | Назначение |
|---|---|
| `profiles.json` | сетевые профили (задержка/джиттер/потери/полоса) |
| `netem.mjs` | применение/снятие профиля через `tc netem` (нужен NET_ADMIN) |
| `../scripts/run-series.mjs` | один прогон серии (4 канала × сценарии 1–3), сырые числа → `results/raw/*.json` |
| `../scripts/aggregate.mjs` | сводка по прогонам → `results/summary.csv` + `summary.json` |
| `Dockerfile`, `compose.yml`, `run-all.sh` | Linux-стенд + headless Chromium + оркестрация всех профилей |

## Запуск (Docker, с эмуляцией сети)

```bash
docker compose -f experiment/compose.yml run --rm bench
```

Прогонит все профили из `compose.yml` (`PROFILES`), на каждом применит netem,
соберёт сырые данные и выполнит агрегацию. Результаты — в `./results/`
(`raw/*.json`, `summary.csv`, `summary.json`).

Сузить набор профилей или параметры:

```bash
PROFILES="lan lossy" REPS=30 docker compose -f experiment/compose.yml run --rm -e PROFILES -e REPS bench
```

## Профили

| Профиль | Задержка | Потери | Полоса |
|---|---|---|---|
| `lan` | 0 (базовая линия) | 0% | — |
| `wifi` | 15 мс ± 5 | 0.5% | — |
| `4g` | 50 мс ± 15 | 1% | — |
| `5g` | 25 мс ± 8 | 0.2% | — |
| `lossy` | 40 мс | 5% | — |
| `limited` | 20 мс | 0% | 5 Мбит/с |

**Методика:** netem задаётся на `lo`, через который проходят и запрос, и эхо,
поэтому измеренный RTT ≈ 2 × односторонней задержки профиля. Сравниваются
относительные величины WebRTC vs WebTransport при одинаковом профиле.

## Локальный прогон без эмуляции (быстрая проверка)

На хосте (сеть не эмулируется, профиль помечается как `none`):

```bash
yarn start          # в одном терминале
yarn series         # в другом: один прогон → results/raw/none-*.json
yarn aggregate      # сводка → results/summary.csv
```
