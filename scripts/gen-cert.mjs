// Генерация самоподписанного ECDSA-сертификата для WebTransport.
// Chrome принимает сертификат через serverCertificateHashes только если:
//  - ключ ECDSA (P-256),
//  - срок действия не более 14 дней.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const certDir = join(root, 'certs');
if (!existsSync(certDir)) mkdirSync(certDir);

const keyPath = join(certDir, 'key.pem');
const certPath = join(certDir, 'cert.pem');

execFileSync('openssl', [
  'req', '-x509', '-nodes',
  '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
  '-keyout', keyPath, '-out', certPath,
  '-days', '13',
  '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
], { stdio: 'inherit' });

const fingerprint = execFileSync('openssl', [
  'x509', '-in', certPath, '-noout', '-fingerprint', '-sha256',
]).toString().trim();

console.log('Сертификат создан:', certPath);
console.log(fingerprint);
console.log('Срок действия: 13 дней. При истечении запустите заново: npm run cert');
