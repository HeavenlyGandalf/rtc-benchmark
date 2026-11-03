// Точка входа сервера экспериментального стенда.
//  - HTTP/1.1 (порт 8080): статика клиента + REST API (сигналинг WebRTC, метаданные).
//  - HTTP/3 / QUIC (порт 4433): WebTransport echo.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quicheLoaded } from '@fails-components/webtransport';
import { startWebTransportServer } from './webtransport.js';
import { handleWebRtcOffer, addWebRtcCandidate } from './webrtc.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const CERT_PATH = join(ROOT, 'certs', 'cert.pem');
const KEY_PATH = join(ROOT, 'certs', 'key.pem');

const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8080);
const WT_PORT = Number(process.env.WT_PORT ?? 4433);

// --- Сертификат: генерируем заново, если отсутствует или скоро истекает ---
function ensureCertificate(): void {
  let needNew = !existsSync(CERT_PATH) || !existsSync(KEY_PATH);
  if (!needNew) {
    const cert = new X509Certificate(readFileSync(CERT_PATH));
    const hoursLeft = (new Date(cert.validTo).getTime() - Date.now()) / 3_600_000;
    if (hoursLeft < 12) needNew = true;
  }
  if (needNew) {
    console.log('[CERT] генерирую новый ECDSA-сертификат (срок 13 дней)...');
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'gen-cert.mjs')], { stdio: 'inherit' });
  }
}

ensureCertificate();
const certPem = readFileSync(CERT_PATH, 'utf8');
const keyPem = readFileSync(KEY_PATH, 'utf8');
// Отпечаток SHA-256 сертификата — передаётся клиенту для serverCertificateHashes.
const certHashHex = new X509Certificate(certPem).fingerprint256.replaceAll(':', '');

// --- Контроль стенда: задержка event loop и CPU процесса сервера ---
// Раннер читает /api/metrics до и после сценария, чтобы проверить, что сервер
// (один поток Node) не стал узким местом и не исказил измерения.
const LOOP_RESOLUTION_MS = 10;
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
loopDelay.enable();
let cpuMark = process.cpuUsage();
let wallMark = performance.now();

function readMetrics(reset: boolean) {
  const cpu = process.cpuUsage(cpuMark);
  const wallMs = performance.now() - wallMark;
  // гистограмма хранит интервал между срабатываниями таймера (нс), в него входит
  // само разрешение — вычитаем его, чтобы получить задержку event loop
  const ns = (v: number) => Math.max(0, v / 1e6 - LOOP_RESOLUTION_MS);
  const out = {
    windowMs: wallMs,
    cpuPct: wallMs > 0 ? ((cpu.user + cpu.system) / 1000 / wallMs) * 100 : 0,
    loopDelayMs: {
      p50: ns(loopDelay.percentile(50)),
      p99: ns(loopDelay.percentile(99)),
      max: ns(loopDelay.max),
    },
    rssMb: process.memoryUsage().rss / 2 ** 20,
  };
  if (reset) {
    loopDelay.reset();
    cpuMark = process.cpuUsage();
    wallMark = performance.now();
  }
  return out;
}

// --- HTTP/1.1: статика + API ---
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Состояние сигналинга P2P (одна комната): offer/answer двух браузерных пиров.
let p2pOffer: string | null = null;
let p2pAnswer: string | null = null;
let peerReady = false;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/info') {
      // 127.0.0.1 вместо localhost: Chrome может резолвить localhost в ::1,
      // а QUIC-сервер слушает IPv4.
      const wtHost = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;
      sendJson(res, 200, {
        certHash: certHashHex,
        wtUrl: `https://${wtHost}:${WT_PORT}/echo`,
        wtRelayUrl: `https://${wtHost}:${WT_PORT}/relay`,
      });
      return;
    }

    if (url.pathname === '/api/metrics') {
      sendJson(res, 200, readMetrics(url.searchParams.has('reset')));
      return;
    }

    if (url.pathname === '/api/webrtc/candidate' && req.method === 'POST') {
      const { id, candidate, mid } = JSON.parse(await readBody(req));
      sendJson(res, addWebRtcCandidate(id, candidate, mid) ? 200 : 404, { ok: true });
      return;
    }

    if (url.pathname === '/api/webrtc/offer' && req.method === 'POST') {
      const { sdp } = JSON.parse(await readBody(req));
      const answer = await handleWebRtcOffer(sdp);
      sendJson(res, 200, answer);
      return;
    }

    // --- P2P WebRTC: сервер ТОЛЬКО ретранслирует SDP между двумя браузерными
    // пирами (в передаче данных не участвует). Одна комната в памяти.
    // Без trickle ICE: пиры присылают SDP с уже собранными кандидатами. ---
    if (url.pathname === '/api/p2p/reset' && req.method === 'POST') {
      p2pOffer = null;
      p2pAnswer = null;
      sendJson(res, 200, { ok: true });
      return;
    }

    // Простой флаг готовности для синхронизации контейнеров в multi-host-прогоне:
    // отвечающий пир (peerB) выставляет его, измеряющий (peerA) ждёт.
    if (url.pathname === '/api/ready') {
      if (req.method === 'POST') {
        peerReady = true;
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 200, { ready: peerReady });
      }
      return;
    }
    if (url.pathname === '/api/p2p/offer') {
      if (req.method === 'POST') {
        p2pOffer = JSON.parse(await readBody(req)).sdp;
        p2pAnswer = null;
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 200, { sdp: p2pOffer });
      }
      return;
    }
    if (url.pathname === '/api/p2p/answer') {
      if (req.method === 'POST') {
        p2pAnswer = JSON.parse(await readBody(req)).sdp;
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 200, { sdp: p2pAnswer });
      }
      return;
    }

    // Статика
    const filePath = join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    if (filePath.startsWith(PUBLIC_DIR) && existsSync(filePath) && statSync(filePath).isFile()) {
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(readFileSync(filePath));
      return;
    }

    res.writeHead(404).end('Not found');
  } catch (err) {
    console.error('[HTTP] ошибка:', err);
    sendJson(res, 500, { error: String(err) });
  }
});

await quicheLoaded;
await startWebTransportServer({ port: WT_PORT, host: '0.0.0.0', certPem, keyPem });

httpServer.listen(HTTP_PORT, () => {
  console.log(`[HTTP] стенд доступен:    http://localhost:${HTTP_PORT}`);
  console.log(`[CERT] sha-256 отпечаток: ${certHashHex}`);
});
