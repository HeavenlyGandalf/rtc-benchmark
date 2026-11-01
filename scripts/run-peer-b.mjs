// peerB (multi-host H1): отвечающий пир. Поднимает headless Chrome, который:
//   1) выступает answerer'ом P2P WebRTC и отражает сообщения (эхо) для peerA;
//   2) подключается к relay-пути WebTransport и отражает дейтаграммы.
// После готовности выставляет флаг /api/ready и обслуживает до завершения peerA.
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium';
const URL = process.env.BENCH_URL ?? 'http://127.0.0.1:8080';
const MAX_SECS = Number(process.env.PEER_MAX_SECS ?? 180);

async function waitServer() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${URL}/api/info`)).ok) return;
    } catch { /* ещё не поднялся */ }
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
    '--user-data-dir=/tmp/chrome-peerb',
  ],
});

try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log('B>', m.text()));
  page.on('pageerror', (e) => console.error('B PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__bench, { timeout: 30_000 });

  await page.evaluate(async () => {
    const b = window.__bench;
    // P2P answerer: не ждём завершения (ждёт offer от peerA), после связи — эхо.
    b.p2pConnect('answerer')
      .then((r) => { window.__ansB = r; r.channel.onMessage((d) => r.channel.send(d)); console.log('p2p answerer + эхо готовы'); })
      .catch((e) => console.log('p2p answerer ошибка:', e.message));
    // Relay-эхо дейтаграмм.
    const info = await b.fetchServerInfo();
    const rl = await b.connectWtRelay(info);
    window.__relayB = rl;
    rl.channel.onMessage((d) => rl.channel.send(d));
    console.log('relay-эхо готово');
    await fetch('/api/ready', { method: 'POST' });
    console.log('ready выставлен');
  });

  console.log(`[peerB] обслуживаю до завершения peerA (макс ${MAX_SECS}с)...`);
  await new Promise((r) => setTimeout(r, MAX_SECS * 1000));
} finally {
  await browser.close();
}
