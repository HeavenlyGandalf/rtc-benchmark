// Агрегация multi-host H1-прогонов (results/raw/h1-*.json): сравнение прямого
// P2P и клиент-серверного relay-пути по профилям, с межпрогонной статистикой
// (среднее ± σ по повторам). Пишет results/h1-summary.csv.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const RAW = join('results', 'raw');
if (!existsSync(RAW)) { console.error(`нет ${RAW}`); process.exit(1); }
const files = readdirSync(RAW).filter((f) => f.startsWith('h1-') && f.endsWith('.json'));
if (!files.length) { console.error('нет h1-*.json'); process.exit(1); }

// profile -> массивы значений по прогонам
const byProfile = new Map();
for (const f of files) {
  const r = JSON.parse(readFileSync(join(RAW, f), 'utf8'));
  const e = byProfile.get(r.profile) ?? byProfile.set(r.profile, { p2p: [], relay: [], ratio: [], p2pSetup: [], relaySetup: [] }).get(r.profile);
  const p2p = r.p2p?.rtt?.median, relay = r.relay?.rtt?.median;
  if (Number.isFinite(p2p)) e.p2p.push(p2p);
  if (Number.isFinite(relay)) e.relay.push(relay);
  if (Number.isFinite(p2p) && Number.isFinite(relay) && p2p > 0) e.ratio.push(relay / p2p);
  if (Number.isFinite(r.p2p?.setupMs)) e.p2pSetup.push(r.p2p.setupMs);
  if (Number.isFinite(r.relay?.setupMs)) e.relaySetup.push(r.relay.setupMs);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const std = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };

const rows = [...byProfile.entries()].sort().map(([profile, e]) => ({
  profile,
  p2pRtt: mean(e.p2p), p2pRttSd: std(e.p2p),
  relayRtt: mean(e.relay), relayRttSd: std(e.relay),
  ratio: mean(e.ratio), ratioSd: std(e.ratio),
  p2pSetup: mean(e.p2pSetup), relaySetup: mean(e.relaySetup),
  runs: e.ratio.length,
}));

const header = 'profile;p2p_rtt_ms;p2p_rtt_sd;relay_rtt_ms;relay_rtt_sd;relay_to_p2p_ratio;ratio_sd;p2p_setup_ms;relay_setup_ms;runs';
const csv = [header, ...rows.map((r) =>
  [r.profile, r.p2pRtt.toFixed(2), r.p2pRttSd.toFixed(2), r.relayRtt.toFixed(2), r.relayRttSd.toFixed(2), r.ratio.toFixed(2), r.ratioSd.toFixed(2), r.p2pSetup.toFixed(1), r.relaySetup.toFixed(1), r.runs].join(';'),
)].join('\n');
writeFileSync(join('results', 'h1-summary.csv'), '﻿' + csv + '\n');

console.log('=== H1: P2P (WebRTC прямой) vs relay (WebTransport через сервер), среднее ± σ ===');
console.log('профиль | P2P RTT        | relay RTT      | relay/P2P     | n');
for (const r of rows) {
  console.log(`${r.profile.padEnd(7)} | ${(r.p2pRtt.toFixed(1) + '±' + r.p2pRttSd.toFixed(1)).padStart(13)} | ${(r.relayRtt.toFixed(1) + '±' + r.relayRttSd.toFixed(1)).padStart(14)} | ${(r.ratio.toFixed(2) + '±' + r.ratioSd.toFixed(2)).padStart(13)} | ${r.runs}`);
}
console.log('→ results/h1-summary.csv');
