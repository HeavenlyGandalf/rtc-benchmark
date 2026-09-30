#!/usr/bin/env python3
"""T1: измерить время сборки одного и того же проекта из 15 страниц.

Четыре генератора, одинаковый текст, одинаковая машина. Каждая сборка
выполняется N раз: первый запуск прогревает кэш файлов и импорты, поэтому в
таблицу идут медиана и минимум из остальных.

Учитывается всё, что реально делает пользователь: для MkDocs — `mkdocs build`,
для Sphinx — `sphinx-build`, для Pelican — `pelican`, для Quarto — `quarto
render` (это внешний процесс на Node, время снимается целиком).
"""
import os
import shutil
import statistics
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "ssg")
VENV = os.path.join(HERE, "venv", "bin")
QUARTO = os.path.join(HERE, "quarto", "bin", "quarto")
RUNS = 5

TOOLS = [
    ("MkDocs 1.6.1 + Material 9.7.7", "mkdocs", f"{VENV}/mkdocs", ["build"]),
    (
        "Sphinx 9.1.0 + MyST 5.1.0",
        "sphinx",
        f"{VENV}/python",
        ["-m", "sphinx", "-b", "html", "source", "_build/html"],
    ),
    (
        "Pelican 4.12.0",
        "pelican",
        f"{VENV}/pelican",
        ["content", "-o", "output", "-s", "pelicanconf.py"],
    ),
    ("Quarto 1.8.24", "quarto", QUARTO, ["render"]),
]

OUT_DIRS = {
    "mkdocs": "site",
    "sphinx": "_build/html",
    "pelican": "output",
    "quarto": "_site",
}


def clean(sub):
    for path in OUT_DIRS.values():
        target = os.path.join(ROOT, sub, path)
        shutil.rmtree(target, ignore_errors=True)


def measure(label, sub, cmd, env=None):
    cwd = os.path.join(ROOT, sub)
    times = []
    stderr = ""
    for i in range(RUNS):
        clean(sub)
        start = time.perf_counter()
        proc = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, env=env
        )
        elapsed = time.perf_counter() - start
        if proc.returncode != 0:
            return None, proc.stderr.strip()[:400]
        times.append(elapsed)
        stderr = proc.stderr or proc.stdout
    # Первый запуск прогревает кэш импортов и файлов, он не показателен.
    warm = times[1:]
    return {
        "label": label,
        "min": min(warm),
        "median": statistics.median(warm),
        "max": max(warm),
        "all": times,
        "warnings": stderr,
    }, None


def dir_stats(path):
    total = 0
    files = 0
    html = 0
    for base, _, names in os.walk(path):
        for name in names:
            full = os.path.join(base, name)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            files += 1
            total += os.path.getsize(full)
            if name.endswith(".html"):
                html += 1
    return total, files, html


env = dict(os.environ)
env["PATH"] = f"{VENV}:{env.get('PATH', '')}"

print(f"{'генератор':<30} {'мин':>7} {'медиана':>8} {'макс':>7} "
      f"{'размер':>9} {'html':>5} {'файлов':>7}")
print("-" * 82)
rows = []
for label, sub, binary, args in TOOLS:
    result, err = measure(label, sub, [binary] + args, env=env)
    if result is None:
        print(f"{label:<30} СБОЙ: {err}")
        rows.append((label, None, err))
        continue
    size, files, html = dir_stats(os.path.join(ROOT, sub, OUT_DIRS[sub]))
    warn = result["warnings"].count("WARNING")
    print(f"{label:<30} {result['min']:>6.2f}с {result['median']:>7.2f}с "
          f"{result['max']:>6.2f}с {size/1024/1024:>8.2f}М {html:>5} {files:>7}")
    rows.append((label, result, f"{size/1024/1024:.2f}М, html={html}, файлов={files}"))

print()
print(f"Все запуски (с), включая первый ({RUNS} шт.), и предупреждения сборки:")
for label, result, note in rows:
    if result is None:
        print(f"  {label:<30} — нет данных")
        continue
    runs = ", ".join(f"{t:.2f}" for t in result["all"])
    print(f"  {label:<30} {runs}")
    if result["warnings"].count("WARNING"):
        first = [ln for ln in result["warnings"].splitlines()
                 if ln.startswith(("WARNING", "ERROR"))]
        for ln in first[:3]:
            print(f"      {ln.strip()[:110]}")