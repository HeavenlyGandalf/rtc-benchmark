// Анализ серии по прогонам (раздел 5.4 отчёта ПР-3).
//   вход:  results/<name>/raw/*.json (по одному файлу на прогон)
//   выход: results/<name>/runs.csv      — одна строка на прогон (единица анализа)
//          results/<name>/summary.csv   — медиана по прогонам и 95 % бутстреп-ДИ
//          results/<name>/analysis.json — гипотезы H2–H4, A/A-тест, валидность прогонов,
//                                         стабильность во времени (тренд по номеру прогона)
//          results/<name>/analysis.md   — те же таблицы для отчёта
// Партия B (A/A) в сводку конфигураций и в гипотезы не входит.
//
// Запуск: node scripts/analyze.mjs results/verify
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { median, quantile, bootstrapMedianCi, ratioOfMedians, mannWhitney, cliffsDelta, holm, spearman } from './lib/stats.mjs';
import { profileNumbers } from './lib/netem-control.mjs';

const DIR = process.argv[2] ?? 'results/verify';
const RAW = join(DIR, 'raw');
const ALPHA = 0.05;
const FRAME_MS = 16.7; // один кадр при 60 Гц — порог практической значимости
const CPU_LIMIT_PCT = 70;
// Самый загруженный процесс Chromium, % одного ядра: близко к 100 % — поток
// рендерера насыщен, и отметки performance.now() запаздывают.
const TOP_PROC_LIMIT_PCT = 90;
// Порог задержки event loop сервера — один кадр 60 Гц. Фон простоя в VM Docker
// Desktop (пробуждение таймера) даёт p99 ≈ 6–7 мс при CPU < 10 %, поэтому порог
// ниже этого фона браковал бы исправные прогоны; см. baseline.json серии.
const LOOP_P99_LIMIT_MS = 16.7;

if (!existsSync(RAW)) {
  console.error(`нет ${RAW} — сначала запустите run-plan.mjs`);
  process.exit(1);
}
const records = readdirSync(RAW)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(RAW, f), 'utf8')));
if (!records.length) {
  console.error(`в ${RAW} нет прогонов`);
  process.exit(1);
}

// --- Таблица прогонов: одна строка = один прогон ---
const runs = records.map((r) => {
  const row = {
    runId: r.runId,
    profile: r.profile,
    rttSize: r.params.rtt.size,
    batch: r.batch,
    planIndex: r.planIndex ?? (Number.parseInt(r.runId, 10) || NaN),
    chromium: r.env.chromium ?? '',
  };
  for (const [key, s] of Object.entries(r.setup)) {
    if (key === 'order' || key === 'rtc' || !s?.samples) continue;
    row[`setup.${key}`] = median(s.samples); // честная медиана (в стенде — верхняя при чётном n)
    if (s.phases?.length) {
      row[`setup.${key}.offer`] = median(s.phases.map((p) => p.offerMs));
      row[`setup.${key}.signal`] = median(s.phases.map((p) => p.answerMs - p.offerMs));
      row[`setup.${key}.connect`] = median(s.phases.map((p) => p.openMs - p.answerMs));
    }
  }
  for (const { mode, stats } of r.rtt) {
    row[`rtt.${mode}.median`] = stats.median;
    row[`rtt.${mode}.p95`] = stats.p95;
    row[`rtt.${mode}.p99`] = stats.p99;
    row[`rtt.${mode}.loss`] = stats.lossPct;
    row[`rtt.${mode}.jitter`] = stats.jitter;
  }
  for (const { mode, result } of r.throughput) {
    row[`tp.${mode}.mbps`] = result.mbps;
    row[`tp.${mode}.loss`] = result.lossPct;
  }
  // контроль ресурсов — по окнам сценариев 1 и 2 (замеры задержки); окно
  // сценария 3 не учитывается: там канал насыщается и CPU высокий по замыслу
  const win = ['setup', 'rtt'];
  const cpuWin = win.map((w) => r.monitor?.cpu?.[w]).filter((c) => c?.available);
  const srvWin = win.map((w) => r.monitor?.server?.[w]).filter(Boolean);
  row['ctl.clientCpuP95'] = cpuWin.length ? Math.max(...cpuWin.map((c) => c.client.p95)) : NaN;
  // сервер — один поток Node: его загрузка считается в % одного ядра по
  // process.cpuUsage (одинаково для обеих топологий), среднее за окно сценария
  row['ctl.clientTopProcP95'] = cpuWin.some((c) => c.clientTopProc) ? Math.max(...cpuWin.filter((c) => c.clientTopProc).map((c) => c.clientTopProc.p95)) : NaN;
  row['ctl.serverCpu'] = srvWin.length ? Math.max(...srvWin.map((m) => m.cpuPct)) : NaN;
  row['ctl.loopP99'] = srvWin.length ? Math.max(...srvWin.map((m) => m.loopDelayMs.p99)) : NaN;
  const tpCpu = r.monitor?.cpu?.throughput;
  row['ctl.tpClientCpuP95'] = tpCpu?.available ? tpCpu.client.p95 : NaN;
  const reasons = [];
  if (row['ctl.clientCpuP95'] > CPU_LIMIT_PCT) reasons.push('CPU клиента');
  if (row['ctl.clientTopProcP95'] > TOP_PROC_LIMIT_PCT) reasons.push('процесс Chromium');
  if (row['ctl.serverCpu'] > CPU_LIMIT_PCT) reasons.push('CPU сервера');
  if (row['ctl.loopP99'] > LOOP_P99_LIMIT_MS) reasons.push('event loop');
  row.valid = reasons.length === 0;
  row.invalidReason = reasons.join(', ');
  return row;
});

const metricKeys = [...new Set(runs.flatMap((r) => Object.keys(r)))].filter((k) => /^(setup|rtt|tp|ctl)\./.test(k)).sort();
const csvCell = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(3) : '') : String(v ?? ''));
const runCols = ['runId', 'planIndex', 'profile', 'rttSize', 'batch', 'valid', 'invalidReason', 'chromium', ...metricKeys];
writeFileSync(join(DIR, 'runs.csv'), '﻿' + [runCols.join(';'), ...runs.map((r) => runCols.map((c) => csvCell(r[c])).join(';'))].join('\n') + '\n');

// Анализируются только валидные прогоны основной партии.
const main = runs.filter((r) => r.batch !== 'B' && r.valid);
const group = (profile, size) => main.filter((r) => r.profile === profile && (size == null || r.rttSize === size));
const values = (rows, key) => rows.map((r) => r[key]).filter(Number.isFinite);
const profilesSeen = [...new Set(main.map((r) => r.profile))];
const sizesSeen = [...new Set(main.map((r) => r.rttSize))].sort((a, b) => a - b);
const baseSize = sizesSeen[0] ?? runs[0].rttSize;

// --- Сводка конфигураций ---
const summary = [];
for (const profile of profilesSeen) {
  for (const size of sizesSeen) {
    const rows = group(profile, size);
    if (!rows.length) continue;
    for (const key of metricKeys) {
      const v = values(rows, key);
      if (!v.length) continue;
      const [lo, hi] = bootstrapMedianCi(v);
      summary.push({ profile, rttSize: size, metric: key, median: median(v), ciLow: lo, ciHigh: hi, n: v.length });
    }
  }
}
writeFileSync(
  join(DIR, 'summary.csv'),
  '﻿' + ['profile;rttSize;metric;median;ci_low;ci_high;n', ...summary.map((s) => [s.profile, s.rttSize, s.metric, csvCell(s.median), csvCell(s.ciLow), csvCell(s.ciHigh), s.n].join(';'))].join('\n') + '\n',
);

// --- Гипотезы ---
function compare({ id, profile, a, b, alternative, minRatio, minDiffMs, aKey, bKey, label, size = baseSize }) {
  // size = null — все размеры сообщения (время установления от размера не зависит)
  const rows = group(profile, size);
  const va = values(rows, aKey);
  const vb = values(rows, bKey);
  const { ratio, ci } = ratioOfMedians(va, vb);
  const mw = mannWhitney(va, vb, alternative);
  const diff = median(va) - median(vb);
  let practical;
  if (alternative === 'less') practical = ratio <= minRatio && -diff >= minDiffMs;
  else if (alternative === 'greater') practical = ratio >= minRatio && diff >= minDiffMs;
  else practical = (ratio >= minRatio || ratio <= 1 / minRatio) && Math.abs(diff) >= minDiffMs;
  return { id, label, profile, a, b, alternative, nA: va.length, nB: vb.length, medianA: median(va), medianB: median(vb), diffMs: diff, ratio, ratioCi: ci, p: mw.p, cliffsDelta: cliffsDelta(va, vb), minRatio, minDiffMs, practical };
}

const tests = [];
for (const profile of profilesSeen) {
  const { delayMs, loss } = profileNumbers(profile);
  const rttMs = 2 * delayMs;
  // H2: WT устанавливает соединение быстрее RTC (основное сравнение — trickle ICE)
  for (const ice of ['trickle', 'full']) {
    tests.push(compare({ id: `H2-${ice}`, label: `H2: установление WT < RTC (${ice} ICE)`, profile, a: 'wt', b: `rtc-${ice}`, aKey: 'setup.wt', bKey: `setup.rtc-${ice}`, alternative: 'less', minRatio: 0.75, minDiffMs: Math.max(rttMs, 1), size: null }));
  }
  if (loss > 0) {
    // H3: при потерях p95 надёжного упорядоченного RTC больше, чем у ненадёжных каналов
    for (const u of ['wt-datagram', 'rtc-unreliable']) {
      tests.push(compare({ id: `H3-${u}`, label: `H3: p95 RTC reliable > ${u}`, profile, a: 'rtc-reliable', b: u, aKey: 'rtt.rtc-reliable.p95', bKey: `rtt.${u}.p95`, alternative: 'greater', minRatio: 1.2, minDiffMs: FRAME_MS }));
    }
    // H4: p95 WT-потока против RTC reliable, направление не задано
    tests.push(compare({ id: 'H4', label: 'H4: p95 WT-поток ≠ RTC reliable', profile, a: 'wt-stream', b: 'rtc-reliable', aKey: 'rtt.wt-stream.p95', bKey: 'rtt.rtc-reliable.p95', alternative: 'two-sided', minRatio: 1.2, minDiffMs: FRAME_MS }));
  }
}
// поправка Холма по профилям внутри каждой гипотезы
for (const id of [...new Set(tests.map((t) => t.id))]) {
  const fam = tests.filter((t) => t.id === id);
  const adj = holm(fam.map((t) => t.p));
  fam.forEach((t, i) => {
    t.pHolm = adj[i];
    t.significant = t.pHolm < ALPHA;
    t.rejectH0 = t.significant && t.practical;
  });
}

// --- A/A-тест: партия A против партии B той же конфигурации ---
let aa = null;
const batchB = runs.filter((r) => r.batch === 'B' && r.valid);
if (batchB.length) {
  const profile = batchB[0].profile;
  const size = batchB[0].rttSize;
  const batchA = group(profile, size);
  const keys = ['rtt.wt-datagram.median', 'rtt.rtc-reliable.median', 'rtt.wt-stream.p95', 'setup.wt', 'setup.rtc-trickle'];
  const checks = keys.map((key) => {
    const va = values(batchA, key);
    const vb = values(batchB, key);
    const { ratio, ci } = ratioOfMedians(va, vb);
    const { p } = mannWhitney(va, vb, 'two-sided');
    // проходит: незначимо (p > 0,05), ДИ отношения содержит 1, точечное отношение в [0,95; 1,05]
    return { metric: key, nA: va.length, nB: vb.length, ratio, ratioCi: ci, p, pass: p > ALPHA && ci[0] <= 1 && ci[1] >= 1 && ratio >= 0.95 && ratio <= 1.05 };
  });
  aa = { profile, rttSize: size, checks, pass: checks.every((c) => c.pass) };
}

// --- Стабильность во времени: нет систематического тренда от первого прогона к последнему ---
// Каждая метрика прогона нормируется на медиану своей конфигурации (профиль × размер),
// чтобы прогоны разных конфигураций были сравнимы; затем по всем валидным прогонам
// (включая A/A-партию) — ρ Спирмена с номером прогона в плане (перестановочный p,
// поправка Холма по метрикам) и дрейф: медиана последней трети плана относительно
// первой. Тренд считается найденным, если p_Holm < 0,05 и |дрейф| ≥ 5 %.
const TREND_KEYS = ['setup.wt', 'setup.rtc-trickle', ...['wt-stream', 'wt-datagram', 'rtc-reliable', 'rtc-unreliable'].flatMap((m) => [`rtt.${m}.median`, `rtt.${m}.p95`])];
const DRIFT_LIMIT = 0.05;
const validRuns = runs.filter((r) => r.valid && Number.isFinite(r.planIndex));
const configMedian = new Map();
const configKey = (r, key) => `${r.profile}|${r.rttSize}|${key}`;
for (const key of TREND_KEYS) {
  for (const r of validRuns) {
    const k = configKey(r, key);
    if (!configMedian.has(k)) configMedian.set(k, median(values(validRuns.filter((x) => x.profile === r.profile && x.rttSize === r.rttSize), key)));
  }
}
let stability = null;
if (validRuns.length >= 6) {
  const maxIndex = Math.max(...validRuns.map((r) => r.planIndex));
  const trends = TREND_KEYS.map((key) => {
    const pts = validRuns
      .map((r) => ({ x: r.planIndex, y: r[key] / configMedian.get(configKey(r, key)) }))
      .filter((p) => Number.isFinite(p.y));
    const { rho, p, n } = spearman(pts.map((q) => q.x), pts.map((q) => q.y));
    const first = pts.filter((q) => q.x <= maxIndex / 3).map((q) => q.y);
    const last = pts.filter((q) => q.x > (2 * maxIndex) / 3).map((q) => q.y);
    return { metric: key, n, rho, p, drift: median(last) / median(first) - 1, spreadIqr: quantile(pts.map((q) => q.y), 0.75) - quantile(pts.map((q) => q.y), 0.25) };
  });
  const adj = holm(trends.map((t) => t.p));
  trends.forEach((t, i) => {
    t.pHolm = adj[i];
    t.trend = t.pHolm < ALPHA && Math.abs(t.drift) >= DRIFT_LIMIT;
  });
  stability = { driftLimit: DRIFT_LIMIT, trends, pass: trends.every((t) => !t.trend) };
}

const baselineFile = join(DIR, 'baseline.json');
const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : null;
const calibrationFile = join(DIR, 'calibration.json');
const calibration = existsSync(calibrationFile) ? JSON.parse(readFileSync(calibrationFile, 'utf8')) : null;
const validity = {
  total: runs.length,
  valid: runs.filter((r) => r.valid).length,
  invalid: runs.filter((r) => !r.valid).map((r) => ({ runId: r.runId, reason: r.invalidReason })),
  clientCpuP95Max: Math.max(...values(runs, 'ctl.clientCpuP95')),
  clientTopProcP95Max: Math.max(...values(runs, 'ctl.clientTopProcP95')),
  serverCpuMax: Math.max(...values(runs, 'ctl.serverCpu')),
  loopP99Max: Math.max(...values(runs, 'ctl.loopP99')),
};
const manifest = records[0].manifest ?? {};
// Серия должна быть получена одним кодом и одним образом (дозапуск это сохраняет)
const distinct = (k) => [...new Set(records.map((r) => r.manifest?.[k] ?? 'unknown'))];
const mixed = ['gitCommit', 'imageDigest', 'gitDirty'].filter((k) => distinct(k).length > 1);
for (const k of mixed) console.warn(`[analyze] ВНИМАНИЕ: в серии разные ${k}: ${distinct(k).join(', ')}`);
const analysis = {
  dir: DIR,
  generatedAt: new Date().toISOString(),
  chromium: records[0].env.chromium ?? null,
  manifest,
  thresholds: { alpha: ALPHA, frameMs: FRAME_MS, cpuLimitPct: CPU_LIMIT_PCT, topProcLimitPct: TOP_PROC_LIMIT_PCT, loopP99LimitMs: LOOP_P99_LIMIT_MS },
  mixedManifest: mixed,
  validity,
  baseline,
  calibration,
  aa,
  stability,
  tests,
  summary,
};
writeFileSync(join(DIR, 'analysis.json'), JSON.stringify(analysis, null, 2));

// --- Отчёт в Markdown ---
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const ciStr = (ci, d = 2) => `[${f(ci[0], d)}; ${f(ci[1], d)}]`;
const pStr = (p) => (p < 0.001 ? '< 0,001' : f(p, 3));
const md = [];
md.push(`# Результаты серии \`${DIR}\``, '');
md.push(`Chromium ${analysis.chromium}, коммит \`${manifest.gitCommit ?? '?'}\`, образ \`${String(manifest.imageDigest ?? '?').slice(0, 19)}\`, топология ${manifest.topology ?? '?'}.`, '');
md.push(`Прогонов: ${validity.total}, валидных: ${validity.valid}. Максимум p95 CPU клиента ${f(validity.clientCpuP95Max)} % лимита (самый загруженный процесс Chromium ${f(validity.clientTopProcP95Max)} % ядра), сервера ${f(validity.serverCpuMax)} % ядра (все потоки процесса, среднее за окно), p99 задержки event loop ${f(validity.loopP99Max, 2)} мс.`, '');
if (baseline?.server) {
  const b = baseline.server;
  md.push(`Фон сервера в простое (${(b.windowMs / 1000).toFixed(0)} с без нагрузки): CPU ${f(b.cpuPct)} %, задержка event loop p50 ${f(b.loopDelayMs.p50, 2)} мс, p99 ${f(b.loopDelayMs.p99, 2)} мс.`, '');
}
if (calibration) {
  md.push('## Калибровка сети', '', '| Профиль | Медиана RTT, мс | Ожидание, мс | Потери, % | Ожидание, % | Переупорядочено, % | Итог |', '|---|---|---|---|---|---|---|');
  for (const c of calibration.results) md.push(`| ${c.profile} | ${f(c.rttMedianMs, 2)} | ${c.rttLowMs != null ? `${c.rttLowMs}…${c.rttHighMs}` : `${c.rttExpectedMs} ± 2`} | ${f(c.lossPct, 2)} | ${f(c.lossExpectedPct, 2)} ± ${f(c.lossTolPct, 2)} | ${f(c.reorderedPct, 2)} | ${c.pass ? 'OK' : 'FAIL'} |`);
  md.push('');
}
md.push(`## Медианы по прогонам (размер сообщения ${baseSize} Б), 95 % бутстреп-ДИ`, '');
const show = ['setup.wt', 'setup.rtc-full', 'setup.rtc-trickle', 'rtt.wt-stream.median', 'rtt.wt-datagram.median', 'rtt.rtc-reliable.median', 'rtt.rtc-unreliable.median', 'rtt.wt-stream.p95', 'rtt.wt-datagram.p95', 'rtt.rtc-reliable.p95', 'rtt.rtc-unreliable.p95', 'tp.wt-stream.mbps', 'tp.rtc-reliable.mbps'];
md.push(`| Метрика | ${profilesSeen.join(' | ')} |`, `|---|${profilesSeen.map(() => '---').join('|')}|`);
for (const key of show) {
  const cells = profilesSeen.map((p) => {
    const s = summary.find((x) => x.profile === p && x.rttSize === baseSize && x.metric === key);
    return s ? `${f(s.median)} ${ciStr([s.ciLow, s.ciHigh], 1)} (n=${s.n})` : '—';
  });
  md.push(`| \`${key}\` | ${cells.join(' | ')} |`);
}
md.push('', '## Фазы установления WebRTC (медиана по прогонам, мс)', '', '| Профиль | Режим | offer | сигналинг | ICE+DTLS+SCTP | всего |', '|---|---|---|---|---|---|');
for (const p of profilesSeen) for (const ice of ['full', 'trickle']) {
  const g = (k) => summary.find((x) => x.profile === p && x.rttSize === baseSize && x.metric === k)?.median;
  md.push(`| ${p} | ${ice} | ${f(g(`setup.rtc-${ice}.offer`))} | ${f(g(`setup.rtc-${ice}.signal`))} | ${f(g(`setup.rtc-${ice}.connect`))} | ${f(g(`setup.rtc-${ice}`))} |`);
}
md.push('', '## Проверка гипотез', '', '| Гипотеза | Профиль | Медиана A, мс | Медиана B, мс | A/B [95 % ДИ] | p (Холм) | δ Клиффа | Значимо | Практически | H₀ отвергнута |', '|---|---|---|---|---|---|---|---|---|---|');
for (const t of tests) {
  md.push(`| ${t.label} | ${t.profile} | ${f(t.medianA)} | ${f(t.medianB)} | ${f(t.ratio, 2)} ${ciStr(t.ratioCi)} | ${pStr(t.pHolm)} | ${f(t.cliffsDelta, 2)} | ${t.significant ? 'да' : 'нет'} | ${t.practical ? 'да' : 'нет'} | **${t.rejectH0 ? 'да' : 'нет'}** |`);
}
if (aa) {
  md.push('', `## A/A-тест (${aa.profile}, партии A и B): ${aa.pass ? 'пройден' : '**не пройден**'}`, '', '| Метрика | A/B [95 % ДИ] | p | Итог |', '|---|---|---|---|');
  for (const c of aa.checks) md.push(`| \`${c.metric}\` | ${f(c.ratio, 3)} ${ciStr(c.ratioCi, 3)} | ${pStr(c.p)} | ${c.pass ? 'OK' : 'FAIL'} |`);
}
if (stability) {
  md.push('', `## Стабильность во времени: ${stability.pass ? 'тренда нет' : '**найден тренд**'}`, '', `Метрика прогона, делённая на медиану своей конфигурации, против номера прогона в плане; ρ Спирмена (перестановочный p, поправка Холма), дрейф — медиана последней трети плана к первой. Тренд — p_Holm < 0,05 и |дрейф| ≥ ${stability.driftLimit * 100} %.`, '', '| Метрика | n | ρ | p (Холм) | Дрейф, % | IQR нормированной метрики | Тренд |', '|---|---|---|---|---|---|---|');
  for (const t of stability.trends) md.push(`| \`${t.metric}\` | ${t.n} | ${f(t.rho, 3)} | ${pStr(t.pHolm)} | ${f(t.drift * 100, 1)} | ${f(t.spreadIqr, 3)} | ${t.trend ? '**да**' : 'нет'} |`);
}
if (validity.invalid.length) {
  md.push('', '## Невалидные прогоны', '', ...validity.invalid.map((i) => `- ${i.runId}: ${i.reason}`));
}
writeFileSync(join(DIR, 'analysis.md'), md.join('\n') + '\n');
console.log(`[analyze] ${records.length} прогонов → ${DIR}/{runs.csv,summary.csv,analysis.json,analysis.md}`);
for (const t of tests) console.log(`  ${t.id.padEnd(18)} ${t.profile.padEnd(7)} A/B=${f(t.ratio, 2)} ${ciStr(t.ratioCi)} p_Holm=${pStr(t.pHolm)} → H₀ ${t.rejectH0 ? 'отвергнута' : 'не отвергнута'}`);
if (aa) console.log(`  A/A ${aa.profile}: ${aa.pass ? 'пройден' : 'НЕ ПРОЙДЕН'}`);
if (stability) console.log(`  стабильность: ${stability.pass ? 'тренда нет' : 'НАЙДЕН ТРЕНД: ' + stability.trends.filter((t) => t.trend).map((t) => t.metric).join(', ')}`);
