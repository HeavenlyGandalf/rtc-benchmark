// peerA (multi-host H1): измеряющий пир. Ждёт готовности peerB, затем мерит RTT:
//   P2P   — прямое WebRTC-соединение A↔B (2 прохода через netem-линк);
//   relay — WebTransport через сервер A→сервер→B→сервер→A (4 прохода).
// Это и есть проверка H1: преимущество прямого P2P над клиент-серверным путём.
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium';
const URL = process.env.BENCH_URL ?? 'http://127.0.0.1:8080';
const PROFILE = process.env.PROFILE ?? 'none';
const params = {
  count: Number(process.env.H1_COUNT ?? 200),
  size: Number(process.env.H1_SIZE ?? 256),
  intervalMs: Number(process.env.H1_INTERVAL ?? 10),
  warmup: 10,
};

async function waitServer() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${URL}/api/info`)).ok) return; } catch { /* ещё нет */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`сервер не ответил по ${URL}`);
}

await waitServer();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    // Страница отдаётся по http://server:8080 (не localhost) → не secure context,
    // и WebTransport был бы недоступен. Разрешаем этот origin как доверенный.
    `--unsafely-treat-insecure-origin-as-secure=${URL}`,
    '--user-data-dir=/tmp/chrome-peera',
  ],
});

try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log('A>', m.text()));
  page.on('pageerror', (e) => console.error('A PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__bench, { timeout: 30_000 });

  // Ждём готовности peerB.
  await page.evaluate(async () => {
    for (let i = 0; i < 120; i++) {
      const { ready } = await (await fetch('/api/ready')).json();
      if (ready) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('peerB не стал готов');
  });
  console.log(`[peerA] профиль=${PROFILE}, peerB готов — измеряю...`);

  // P2P WebRTC (прямое A↔B).
  const p2p = await page.evaluate(async (p) => {
    const b = window.__bench;
    const r = await b.p2pConnect('offerer');
    const rtt = await b.runRttTest(r.channel, p);
    r.pc.close();
    return { setupMs: r.setupMs, rtt };
  }, params);
  console.log(`[peerA] P2P:   установление ${p2p.setupMs.toFixed(1)} мс, RTT медиана ${p2p.rtt.median.toFixed(2)} мс, p95 ${p2p.rtt.p95.toFixed(2)} мс, потери ${p2p.rtt.lossPct.toFixed(2)}%`);

  // Relay WebTransport (клиент-серверный путь A→сервер→B).
  const relay = await page.evaluate(async (p) => {
    const b = window.__bench;
    const info = await b.fetchServerInfo();
    const r = await b.connectWtRelay(info);
    const rtt = await b.runRttTest(r.channel, p);
    return { setupMs: r.setupMs, rtt };
  }, params);
  console.log(`[peerA] relay: установление ${relay.setupMs.toFixed(1)} мс, RTT медиана ${relay.rtt.median.toFixed(2)} мс, p95 ${relay.rtt.p95.toFixed(2)} мс, потери ${relay.rtt.lossPct.toFixed(2)}%`);

  const ratio = relay.rtt.median / p2p.rtt.median;
  console.log(`[peerA] H1: relay/P2P по медиане RTT = ${ratio.toFixed(2)}×`);

  const ua = await page.evaluate(() => navigator.userAgent);
  const record = { scenario: 'h1-multihost', profile: PROFILE, startedAt: new Date().toISOString(), env: { node: process.version, userAgent: ua, benchUrl: URL }, params, p2p, relay };
  const dir = join('results', 'raw');
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
  const file = join(dir, `h1-${PROFILE}-${ts}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`[peerA] сохранено: ${file}`);
} finally {
  await browser.close();
}
