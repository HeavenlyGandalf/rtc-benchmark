// WebTransport echo-сервер поверх HTTP/3 (QUIC).
// Эхо-семантика: всё, что приходит от клиента, возвращается обратно —
// и по надёжным двунаправленным потокам, и по ненадёжным дейтаграммам.
import { Http3Server } from '@fails-components/webtransport';

export interface WtServerOptions {
  port: number;
  host: string;
  certPem: string;
  keyPem: string;
}

export async function startWebTransportServer(opts: WtServerOptions): Promise<Http3Server> {
  const server = new Http3Server({
    port: opts.port,
    host: opts.host,
    secret: 'rtc-benchmark-secret',
    cert: opts.certPem,
    privKey: opts.keyPem,
    // без 'bytes' session.datagrams.readable не отдаёт дейтаграммы
    defaultDatagramsReadableMode: 'bytes',
  });

  server.startServer();
  await server.ready;
  console.log(`[WT]   WebTransport (HTTP/3) слушает udp://${opts.host}:${opts.port}, путь /echo`);

  acceptSessions(server).catch((err) => console.error('[WT] accept loop error:', err));
  return server;
}

async function acceptSessions(server: Http3Server): Promise<void> {
  const sessionReader = server.sessionStream('/echo').getReader();
  for (;;) {
    const { done, value: session } = await sessionReader.read();
    if (done) break;
    handleSession(session).catch((err) => console.error('[WT] session error:', err));
  }
}

async function handleSession(session: any): Promise<void> {
  await session.ready;
  console.log('[WT]   новая сессия');

  // Эхо дейтаграмм (ненадёжная доставка, QUIC datagrams)
  (async () => {
    const reader = session.datagrams.readable.getReader();
    const writer = session.datagrams.writable.getWriter();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      writer.write(value).catch(() => {});
    }
  })().catch(() => {});

  // Эхо надёжных двунаправленных потоков (QUIC streams)
  (async () => {
    const reader = session.incomingBidirectionalStreams.getReader();
    for (;;) {
      const { done, value: stream } = await reader.read();
      if (done) break;
      stream.readable.pipeTo(stream.writable).catch(() => {});
    }
  })().catch(() => {});

  session.closed
    .then(() => console.log('[WT]   сессия закрыта'))
    .catch(() => {});
}
