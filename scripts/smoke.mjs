// Дымовая проверка стенда (раздел 4 отчёта ПР-4): за 1–2 минуты убедиться,
// что все сервисы поднялись, объект исследования отвечает, эмуляция сети
// работает и метрики собираются. Запускается в контейнере bench топологии
// compose-router.yml (make smoke), до основной серии.
//
// Проверки:
//   1. router: netem-agent отвечает на /health;
//   2. server: /api/info отдаёт адрес WebTransport и отпечаток сертификата;
//   3. server: /api/metrics отдаёт CPU и задержку event loop;
//   4. netem: короткая UDP-калибровка lan и 4g через маршрутизатор проходит;
//   5. один короткий прогон run-series: все 4 канала вернули RTT, время
//      установления WT и RTC, пропускную способность; монитор CPU клиента и
//      метрики сервера по окнам сценариев записаны в манифест.
// Код выхода 1 при любом FAIL.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BENCH_URL = process.env.BENCH_URL ?? 'http://127.0.0.1:8080';
const AGENT = process.env.NETEM_AGENT;
const OUT = join(process.env.OUT_ROOT ?? 'results', 'smoke-check');
const MODES = ['wt-stream', 'wt-datagram', 'rtc-reliable', 'rtc-unreliable'];

const checks = [];
function check(name, pass, detail = '') {
  checks.push({ name, pass });
  console.log(`[smoke] ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(name, false, err.message);
  }
}

await step('router: netem-agent /health', async () => {
  if (!AGENT) throw new Error('NETEM_AGENT не задан');
  const h = await getJson(`${AGENT}/health`);
  check('router: netem-agent /health', h.ok === true);
});

await step('server: /api/info', async () => {
  const info = await getJson(`${BENCH_URL}/api/info`);
  check('server: /api/info', /^https:\/\//.test(info.wtUrl) && /^[0-9a-f]{64}$/i.test(info.certHash), info.wtUrl);
});

await step('server: /api/metrics', async () => {
  const m = await getJson(`${BENCH_URL}/api/metrics?reset`);
  check('server: /api/metrics', Number.isFinite(m.cpuPct) && Number.isFinite(m.loopDelayMs?.p99), `CPU ${m.cpuPct?.toFixed(1)} %, event loop p99 ${m.loopDelayMs?.p99?.toFixed(2)} мс`);
});

rmSync(OUT, { recursive: true, force: true });

const cal = spawnSync(process.execPath, ['scripts/calibrate.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, PROFILES: 'lan 4g', OUT_DIR: OUT },
});
check('netem: калибровка lan и 4g через маршрутизатор', cal.status === 0);

const run = spawnSync(process.execPath, ['scripts/run-series.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PROFILE: 'lan',
    REPS: '3',
    RTT_COUNT: '100',
    RTT_WARMUP: '10',
    TP_DURATION: '1',
    SEED: '1',
    RUN_ID: 'smoke',
    OUT_DIR: OUT,
    BATCH: 'smoke',
  },
});
check('прогон: run-series завершился', run.status === 0);

if (run.status === 0) {
  await step('прогон: данные и манифест', async () => {
    const r = JSON.parse(readFileSync(join(OUT, 'smoke.json'), 'utf8'));
    const rttModes = r.rtt.filter((x) => x.stats.received > 0 && x.stats.samples?.length).map((x) => x.mode);
    check('прогон: RTT по 4 каналам', MODES.every((m) => rttModes.includes(m)), rttModes.join(', '));
    check('прогон: время установления WT и RTC', ['wt', 'rtc-full', 'rtc-trickle'].every((k) => r.setup[k]?.samples?.length > 0));
    check('прогон: пропускная способность', r.throughput.length === 4 && r.throughput.every((t) => t.result.mbps > 0));
    check('метрики: CPU клиента (монитор /proc)', r.monitor.cpu.rtt?.available === true, `p95 ${r.monitor.cpu.rtt?.client?.p95?.toFixed(1)} % лимита`);
    check('метрики: CPU и event loop сервера по окнам', ['setup', 'rtt'].every((w) => Number.isFinite(r.monitor.server[w]?.cpuPct)));
    const m = r.manifest;
    const known = (v) => Boolean(v) && v !== 'unknown';
    const pass = [m.gitCommit, m.imageDigest, m.host?.cpu, m.host?.os, m.host?.docker].every(known) && m.cpuLimitCores > 0 && m.memLimitMb > 0;
    check('манифест: коммит, образ, хост, лимиты', pass, `${String(m.gitCommit).slice(0, 7)}, ${String(m.imageDigest).slice(0, 19)}, ${m.host?.cpu} / ${m.host?.os} / Docker ${m.host?.docker}, лимит ${m.cpuLimitCores} CPU ${m.memLimitMb} МБ`);
  });
}

const failed = checks.filter((c) => !c.pass);
console.log(`[smoke] ${checks.length - failed.length}/${checks.length} проверок пройдено`);
process.exit(failed.length ? 1 : 0);
