// Проверка опубликованной страницы документации в реальном браузере.
// Нужна потому, что часть требований не видна в исходном HTML:
//   - формулы рисует MathJax на клиенте, поэтому curl их не находит;
//   - ошибки в консоли и неудачные запросы видны только в браузере.
// Использование: yarn node check-site.mjs <url> [--screenshot <файл>]
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2];
const shotIdx = process.argv.indexOf('--screenshot');
const shot = shotIdx > -1 ? process.argv[shotIdx + 1] : undefined;

if (!url) {
  console.error('Укажите адрес: yarn node check-site.mjs <url>');
  process.exit(2);
}

const origin = new URL(url).origin;
const local = origin.includes('localhost') || origin.includes('127.0.0.1');

// --ignore <подстрока> — разрешить конкретные внешние запросы, не считая их
// проблемой. Нужен, например, для обращений плагина social темы MkDocs
// Material к api.github.com: они идут на локальную страницу в любом случае и
// о них нужно писать в отчёте, а не молча пропускать.
const ignores = process.argv.reduce((acc, a, i, arr) => {
  if (a === '--ignore' && arr[i + 1]) acc.push(arr[i + 1]);
  return acc;
}, []);
const ignored = (u) => ignores.filter((s) => u.includes(s));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-first-run'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1400 });

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const badResponses = [];
const externalRequests = new Set();

page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('requestfailed', (r) =>
  failedRequests.push(`${r.url()} — ${r.failure()?.errorText ?? '?'}`),
);
page.on('response', (r) => {
  const s = r.status();
  if (s >= 400 && !ignored(r.url()).length) badResponses.push(`${s} ${r.url()}`);
});
page.on('request', (r) => {
  const u = r.url();
  // data:-URI не запрос в сети, а встроенная картинка; интересуют только http(s).
  if (/^https?:/.test(u) && new URL(u).origin !== origin && !ignored(u).length) {
    externalRequests.add(u);
  }
});

const resp = await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
// Дать MathJax время на типографский проход.
await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));

const data = await page.evaluate(() => {
  // Разделители, показанные как код в самом тексте страницы, не считаются
  // нераскрытыми формулами: исключаю всё внутри code и pre.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const inCode = (node) => {
    for (let n = node.parentElement; n; n = n.parentElement) {
      if (n.tagName === 'CODE' || n.tagName === 'PRE') return true;
    }
    return false;
  };
  let leftover = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (inCode(n)) continue;
    leftover += (n.textContent.match(/\\\(|\\\[|\\\)|\\\]/g) ?? []).length;
  }
  return {
    title: document.title,
    h1: document.querySelector('h1')?.textContent?.trim() ?? null,
    canonical: document.querySelector('link[rel=canonical]')?.href ?? null,
    mathContainers: document.querySelectorAll('mjx-container').length,
    mathSvgs: document.querySelectorAll('mjx-container svg').length,
    leftoverDelimiters: leftover,
    navLinks: [...document.querySelectorAll('.md-nav a[href]')].map((a) => a.getAttribute('href')),
    searchInput: Boolean(document.querySelector('input[data-md-component=query]')),
    fonts: [...document.querySelectorAll('link[rel=stylesheet],link[rel=preload]')]
      .map((l) => l.href)
      .filter((h) => h.includes('font') || h.includes('googleapis')),
  };
});

// Пройти по внутренним ссылкам навигации и собрать коды ответа.
const internal = [...new Set(data.navLinks)].filter((h) => h && !/^https?:/.test(h));
const linkStatus = [];
for (const href of internal) {
  const abs = new URL(href, url).href;
  if (abs.replace(/#.*$/, '') !== url.replace(/#.*$/, '')) {
    const r = await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    linkStatus.push({ href, status: r?.status() ?? 0 });
  }
}

if (shot) await page.screenshot({ path: shot, fullPage: true });

await browser.close();

// Сообщение «Failed to load resource: the server responded with a status of
// NNN ()» не несёт адреса и целиком дублирует список badResponses, где тот же
// ответ записан вместе с URL. Оставляю только те, у которых есть причина.
const genericResourceErrors = consoleErrors.filter((t) =>
  /^Failed to load resource: the server responded with a status of \d+ \(\)$/.test(t.trim()),
);

const report = {
  url,
  http: resp?.status() ?? 0,
  ...data,
  consoleErrors: consoleErrors.filter((t) => !genericResourceErrors.includes(t)),
  genericResourceErrors,
  pageErrors,
  failedRequests,
  badResponses,
  externalRequests: [...externalRequests],
  linkStatus,
};

console.log(JSON.stringify(report, null, 2));

const problems = [];
if (report.http !== 200) problems.push(`HTTP ${report.http}`);
if (report.pageErrors.length) problems.push(`ошибки страницы: ${report.pageErrors.join('; ')}`);
if (report.consoleErrors.length) problems.push(`ошибки консоли: ${report.consoleErrors.join('; ')}`);
if (report.failedRequests.length) problems.push(`неудачные запросы: ${report.failedRequests.join('; ')}`);
if (report.badResponses.length) problems.push(`ответы с кодом >= 400: ${report.badResponses.join('; ')}`);
if (report.leftoverDelimiters) problems.push(`нераскрытых разделителей: ${report.leftoverDelimiters}`);
if (report.fonts.length) problems.push(`внешние шрифты: ${report.fonts.join('; ')}`);
const badLinks = report.linkStatus.filter((l) => l.status !== 200);
if (badLinks.length) problems.push(`битые ссылки навигации: ${JSON.stringify(badLinks)}`);

if (report.externalRequests.length) {
  const how = local ? 'внешние запросы (локально терпимы)' : 'ВНЕШНИЕ ЗАПРОСЫ';
  console.error(`\n${how}: ${report.externalRequests.join(', ')}`);
  if (!local) problems.push(`внешние запросы: ${report.externalRequests.join('; ')}`);
}

if (problems.length) {
  console.error('\nПРОБЛЕМЫ:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.error(
  `\nOK: HTTP ${report.http}, формул отрисовано ${report.mathSvgs}, ` +
    `ошибок нет, ссылки навигации отвечают 200.`,
);
