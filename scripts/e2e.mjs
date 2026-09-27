// E2E-тест стенда в headless Chrome (системный браузер + фейковая камера).
// Прогоняет все четыре сценария с уменьшенными параметрами и делает скриншот.
//
// Требуется запущенный стенд: в одном терминале `yarn start`,
// в другом — `yarn e2e`. Путь к Chrome переопределяется через CHROME_PATH.
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.BENCH_URL ?? 'http://localhost:8080';

// Превентивная проверка: без сервера падение будет выглядеть как ошибка браузера.
try {
  const res = await fetch(`${URL}/api/info`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  console.log('Стенд отвечает:', (await res.json()).wtUrl);
} catch (err) {
  console.error(`Стeнд не отвечает по ${URL} (${err.message}).`);
  console.error('Запустите сервер в другом терминале: yarn start');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--no-first-run',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 2400 });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

process.on('uncaughtException', async (err) => {
  console.error('FAIL:', err.message);
  try {
    const logText = await page.$eval('#log', (el) => el.textContent);
    console.error('--- журнал страницы ---\n' + logText);
  } catch { /* страница уже закрыта */ }
  process.exit(1);
});

await page.goto(URL, { waitUntil: 'networkidle0' });
const support = await page.$eval('#support', (el) => el.textContent);
console.log('Поддержка API:', support);

const setVal = (sel, v) =>
  page.$eval(sel, (el, val) => { el.value = String(val); }, v);

// Сценарий 1: установление соединения (3 повтора)
await setVal('#setup-reps', 3);
await page.click('#btn-setup');
await page.waitForFunction(
  () => document.getElementById('setup-progress').textContent === 'готово',
  { timeout: 60_000 },
);
console.log('Сценарий 1 WT: ', await page.$eval('#setup-wt', (el) => el.textContent));
console.log('Сценарий 1 RTC:', await page.$eval('#setup-rtc', (el) => el.textContent));

// Сценарий 2: RTT (50 сообщений, интервал 10 мс)
await setVal('#rtt-count', 50);
await setVal('#rtt-interval', 10);
await page.click('#btn-rtt');
await page.waitForFunction(
  () => document.getElementById('rtt-progress').textContent === 'готово',
  { timeout: 120_000 },
);
console.log('Сценарий 2: готово');

// Сценарий 3: throughput (2 секунды на режим)
await setVal('#tp-duration', 2);
await page.click('#btn-tp');
await page.waitForFunction(
  () => document.getElementById('tp-progress').textContent === 'готово',
  { timeout: 120_000 },
);
console.log('Сценарий 3: готово');

// Сценарий 4: видео — WebRTC
await page.click('#btn-video-rtc');
await page.waitForFunction(
  () => document.getElementById('rtc-video-stats').textContent.includes('мс') ||
        document.getElementById('rtc-video-stats').textContent.includes('FPS'),
  { timeout: 30_000 },
);
await new Promise((r) => setTimeout(r, 4000));
console.log('Видео WebRTC:      ', await page.$eval('#rtc-video-stats', (el) => el.textContent));

// Сценарий 4: видео — WebTransport + WebCodecs
await page.click('#btn-video-wt');
await new Promise((r) => setTimeout(r, 5000));
console.log('Видео WebTransport:', await page.$eval('#wt-video-stats', (el) => el.textContent));

// Итоговая таблица и скриншот
const rows = await page.$$eval('#results-body tr', (trs) =>
  trs.map((tr) => [...tr.children].map((td) => td.textContent).join(' | ')),
);
console.log('\n=== Таблица результатов ===');
rows.forEach((r) => console.log(r));

await page.screenshot({ path: 'results/e2e-screenshot.png', fullPage: true });
console.log('\nСкриншот: results/e2e-screenshot.png');

// стоп видео и выход
await page.click('#btn-video-rtc');
await page.click('#btn-video-wt');
await browser.close();
