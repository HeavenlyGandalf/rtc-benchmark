# Запуск эксперимента одной командой (раздел 4 отчёта ПР-3).
#
#   make image          собрать образ стенда (rtc-bench-exp)
#   make test           typecheck + модульные тесты статистики (на хосте)
#   make calibrate      только калибровка сети на топологии с маршрутизатором
#   make verify         сокращённый план + сравнение с эталоном results/reference
#   make verify-smoke   дымовой план для CI (2 профиля × 3 прогона, мягкие проверки)
#   make experiment     полный план E1+E2 (experiment/plan.json, 260 прогонов, ~7 ч)
#   make resume PLAN=experiment/plan-verify.json   дозапустить прерванную серию
#   make analyze NAME=verify   пересчитать анализ по сохранённым сырым данным
#   make reference      сделать текущий results/verify эталоном (для автора)
#   make h1             серия H1: P2P против relay (compose-multihost.yml)
#   make pilot          пилотный одноузловой прогон (netem на lo, compose.yml)
#
# Готовый образ можно не собирать, а взять по digest: make verify IMAGE=ghcr.io/...@sha256:...

IMAGE ?= rtc-bench-exp
COMPOSE_ROUTER = docker compose -f experiment/compose-router.yml
GIT_COMMIT ?= $(shell git rev-parse HEAD 2>/dev/null || echo unknown)
# Только отслеживаемые файлы: результаты серии в results/ сами по себе не «пачкают» код
GIT_DIRTY ?= $(shell test -z "$$(git status --porcelain --untracked-files=no 2>/dev/null)" && echo no || echo yes)
HOST_LABEL ?= $(shell uname -sm)
# Id локального образа (для образа из реестра — его digest); пишется в манифест
IMAGE_DIGEST = $(shell docker image inspect $(IMAGE) --format '{{.Id}}' 2>/dev/null || echo unknown)
NAME ?= verify
# Доп. аргументы сборки, например прокси хоста для Docker Desktop:
#   make image BUILD_ARGS="--build-arg HTTPS_PROXY=http://host.docker.internal:10809"
BUILD_ARGS ?=

# Каталоги, которые контейнер мог оставить за root (прерванный прогон на Linux),
# удаляются изнутри контейнера с тем же томом.
clean_results = docker run --rm -v "$(CURDIR)/results:/r" $(IMAGE) rm -rf $(addprefix /r/,$(1))

HOST_UID ?= $(shell id -u)
HOST_GID ?= $(shell id -g)

export IMAGE GIT_COMMIT GIT_DIRTY HOST_LABEL HOST_UID HOST_GID

.PHONY: image test calibrate verify verify-smoke experiment resume analyze reference h1 pilot clean

image:
	docker build $(BUILD_ARGS) -f experiment/Dockerfile -t $(IMAGE) .

test:
	yarn typecheck
	node scripts/test-stats.mjs

# Общий прогон плана на compose-router.yml; результат — results/<plan.name>/.
define run_plan
	IMAGE_DIGEST=$(IMAGE_DIGEST) PLAN=$(1) $(COMPOSE_ROUTER) up --abort-on-container-exit --exit-code-from bench; \
	status=$$?; $(COMPOSE_ROUTER) down --remove-orphans >/dev/null 2>&1; exit $$status
endef

calibrate:
	IMAGE_DIGEST=$(IMAGE_DIGEST) $(COMPOSE_ROUTER) run --rm -e PROFILES="lan wifi 4g 5g lossy limited" -e OUT_DIR=results/calibration \
	  bench bash -c 'ip route replace $$ROUTE_TO via $$ROUTE_VIA && node scripts/calibrate.mjs; s=$$?; chown -R $$HOST_UID:$$HOST_GID results/calibration; exit $$s'; \
	status=$$?; $(COMPOSE_ROUTER) down --remove-orphans >/dev/null 2>&1; exit $$status

verify:
	$(call clean_results,verify)
	$(call run_plan,experiment/plan-verify.json)
	node scripts/compare.mjs results/verify results/reference

verify-smoke:
	$(call clean_results,smoke)
	$(call run_plan,experiment/plan-smoke.json)
	COMPARE_MODE=smoke node scripts/compare.mjs results/smoke

experiment:
	$(call run_plan,experiment/plan.json)

# Дозапуск прерванной серии: готовые прогоны (raw/<run-id>.json) пропускаются,
# фон и калибровка снимаются заново перед продолжением.
PLAN ?= experiment/plan-verify.json
resume:
	$(call run_plan,$(PLAN))

analyze:
	node scripts/analyze.mjs results/$(NAME)

# Эталон — вся серия целиком (с сырыми данными), чтобы его анализ можно было пересчитать
reference:
	rm -rf results/reference
	cp -R results/verify results/reference

h1:
	for p in lan wifi 4g lossy; do \
	  PROFILE=$$p docker compose -f experiment/compose-multihost.yml up --abort-on-container-exit --exit-code-from peerA || exit 1; \
	  docker compose -f experiment/compose-multihost.yml down >/dev/null 2>&1; \
	done

pilot:
	docker compose -f experiment/compose.yml run --rm bench

clean:
	$(COMPOSE_ROUTER) down --remove-orphans
	$(call clean_results,smoke verify)
