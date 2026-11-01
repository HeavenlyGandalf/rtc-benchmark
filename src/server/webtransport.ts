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
  console.log(`[WT]   WebTransport (HTTP/3) слушает udp://${opts.host}:${opts.port}, пути /echo, /relay`);

  acceptSessions(server).catch((err) => console.error('[WT] accept loop error:', err));
  acceptRelaySessions(server).catch((err) => console.error('[WT] relay loop error:', err));
  return server;
}

// Relay-путь для multi-host-сравнения (H1): сервер пересёт дейтаграммы между
// ДВУМЯ пирами (A→сервер→B и обратно), в отличие от /echo (возврат отправителю).
// Это даёт клиент-серверный путь с «серверным хопом» для сравнения с прямым P2P.
interface RelayPeer {
  writer: { write(v: Uint8Array): Promise<void> };
  partner: RelayPeer | null;
}

async function acceptRelaySessions(server: Http3Server): Promise<void> {
  const reader = server.sessionStream('/relay').getReader();
  let pending: RelayPeer | null = null;
  for (;;) {
    const { done, value: session } = await reader.read();
    if (done) break;
    (async () => {
      await (session as any).ready;
      const writer = (session as any).datagrams.writable.getWriter();
      const self: RelayPeer = { writer, partner: null };
      // Блок без await — атомарное связывание первых двух сессий в пару.
      if (pending) {
        const other: RelayPeer = pending;
        self.partner = other;
        other.partner = self;
        pending = null;
        console.log('[WT]   relay: пара пиров образована');
      } else {
        pending = self;
      }
      const r = (session as any).datagrams.readable.getReader();
      (async () => {
        for (;;) {
          const { done, value } = await r.read();
          if (done) break;
          if (self.partner) self.partner.writer.write(value).catch(() => {});
        }
      })().catch(() => {});
      (session as any).closed.then(() => { if (pending === self) pending = null; }).catch(() => {});
    })().catch((err) => console.error('[WT] relay session error:', err));
  }
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
