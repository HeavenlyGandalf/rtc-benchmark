#!/usr/bin/env node
// Применение/снятие сетевых профилей через tc netem на интерфейсе (по умолчанию lo).
// Требует NET_ADMIN (root) — поэтому запускается внутри Docker-контейнера.
// Профили описаны в experiment/profiles.json.
//
// ВАЖНО по методике: задержка задаётся на интерфейсе lo, через который проходят
// и запрос, и ответное эхо. Поэтому измеренный RTT ≈ 2 × (односторонняя delay).
// Это намеренно и оговаривается в отчёте: сравниваются относительные величины
// WebRTC vs WebTransport при ОДИНАКОВОМ профиле.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// IFACE — один интерфейс, список через пробел или auto (все eth*: так
// контейнер-маршрутизатор шейпит обе стороны, и RTT ≈ 2 × delay; туннельные
// псевдоинтерфейсы ядра — gre0, sit0 и т.п. — не трогаем).
const IFACE_SPEC = process.env.IFACE ?? 'lo';
const IFACES =
  IFACE_SPEC === 'auto'
    ? readdirSync('/sys/class/net')
        .filter((n) => /^eth\d+$/.test(n) && existsSync(`/sys/class/net/${n}/ifindex`))
        .sort()
    : IFACE_SPEC.split(/\s+/).filter(Boolean);
const [action, profileName] = process.argv.slice(2);

function tc(args) {
  execFileSync('tc', args, { stdio: 'inherit' });
}
function clearQdisc(iface) {
  try {
    execFileSync('tc', ['qdisc', 'del', 'dev', iface, 'root'], { stdio: 'ignore' });
  } catch {
    /* qdisc отсутствует — нечего снимать */
  }
}

if (action === 'clear') {
  for (const iface of IFACES) clearQdisc(iface);
  process.exit(0);
}
if (action !== 'apply' || !profileName) {
  console.error('usage: netem.mjs apply <profile> | clear');
  process.exit(1);
}

const profiles = JSON.parse(readFileSync(join(HERE, 'profiles.json'), 'utf8'));
const p = profiles[profileName];
if (!p) {
  console.error(`неизвестный профиль: ${profileName} (есть: ${Object.keys(profiles).join(', ')})`);
  process.exit(1);
}

const opts = [];
const delayTokens = String(p.delay ?? '').trim().split(/\s+/).filter(Boolean);
const neutralDelay = delayTokens.length === 1 && /^0m?s?$/.test(delayTokens[0]);
if (delayTokens.length && !neutralDelay) opts.push('delay', ...delayTokens);
if (p.loss && !/^0%?$/.test(String(p.loss).trim())) opts.push('loss', String(p.loss).trim());
if (p.rate && String(p.rate).trim()) opts.push('rate', String(p.rate).trim());

for (const iface of IFACES) {
  clearQdisc(iface);
  if (opts.length) {
    tc(['qdisc', 'add', 'dev', iface, 'root', 'netem', ...opts]);
    console.log(`[netem] ${iface}: ${profileName} → ${opts.join(' ')}`);
  } else {
    console.log(`[netem] ${iface}: ${profileName} → нейтральный профиль (ограничения сняты)`);
  }
}
