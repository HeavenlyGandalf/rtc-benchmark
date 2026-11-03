// Метаданные прогона: что, где и когда запускалось. Пишутся рядом с сырыми
// данными, чтобы любой результат можно было связать с кодом и окружением.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus, totalmem, release, platform, arch, hostname } from 'node:os';
import { cpuLimitCores } from './monitor.mjs';

function gitCommit() {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown'; // внутри образа .git нет — коммит передаётся через env
  }
}

function memLimitMb() {
  try {
    const v = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (v !== 'max') return Math.round(Number(v) / 2 ** 20);
  } catch {
    /* не cgroup v2 */
  }
  return null;
}

export function environmentManifest(extra = {}) {
  const cpu = cpus();
  return {
    gitCommit: gitCommit(),
    gitDirty: process.env.GIT_DIRTY ?? 'unknown',
    imageDigest: process.env.IMAGE_DIGEST ?? 'unknown',
    hostLabel: process.env.HOST_LABEL ?? hostname(),
    node: process.version,
    os: `${platform()} ${arch()} ${release()}`,
    cpuModel: cpu[0]?.model ?? 'unknown',
    cpuCount: cpu.length,
    cpuLimitCores: cpuLimitCores(),
    memTotalMb: Math.round(totalmem() / 2 ** 20),
    memLimitMb: memLimitMb(),
    ...extra,
  };
}
