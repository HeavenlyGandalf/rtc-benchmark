// Калибровка эмуляции сети (раздел 5.5 отчёта ПР-3): под каждым профилем
// гоняет UDP-эхо без QUIC и SCTP и сверяет измеренное с заданным:
//   медиана RTT ≈ 2 × delay (задержка ставится на каждом проходе), допуск ±2 мс;
//   потери ≈ 1 − (1 − p)² (потеря возможна и на запросе, и на эхе),
//   допуск — 3σ биномиальной оценки + 0,2 п.п.
// Если хоть один профиль не прошёл, код выхода 1: основную серию запускать нельзя.
//
// env: PROFILES (через пробел), CAL_PACKETS (10000), CAL_INTERVAL_US (1000),
//      CAL_TARGET (host:port эха; по умолчанию поднимается локальное эхо),
//      OUT_DIR (куда писать calibration.json), NETEM_AGENT / IFACE — см. netem-control.
import { createSocket } from 'node:dgram';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyProfile, clearProfile, profileNumbers } from './lib/netem-control.mjs';
import { startUdpEcho } from './udp-echo.mjs';

const PROFILES = (process.env.PROFILES ?? 'lan 4g lossy').split(/\s+/).filter(Boolean);
const PACKETS = Number(process.env.CAL_PACKETS ?? 10_000);
const INTERVAL_US = Number(process.env.CAL_INTERVAL_US ?? 1000);
const OUT_DIR = process.env.OUT_DIR ?? 'results';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let echo = null;
let [host, port] = (process.env.CAL_TARGET ?? '').split(':');
if (!host) {
  echo = await startUdpEcho(0, '127.0.0.1');
  host = '127.0.0.1';
  port = echo.address().port;
}
port = Number(port || 9999);

async function measure() {
  const sock = createSocket('udp4');
  const sent = new Map();
  const rtts = [];
  sock.on('message', (msg) => {
    const seq = msg.readUInt32BE(0);
    const t = sent.get(seq);
    if (t !== undefined) {
      rtts.push(Number(process.hrtime.bigint() - t) / 1e6);
      sent.delete(seq);
    }
  });
  await new Promise((r) => sock.bind(0, r));
  const buf = Buffer.alloc(64);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < PACKETS; i++) {
    // равномерный график отправки по монотонным часам, без накопления дрейфа
    while (Number(process.hrtime.bigint() - t0) / 1000 < i * INTERVAL_US) await new Promise(setImmediate);
    buf.writeUInt32BE(i, 0);
    sent.set(i, process.hrtime.bigint());
    sock.send(buf, port, host);
  }
  await sleep(1500); // хвост эха
  sock.close();
  rtts.sort((a, b) => a - b);
  return { received: rtts.length, median: rtts[Math.floor(rtts.length / 2)], p95: rtts[Math.floor(rtts.length * 0.95)] };
}

const results = [];
try {
  for (const name of PROFILES) {
    await applyProfile(name);
    await sleep(2000);
    const { delayMs, loss } = profileNumbers(name);
    const m = await measure();
    const lossMeasured = 1 - m.received / PACKETS;
    const lossExpected = 1 - (1 - loss) ** 2;
    const lossTol = 3 * Math.sqrt((lossExpected * (1 - lossExpected)) / PACKETS) + 0.002;
    const rttExpected = 2 * delayMs;
    const rttOk = Math.abs(m.median - rttExpected) <= 2;
    const lossOk = Math.abs(lossMeasured - lossExpected) <= lossTol;
    const row = {
      profile: name,
      rttMedianMs: m.median,
      rttP95Ms: m.p95,
      rttExpectedMs: rttExpected,
      lossPct: lossMeasured * 100,
      lossExpectedPct: lossExpected * 100,
      lossTolPct: lossTol * 100,
      pass: rttOk && lossOk,
    };
    results.push(row);
    console.log(
      `[calibrate] ${name.padEnd(8)} RTT медиана ${m.median.toFixed(2)} мс (ожид. ${rttExpected} ± 2) ${rttOk ? 'OK' : 'FAIL'}; ` +
        `потери ${(lossMeasured * 100).toFixed(2)} % (ожид. ${(lossExpected * 100).toFixed(2)} ± ${(lossTol * 100).toFixed(2)}) ${lossOk ? 'OK' : 'FAIL'}`,
    );
  }
} finally {
  await clearProfile();
  echo?.close();
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'calibration.json'), JSON.stringify({ packets: PACKETS, intervalUs: INTERVAL_US, target: `${host}:${port}`, results }, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.error(`[calibrate] не прошли: ${failed.map((r) => r.profile).join(', ')}`);
  process.exit(1);
}
console.log('[calibrate] все профили откалиброваны');
