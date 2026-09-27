// Smoke-тест WebRTC-части: офер через HTTP-сигналинг, эхо по DataChannel.
// Клиентскую роль играет polyfill RTCPeerConnection из node-datachannel.
import { RTCPeerConnection } from 'node-datachannel/polyfill';

const pc = new RTCPeerConnection({ iceServers: [] });
const dc = pc.createDataChannel('reliable');

const opened = new Promise((res) => (dc.onopen = res));
await pc.setLocalDescription(await pc.createOffer());
// ждём окончания сбора кандидатов
await new Promise((res) => {
  if (pc.iceGatheringState === 'complete') return res();
  pc.addEventListener('icegatheringstatechange', () => {
    if (pc.iceGatheringState === 'complete') res();
  });
});

const res = await fetch('http://127.0.0.1:8080/api/webrtc/offer', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sdp: pc.localDescription.sdp }),
});
if (!res.ok) throw new Error(`signaling HTTP ${res.status}`);
const answer = await res.json();
await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });

await Promise.race([
  opened,
  new Promise((_, rej) => setTimeout(() => rej(new Error('datachannel open timeout')), 5000)),
]);
console.log('OK: data channel открыт');

const echoed = new Promise((res) => (dc.onmessage = (e) => res(e.data)));
dc.send('ping-123');
const reply = await Promise.race([
  echoed,
  new Promise((_, rej) => setTimeout(() => rej(new Error('echo timeout')), 3000)),
]);
console.log('OK: эхо DataChannel:', reply);

pc.close();
process.exit(0);
