// Конфигурация MathJax для этого сайта. Подключается в mkdocs.yml через
// extra_javascript раньше загрузчика tex-svg.js.
//
// Разделители \( \), \[ \] выдаёт расширение pymdownx.arithmatex с опцией
// generic: true: формулы приезжают в HTML как class="arithmatex", и разбирает
// их MathJax на странице.
window.MathJax = {
  tex: {
    inlineMath: [["\\(", "\\)"]],
    displayMath: [["\\[", "\\]"]],
    processEscapes: true,
    processEnvironments: true
  },
  options: {
    ignoreHtmlClass: ".*|",
    processHtmlClass: "arithmatex"
  }
};

// Перерисовка на лету не нужна: в mkdocs.yml не включён navigation.instant,
// страница перезагружается целиком и типографский проход запускается сам.
//
// Если navigation.instant всё же включат, здесь понадобится подписка:
//   document$.subscribe(function () {
//     MathJax.typesetClear();
//     MathJax.texReset();
//     MathJax.typesetPromise();
//   });
// Вызов MathJax.startup.output.clearCache(), который встречается в чужих
// инструкциях, в MathJax 3.2.2 не существует: clearCache есть у фабрики
// SVG-кэша, и такой вызов падает с TypeError в консоли.
