// Измерительные сценарии: время установления соединения, RTT/джиттер,
// пропускная способность. Все сценарии работают через единый интерфейс
// BenchChannel, что гарантирует одинаковую методику для всех транспортов.
import type { BenchChannel, ChannelMode } from './transports/types.js';
import {
  connectWebTransport,
  fetchServerInfo,
  WtStreamChannel,
  WtDatagramChannel,
  type ServerInfo,
} from './transports/webtransport.js';
import { connectWebRtc } from './transports/webrtc.js';
import { buildMessage, parseMessage, computeRttStats, sleep, type RttStats } from './util.js';

export interface RttParams {
  count: number;
  size: number;
  intervalMs: number;
  warmup: number;
}

export interface ThroughputParams {
  durationMs: number;
  size: number;
}

export interface ThroughputResult {
  mbps: number;
  sentMsgs: number;
  receivedMsgs: number;
  lossPct: number;
  durationMs: number;
}

export interface SetupResult {
  samples: number[];
  mean: number;
  median: number;
}

/** Держатель открытых соединений на время серии тестов. */
export class BenchSession {
  private info!: ServerInfo;
  private wt: WebTransport | null = null;
  private rtcPc: RTCPeerConnection | null = null;
  private channels = new Map<ChannelMode, BenchChannel>();
  wtSetupMs = NaN;
  rtcSetupMs = NaN;

  async init(): Promise<void> {
    this.info = await fetchServerInfo();
  }

  async channel(mode: ChannelMode): Promise<BenchChannel> {
    const existing = this.channels.get(mode);
    if (existing) return existing;

    if (mode.startsWith('wt')) {
      if (!this.wt) {
        const { wt, setupMs } = await connectWebTransport(this.info);
        this.wt = wt;
        this.wtSetupMs = setupMs;
      }
      if (mode === 'wt-stream') {
        const ch = new WtStreamChannel(this.wt);
        await ch.open();
        this.channels.set(mode, ch);
      } else {
        this.channels.set(mode, new WtDatagramChannel(this.wt));
      }
    } else {
      if (!this.rtcPc) {
        const { pc, reliable, unreliable, setupMs } = await connectWebRtc();
        this.rtcPc = pc;
        this.rtcSetupMs = setupMs;
        this.channels.set('rtc-reliable', reliable);
        this.channels.set('rtc-unreliable', unreliable);
      }
    }
    return this.channels.get(mode)!;
  }

  async closeAll(): Promise<void> {
    for (const ch of this.channels.values()) await ch.close().catch(() => {});
    this.channels.clear();
    this.wt?.close();
    this.wt = null;
    this.rtcPc?.close();
    this.rtcPc = null;
  }
}

/** Сценарий 1: время установления соединения (повторные подключения). */
export async function runSetupTest(
  kind: 'wt' | 'rtc',
  repetitions: number,
  onProgress?: (i: number) => void,
): Promise<SetupResult> {
  const info = await fetchServerInfo();
  const samples: number[] = [];
  for (let i = 0; i < repetitions; i++) {
    if (kind === 'wt') {
      const { wt, setupMs } = await connectWebTransport(info);
      samples.push(setupMs);
      wt.close();
    } else {
      const { pc, setupMs } = await connectWebRtc();
      samples.push(setupMs);
      pc.close();
    }
    onProgress?.(i + 1);
    await sleep(100);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples,
    mean: samples.reduce((s, v) => s + v, 0) / samples.length,
    median: sorted[Math.floor(sorted.length / 2)],
  };
}

/** Сценарий 2: RTT — ping-pong с заданным размером и интервалом. */
export async function runRttTest(
  ch: BenchChannel,
  params: RttParams,
  onProgress?: (done: number, total: number) => void,
): Promise<RttStats> {
  const size = ch.maxMessageSize > 0 ? Math.min(params.size, ch.maxMessageSize) : params.size;
  const rttBySeq = new Map<number, number>();
  const sendTimes = new Map<number, number>();

  ch.onMessage((data) => {
    const { seq } = parseMessage(data);
    const t = sendTimes.get(seq);
    if (t !== undefined && !rttBySeq.has(seq)) {
      rttBySeq.set(seq, performance.now() - t);
    }
  });

  // Прогрев: первые сообщения раскачивают cwnd и кэши, в статистику не входят.
  for (let i = 0; i < params.warmup; i++) {
    await ch.send(buildMessage(0xffff0000 + i, size));
    await sleep(params.intervalMs);
  }

  const baseSeq = 1;
  for (let i = 0; i < params.count; i++) {
    const seq = baseSeq + i;
    sendTimes.set(seq, performance.now());
    await ch.send(buildMessage(seq, size));
    onProgress?.(i + 1, params.count);
    await sleep(params.intervalMs);
  }

  await sleep(500); // ждём хвост эха
  ch.onMessage(() => {});

  const rtts = [...rttBySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return computeRttStats(rtts, params.count);
}

/** Сценарий 3: пропускная способность (echo-goodput за фиксированное время). */
export async function runThroughputTest(
  ch: BenchChannel,
  params: ThroughputParams,
): Promise<ThroughputResult> {
  const size = ch.maxMessageSize > 0 ? Math.min(params.size, ch.maxMessageSize) : params.size;
  let receivedMsgs = 0;
  let receivedBytes = 0;
  let sentMsgs = 0;

  ch.onMessage((data) => {
    receivedMsgs++;
    receivedBytes += data.byteLength;
  });

  const t0 = performance.now();
  const deadline = t0 + params.durationMs;
  while (performance.now() < deadline) {
    await ch.send(buildMessage(sentMsgs++, size));
  }
  const sendDone = performance.now();
  await sleep(700); // дренаж очередей
  ch.onMessage(() => {});

  const durationMs = sendDone - t0;
  return {
    mbps: (receivedBytes * 8) / 1_000_000 / (durationMs / 1000),
    sentMsgs,
    receivedMsgs,
    lossPct: sentMsgs ? ((sentMsgs - receivedMsgs) / sentMsgs) * 100 : 0,
    durationMs,
  };
}
