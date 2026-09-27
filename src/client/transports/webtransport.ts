// Клиентская обёртка WebTransport: надёжные потоки и ненадёжные дейтаграммы.
import type { BenchChannel, ChannelMode } from './types.js';

export interface ServerInfo {
  certHash: string;
  wtUrl: string;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function fetchServerInfo(): Promise<ServerInfo> {
  const res = await fetch('/api/info');
  if (!res.ok) throw new Error('Не удалось получить /api/info');
  return res.json();
}

export async function connectWebTransport(info: ServerInfo): Promise<{ wt: WebTransport; setupMs: number }> {
  const t0 = performance.now();
  const wt = new WebTransport(info.wtUrl, {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: hexToBytes(info.certHash).buffer as ArrayBuffer }],
  });
  await wt.ready;
  return { wt, setupMs: performance.now() - t0 };
}

/** Надёжный двунаправленный QUIC-поток с кадрированием [u32 длина][payload]. */
export class WtStreamChannel implements BenchChannel {
  mode: ChannelMode = 'wt-stream';
  maxMessageSize = 0;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private cb: (data: Uint8Array) => void = () => {};

  constructor(private wt: WebTransport) {}

  async open(): Promise<void> {
    const stream = await this.wt.createBidirectionalStream();
    this.writer = stream.writable.getWriter();
    this.readLoop(stream.readable).catch(() => {});
  }

  private async readLoop(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    let buf = new Uint8Array(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf);
      merged.set(value, buf.length);
      buf = merged;
      for (;;) {
        if (buf.length < 4) break;
        const len = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
        if (buf.length < 4 + len) break;
        this.cb(buf.slice(4, 4 + len));
        buf = buf.slice(4 + len);
      }
    }
  }

  async send(data: Uint8Array): Promise<void> {
    const framed = new Uint8Array(4 + data.length);
    new DataView(framed.buffer).setUint32(0, data.length);
    framed.set(data, 4);
    await this.writer.ready;
    await this.writer.write(framed);
  }

  onMessage(cb: (data: Uint8Array) => void): void {
    this.cb = cb;
  }

  async close(): Promise<void> {
    try { await this.writer.close(); } catch { /* уже закрыт */ }
  }
}

/** Ненадёжные QUIC-дейтаграммы. */
export class WtDatagramChannel implements BenchChannel {
  mode: ChannelMode = 'wt-datagram';
  maxMessageSize: number;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private cb: (data: Uint8Array) => void = () => {};

  constructor(private wt: WebTransport) {
    this.writer = wt.datagrams.writable.getWriter();
    this.maxMessageSize = wt.datagrams.maxDatagramSize ?? 1200;
    this.readLoop().catch(() => {});
  }

  private async readLoop(): Promise<void> {
    const reader = this.wt.datagrams.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.cb(value);
    }
  }

  async send(data: Uint8Array): Promise<void> {
    await this.writer.ready;
    await this.writer.write(data);
  }

  onMessage(cb: (data: Uint8Array) => void): void {
    this.cb = cb;
  }

  async close(): Promise<void> {
    try { this.writer.releaseLock(); } catch { /* нечего освобождать */ }
  }
}
