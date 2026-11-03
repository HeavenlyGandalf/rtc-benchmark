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

function snapshot() {
  const ticks = { client: 0, server: 0 };
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const group = groupOf(name);
    if (!group) continue;
    try {
      // поля 14 и 15 (utime, stime) после закрывающей скобки имени процесса
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      ticks[group] += Number(fields[11]) + Number(fields[12]);
    } catch {
      /* процесс завершился между readdir и read */
    }
  }
  return { t: performance.now(), ticks };
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);

/** Запускает выборку; stop() возвращает сводку в % от лимита контейнера. */
export function startCpuMonitor(intervalMs = 1000) {
  if (!existsSync('/proc/self/stat')) return { stop: () => ({ available: false }) };
  const limit = cpuLimitCores();
  const series = { client: [], server: [] };
  let prev = snapshot();
  const timer = setInterval(() => {
    const cur = snapshot();
    const sec = (cur.t - prev.t) / 1000;
    for (const g of ['client', 'server']) {
      const used = (cur.ticks[g] - prev.ticks[g]) / CLK_TCK;
      series[g].push(Math.max(0, (used / sec / limit) * 100));
    }
    prev = cur;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      const out = { available: true, limitCores: limit, samples: series.client.length };
      for (const g of ['client', 'server']) {
        const s = [...series[g]].sort((a, b) => a - b);
        out[g] = { p50: pct(s, 50), p95: pct(s, 95), max: s.at(-1) ?? null };
      }
      return out;
    },
  };
}
