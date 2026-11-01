// Сценарий настоящего P2P WebRTC (проверка H1): две браузерные страницы —
// offerer и answerer — соединяются напрямую по DataChannel, сервер лишь
// ретранслирует SDP. Offerer измеряет RTT, answerer отражает сообщения (эхо).
// Для сравнения с клиент-серверным путём см. RTT из summary.csv (сценарий 2,
// WebRTC/надёжный) под тем же профилем.
//
// ВАЖНО (оговорка к H1): здесь оба пира на одном хосте (loopback), поэтому у P2P
// (A↔B) и клиент-серверного эха (A↔сервер) одинаковое число прохождений через lo.
// Полное преимущество P2P по задержке проявляется только при разнесении сервера
// на отдельный хост (multi-host). Здесь мы получаем корректные P2P-метрики
// установления и RTT; архитектурная разница задержки — предмет multi-host прогона.
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BENCH_URL ?? 'http://127.0.0.1:8080';
const PROFILE = process.env.PROFILE ?? 'none';
const rttParams = {
  count: Number(process.env.P2P_COUNT ?? 200),
  size: Number(process.env.P2P_SIZE ?? 256),
  intervalMs: Number(process.env.P2P_INTERVAL ?? 10),
  warmup: 10,
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
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    // Без этого Chrome прячет host-IP за mDNS .local-кандидатами, которые
    // между двумя страницами в headless не резолвятся и ICE не соединяется.
    '--disable-features=WebRtcHideLocalIpsWithMdns',
  ],
});

try {
  const pageA = await browser.newPage(); // offerer
  const pageB = await browser.newPage(); // answerer (эхо)
  for (const pg of [pageA, pageB]) {
    pg.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
    await pg.goto(URL, { waitUntil: 'networkidle0' });
    await pg.waitForFunction(() => !!window.__bench, { timeout: 30_000 });
  }

  console.log(`[p2p] профиль=${PROFILE}, установление двух пиров...`);

  // Соединение двух пиров параллельно: answerer отражает все входящие сообщения.
  const [offerSetupMs, answerSetupMs] = await Promise.all([
    pageA.evaluate(async () => {
      const r = await window.__bench.p2pConnect('offerer');
      window.__off = r;
      return r.setupMs;
    }),
    pageB.evaluate(async () => {
      const r = await window.__bench.p2pConnect('answerer');
      window.__ans = r;
      r.channel.onMessage((d) => { r.channel.send(d); });
      return r.setupMs;
    }),
  ]);
  console.log(`[p2p] установлено: offerer ${offerSetupMs.toFixed(1)} мс, answerer ${answerSetupMs.toFixed(1)} мс`);

  // RTT по прямому P2P-каналу (offerer шлёт, answerer отражает).
  const stats = await pageA.evaluate(async (p) => {
    return await window.__bench.runRttTest(window.__off.channel, p);
  }, rttParams);
  console.log(`[p2p] RTT P2P: медиана ${stats.median.toFixed(2)} мс, p95 ${stats.p95.toFixed(2)} мс, потери ${stats.lossPct.toFixed(2)}%`);

  await pageA.evaluate(() => window.__off?.pc.close());
  await pageB.evaluate(() => window.__ans?.pc.close());

  const ua = await pageA.evaluate(() => navigator.userAgent);
  const record = {
    scenario: 'p2p',
    profile: PROFILE,
    startedAt: new Date().toISOString(),
    env: { node: process.version, userAgent: ua, benchUrl: URL },
    rttParams,
    setup: { offerSetupMs, answerSetupMs },
    rtt: stats,
  };
  const dir = join('results', 'raw');
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
  const file = join(dir, `p2p-${PROFILE}-${ts}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`[p2p] сохранено: ${file}`);
} finally {
  await browser.close();
}
