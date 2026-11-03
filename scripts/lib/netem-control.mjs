// Единая точка применения сетевого профиля для раннеров:
//   NETEM_AGENT задан — профиль ставит контейнер-маршрутизатор (HTTP);
//   иначе — локально через experiment/netem.mjs (интерфейс из IFACE, по умолчанию lo).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT = process.env.NETEM_AGENT;

export const profiles = JSON.parse(readFileSync(join(ROOT, 'experiment', 'profiles.json'), 'utf8'));

/** Задержка (мс), джиттер (мс) и доля потерь одного прохода профиля. */
export function profileNumbers(name) {
  if (name === 'none') return { delayMs: 0, jitterMs: 0, loss: 0, rate: null }; // сеть не эмулируется
  const p = profiles[name];
  if (!p) throw new Error(`неизвестный профиль: ${name}`);
  const [delay = '0', jitter = '0'] = String(p.delay ?? '0').trim().split(/\s+/);
  return {
    delayMs: parseFloat(delay) || 0,
    jitterMs: parseFloat(jitter) || 0,
    loss: (parseFloat(String(p.loss ?? '0')) || 0) / 100,
    rate: p.rate || null,
  };
}

async function agent(path) {
  const res = await fetch(`${AGENT}${path}`, { method: 'POST' });
  const body = await res.json();
  if (!res.ok) throw new Error(`netem-agent ${path}: ${body.error}`);
  process.stdout.write(body.log ?? '');
}

export async function applyProfile(name) {
  if (name === 'none') return clearProfile();
  if (AGENT) return agent(`/apply/${name}`);
  execFileSync(process.execPath, [join(ROOT, 'experiment', 'netem.mjs'), 'apply', name], { stdio: 'inherit' });
}

export async function clearProfile() {
  if (AGENT) return agent('/clear');
  execFileSync(process.execPath, [join(ROOT, 'experiment', 'netem.mjs'), 'clear'], { stdio: 'inherit' });
}
