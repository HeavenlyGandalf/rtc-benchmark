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

const RATE_UNITS = { bit: 1, kbit: 1e3, mbit: 1e6, gbit: 1e9 };

/** Полоса netem (`5mbit`, `1gbit`) в бит/с; null — без ограничения. */
export function parseRate(rate) {
  const s = String(rate ?? '').trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^([\d.]+)\s*(bit|kbit|mbit|gbit)$/);
  // другие единицы tc (mbps — байты/с, kibit, …) молча дали бы неверное ожидание калибровки
  if (!m) throw new Error(`неподдерживаемая единица полосы в профиле: ${rate} (допустимы bit, kbit, mbit, gbit)`);
  return Number(m[1]) * RATE_UNITS[m[2]];
}

/**
 * Задержка (мс), джиттер (мс) и доля потерь одного прохода профиля.
 * noReorder — джиттер без переупорядочивания: с `rate` netem не даёт пакету
 * обогнать предыдущий, задержка пакета становится не меньше задержки соседа.
 */
export function profileNumbers(name) {
  if (name === 'none') return { delayMs: 0, jitterMs: 0, loss: 0, rate: null, rateBps: null, noReorder: false }; // сеть не эмулируется
  const p = profiles[name];
  if (!p) throw new Error(`неизвестный профиль: ${name}`);
  const [delay = '0', jitter = '0'] = String(p.delay ?? '0').trim().split(/\s+/);
  return {
    delayMs: parseFloat(delay) || 0,
    jitterMs: parseFloat(jitter) || 0,
    loss: (parseFloat(String(p.loss ?? '0')) || 0) / 100,
    rate: p.rate || null,
    rateBps: parseRate(p.rate),
    noReorder: p.reorder === false,
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
