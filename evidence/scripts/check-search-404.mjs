// C4: поиск по сайту и страница 404 в реальном браузере.
//
// Зачем отдельный скрипт: поиск в теме MkDocs Material работает на клиенте,
// результаты появляются в DOM после ввода, а не приходят в исходном HTML.
// Число результатов и число уникальных адресов — разные вещи: одна страница
// может попасть в выдачу несколько раз, по разным совпадениям. Отчёт
// различает их, поэтому измеряются оба.
//
// Использование:
//   yarn node check-search-404.mjs <адрес> "<запрос>" ["<запрос2>" ...]
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
const queries = process.argv.slice(3).filter(Boolean);

if (!base || !queries.length) {
  console.error('Использование: yarn node check-search-404.mjs <адрес> "<запрос>" [...]');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-first-run'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1000 });

for (const q of queries) {
  // Ждём главную: поисковая строка есть на каждой странице, но индекс
  // темы подгружается один раз и оттуда берутся результаты.
  await page.goto(base + '/', { waitUntil: 'networkidle2', timeout: 45000 });

  await page.waitForSelector('input.md-search__input', { timeout: 20000 });
  await page.click('input.md-search__input');
  await page.type('input.md-search__input', q, { delay: 30 });

  // Результаты в выдаче появляются не сразу: тема подгружает индекс и
  // дописывает совпадения по одному. Считать сразу после первого появления
  // нельзя — число результатов плавает от прогона к прогону. Поэтому ждём,
  // пока счётчик перестанет меняться.
  // Условие стабильности: одно и то же число на протяжении пяти замеров
  // подряд с интервалом 500 мс, то есть две с половиной секунды без
  // изменений. Меньше нельзя: выдача приходит волнами, и после первой
  // волны счётчик на секунду замирает, а потом растёт снова.
  const SETTLE_POLLS = 5;
  const POLL_MS = 500;
  const stable = async () => {
    let last = -1;
    let same = 0;
    for (let i = 0; i < 60; i++) {
      const n = await page.evaluate(
        () => document.querySelectorAll('.md-search-result__link').length,
      );
      same = n === last && n > 0 ? same + 1 : 0;
      if (same >= SETTLE_POLLS) return n;
      last = n;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return last;
  };
  const count = await stable();
  if (count === 0) {
    console.log(`${base.includes('ifmo') ? 'Helios' : 'Pages  '} поиск «${q}»: результатов нет`);
    continue;
  }

  const found = await page.evaluate(() => {
    const links = [...document.querySelectorAll('.md-search-result__link')].map((a) => {
      const href = a.getAttribute('href') ?? '';
      // Ссылка в выдаче несёт подсветку совпадения: ?h=паттерн и якорь
      // #фрагмент. Это делает адреса разными, хотя страница одна и та же,
      // поэтому страницы считаем отдельно — по pathname.
      let page = href;
      try {
        page = new URL(href, location.origin).pathname;
      } catch {
        page = href.split('?')[0].split('#')[0];
      }
      return { href, page, title: (a.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60) };
    });
    return {
      total: links.length,
      uniqueHrefs: [...new Set(links.map((l) => l.href))].length,
      pages: [...new Set(links.map((l) => l.page))],
    };
  });

  console.log(
    `${base.includes('ifmo') ? 'Helios  ' : 'Pages   '} поиск «${q}»: ` +
      `ссылок=${found.total}, уникальных адресов=${found.uniqueHrefs}, ` +
      `уникальных страниц=${found.pages.length} → ${found.pages.join(', ')}`,
  );
}

// Страница 404: заведомо несуществующий путь.
await page.goto(base + '/', { waitUntil: 'networkidle2', timeout: 45000 });
const resp = await page.goto(base + '/страница-такой-точно-нет/', {
  waitUntil: 'networkidle2',
  timeout: 45000,
});
const notFound = await page.evaluate(() => ({
  title: document.title,
  h1: (document.querySelector('h1')?.textContent ?? '').trim(),
}));
console.log(
  `${base.includes('ifmo') ? 'Helios  ' : 'Pages   '} 404: код=${resp?.status() ?? 0} ` +
    `title=«${notFound.title}» h1=«${notFound.h1}»`,
);

await browser.close();
