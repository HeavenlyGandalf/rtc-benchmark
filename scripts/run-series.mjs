// Автоматический прогон серии измерений (сценарии 1–3) в headless Chrome.
// Собирает СЫРЫЕ числа через window.__bench (page.evaluate), а не текст из DOM.
// Один запуск = один прогон (единица анализа): свежий браузер, новые соединения.
// Пишет JSON в <OUT_DIR>/<RUN_ID>.json; манифест окружения — внутри записи.
//
// Требуется запущенный стенд (BENCH_URL). Профиль берётся из env PROFILE
// (метка в результате; саму сеть задаёт experiment/netem.mjs или netem-agent).
//
// Параметры серии (env, со значениями по умолчанию для быстрого прогона):
//   REPS, SETUP_WARMUP, ICE_MODES, RTT_COUNT, RTT_SIZE, RTT_INTERVAL, RTT_WARMUP,
//   TP_DURATION, TP_SIZE, TP_DRAIN, SEED, RUN_ID, OUT_DIR, BATCH, PLAN_INDEX
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32, shuffle } from './lib/rng.mjs';
import { startCpuMonitor } from './lib/monitor.mjs';
import { environmentManifest } from './lib/manifest.mjs';

const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BENCH_URL ?? 'http://127.0.0.1:8080';
const PROFILE = process.env.PROFILE ?? 'none';
const SEED = Number(process.env.SEED ?? Date.now() % 2 ** 31);
const OUT_DIR = process.env.OUT_DIR ?? join('results', 'raw');
const ts = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
const RUN_ID = process.env.RUN_ID ?? `${PROFILE}-${ts}`;

const params = {
  reps: Number(process.env.REPS ?? 30),
  setupWarmup: Number(process.env.SETUP_WARMUP ?? 1),
  iceModes: (process.env.ICE_MODES ?? 'full trickle').split(/\s+/).filter(Boolean),
  rtt: {
    count: Number(process.env.RTT_COUNT ?? 200),
    size: Number(process.env.RTT_SIZE ?? 256),
    intervalMs: Number(process.env.RTT_INTERVAL ?? 10),
    warmup: Number(process.env.RTT_WARMUP ?? 50),
  },
  throughput: {
    durationMs: Number(process.env.TP_DURATION ?? 3) * 1000,
    size: Number(process.env.TP_SIZE ?? 16384),
    drainMs: Number(process.env.TP_DRAIN ?? 700),
  },
};

// Проверка доступности стенда до запуска браузера.
try {
  const res = await fetch(`${URL}/api/info`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  console.error(`Стенд не отвечает по ${URL} (${err.message}). Запустите сервер.`);
  process.exit(1);
}

/** Метрики сервера за окно с прошлого вызова (CPU, задержка event loop). */
async function serverMetrics() {
  try {
    const res = await fetch(`${URL}/api/metrics?reset`);
    return res.ok ? await res.json() : null;
  } catch {
    return null; // старый сервер без /api/metrics
  }
}

const rand = mulberry32(SEED);
const startedAt = new Date().toISOString();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 600_000, // самый долгий page.evaluate — серия RTT по 4 каналам
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--no-first-run',
    // WebTransport доступен только в защищённом контексте: стенд по адресу
    // другого контейнера (топология с маршрутизатором) им по умолчанию не считается
    ...(/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(URL)
      ? []
      : [`--unsafely-treat-insecure-origin-as-secure=${URL}`, `--user-data-dir=/tmp/chrome-${process.pid}`]),
  ],
});

try {
  const chromium = await browser.version();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__bench, { timeout: 30_000 });
  const modes = await page.evaluate(() => window.__bench.MODES);

  console.log(`[series] ${RUN_ID}: профиль=${PROFILE}, сид=${SEED}, REPS=${params.reps}, RTT=${params.rtt.count}×${params.rtt.size}Б`);
  // CPU клиента и метрики сервера снимаются отдельно по окнам сценариев:
  // в сценарии 3 загрузка высокая по замыслу (канал насыщается), а валидность
  // замеров задержки оценивается по окнам сценариев 1 и 2.
  const cpu = {};
  const server = {};
  let monitor = startCpuMonitor();
  await serverMetrics(); // сброс окна
  const closeWindow = async (name) => {
    cpu[name] = monitor.stop();
    server[name] = await serverMetrics();
    monitor = startCpuMonitor();
  };

  // Сценарий 1: установление соединения. Порядок вариантов случайный.
  const setupVariants = shuffle(
    [{ kind: 'wt', key: 'wt' }, ...params.iceModes.map((m) => ({ kind: 'rtc', iceMode: m, key: `rtc-${m}` }))],
    rand,
  );
  const setup = {};
  for (const v of setupVariants) {
    setup[v.key] = await page.evaluate(
      (kind, reps, opts) => window.__bench.runSetupTest(kind, reps, undefined, opts),
      v.kind,
      params.reps,
      { iceMode: v.iceMode, warmup: params.setupWarmup },
    );
    console.log(`[series] 1 — установление ${v.key}: медиана ${setup[v.key].median.toFixed(2)} мс`);
  }
  // обратная совместимость с aggregate.mjs: rtc = текущий режим по умолчанию
  if (setup['rtc-full']) setup.rtc = setup['rtc-full'];
  setup.order = setupVariants.map((v) => v.key);
  await closeWindow('setup');

  // Сценарий 2: RTT по всем каналам (свежая сессия), порядок каналов случайный.
  const rttOrder = shuffle(modes, rand);
  const rtt = await page.evaluate(async (order, p) => {
    const b = window.__bench;
    const session = new b.BenchSession();
    await session.init();
    const out = [];
    try {
      for (const mode of order) {
        const ch = await session.channel(mode);
        const stats = await b.runRttTest(ch, p);
        out.push({ mode, stats });
      }
    } finally {
      await session.closeAll();
    }
    return out;
  }, rttOrder, params.rtt);
  for (const r of rtt) {
    console.log(`[series] 2 — RTT ${r.mode}: медиана ${r.stats.median.toFixed(2)} мс, p95 ${r.stats.p95.toFixed(2)} мс, потери ${r.stats.lossPct.toFixed(2)}%`);
  }
  await closeWindow('rtt');

  // Сценарий 3: пропускная способность (свежая сессия), порядок каналов случайный.
  const tpOrder = shuffle(modes, rand);
  const throughput = await page.evaluate(async (order, p) => {
    const b = window.__bench;
    const session = new b.BenchSession();
    await session.init();
    const out = [];
    try {
      for (const mode of order) {
        const ch = await session.channel(mode);
        const result = await b.runThroughputTest(ch, p);
        out.push({ mode, result });
      }
    } finally {
      await session.closeAll();
    }
    return out;
  }, tpOrder, params.throughput);
  for (const r of throughput) {
    console.log(`[series] 3 — throughput ${r.mode}: ${r.result.mbps.toFixed(2)} Мбит/с, потери ${r.result.lossPct.toFixed(2)}%`);
  }
  cpu.throughput = monitor.stop();
  server.throughput = await serverMetrics();

  const ua = await page.evaluate(() => navigator.userAgent);
  const record = {
    runId: RUN_ID,
    profile: PROFILE,
    batch: process.env.BATCH ?? 'main',
    planIndex: process.env.PLAN_INDEX ? Number(process.env.PLAN_INDEX) : null,
    seed: SEED,
    startedAt,
    finishedAt: new Date().toISOString(),
    env: { node: process.version, userAgent: ua, chromium, benchUrl: URL },
    manifest: environmentManifest({
      netem: process.env.NETEM_PROFILE_JSON ? JSON.parse(process.env.NETEM_PROFILE_JSON) : null,
      topology: process.env.TOPOLOGY ?? 'single-host',
    }),
    order: { setup: setup.order, rtt: rttOrder, throughput: tpOrder },
    monitor: { cpu, server },
    params,
    setup,
    rtt,
    throughput,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${RUN_ID}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`[series] сохранено: ${file}`);
} finally {
  await browser.close();
}
