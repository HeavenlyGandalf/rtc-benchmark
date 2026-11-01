// Настоящий P2P WebRTC между ДВУМЯ браузерными пирами (для проверки H1 из НИР-2:
// прямое соединение без серверного посредника в передаче данных).
// Сервер используется только как сигналинг-реле (обмен SDP через /api/p2p/*).
// Данные идут напрямую A↔B по DataChannel. Без trickle ICE: ждём завершения
// сбора кандидатов и отправляем полный SDP.
import { RtcChannel } from './webrtc.js';

export type P2pRole = 'offerer' | 'answerer';

export interface P2pResult {
  pc: RTCPeerConnection;
  channel: RtcChannel;
  setupMs: number;
}

export async function p2pConnect(
  role: P2pRole,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<P2pResult> {
  const pollMs = opts.pollMs ?? 150;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const t0 = performance.now();
  const pc = new RTCPeerConnection({ iceServers: [] });
  let channel: RtcChannel;

  if (role === 'offerer') {
    const dc = pc.createDataChannel('p2p');
    dc.binaryType = 'arraybuffer';
    await fetch('/api/p2p/reset', { method: 'POST' });
    await pc.setLocalDescription(await pc.createOffer());
    await waitIceComplete(pc);
    await postSdp('/api/p2p/offer', pc.localDescription!.sdp);
    const answerSdp = await pollSdp('/api/p2p/answer', pollMs, timeoutMs);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    await waitOpen(dc);
    channel = new RtcChannel(pc, dc, 'rtc-reliable');
  } else {
    const offerSdp = await pollSdp('/api/p2p/offer', pollMs, timeoutMs);
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const dcReady = new Promise<RTCDataChannel>((resolve) => {
      pc.ondatachannel = (e) => resolve(e.channel);
    });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIceComplete(pc);
    await postSdp('/api/p2p/answer', pc.localDescription!.sdp);
    const dc = await dcReady;
    dc.binaryType = 'arraybuffer';
    await waitOpen(dc);
    channel = new RtcChannel(pc, dc, 'rtc-reliable');
  }

  return { pc, channel, setupMs: performance.now() - t0 };
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

async function postSdp(path: string, sdp: string): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sdp }),
  });
  if (!res.ok) throw new Error(`P2P сигналинг ${path}: HTTP ${res.status}`);
}

async function pollSdp(path: string, pollMs: number, timeoutMs: number): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const res = await fetch(path);
    if (res.ok) {
      const { sdp } = await res.json();
      if (sdp) return sdp;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`P2P сигналинг ${path}: таймаут ожидания SDP`);
}
