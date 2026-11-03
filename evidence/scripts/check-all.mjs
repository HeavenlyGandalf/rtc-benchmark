// C4: проверка всех страниц опубликованного сайта в реальном браузере.
// Проверяется то, чего не видно в исходном HTML:
//   - формулы рисует MathJax на клиенте, curl их не находит;
//   - таблицы и поиск работают после загрузки;
//   - ошибки в консоли и неудачные запросы видны только в браузере.
// Использование: yarn node check-all.mjs <url>
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base = process.argv[2].replace(/\/$/, '');
// Адрес, который страницы объявляют в link[rel=canonical]. Это site_url из
// mkdocs.yml, а не адрес, по которому страницу открыли: сайт один, и на
// зеркале Helios canonical обязан указывать на основной адрес. Без
// отдельного параметра проверка ругалась бы на Helios, показывая ровно то,
// что сделано правильно.
const canonicalBase = (process.argv[3] ?? base).replace(/\/$/, '');
if (!base) {
  console.error('Укажите адрес: yarn node check-all.mjs <url>');
  process.exit(2);
}

// Плагин social темы MkDocs Material ходит к api.github.com и получает 404,
// пока у репозитория нет GitHub Release. Это ожидаемо и не относится к
// содержимому сайта, но в отчёте должно быть видно, что запрос был.
const IGNORE = ['api.github.com'];

const PAGES = [
  '/', '/about/', '/debugging/', '/license/', '/limitations/', '/methodology/',
  '/results/', '/running/', '/scenarios/', '/webrtc/', '/webtransport/',
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-first-run'],
});

let bad = 0;
const expectedRequests = [];

for (const path of PAGES) {
  const url = base + path;
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1400 });

  const consoleErrors = [];
  const failed = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => failed.push(`${r.url()} — ${r.failure()?.errorText}`));
  // Раздельно ведём «настоящие» сбои и ожидаемые: сообщение консоли
  // «Failed to load resource … 404» не содержит адреса, поэтому отфильтровать
  // его по api.github.com нельзя. Вместо этого ожидаемые запросы считаются
  // отдельно, и общее текстовое сообщение консоли сбрасывается, когда
  // непокрытых сбоев нет.
  const ignoredHits = [];
  page.on('response', (r) => {
    if (r.status() < 400) return;
    if (IGNORE.some((s) => r.url().includes(s))) ignoredHits.push(`${r.url()} — HTTP ${r.status()}`);
    else failed.push(`${r.url()} — HTTP ${r.status()}`);
  });

  const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  // MathJax рисует формулы асинхронно; ждём его появления, а не фиксированную паузу.
  await page
    .waitForFunction(
      () => !document.querySelector('mjx-container') || window.MathJax?.startup?.promise,
      { timeout: 15000 },
    )
    .catch(() => {});
  await page
    .waitForFunction(() => document.readyState === 'complete', { timeout: 15000 })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 600));

  const info = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      title: document.title,
      h1: document.querySelector('h1')?.innerText?.trim() ?? '',
      canonical: document.querySelector('link[rel=canonical]')?.href ?? '',
      mjx: document.querySelectorAll('mjx-container').length,
      mjxSvg: document.querySelectorAll('mjx-container svg').length,
      // Неразобранный разделитель TeX остаётся в тексте, если MathJax не справился.
      leftovers: (text.match(/(^|\s)\$\$?[^$\n]{1,80}\$\$?/g) ?? []).filter((s) =>
        /\\[a-zA-Z]/.test(s),
      ).length,
      tables: document.querySelectorAll('table').length,
      rows: document.querySelectorAll('table tr').length,
      navLinks: document.querySelectorAll('.md-nav__link').length,
      brokenImgs: [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).length,
    };
  });

  const generic = (t) => /Failed to load resource/i.test(t);
  const errs = consoleErrors.filter(
    (t) =>
      !IGNORE.some((s) => t.includes(s)) &&
      // Текст без адреса: оставляем только если есть непокрытый сбой.
      !(generic(t) && failed.length === 0),
  );
  const fails = failed;
  if (ignoredHits.length) expectedRequests.push(...ignoredHits.map((u) => `${path} ${u}`));
  const status = resp?.status() ?? 0;
  const problems = [];
  if (status !== 200) problems.push(`HTTP ${status}`);
  if (info.leftovers) problems.push(`нераскрытых разделителей: ${info.leftovers}`);
  if (info.brokenImgs) problems.push(`битых картинок: ${info.brokenImgs}`);
  if (errs.length) problems.push(`ошибок консоли: ${errs.length}`);
  if (fails.length) problems.push(`неудачных запросов: ${fails.length}`);
  const wantCanonical = canonicalBase + (path === '/' ? '/' : path);
  if (info.canonical !== wantCanonical) {
    problems.push(`canonical ${info.canonical} вместо ${wantCanonical}`);
  }
  if (problems.length) bad++;

  console.log(
    `${problems.length ? 'FAIL' : 'ok  '} ${path.padEnd(14)} ` +
      `HTTP ${status} формул=${String(info.mjx).padStart(2)} svg=${String(info.mjxSvg).padStart(2)} ` +
      `таблиц=${info.tables} строк=${String(info.rows).padStart(3)} картинок-битых=${info.brokenImgs} ` +
      `canonical=${info.canonical ? 'ok' : 'НЕТ'} «${info.h1.slice(0, 28)}»` +
      (problems.length ? `  ← ${problems.join('; ')}` : ''),
  );
  for (const e of [...errs, ...fails].slice(0, 3)) console.log(`       ${e.slice(0, 120)}`);
  await page.close();
}

await browser.close();
console.log('\nОжидаемые внешние запросы (плагин social темы, 404 — нет GitHub Release):');
for (const u of [...new Set(expectedRequests)]) console.log(`  ${u}`);
console.log(bad ? `\n${bad} страниц с замечаниями` : '\nВсе страницы чисты');
process.exit(bad ? 1 : 0);
