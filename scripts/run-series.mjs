// Автоматический прогон серии измерений (сценарии 1–3) в headless Chrome.
// Собирает СЫРЫЕ числа через window.__bench (page.evaluate), а не текст из DOM.
// Пишет JSON в results/raw/<profile>-<timestamp>.json.
//
// Требуется запущенный стенд (BENCH_URL). Профиль берётся из env PROFILE
// (только метка в результате; саму сеть задаёт experiment/netem.mjs отдельно).
//
// Параметры серии (env, со значениями по умолчанию для быстрого прогона):
//   REPS, RTT_COUNT, RTT_SIZE, RTT_INTERVAL, TP_DURATION, TP_SIZE
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BENCH_URL ?? 'http://127.0.0.1:8080';
const PROFILE = process.env.PROFILE ?? 'none';

const params = {
  reps: Number(process.env.REPS ?? 30),
  rtt: {
    count: Number(process.env.RTT_COUNT ?? 200),
    size: Number(process.env.RTT_SIZE ?? 256),
    intervalMs: Number(process.env.RTT_INTERVAL ?? 10),
    warmup: 10,
  },
  throughput: {
    durationMs: Number(process.env.TP_DURATION ?? 3) * 1000,
    size: Number(process.env.TP_SIZE ?? 16384),
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

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--no-first-run',
  ],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__bench, { timeout: 30_000 });

  console.log(`[series] профиль=${PROFILE}, REPS=${params.reps}, RTT=${params.rtt.count}×${params.rtt.size}Б`);

  // Сценарий 1: установление соединения.
  const setup = await page.evaluate(async (reps) => {
    const b = window.__bench;
    const wt = await b.runSetupTest('wt', reps);
    const rtc = await b.runSetupTest('rtc', reps);
    return { wt, rtc };
  }, params.reps);
  console.log(`[series] 1 — установление: WT медиана ${setup.wt.median.toFixed(2)} мс, RTC медиана ${setup.rtc.median.toFixed(2)} мс`);

  // Сценарий 2: RTT по всем каналам (свежая сессия).
  const rtt = await page.evaluate(async (p) => {
    const b = window.__bench;
    const session = new b.BenchSession();
    await session.init();
    const out = [];
    try {
      for (const mode of b.MODES) {
        const ch = await session.channel(mode);
        const stats = await b.runRttTest(ch, p);
        out.push({ mode, stats });
      }
    } finally {
      await session.closeAll();
    }
    return out;
  }, params.rtt);
  for (const r of rtt) {
    console.log(`[series] 2 — RTT ${r.mode}: медиана ${r.stats.median.toFixed(2)} мс, p95 ${r.stats.p95.toFixed(2)} мс, потери ${r.stats.lossPct.toFixed(2)}%`);
  }

  // Сценарий 3: пропускная способность по всем каналам (свежая сессия).
  const throughput = await page.evaluate(async (p) => {
    const b = window.__bench;
    const session = new b.BenchSession();
    await session.init();
    const out = [];
    try {
      for (const mode of b.MODES) {
        const ch = await session.channel(mode);
        const result = await b.runThroughputTest(ch, p);
        out.push({ mode, result });
      }
    } finally {
      await session.closeAll();
    }
    return out;
  }, params.throughput);
  for (const r of throughput) {
    console.log(`[series] 3 — throughput ${r.mode}: ${r.result.mbps.toFixed(2)} Мбит/с, потери ${r.result.lossPct.toFixed(2)}%`);
  }

  const ua = await page.evaluate(() => navigator.userAgent);
  const record = {
    profile: PROFILE,
    startedAt: new Date().toISOString(),
    env: { node: process.version, userAgent: ua, benchUrl: URL },
    params,
    setup,
    rtt,
    throughput,
  };

  const dir = join('results', 'raw');
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
  const file = join(dir, `${PROFILE}-${ts}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`[series] сохранено: ${file}`);
} finally {
  await browser.close();
}
