// Точка входа сервера экспериментального стенда.
//  - HTTP/1.1 (порт 8080): статика клиента + REST API (сигналинг WebRTC, метаданные).
//  - HTTP/3 / QUIC (порт 4433): WebTransport echo.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quicheLoaded } from '@fails-components/webtransport';
import { startWebTransportServer } from './webtransport.js';
import { handleWebRtcOffer } from './webrtc.js';

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

// --- HTTP/1.1: статика + API ---
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

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
      });
      return;
    }

    if (url.pathname === '/api/webrtc/offer' && req.method === 'POST') {
      const { sdp } = JSON.parse(await readBody(req));
      const answer = await handleWebRtcOffer(sdp);
      sendJson(res, 200, answer);
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
