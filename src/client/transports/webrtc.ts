// Клиентская обёртка WebRTC: P2P-соединение с echo-сервером,
// сигналинг — HTTP POST (offer/answer без trickle ICE).
import type { BenchChannel, ChannelMode } from './types.js';

export async function connectWebRtc(): Promise<{
  pc: RTCPeerConnection;
  reliable: RtcChannel;
  unreliable: RtcChannel;
  setupMs: number;
}> {
  const t0 = performance.now();
  const pc = new RTCPeerConnection({ iceServers: [] });

  const reliableDc = pc.createDataChannel('reliable');
  const unreliableDc = pc.createDataChannel('unreliable', {
    ordered: false,
    maxRetransmits: 0,
  });
  reliableDc.binaryType = 'arraybuffer';
  unreliableDc.binaryType = 'arraybuffer';

  await pc.setLocalDescription(await pc.createOffer());
  await waitIceComplete(pc);

  const res = await fetch('/api/webrtc/offer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sdp: pc.localDescription!.sdp }),
  });
  if (!res.ok) throw new Error(`Сигналинг WebRTC: HTTP ${res.status}`);
  const answer = await res.json();
  await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });

  await Promise.all([waitOpen(reliableDc), waitOpen(unreliableDc)]);
  const setupMs = performance.now() - t0;

  return {
    pc,
    reliable: new RtcChannel(pc, reliableDc, 'rtc-reliable'),
    unreliable: new RtcChannel(pc, unreliableDc, 'rtc-unreliable'),
    setupMs,
  };
}

function waitIceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') resolve();
    });
  });
}

function waitOpen(dc: RTCDataChannel): Promise<void> {
  if (dc.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    dc.onopen = () => resolve();
    dc.onerror = (e) => reject(e);
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
