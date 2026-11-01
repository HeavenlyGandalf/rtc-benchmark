#!/usr/bin/env node
// Применение/снятие сетевых профилей через tc netem на интерфейсе (по умолчанию lo).
// Требует NET_ADMIN (root) — поэтому запускается внутри Docker-контейнера.
// Профили описаны в experiment/profiles.json.
//
// ВАЖНО по методике: задержка задаётся на интерфейсе lo, через который проходят
// и запрос, и ответное эхо. Поэтому измеренный RTT ≈ 2 × (односторонняя delay).
// Это намеренно и оговаривается в отчёте: сравниваются относительные величины
// WebRTC vs WebTransport при ОДИНАКОВОМ профиле.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const IFACE = process.env.IFACE ?? 'lo';
const [action, profileName] = process.argv.slice(2);

function tc(args) {
  execFileSync('tc', args, { stdio: 'inherit' });
}
function clearQdisc() {
  try {
    tc(['qdisc', 'del', 'dev', IFACE, 'root']);
  } catch {
    /* qdisc отсутствует — нечего снимать */
  }
}

if (action === 'clear') {
  clearQdisc();
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

clearQdisc();

const args = ['qdisc', 'add', 'dev', IFACE, 'root', 'netem'];
const delayTokens = String(p.delay ?? '').trim().split(/\s+/).filter(Boolean);
const neutralDelay = delayTokens.length === 1 && /^0m?s?$/.test(delayTokens[0]);
if (delayTokens.length && !neutralDelay) args.push('delay', ...delayTokens);
if (p.loss && !/^0%?$/.test(String(p.loss).trim())) args.push('loss', String(p.loss).trim());
if (p.rate && String(p.rate).trim()) args.push('rate', String(p.rate).trim());

if (args.length > 6) {
  tc(args);
  console.log(`[netem] ${IFACE}: ${profileName} → ${args.slice(6).join(' ')}`);
} else {
  console.log(`[netem] ${IFACE}: ${profileName} → нейтральный профиль (ограничения сняты)`);
}
