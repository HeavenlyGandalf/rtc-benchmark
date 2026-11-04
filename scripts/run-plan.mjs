// Оркестратор эксперимента по плану (experiment/plan*.json):
//   1) калибровка сети (scripts/calibrate.mjs) — при провале серия не начинается;
//   2) расписание: все (конфигурация × повтор) + A/A-партия B, перемешанные с сидом;
//   3) один отбрасываемый прогон (прогрев браузера и сервера);
//   4) для каждого прогона: профиль netem → пауза → run-series.mjs (свежий браузер).
// Результаты: results/<plan.name>/raw/*.json, schedule.json, calibration.json.
//
// Запуск: PLAN=experiment/plan-verify.json node scripts/run-plan.mjs
// env: PLAN, OUT_ROOT (results), ONLY_SCHEDULE=1 — только напечатать расписание.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mulberry32, shuffle, deriveSeed } from './lib/rng.mjs';
import { applyProfile, clearProfile, profileNumbers, profiles } from './lib/netem-control.mjs';

const PLAN_PATH = process.env.PLAN ?? 'experiment/plan-verify.json';
const plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
const OUT = join(process.env.OUT_ROOT ?? 'results', plan.name);
const RAW = join(OUT, 'raw');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Расписание ---
const configs = [];
for (const profile of plan.factors.profile) {
  for (const rttSize of plan.factors.rttSize) configs.push({ profile, rttSize, batch: 'A' });
}
let schedule = [];
for (const c of configs) for (let r = 0; r < plan.repsPerConfig; r++) schedule.push({ ...c, rep: r + 1 });
if (plan.aa) {
  for (let r = 0; r < plan.aa.reps; r++) {
    schedule.push({ profile: plan.aa.profile, rttSize: plan.aa.rttSize, batch: 'B', rep: r + 1 });
  }
}
schedule = shuffle(schedule, mulberry32(plan.seed)).map((s, i) => ({
  ...s,
  index: i + 1,
  seed: deriveSeed(plan.seed, i + 1),
  runId: `${String(i + 1).padStart(3, '0')}-${s.profile}-${s.rttSize}-${s.batch}${s.rep}`,
}));
for (const s of schedule) {
  if (!profiles[s.profile]) throw new Error(`профиль ${s.profile} не описан в experiment/profiles.json`);
}

mkdirSync(RAW, { recursive: true });
writeFileSync(join(OUT, 'schedule.json'), JSON.stringify({ plan: PLAN_PATH, ...plan, schedule }, null, 2));
console.log(`[plan] ${plan.name}: ${configs.length} конфигураций × ${plan.repsPerConfig} + A/A ${plan.aa?.reps ?? 0} = ${schedule.length} прогонов, сид ${plan.seed}`);
if (process.env.ONLY_SCHEDULE) {
  for (const s of schedule) console.log(`  ${s.runId}`);
  process.exit(0);
}

// --- Фон стенда в простое: CPU и задержка event loop сервера без нагрузки ---
// Нужен, чтобы отличить перегрузку сервера от собственного шума платформы
// (задержки пробуждения таймера в VM). Пишется в baseline.json.
const BENCH_URL = process.env.BENCH_URL ?? 'http://127.0.0.1:8080';
try {
  await fetch(`${BENCH_URL}/api/metrics?reset`);
  await sleep(Number(process.env.BASELINE_MS ?? 10_000));
  const server = await (await fetch(`${BENCH_URL}/api/metrics?reset`)).json();
  writeFileSync(join(OUT, 'baseline.json'), JSON.stringify({ server }, null, 2));
  console.log(`[plan] фон сервера: CPU ${server.cpuPct.toFixed(1)} %, event loop p99 ${server.loopDelayMs.p99.toFixed(2)} мс`);
} catch (err) {
  console.warn(`[plan] фон сервера не снят: ${err.message}`);
}

// --- Калибровка ---
if (plan.calibrate) {
  const cal = spawnSync(process.execPath, ['scripts/calibrate.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, PROFILES: [...new Set(plan.factors.profile)].join(' '), OUT_DIR: OUT },
  });
  if (cal.status !== 0) {
    console.error('[plan] калибровка не пройдена — серия не запускается');
    process.exit(1);
  }
}

// --- Прогоны ---
function runSeries(s, outDir, batch) {
  const { delayMs, jitterMs } = profileNumbers(s.profile);
  // окно дренажа не короче 4 RTT профиля, иначе хвост эха считается потерей
  const drainMs = Math.max(700, Math.ceil(4 * 2 * (delayMs + jitterMs)));
  const env = {
    ...process.env,
    ...Object.fromEntries(Object.entries(plan.series).map(([k, v]) => [k, String(v)])),
    PROFILE: s.profile,
    RTT_SIZE: String(s.rttSize),
    TP_DRAIN: String(drainMs),
    SEED: String(s.seed),
    RUN_ID: s.runId,
    OUT_DIR: outDir,
    BATCH: batch,
    PLAN_INDEX: String(s.index),
    NETEM_PROFILE_JSON: JSON.stringify({ name: s.profile, ...profiles[s.profile] }),
  };
  return spawnSync(process.execPath, ['scripts/run-series.mjs'], { stdio: 'inherit', env }).status === 0;
}

const failures = [];
// Прогоны, упавшие с первой попытки: в анализ попадает только повтор, поэтому
// их число — данные о надёжности и о возможном смещении отбора.
const retried = [];
try {
  if (plan.discardFirstRun) {
    const first = schedule[0];
    console.log('[plan] прогревочный прогон (в анализ не входит)');
    await applyProfile(first.profile);
    await sleep(plan.pauseAfterNetemMs);
    runSeries({ ...first, runId: '000-warmup', index: 0 }, join(OUT, 'discarded'), 'warmup');
  }
  for (const s of schedule) {
    if (existsSync(join(RAW, `${s.runId}.json`))) {
      console.log(`[plan] ${s.runId} уже есть — пропуск (дозапуск прерванной серии)`);
      continue;
    }
    console.log(`[plan] ===== ${s.index}/${schedule.length}: ${s.runId} =====`);
    await applyProfile(s.profile);
    await sleep(plan.pauseAfterNetemMs);
    let ok = runSeries(s, RAW, s.batch);
    if (!ok) {
      console.warn(`[plan] ${s.runId} упал — повтор`);
      retried.push(s.runId);
      ok = runSeries(s, RAW, s.batch);
    }
    if (!ok) failures.push(s.runId);
  }
} finally {
  await clearProfile();
}

writeFileSync(join(OUT, 'failures.json'), JSON.stringify({ failed: failures, retried }, null, 2));
console.log(`[plan] готово: ${schedule.length - failures.length}/${schedule.length} прогонов в ${RAW}`);
if (failures.length) {
  console.error(`[plan] не удались: ${failures.join(', ')}`);
  process.exit(1);
}
