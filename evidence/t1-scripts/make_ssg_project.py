#!/usr/bin/env python3
"""T1: собрать один и тот же проект из 15 страниц для четырёх генераторов.

Зачем: выбрать генератор для документации стенда не на глаз, а по измерениям.
Чтобы числа были сравнимы, все четыре сборки получают один и тот же текст:
15 страниц одинаковой структуры, отличается только синтаксис.

Что различается намеренно:
  - формулы: MkDocs и Sphinx рисуют их на клиенте (MathJax), Quarto — на
    сервере (LaTeX), Pelican в этой версии без плагина математики, поэтому там
    формула остаётся исходным текстом. Это часть результата, а не огрех
    подготовки.
  - оглавление: у MkDocs и Sphinx оно в конфиге, у Pelican строится из
    структуры папок, у Quarto — из `toc.yml`.
"""
import os
import shutil
import textwrap

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ssg")

PAGES = [
    ("Обзор проекта", "Что измеряется и зачем"),
    ("Требования", "Что нужно для запуска"),
    ("Быстрый старт", "Первый запуск за пять минут"),
    ("Команды", "Сборка, проверка, публикация"),
    ("Переменные окружения", "Что можно переопределить"),
    ("Сценарии экспериментов", "Четыре сценария"),
    ("Методика", "Как снимаются числа"),
    ("Состав метрик", "Какие величины выдаёт стенд"),
    ("Результаты", "Как читать измерения"),
    ("Ограничения", "Чего измерения не показывают"),
    ("WebRTC", "Транспорт на WebRTC"),
    ("WebTransport", "Транспорт на WebTransport"),
    ("Сравнение транспортов", "Сопоставление каналов"),
    ("Публикация сайта", "Как выкладывается документация"),
    ("Отладка", "Что делать, если не работает"),
]

WORDS = [
    "Установление соединения измеряется от нажатия до первого обмена пакетами.",
    "Задержка считывается средствами браузера, а не собственными метками времени.",
    "Пропускная способность считается по числу принятых сообщений за интервал.",
    "Каждый сценарий выполняется несколько раз, единичный замер не показателен.",
    "Погрешность на loopback определяется планировщиком, а не сетью.",
    "Видеометрики выводятся потоково и не попадают в таблицу результатов.",
]


def body(index, title, subtitle):
    parts = [f"# {title}", "", subtitle, ""]
    for i, word in enumerate(WORDS):
        parts.append(f"{word} Абзац {index}-{i + 1} описывает часть методики "
                     f"и содержит достаточно текста, чтобы страница весила "
                     f"примерно одинаково в любом генераторе.")
        parts.append("")
    parts += [
        "## Параметры",
        "",
        "| Параметр | Значение |",
        "|---|---|",
        f"| Страница | {index + 1} из {len(PAGES)} |",
        "| Повторов | 3 |",
        "| Интервал | 100 мс |",
        "",
        "## Формула",
        "",
        "$$t_{connect} = \\frac{1}{n}\\sum_{i=1}^{n} t_i$$",
        "",
    ]
    return "\n".join(parts) + "\n"


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def vendor_mathjax(root):
    """Копирует локальный MathJax проекта в собираемый сайт.

    Без этого шага MkDocs собирает страницу вовсе без отрисовщика формул: в
    готовом HTML остаётся только `\\(...\\)`, и читатель видит формулу
    текстом. Путь к файлам берётся из docs/assets/mathjax самого проекта,
    чтобы сравнение шло на тех же настройках.
    """
    src = os.environ.get(
        "MATHJAX_SRC",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "mathjax"),
    )
    dest = os.path.join(root, "docs", "assets", "mathjax")
    os.makedirs(dest, exist_ok=True)
    for name in ("tex-svg.js", "mathjax-config.js"):
        shutil.copy(os.path.join(src, name), os.path.join(dest, name))


def build_mkdocs():
    root = os.path.join(ROOT, "mkdocs")
    shutil.rmtree(root, ignore_errors=True)
    nav = []
    for i, (title, sub) in enumerate(PAGES):
        slug = f"page-{i + 1:02d}"
        write(os.path.join(root, "docs", f"{slug}.md"), body(i, title, sub))
        nav.append(f"- {title}: {slug}.md")
    vendor_mathjax(root)
    write(
        os.path.join(root, "mkdocs.yml"),
        textwrap.dedent(
            """\
            site_name: T1
            theme:
              name: material
            markdown_extensions:
              - pymdownx.arithmatex:
                  generic: true
              - tables
            # MathJax лежит рядом с сайтом, а не в CDN: сборка документации не
            # должна зависеть от внешней сети, иначе формулы пропадают у того,
            # кто читает документацию из закрытого контура. Это тот же приём,
            # что и в самом проекте.
            extra_javascript:
              - assets/mathjax/tex-svg.js
              - assets/mathjax/mathjax-config.js
            nav:
            """
        )
        + "\n".join("  " + line for line in nav)
        + "\n",
    )


def build_sphinx():
    root = os.path.join(ROOT, "sphinx")
    shutil.rmtree(root, ignore_errors=True)
    toctree = []
    for i, (title, sub) in enumerate(PAGES):
        slug = f"page-{i + 1:02d}"
        write(os.path.join(root, "source", f"{slug}.md"), body(i, title, sub))
        toctree.append(slug)
    # Оглавление у MyST задаётся огороженной директивой. В этой сборке
    # myst-parser 5.1.0 варианты `.. toctree::` и `:::{toctree}` не
    # разрешились: обе строки попали в HTML как обычный текст, и сборка
    # завершилась с 15 предупреждениями «document isn't included in any
    # toctree». Огороженная форма отработала сразу.
    write(
        os.path.join(root, "source", "index.md"),
        "# T1\n\n```{toctree}\n:maxdepth: 2\n\n"
        + "\n".join(toctree)
        + "\n```\n",
    )

    write(
        os.path.join(root, "source", "conf.py"),
        textwrap.dedent(
            """\
            project = "T1"
            extensions = ["myst_parser"]
            # MyST не понимает `$$...$$` без явного включения dollarmath:
            # без него формула остаётся обычным текстом и никакой ошибки при
            # сборке не возникает — тихо неправильный результат.
            myst_enable_extensions = ["dollarmath"]
            html_theme = "alabaster"
            html_title = "T1"
            exclude_patterns = ["_build"]
            """
        ),
    )


def build_pelican():
    root = os.path.join(ROOT, "pelican")
    shutil.rmtree(root, ignore_errors=True)
    for i, (title, sub) in enumerate(PAGES):
        slug = f"page-{i + 1:02d}"
        # Pelican берёт заголовок из метаданных, а не из первой строки
        # Markdown, поэтому странице нужны front matter. Текст страницы при
        # этом ровно тот же, что и у остальных генераторов.
        front = f"Title: {title}\nDate: 2026-01-01\n\n"
        write(os.path.join(root, "content", f"{slug}.md"), front + body(i, title, sub))
    write(
        os.path.join(root, "pelicanconf.py"),
        textwrap.dedent(
            """\
            AUTHOR = "T1"
            SITENAME = "T1"
            PATH = "content"
            OUTPUT_PATH = "output"
            TIMEZONE = "UTC"
            DEFAULT_LANG = "ru"
            """
        ),
    )


def build_quarto():
    root = os.path.join(ROOT, "quarto")
    shutil.rmtree(root, ignore_errors=True)
    for i, (title, sub) in enumerate(PAGES):
        slug = f"page-{i + 1:02d}"
        write(os.path.join(root, f"{slug}.qmd"), body(i, title, sub))
    # Quarto считает заголовок из первого # сам, а оглавление задаётся отдельно.
    # У сайта в Quarto `toc` — это флажок боковой панели, а не список файлов:
    # список документов там недопустим, валидация требует true/false.
    # Раздел «оглавление» у сайта Quarto строится сам по заголовкам первого
    # уровня, поэтому перечислять файлы не нужно.
    toc = "toc: true\n"
    write(
        os.path.join(root, "_quarto.yml"),
        textwrap.dedent(
            """\
            project:
              type: website
            website:
              title: "T1"
            format:
              html:
                theme: cosmo
            """
        )
        + toc,
    )


for fn in (build_mkdocs, build_sphinx, build_pelican, build_quarto):
    fn()
    print(f"{fn.__name__}: готово")

for name in ("mkdocs", "sphinx", "pelican", "quarto"):
    total = sum(
        len(files) for _, _, files in os.walk(os.path.join(ROOT, name))
    )
    print(f"  {name}: файлов {total}")