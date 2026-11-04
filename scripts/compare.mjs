// Сверка серии проверяющего с эталоном (раздел 4.2 отчёта ПР-3).
//   node scripts/compare.mjs results/verify results/reference
// Проверки (PASS/FAIL, код выхода 1 при любом FAIL):
//   1. калибровка сети пройдена по всем профилям;
//   2. ≥ 90 % прогонов валидны (в сценариях 1–2 CPU клиента и сервера < 70 %,
//      самый загруженный процесс Chromium < 90 % ядра,
//      p99 задержки event loop сервера < 16,7 мс);
//   3. A/A-тест пройден;
//   0. серия получена одним коммитом и одним образом (предупреждение, не FAIL);
//   4. решения по гипотезам (H₀ отвергнута / нет) совпадают с эталоном;
//   5. направление отношений A/B совпадает, а их 95 % ДИ пересекаются;
//   6. медианы RTT в профилях с задержкой — в пределах ±10 % от эталона
//      (на lan не сравниваются: там RTT определяется CPU, а не сетью).
// COMPARE_MODE=smoke (CI): только 1–3 и знак отношений для H2 — машина другая,
// число прогонов мало, поэтому строгие допуски не применяются.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [curDir = 'results/verify', refDir = 'results/reference'] = process.argv.slice(2);
const SMOKE = process.env.COMPARE_MODE === 'smoke';
const load = (d) => JSON.parse(readFileSync(join(d, 'analysis.json'), 'utf8'));
const cur = load(curDir);
const ref = !SMOKE && existsSync(join(refDir, 'analysis.json')) ? load(refDir) : null;
if (!SMOKE && !ref) {
  console.error(`нет эталона ${refDir}/analysis.json`);
  process.exit(1);
}

const rows = [];
const check = (name, pass, detail = '') => rows.push({ name, pass, detail });
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');

if (cur.mixedManifest?.length) console.warn(`[compare] ВНИМАНИЕ: серия смешивает ${cur.mixedManifest.join(', ')}`);

// 1. Калибровка
const cal = cur.calibration?.results ?? [];
check('Калибровка сети', cal.length > 0 && cal.every((c) => c.pass), cal.map((c) => `${c.profile}:${c.pass ? 'ok' : 'fail'}`).join(' '));

// 2. Валидность прогонов
const v = cur.validity;
check('Валидные прогоны ≥ 90 %', v.valid / v.total >= 0.9, `${v.valid}/${v.total}; CPU клиента p95 ≤ ${f(v.clientCpuP95Max, 0)} %, сервера ≤ ${f(v.serverCpuMax, 0)} %, event loop p99 ≤ ${f(v.loopP99Max)} мс`);

// 3. A/A
if (cur.aa) {
  // smoke: 3 против 3 прогонов — p-value здесь бессодержателен (минимум ≈ 0,08),
  // поэтому проверяется только, что партии не расходятся грубо: отношение медиан в [0,8; 1,25]
  const loose = SMOKE ? cur.aa.checks.every((c) => c.ratio >= 0.8 && c.ratio <= 1.25) : cur.aa.pass;
  check(SMOKE ? 'A/A (отношение в [0,8; 1,25])' : 'A/A-тест', loose, cur.aa.checks.map((c) => `${c.metric}=${f(c.ratio, 3)}`).join(' '));
}

if (SMOKE) {
  for (const t of cur.tests.filter((t) => t.id === 'H2-trickle')) {
    check(`H2 знак: WT быстрее RTC (${t.profile})`, t.ratio < 1, `WT/RTC = ${f(t.ratio)}`);
  }
} else {
  // Предупреждение о версии браузера: другая мажорная версия Chromium — частая
  // причина расхождений, но сама по себе не ошибка.
  const major = (s) => String(s ?? '').match(/(\d+)\./)?.[1];
  if (major(cur.chromium) !== major(ref.chromium)) {
    console.warn(`[compare] ВНИМАНИЕ: Chromium ${cur.chromium}, в эталоне ${ref.chromium}`);
  }
  // 4–5. Гипотезы
  for (const rt of ref.tests) {
    const ct = cur.tests.find((t) => t.id === rt.id && t.profile === rt.profile);
    if (!ct) {
      check(`${rt.id} ${rt.profile}`, false, 'нет в текущей серии');
      continue;
    }
    check(`${rt.id} ${rt.profile}: решение`, ct.rejectH0 === rt.rejectH0, `сейчас ${ct.rejectH0 ? 'отвергнута' : 'не отвергнута'}, эталон ${rt.rejectH0 ? 'отвергнута' : 'не отвергнута'}`);
    const sameSide = Math.sign(Math.log(ct.ratio)) === Math.sign(Math.log(rt.ratio)) || (ct.ratioCi[0] <= 1 && ct.ratioCi[1] >= 1 && rt.ratioCi[0] <= 1 && rt.ratioCi[1] >= 1);
    const overlap = ct.ratioCi[0] <= rt.ratioCi[1] && rt.ratioCi[0] <= ct.ratioCi[1];
    check(`${rt.id} ${rt.profile}: отношение`, sameSide && overlap, `${f(ct.ratio)} [${f(ct.ratioCi[0])}; ${f(ct.ratioCi[1])}] против ${f(rt.ratio)} [${f(rt.ratioCi[0])}; ${f(rt.ratioCi[1])}]`);
  }
  // 6. Медианы RTT
  for (const rs of ref.summary.filter((s) => /^rtt\..*\.median$/.test(s.metric) && s.profile !== 'lan')) {
    const cs = cur.summary.find((s) => s.profile === rs.profile && s.rttSize === rs.rttSize && s.metric === rs.metric);
    const dev = cs ? cs.median / rs.median - 1 : NaN;
    check(`${rs.profile} ${rs.metric}`, Math.abs(dev) <= 0.1, cs ? `${f(cs.median)} мс против ${f(rs.median)} мс (${dev >= 0 ? '+' : ''}${f(dev * 100, 1)} %)` : 'нет в текущей серии');
  }
}

const width = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
const failed = rows.filter((r) => !r.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} проверок пройдено${SMOKE ? ' (режим smoke)' : ''}`);
process.exit(failed ? 1 : 0);
