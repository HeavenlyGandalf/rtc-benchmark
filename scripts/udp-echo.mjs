// Калибровочное UDP-эхо: возвращает каждую дейтаграмму отправителю. Нужно,
// чтобы проверить эмуляцию сети без QUIC и SCTP (см. scripts/calibrate.mjs).
// Порт — UDP_ECHO_PORT (9999).
import { createSocket } from 'node:dgram';

export function startUdpEcho(port = Number(process.env.UDP_ECHO_PORT ?? 9999), host = '0.0.0.0') {
  const sock = createSocket('udp4');
  sock.on('message', (msg, rinfo) => sock.send(msg, rinfo.port, rinfo.address));
  return new Promise((resolve) => sock.bind(port, host, () => resolve(sock)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sock = await startUdpEcho();
  console.log(`[udp-echo] :${sock.address().port}`);
}
