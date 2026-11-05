// Графики серии (раздел 5 отчёта ПР-4) — статические SVG без внешних зависимостей.
//   вход:  results/<name>/raw/*.json (выборки) и results/<name>/runs.csv (валидность прогонов,
//          поэтому сначала analyze.mjs); analysis.json — для подписей тренда
//   выход: results/<name>/plots/
//     box-rtt-p95-<size>.svg     p95 RTT по прогонам: ящик + точки отдельных прогонов
//     box-rtt-median-<size>.svg  медиана RTT по прогонам
//     box-setup.svg              время установления WT и RTC (полный сбор ICE / trickle)
//     ecdf-rtt-<size>.svg        ECDF RTT отдельных сообщений (все прогоны конфигурации)
//     stability.svg              метрика / медиана конфигурации против номера прогона
//     aa.svg                     A/A: партия A против партии B
//
// Цвет кодирует технологию (WebTransport — синий, WebRTC — оранжевый); канал
// подписан по оси. Четыре канала одним цветом на линию не различить (проверка
// палитры: оранжевый и жёлтый ближе порога различимости), поэтому надёжные и
// ненадёжные каналы на ECDF разнесены по разным панелям.
//
// Анализ — только валидные прогоны (как в analyze.mjs); его нужно запустить раньше:
// валидность берётся из runs.csv.
//
// Запуск: node scripts/plots.mjs results/full
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { median, quantile } from './lib/stats.mjs';
import { mulberry32 } from './lib/rng.mjs';

const DIR = process.argv[2] ?? 'results/full';
const RAW = join(DIR, 'raw');
const OUT = join(DIR, 'plots');

const C = {
  surface: '#fcfcfb',
  text: '#0b0b0b',
  text2: '#52514e',
  muted: '#8a8984',
  grid: '#e6e5e1',
  axis: '#b9b8b2',
  wt: '#2a78d6',
  rtc: '#eb6834',
};
const FONT = "font-family='-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif'";
const PROFILE_ORDER = ['lan', 'wifi', '5g', '4g', '4g-noreorder', 'lossy', 'limited'];
const CHANNELS = [
  { key: 'wt-stream', label: 'WT\nпоток', tech: 'wt' },
  { key: 'rtc-reliable', label: 'RTC\nнадёжн.', tech: 'rtc' },
  { key: 'wt-datagram', label: 'WT\nдейтагр.', tech: 'wt' },
  { key: 'rtc-unreliable', label: 'RTC\nненадёжн.', tech: 'rtc' },
];
const SETUPS = [
  { key: 'wt', label: 'WT', tech: 'wt' },
  { key: 'rtc-trickle', label: 'RTC\ntrickle ICE', tech: 'rtc' },
  { key: 'rtc-full', label: 'RTC\nполный сбор', tech: 'rtc' },
];

// --- данные ---
if (!existsSync(join(DIR, 'runs.csv'))) {
  console.error(`нет ${DIR}/runs.csv — сначала node scripts/analyze.mjs ${DIR}`);
  process.exit(1);
}
const csv = readFileSync(join(DIR, 'runs.csv'), 'utf8').replace(/^﻿/, '').trim().split('\n');
const header = csv[0].split(';');
const validById = new Map(
  csv.slice(1).map((line) => {
    const cells = line.split(';');
    return [cells[header.indexOf('runId')], cells[header.indexOf('valid')] === 'true'];
  }),
);
const records = readdirSync(RAW)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(RAW, f), 'utf8')))
  .filter((r) => validById.get(r.runId));
const runIndex = (r) => r.planIndex ?? Number.parseInt(r.runId, 10);
const profiles = PROFILE_ORDER.filter((p) => records.some((r) => r.profile === p)).concat(
  [...new Set(records.map((r) => r.profile))].filter((p) => !PROFILE_ORDER.includes(p)),
);
const sizes = [...new Set(records.map((r) => r.params.rtt.size))].sort((a, b) => a - b);
const main = records.filter((r) => r.batch !== 'B');
const rttStat = (r, mode, stat) => r.rtt.find((x) => x.mode === mode)?.stats?.[stat];
const setupMedian = (r, key) => median(r.setup[key]?.samples ?? []);

// --- SVG-примитивы ---
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v) => (Math.round(v * 10) / 10).toString();
const fmt = (v) => {
  const a = Math.abs(v);
  if (a === 0) return '0';
  const d = a >= 10 ? 0 : a >= 1 ? 1 : 2;
  return v.toFixed(d).replace('.', ',');
};
function text(x, y, s, { size = 12, fill = C.text2, anchor = 'start', weight = 400 } = {}) {
  return `<text x='${num(x)}' y='${num(y)}' font-size='${size}' fill='${fill}' text-anchor='${anchor}' font-weight='${weight}'>${esc(s)}</text>`;
}
function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) hi = lo + 1;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(Number(t.toFixed(10)));
  return { ticks, lo: Math.min(lo, ticks[0]), hi: Math.max(hi, ticks.at(-1)) };
}
function svgDoc(width, height, body, title) {
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}' ${FONT} role='img' aria-label='${esc(title)}'>
<title>${esc(title)}</title>
<rect width='${width}' height='${height}' fill='${C.surface}'/>
${body}
</svg>
`;
}
function legend(x, y, items) {
  let out = '';
  let cx = x;
  for (const it of items) {
    if (it.line) out += `<line x1='${cx}' y1='${y - 4}' x2='${cx + 18}' y2='${y - 4}' stroke='${it.color}' stroke-width='2'/>`;
    else out += `<rect x='${cx}' y='${y - 10}' width='12' height='12' rx='2' fill='${it.color}' fill-opacity='0.25' stroke='${it.color}' stroke-width='1.5'/>`;
    const w = it.line ? 24 : 18;
    out += text(cx + w, y, it.label, { fill: C.text2 });
    cx += w + it.label.length * 7 + 22;
  }
  return out;
}

/** Панель с ящиками и точками прогонов. groups: [{label, color, values}] */
function boxPanel(x, y, w, h, title, groups, { unit = 'мс', zero = true, seed = 1, refLine = null } = {}) {
  const all = groups.flatMap((g) => g.values).filter(Number.isFinite);
  let out = text(x, y - 8, title, { size: 13, fill: C.text, weight: 600 });
  if (!all.length) return out + text(x + w / 2, y + h / 2, 'нет данных', { anchor: 'middle', fill: C.muted });
  const lo0 = zero ? 0 : Math.min(...all);
  const pad = (Math.max(...all) - lo0) * 0.06 || 1;
  const { ticks, lo, hi } = niceTicks(zero ? 0 : lo0 - pad, Math.max(...all) + pad, 4);
  const plotX = x + 44;
  const plotW = w - 48;
  const ys = (v) => y + h - ((v - lo) / (hi - lo)) * h;
  for (const t of ticks) {
    out += `<line x1='${plotX}' x2='${plotX + plotW}' y1='${num(ys(t))}' y2='${num(ys(t))}' stroke='${C.grid}' stroke-width='1'/>`;
    out += text(plotX - 6, ys(t) + 4, fmt(t), { size: 11, anchor: 'end', fill: C.muted });
  }
  if (refLine != null) out += `<line x1='${plotX}' x2='${plotX + plotW}' y1='${num(ys(refLine))}' y2='${num(ys(refLine))}' stroke='${C.text2}' stroke-width='1' stroke-dasharray='4 3'/>`;
  out += text(x, y + 4, unit, { size: 10, fill: C.muted });
  const band = plotW / groups.length;
  const rand = mulberry32(seed);
  groups.forEach((g, i) => {
    const v = g.values.filter(Number.isFinite);
    const cx = plotX + band * (i + 0.5);
    const bw = Math.min(34, band * 0.5);
    g.label.split('\n').forEach((line, k) => {
      out += text(cx, y + h + 16 + k * 13, line, { size: 11, anchor: 'middle', fill: k ? C.text2 : C.text });
    });
    if (!v.length) return;
    const q1 = quantile(v, 0.25);
    const q3 = quantile(v, 0.75);
    const md = median(v);
    const iqr = q3 - q1;
    const inside = v.filter((t) => t >= q1 - 1.5 * iqr && t <= q3 + 1.5 * iqr);
    const wLo = Math.min(...inside);
    const wHi = Math.max(...inside);
    out += `<line x1='${num(cx)}' x2='${num(cx)}' y1='${num(ys(wLo))}' y2='${num(ys(q1))}' stroke='${g.color}' stroke-width='1.5'/>`;
    out += `<line x1='${num(cx)}' x2='${num(cx)}' y1='${num(ys(q3))}' y2='${num(ys(wHi))}' stroke='${g.color}' stroke-width='1.5'/>`;
    out += `<rect x='${num(cx - bw / 2)}' y='${num(ys(q3))}' width='${num(bw)}' height='${num(Math.max(1, ys(q1) - ys(q3)))}' rx='3' fill='${g.color}' fill-opacity='0.18' stroke='${g.color}' stroke-width='1.5'/>`;
    out += `<line x1='${num(cx - bw / 2)}' x2='${num(cx + bw / 2)}' y1='${num(ys(md))}' y2='${num(ys(md))}' stroke='${g.color}' stroke-width='2.5'/>`;
    for (const t of v) {
      const jx = cx + bw / 2 + 6 + rand() * Math.min(14, band * 0.2);
      out += `<circle cx='${num(jx)}' cy='${num(ys(t))}' r='2.6' fill='${g.color}' stroke='${C.surface}' stroke-width='1'/>`;
    }
    // медиана по прогонам — под подписью группы, чтобы не налезать на точки соседей
    out += text(cx, y + h + 16 + g.label.split('\n').length * 13, `м = ${fmt(md)}`, { size: 11, anchor: 'middle', fill: C.text, weight: 600 });
  });
  out += `<line x1='${plotX}' x2='${plotX + plotW}' y1='${y + h}' y2='${y + h}' stroke='${C.axis}' stroke-width='1'/>`;
  return out;
}

function grid(n, cols, cellW, cellH, top, left = 16) {
  return Array.from({ length: n }, (_, i) => ({ x: left + (i % cols) * cellW, y: top + Math.floor(i / cols) * cellH }));
}

const files = [];
function save(name, svg) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), svg);
  files.push(name);
}
const techLegend = [
  { label: 'WebTransport', color: C.wt },
  { label: 'WebRTC', color: C.rtc },
];

// --- 1–2. Ящики RTT по прогонам ---
for (const size of sizes) {
  for (const stat of ['p95', 'median']) {
    const cols = 4;
    const cellW = 330;
    const cellH = 280;
    const pos = grid(profiles.length, cols, cellW, cellH, 84);
    let body = text(16, 26, `${stat === 'p95' ? 'p95' : 'Медиана'} RTT прикладного уровня за прогон, размер сообщения ${size} Б`, { size: 16, fill: C.text, weight: 600 });
    body += text(16, 46, 'Точка — один прогон (единица анализа); ящик — квартили, усы — 1,5 IQR, «м» — медиана по прогонам. Шкалы панелей разные.', { size: 12 });
    body += legend(16, 68, techLegend);
    profiles.forEach((p, i) => {
      const rows = main.filter((r) => r.profile === p && r.params.rtt.size === size);
      const groups = CHANNELS.map((ch) => ({ label: ch.label, color: C[ch.tech], values: rows.map((r) => rttStat(r, ch.key, stat)) }));
      body += boxPanel(pos[i].x, pos[i].y + 20, cellW - 30, cellH - 100, `${p} (n = ${rows.length})`, groups, { seed: i + 1 });
    });
    const height = 84 + Math.ceil(profiles.length / cols) * cellH;
    save(`box-rtt-${stat}-${size}.svg`, svgDoc(16 + cols * cellW, height, body, `${stat} RTT по прогонам, ${size} Б`));
  }
}

// --- 3. Время установления ---
{
  const cols = 4;
  const cellW = 330;
  const cellH = 280;
  const pos = grid(profiles.length, cols, cellW, cellH, 84);
  let body = text(16, 26, 'Время установления соединения: медиана рукопожатий за прогон', { size: 16, fill: C.text, weight: 600 });
  body += text(16, 46, 'Оба размера сообщения вместе (установление от размера не зависит). Точка — прогон. Шкалы панелей разные.', { size: 12 });
  body += legend(16, 68, techLegend);
  profiles.forEach((p, i) => {
    const rows = main.filter((r) => r.profile === p);
    const groups = SETUPS.map((s) => ({ label: s.label, color: C[s.tech], values: rows.map((r) => setupMedian(r, s.key)) }));
    body += boxPanel(pos[i].x, pos[i].y + 20, cellW - 30, cellH - 100, `${p} (n = ${rows.length})`, groups, { seed: 100 + i });
  });
  save('box-setup.svg', svgDoc(16 + cols * cellW, 84 + Math.ceil(profiles.length / cols) * cellH, body, 'Время установления соединения'));
}

// --- 4. ECDF RTT сообщений ---
function ecdfPanel(x, y, w, h, title, allSeries) {
  let out = text(x, y - 8, title, { size: 13, fill: C.text, weight: 600 });
  // канал без выборок (например, все прогоны конфигурации невалидны) не рисуется
  const series = allSeries.filter((s) => s.sorted.length);
  if (!series.length) return out + text(x + w / 2, y + h / 2, 'нет данных', { anchor: 'middle', fill: C.muted });
  const xMin = Math.min(...series.map((s) => s.sorted[0]));
  // хвост за p99,5 обрезан, чтобы основная часть кривой не сжималась в угол
  const xMax = Math.max(...series.map((s) => s.sorted[Math.floor(s.sorted.length * 0.995)] ?? s.sorted.at(-1)));
  const { ticks, lo, hi } = niceTicks(Math.max(0, xMin - (xMax - xMin) * 0.03), xMax, 4);
  const plotX = x + 34;
  const plotW = w - 40;
  const xs = (v) => plotX + ((Math.min(v, hi) - lo) / (hi - lo)) * plotW;
  const ys = (q) => y + h - q * h;
  for (const q of [0, 0.25, 0.5, 0.75, 0.95]) {
    out += `<line x1='${plotX}' x2='${plotX + plotW}' y1='${num(ys(q))}' y2='${num(ys(q))}' stroke='${q === 0.95 ? C.axis : C.grid}' stroke-width='1' ${q === 0.95 ? "stroke-dasharray='3 3'" : ''}/>`;
    out += text(plotX - 5, ys(q) + 4, q === 0.95 ? '0,95' : fmt(q), { size: 10, anchor: 'end', fill: C.muted });
  }
  for (const t of ticks) out += text(xs(t), y + h + 15, fmt(t), { size: 10, anchor: 'middle', fill: C.muted });
  out += text(plotX + plotW, y + h + 28, 'RTT, мс', { size: 10, anchor: 'end', fill: C.muted });
  for (const s of series) {
    const n = s.sorted.length;
    const pts = [];
    const steps = 300;
    for (let k = 0; k <= steps; k++) {
      const q = k / steps;
      const v = s.sorted[Math.min(n - 1, Math.floor(q * (n - 1)))];
      if (v > hi) break;
      pts.push(`${num(xs(v))},${num(ys(q))}`);
    }
    out += `<polyline points='${pts.join(' ')}' fill='none' stroke='${s.color}' stroke-width='2' stroke-linejoin='round' ${s.dash ? `stroke-dasharray='${s.dash}'` : ''}/>`;
  }
  out += `<line x1='${plotX}' x2='${plotX + plotW}' y1='${y + h}' y2='${y + h}' stroke='${C.axis}' stroke-width='1'/>`;
  return out;
}
for (const size of sizes) {
  const cellW = 230;
  const cellH = 210;
  const rowsSpec = [
    { label: 'надёжные', pairs: ['wt-stream', 'rtc-reliable'] },
    { label: 'ненадёжные', pairs: ['wt-datagram', 'rtc-unreliable'] },
  ];
  let body = text(16, 26, `ECDF RTT отдельных сообщений, размер ${size} Б (все валидные прогоны конфигурации)`, { size: 16, fill: C.text, weight: 600 });
  body += text(16, 46, 'Верхний ряд — надёжные каналы (WT-поток и RTC reliable), нижний — ненадёжные (WT-дейтаграммы и RTC unreliable).', { size: 12 });
  body += text(16, 62, 'Пунктир — уровень p95; хвост за p99,5 обрезан. Шкалы X разные.', { size: 12 });
  body += legend(16, 84, techLegend.map((t) => ({ ...t, line: true })));
  rowsSpec.forEach((row, ri) => {
    profiles.forEach((p, pi) => {
      const rows = main.filter((r) => r.profile === p && r.params.rtt.size === size);
      const series = row.pairs.map((mode) => {
        const ch = CHANNELS.find((c) => c.key === mode);
        const sorted = rows.flatMap((r) => r.rtt.find((x) => x.mode === mode)?.stats?.samples ?? []).filter(Number.isFinite).sort((a, b) => a - b);
        return { color: C[ch.tech], sorted };
      });
      body += ecdfPanel(16 + pi * cellW, 120 + ri * cellH, cellW - 24, cellH - 60, `${p} · ${row.label}`, series);
    });
  });
  save(`ecdf-rtt-${size}.svg`, svgDoc(16 + profiles.length * cellW, 120 + 2 * cellH, body, `ECDF RTT, ${size} Б`));
}

// --- 5. Стабильность во времени ---
{
  const analysis = existsSync(join(DIR, 'analysis.json')) ? JSON.parse(readFileSync(join(DIR, 'analysis.json'), 'utf8')) : null;
  const trends = analysis?.stability?.trends ?? [];
  const metrics = [
    ['setup.wt', 'установление WT', (r) => setupMedian(r, 'wt')],
    ['setup.rtc-trickle', 'установление RTC trickle', (r) => setupMedian(r, 'rtc-trickle')],
    ['rtt.wt-datagram.median', 'медиана RTT WT-дейтагр.', (r) => rttStat(r, 'wt-datagram', 'median')],
    ['rtt.rtc-unreliable.median', 'медиана RTT RTC ненадёжн.', (r) => rttStat(r, 'rtc-unreliable', 'median')],
    ['rtt.wt-stream.p95', 'p95 RTT WT-поток', (r) => rttStat(r, 'wt-stream', 'p95')],
    ['rtt.rtc-reliable.p95', 'p95 RTT RTC надёжн.', (r) => rttStat(r, 'rtc-reliable', 'p95')],
  ];
  const cols = 3;
  const cellW = 440;
  const cellH = 230;
  let body = text(16, 26, 'Стабильность во времени: метрика прогона / медиана её конфигурации против номера прогона', { size: 16, fill: C.text, weight: 600 });
  body += text(16, 46, 'Все валидные прогоны (включая A/A-партию) в порядке выполнения. Линия — скользящая медиана по 15 прогонам; 1 — медиана конфигурации; △ — точка за пределами шкалы.', { size: 12 });
  const pos = grid(metrics.length, cols, cellW, cellH, 80);
  metrics.forEach(([key, label, get], i) => {
    const pts = records
      .map((r) => {
        const same = records.filter((q) => q.profile === r.profile && q.params.rtt.size === r.params.rtt.size).map(get);
        return { x: runIndex(r), y: get(r) / median(same) };
      })
      .filter((p) => Number.isFinite(p.y) && Number.isFinite(p.x))
      .sort((a, b) => a.x - b.x);
    const { x, y } = pos[i];
    if (!pts.length) {
      body += text(x, y + 6, `${label}: нет данных`, { size: 13, fill: C.muted });
      return;
    }
    const w = cellW - 40;
    const h = cellH - 80;
    const t = trends.find((tr) => tr.metric === key);
    const note = t ? `ρ = ${t.rho.toFixed(2).replace('.', ',')}, p_Holm ${t.pHolm < 0.001 ? '< 0,001' : `= ${t.pHolm.toFixed(3).replace('.', ',')}`}, дрейф ${(t.drift * 100).toFixed(1).replace('.', ',')} %` : '';
    body += text(x, y + 6, label, { size: 13, fill: C.text, weight: 600 });
    body += text(x, y + 22, note, { size: 11, fill: C.text2 });
    const ylo = Math.min(0.8, quantile(pts.map((p) => p.y), 0.01));
    const yhi = Math.max(1.2, quantile(pts.map((p) => p.y), 0.99));
    const { ticks, lo, hi } = niceTicks(ylo, yhi, 4);
    const maxX = Math.max(...pts.map((p) => p.x), 1);
    const plotX = x + 36;
    const plotY = y + 36;
    const xs = (v) => plotX + (v / maxX) * (w - 36);
    const ys = (v) => plotY + h - ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * h;
    for (const tk of ticks) {
      body += `<line x1='${plotX}' x2='${plotX + w - 36}' y1='${num(ys(tk))}' y2='${num(ys(tk))}' stroke='${tk === 1 ? C.axis : C.grid}' stroke-width='1'/>`;
      body += text(plotX - 5, ys(tk) + 4, fmt(tk), { size: 10, anchor: 'end', fill: C.muted });
    }
    for (const p of pts) {
      const cx = num(xs(p.x));
      if (p.y > hi || p.y < lo) {
        // за пределами шкалы: полый треугольник у края, вершиной в сторону выброса
        // нижний треугольник чуть приподнят, чтобы не касаться подписей оси X
        const cy = ys(p.y) - (p.y < lo ? 5 : 0);
        const d = p.y > hi ? -5 : 5;
        body += `<path d='M${cx},${num(cy + d)} l-4,${-d} h8 z' fill='${C.surface}' stroke='${C.wt}' stroke-width='1.5'/>`;
      } else {
        body += `<circle cx='${cx}' cy='${num(ys(p.y))}' r='2.4' fill='${C.wt}' fill-opacity='0.55'/>`;
      }
    }
    const roll = pts.map((p, k) => `${num(xs(p.x))},${num(ys(median(pts.slice(Math.max(0, k - 7), k + 8).map((q) => q.y))))}`);
    body += `<polyline points='${roll.join(' ')}' fill='none' stroke='${C.text}' stroke-width='2'/>`;
    for (const tk of niceTicks(0, maxX, 5).ticks) body += text(xs(tk), plotY + h + 15, String(tk), { size: 10, anchor: 'middle', fill: C.muted });
    body += text(plotX + w - 36, plotY + h + 28, 'номер прогона в плане', { size: 10, anchor: 'end', fill: C.muted });
  });
  save('stability.svg', svgDoc(16 + cols * cellW, 80 + Math.ceil(metrics.length / cols) * cellH, body, 'Стабильность во времени'));
}

// --- 6. A/A ---
{
  const b = records.filter((r) => r.batch === 'B');
  if (b.length) {
    const { profile } = b[0];
    const size = b[0].params.rtt.size;
    const a = main.filter((r) => r.profile === profile && r.params.rtt.size === size);
    const metrics = [
      ['медиана RTT WT-дейтагр.', (r) => rttStat(r, 'wt-datagram', 'median')],
      ['медиана RTT RTC надёжн.', (r) => rttStat(r, 'rtc-reliable', 'median')],
      ['p95 RTT WT-поток', (r) => rttStat(r, 'wt-stream', 'p95')],
      ['установление WT', (r) => setupMedian(r, 'wt')],
      ['установление RTC trickle', (r) => setupMedian(r, 'rtc-trickle')],
    ];
    const cellW = 230;
    let body = text(16, 26, `A/A-тест: одна конфигурация (${profile}, ${size} Б), прогоны случайно разделены на партии A и B`, { size: 16, fill: C.text, weight: 600 });
    body += text(16, 46, `Партия A — ${a.length} прогонов, B — ${b.length}; партии перемешаны с остальными прогонами плана. Различия быть не должно.`, { size: 12 });
    metrics.forEach(([label, get], i) => {
      const groups = [
        { label: 'A', color: C.wt, values: a.map(get) },
        { label: 'B', color: C.muted, values: b.map(get) },
      ];
      body += boxPanel(16 + i * cellW, 96, cellW - 24, 200, label, groups, { zero: false, seed: 200 + i });
    });
    save('aa.svg', svgDoc(16 + metrics.length * cellW, 350, body, 'A/A-тест'));
  }
}

console.log(`[plots] ${records.length} валидных прогонов → ${OUT}/: ${files.join(', ')}`);
