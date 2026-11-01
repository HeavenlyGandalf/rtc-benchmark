// Сценарий масштабируемости (критерий К8 из НИР-2): как деградируют RTT и потери
// при росте числа ОДНОВРЕМЕННЫХ клиентов к одному серверу.
//   WebTransport (wt-stream/wt-datagram): N независимых QUIC-соединений.
//   WebRTC (rtc-reliable/rtc-unreliable): N RTCPeerConnection к эхо-серверу.
// Это проверяет тезис НИР-2 «один сервер — много клиентов» в клиент-серверном
// контексте (не P2P-mesh между браузерами — см. оговорку в отчёте).
//
// Параметры (env):
//   MODE (wt-stream|wt-datagram|rtc-reliable|rtc-unreliable, по умолч. wt-stream)
//   CLIENTS   — список N через пробел (по умолч. "1 5 10 20")
//   SCALE_COUNT, SCALE_SIZE, SCALE_INTERVAL — параметры RTT на клиента
//   PROFILE   — метка сетевого профиля (саму сеть задаёт netem отдельно)
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BENCH_URL ?? 'http://127.0.0.1:8080';
const PROFILE = process.env.PROFILE ?? 'none';
const MODE = process.env.MODE ?? 'wt-stream';
const CLIENTS = (process.env.CLIENTS ?? '1 5 10 20').split(/\s+/).map(Number).filter((n) => n > 0);
const rttParams = {
  count: Number(process.env.SCALE_COUNT ?? 100),
  size: Number(process.env.SCALE_SIZE ?? 256),
  intervalMs: Number(process.env.SCALE_INTERVAL ?? 10),
  warmup: 5,
};

try {
  const res = await fetch(`${URL}/api/info`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  console.error(`Стенд не отвечает по ${URL} (${err.message}).`);
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__bench, { timeout: 30_000 });

  console.log(`[scale] профиль=${PROFILE}, канал=${MODE}, N=[${CLIENTS.join(', ')}]`);

  const points = [];
  for (const n of CLIENTS) {
    const point = await page.evaluate(async (mode, n, params) => {
      const b = window.__bench;
      const sessions = [];
      // Открываем N клиентов (каждый — своё соединение).
      for (let i = 0; i < n; i++) {
        const s = new b.BenchSession();
        await s.init();
        sessions.push(s);
      }
      const channels = [];
      for (const s of sessions) channels.push(await s.channel(mode));

      // Параллельный ping-pong со всех клиентов.
      const t0 = performance.now();
      const statsArr = await Promise.all(channels.map((ch) => b.runRttTest(ch, params)));
      const wallMs = performance.now() - t0;

      for (const s of sessions) await s.closeAll();

      const medians = statsArr.map((s) => s.median).filter(Number.isFinite);
      const losses = statsArr.map((s) => s.lossPct).filter(Number.isFinite);
      const p95s = statsArr.map((s) => s.p95).filter(Number.isFinite);
      const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
      return {
        clients: n,
        wallMs,
        medianRttMs: avg(medians),
        maxP95Ms: p95s.length ? Math.max(...p95s) : NaN,
        meanLossPct: avg(losses),
      };
    }, MODE, n, rttParams);
    points.push(point);
    console.log(`[scale] N=${String(point.clients).padStart(3)}: RTT медиана ${point.medianRttMs.toFixed(2)} мс, max p95 ${point.maxP95Ms.toFixed(2)} мс, потери ${point.meanLossPct.toFixed(2)}%`);
  }

  const ua = await page.evaluate(() => navigator.userAgent);
  const record = { scenario: 'scalability', profile: PROFILE, mode: MODE, startedAt: new Date().toISOString(), env: { node: process.version, userAgent: ua, benchUrl: URL }, rttParams, points };
  const dir = join('results', 'raw');
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
  const file = join(dir, `scale-${MODE}-${PROFILE}-${ts}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`[scale] сохранено: ${file}`);
} finally {
  await browser.close();
}
