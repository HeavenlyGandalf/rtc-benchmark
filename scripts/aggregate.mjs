// Агрегация сырых прогонов (results/raw/*.json) в сводную статистику.
// Группирует по (профиль, сценарий, транспорт, метрика) и считает среднее по
// повторным прогонам (+ число прогонов, σ между прогонами). Пишет:
//   results/summary.csv   — длинный формат profile;scenario;transport;metric;value;runs;stddev
//   results/summary.json  — те же данные структурно
//
// Внутрисерийная статистика (p95/p99/джиттер и т.п.) считается в самом стенде
// (computeRttStats); здесь сводятся МЕЖПРОГОННЫЕ значения.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const RAW_DIR = join('results', 'raw');
if (!existsSync(RAW_DIR)) {
  console.error(`нет каталога ${RAW_DIR} — сначала запустите run-series.mjs`);
  process.exit(1);
}

const files = readdirSync(RAW_DIR).filter((f) => f.endsWith('.json'));
if (files.length === 0) {
  console.error(`в ${RAW_DIR} нет .json — нечего агрегировать`);
  process.exit(1);
}

// key "profile\tscenario\ttransport\tmetric" -> number[]
const bucket = new Map();
function add(profile, scenario, transport, metric, value) {
  if (!Number.isFinite(value)) return;
  const key = [profile, scenario, transport, metric].join('\t');
  (bucket.get(key) ?? bucket.set(key, []).get(key)).push(value);
}

const WT = { 'wt-stream': 'WebTransport/поток', 'wt-datagram': 'WebTransport/дейтаграмма' };
const RTC = { 'rtc-reliable': 'WebRTC/надёжный', 'rtc-unreliable': 'WebRTC/ненадёжный' };
const modeLabel = (m) => WT[m] ?? RTC[m] ?? m;

for (const f of files) {
  const rec = JSON.parse(readFileSync(join(RAW_DIR, f), 'utf8'));
  const profile = rec.profile ?? 'none';

  // Сценарий 1 — установление соединения.
  for (const [kind, label] of [['wt', 'WebTransport'], ['rtc', 'WebRTC']]) {
    const s = rec.setup?.[kind];
    if (!s) continue;
    add(profile, 'Установление', label, 'медиана, мс', s.median);
    add(profile, 'Установление', label, 'среднее, мс', s.mean);
  }

  // Сценарий 2 — RTT.
  for (const { mode, stats } of rec.rtt ?? []) {
    const t = modeLabel(mode);
    add(profile, 'RTT', t, 'медиана, мс', stats.median);
    add(profile, 'RTT', t, 'p95, мс', stats.p95);
    add(profile, 'RTT', t, 'p99, мс', stats.p99);
    add(profile, 'RTT', t, 'джиттер, мс', stats.jitter);
    add(profile, 'RTT', t, 'σ, мс', stats.stddev);
    add(profile, 'RTT', t, 'потери, %', stats.lossPct);
  }

  // Сценарий 3 — пропускная способность.
  for (const { mode, result } of rec.throughput ?? []) {
    const t = modeLabel(mode);
    add(profile, 'Пропускная способность', t, 'Мбит/с', result.mbps);
    add(profile, 'Пропускная способность', t, 'потери, %', result.lossPct);
  }
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
};

const rows = [...bucket.entries()]
  .map(([key, values]) => {
    const [profile, scenario, transport, metric] = key.split('\t');
    return { profile, scenario, transport, metric, value: mean(values), runs: values.length, stddev: std(values) };
  })
  .sort((a, b) =>
    a.profile.localeCompare(b.profile) ||
    a.scenario.localeCompare(b.scenario) ||
    a.transport.localeCompare(b.transport) ||
    a.metric.localeCompare(b.metric),
  );

const header = 'profile;scenario;transport;metric;value;runs;stddev';
const csv = [header, ...rows.map((r) =>
  [r.profile, r.scenario, r.transport, r.metric, r.value.toFixed(3), r.runs, r.stddev.toFixed(3)].join(';'),
)].join('\n');

writeFileSync(join('results', 'summary.csv'), '﻿' + csv + '\n');
writeFileSync(join('results', 'summary.json'), JSON.stringify(rows, null, 2));

console.log(`Агрегировано ${files.length} прогон(ов) → results/summary.csv, results/summary.json`);
console.log(`Строк сводки: ${rows.length}`);
// Компактная таблица в консоль.
for (const r of rows) {
  console.log(`${r.profile.padEnd(8)} | ${r.scenario.padEnd(22)} | ${r.transport.padEnd(22)} | ${r.metric.padEnd(14)} | ${r.value.toFixed(2)} (n=${r.runs})`);
}
