// Монитор CPU процессов внутри контейнера (Linux, /proc). Раз в секунду считает
// долю CPU по группам процессов: chromium (клиент) и сервер стенда (node с
// src/server/index.ts). На macOS /proc нет — монитор возвращает пустую сводку.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { cpus } from 'node:os';

const CLK_TCK = 100; // USER_HZ в Linux — 100 на всех распространённых ядрах

/** Лимит CPU контейнера в ядрах (cgroup v2 cpu.max), иначе число CPU. */
export function cpuLimitCores() {
  try {
    const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (quota !== 'max') return Number(quota) / Number(period);
  } catch {
    /* не cgroup v2 */
  }
  return cpus().length;
}

function groupOf(pid) {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (/chrom/i.test(cmd)) return 'client';
    if (cmd.includes('src/server/index.ts')) return 'server';
  } catch {
    /* процесс завершился */
  }
  return null;
}

/** Тики CPU (utime + stime) по PID процессов стенда: pid → { group, ticks }. */
function snapshot() {
  const procs = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const group = groupOf(name);
    if (!group) continue;
    try {
      // поля 14 и 15 (utime, stime) после закрывающей скобки имени процесса
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      procs.set(name, { group, ticks: Number(fields[11]) + Number(fields[12]) });
    } catch {
      /* процесс завершился между readdir и read */
    }
  }
  return { t: performance.now(), procs };
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
const summarize = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: pct(s, 50), p95: pct(s, 95), max: s.at(-1) ?? null };
};

/**
 * Запускает выборку раз в intervalMs; stop() возвращает сводку:
 *   client/server — суммарная загрузка группы, % от лимита контейнера;
 *   clientTopProc — самый загруженный процесс Chromium, % одного ядра
 *   (насыщенный поток рендерера искажает performance.now(), а в сумме по
 *   группе на 4 ядрах он выглядел бы как 25 %).
 * Дельты считаются только по PID, которые есть в обоих снимках: процесс,
 * появившийся посреди окна, не добавляет в выборку весь свой прошлый CPU.
 */
export function startCpuMonitor(intervalMs = 1000) {
  if (!existsSync('/proc/self/stat')) return { stop: () => ({ available: false }) };
  const limit = cpuLimitCores();
  const series = { client: [], server: [], clientTopProc: [] };
  let prev = snapshot();
  const timer = setInterval(() => {
    const cur = snapshot();
    const sec = (cur.t - prev.t) / 1000;
    const sum = { client: 0, server: 0 };
    let top = 0;
    for (const [pid, { group, ticks }] of cur.procs) {
      const before = prev.procs.get(pid);
      if (!before) continue;
      const cores = Math.max(0, ticks - before.ticks) / CLK_TCK / sec;
      sum[group] += cores;
      if (group === 'client') top = Math.max(top, cores);
    }
    series.client.push((sum.client / limit) * 100);
    series.server.push((sum.server / limit) * 100);
    series.clientTopProc.push(top * 100);
    prev = cur;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return {
        available: true,
        limitCores: limit,
        samples: series.client.length,
        client: summarize(series.client),
        server: summarize(series.server),
        clientTopProc: summarize(series.clientTopProc),
      };
    },
  };
}
