// Утилиты: формат измерительных сообщений и статистика.

// Формат сообщения: [uint32 seq][float64 sendTime][padding до size]
export const MSG_HEADER = 12;

export function buildMessage(seq: number, size: number): Uint8Array {
  const buf = new Uint8Array(Math.max(size, MSG_HEADER));
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, seq);
  dv.setFloat64(4, performance.now());
  return buf;
}

export function parseMessage(data: Uint8Array): { seq: number; sendTime: number } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { seq: dv.getUint32(0), sendTime: dv.getFloat64(4) };
}

export interface RttStats {
  count: number;
  received: number;
  lossPct: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  p99: number;
  stddev: number;
  jitter: number; // RFC 3550: сглаженное среднее отклонение между соседними RTT
  samples: number[];
}

export function computeRttStats(rtts: number[], sent: number): RttStats {
  const sorted = [...rtts].sort((a, b) => a - b);
  const n = sorted.length;
  const pct = (p: number) => (n ? sorted[Math.min(n - 1, Math.floor((p / 100) * n))] : NaN);
  const mean = n ? sorted.reduce((s, v) => s + v, 0) / n : NaN;
  const stddev = n ? Math.sqrt(sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n) : NaN;
  let jitter = 0;
  for (let i = 1; i < rtts.length; i++) {
    jitter += (Math.abs(rtts[i] - rtts[i - 1]) - jitter) / 16;
  }
  return {
    count: sent,
    received: n,
    lossPct: sent ? ((sent - n) / sent) * 100 : 0,
    min: sorted[0] ?? NaN,
    max: sorted[n - 1] ?? NaN,
    mean,
    median: pct(50),
    p95: pct(95),
    p99: pct(99),
    stddev,
    jitter,
    samples: rtts,
  };
}

export function fmt(v: number, digits = 2): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
