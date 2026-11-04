// Клиентская обёртка WebRTC: P2P-соединение с echo-сервером,
// сигналинг — HTTP POST. Два режима ICE:
//   full    — ждём полного сбора кандидатов, offer уходит с ними (по умолчанию);
//   trickle — offer уходит сразу, кандидаты досылаются POST /api/webrtc/candidate.
import type { BenchChannel, ChannelMode } from './types.js';

export type IceMode = 'full' | 'trickle';

/** Фазы установления соединения, мс от начала. */
export interface RtcSetupPhases {
  /** offer готов к отправке (full — после сбора кандидатов) */
  offerMs: number;
  /** answer получен и применён */
  answerMs: number;
  /** оба DataChannel открыты (ICE + DTLS + SCTP) */
  openMs: number;
}

export async function connectWebRtc(iceMode: IceMode = 'full'): Promise<{
  pc: RTCPeerConnection;
  reliable: RtcChannel;
  unreliable: RtcChannel;
  setupMs: number;
  phases: RtcSetupPhases;
}> {
  const t0 = performance.now();
  const pc = new RTCPeerConnection({ iceServers: [] });
  // Все обработчики установления снимаются разом по завершении (успех или ошибка).
  const setup = new AbortController();
  const { signal } = setup;

  try {
    const reliableDc = pc.createDataChannel('reliable');
    const unreliableDc = pc.createDataChannel('unreliable', {
      ordered: false,
      maxRetransmits: 0,
    });
    reliableDc.binaryType = 'arraybuffer';
    unreliableDc.binaryType = 'arraybuffer';

    // Сбой ICE/DTLS — ошибка установления сразу, а не по таймауту открытия каналов.
    const failed = new Promise<never>((_, reject) => {
      const check = () => {
        if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') {
          reject(new Error(`WebRTC: соединение не установлено (ICE ${pc.iceConnectionState}, ${pc.connectionState})`));
        }
      };
      pc.addEventListener('connectionstatechange', check, { signal });
      pc.addEventListener('iceconnectionstatechange', check, { signal });
    });
    failed.catch(() => {}); // отказ обрабатывается через Promise.race ниже

    // Trickle: кандидаты, собранные до получения id соединения, копятся в очереди.
    let sessionId: string | null = null;
    const pending: RTCIceCandidate[] = [];
    const sendCandidate = (c: RTCIceCandidate) =>
      fetch('/api/webrtc/candidate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: sessionId, candidate: c.candidate, mid: c.sdpMid ?? '0' }),
      }).catch(() => {});
    if (iceMode === 'trickle') {
      pc.addEventListener(
        'icecandidate',
        (e) => {
          if (!e.candidate || !e.candidate.candidate) return;
          if (sessionId) void sendCandidate(e.candidate);
          else pending.push(e.candidate);
        },
        { signal },
      );
    }

    await pc.setLocalDescription(await pc.createOffer());
    if (iceMode === 'full') await waitIceComplete(pc, signal);
    const offerMs = performance.now() - t0;

    const res = await fetch('/api/webrtc/offer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sdp: pc.localDescription!.sdp }),
    });
    if (!res.ok) throw new Error(`Сигналинг WebRTC: HTTP ${res.status}`);
    const answer: { sdp: string; id: string } = await res.json();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    sessionId = answer.id;
    for (const c of pending.splice(0)) void sendCandidate(c);
    const answerMs = performance.now() - t0;

    await Promise.race([Promise.all([waitOpen(reliableDc, signal), waitOpen(unreliableDc, signal)]), failed]);
    const setupMs = performance.now() - t0;

    return {
      pc,
      reliable: new RtcChannel(pc, reliableDc, 'rtc-reliable'),
      unreliable: new RtcChannel(pc, unreliableDc, 'rtc-unreliable'),
      setupMs,
      phases: { offerMs, answerMs, openMs: setupMs },
    };
  } catch (err) {
    pc.close();
    throw err;
  } finally {
    setup.abort();
  }
}

// Зависшее соединение должно стать ошибкой прогона (оркестратор его повторит),
// а не бесконечным ожиданием.
const GATHER_TIMEOUT_MS = 10_000;
const OPEN_TIMEOUT_MS = 15_000;

function waitIceComplete(pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`сбор ICE-кандидатов не завершился за ${GATHER_TIMEOUT_MS} мс`)), GATHER_TIMEOUT_MS);
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    pc.addEventListener(
      'icegatheringstatechange',
      () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      },
      { signal },
    );
  });
}

function waitOpen(dc: RTCDataChannel, signal: AbortSignal): Promise<void> {
  if (dc.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DataChannel "${dc.label}" не открылся за ${OPEN_TIMEOUT_MS} мс`)), OPEN_TIMEOUT_MS);
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    dc.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { signal },
    );
    dc.addEventListener(
      'error',
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
      { signal },
    );
  });
}

const BUFFER_HIGH = 1 << 20; // 1 МБ — порог backpressure при throughput-тесте

export class RtcChannel implements BenchChannel {
  maxMessageSize: number;

  constructor(
    private pc: RTCPeerConnection,
    private dc: RTCDataChannel,
    public mode: ChannelMode,
  ) {
    // лимит SCTP-сообщения, согласованный в SDP
    this.maxMessageSize = (pc as any).sctp?.maxMessageSize ?? 65536;
    this.dc.bufferedAmountLowThreshold = BUFFER_HIGH / 2;
  }

  async send(data: Uint8Array): Promise<void> {
    if (this.dc.bufferedAmount > BUFFER_HIGH) {
      await new Promise<void>((resolve) => {
        this.dc.addEventListener('bufferedamountlow', () => resolve(), { once: true });
      });
    }
    this.dc.send(data as unknown as ArrayBuffer);
  }

  onMessage(cb: (data: Uint8Array) => void): void {
    this.dc.onmessage = (e) => cb(new Uint8Array(e.data as ArrayBuffer));
  }

  async close(): Promise<void> {
    this.dc.close();
  }
}
