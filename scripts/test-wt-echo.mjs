// Smoke-тест WebTransport-сервера из Node: поток и дейтаграмма должны вернуться эхом.
import { WebTransport, quicheLoaded } from '@fails-components/webtransport';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

await quicheLoaded;
const cert = new X509Certificate(readFileSync(new URL('../certs/cert.pem', import.meta.url)));
const hash = Buffer.from(cert.fingerprint256.replaceAll(':', ''), 'hex');

const wt = new WebTransport('https://127.0.0.1:4433/echo', {
  serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }],
});
await wt.ready;
console.log('OK: сессия установлена');

// Надёжный поток
const bidi = await wt.createBidirectionalStream();
const writer = bidi.writable.getWriter();
const payload = new Uint8Array([0, 0, 0, 5, 1, 2, 3, 4, 5]); // фрейм [len=5][12345]
await writer.write(payload);
const reader = bidi.readable.getReader();
const { value } = await reader.read();
console.log('OK: эхо потока:', Buffer.from(value).toString('hex'));

// Дейтаграмма
const dgWriter = wt.datagrams.writable.getWriter();
await dgWriter.write(new Uint8Array([9, 9, 9]));
const dgReader = wt.datagrams.readable.getReader();
const dg = await Promise.race([
  dgReader.read(),
  new Promise((_, rej) => setTimeout(() => rej(new Error('datagram echo timeout')), 3000)),
]);
console.log('OK: эхо дейтаграммы:', Buffer.from(dg.value).toString('hex'));

wt.close();
process.exit(0);
