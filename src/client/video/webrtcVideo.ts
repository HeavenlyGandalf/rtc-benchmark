// Видеостриминг через WebRTC: камера -> RTCPeerConnection -> echo-сервер
// (RTP loopback) -> удалённый трек -> <video>. Встроенный медиастек браузера:
// кодек согласуется по SDP, битрейт адаптируется GCC.
export interface VideoStats {
  e2eMs: number | null; // glass-to-glass задержка
  fps: number | null;
  bitrateKbps: number | null;
  jitterMs: number | null;
  rttMs: number | null;
  packetsLost: number | null;
}

export interface VideoSession {
  stop(): void;
}

export async function startWebRtcVideo(
  localVideo: HTMLVideoElement,
  remoteVideo: HTMLVideoElement,
  onStats: (s: VideoStats) => void,
): Promise<VideoSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, frameRate: 30 },
  });
  localVideo.srcObject = stream;

  const pc = new RTCPeerConnection({ iceServers: [] });
  for (const track of stream.getTracks()) pc.addTrack(track, stream);

  pc.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0] ?? new MediaStream([e.track]);
  };

  await pc.setLocalDescription(await pc.createOffer());
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve) => {
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') resolve();
      });
    });
  }
  const res = await fetch('/api/webrtc/offer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sdp: pc.localDescription!.sdp }),
  });
  const answer = await res.json();
  await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });

  // Glass-to-glass: для loopback отправитель и получатель используют одни
  // часы, поэтому expectedDisplayTime - captureTime даёт сквозную задержку.
  let lastE2e: number | null = null;
  let rafId = 0;
  const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
    const capture = (meta as any).captureTime as number | undefined;
    if (capture !== undefined) lastE2e = meta.expectedDisplayTime - capture;
    rafId = remoteVideo.requestVideoFrameCallback(onFrame);
  };
  rafId = remoteVideo.requestVideoFrameCallback(onFrame);

  let prevBytes = 0;
  let prevTs = performance.now();
  const statsTimer = setInterval(async () => {
    const report = await pc.getStats();
    let fps: number | null = null;
    let jitterMs: number | null = null;
    let rttMs: number | null = null;
    let packetsLost: number | null = null;
    let bitrateKbps: number | null = null;

    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        fps = s.framesPerSecond ?? null;
        jitterMs = s.jitter != null ? s.jitter * 1000 : null;
        packetsLost = s.packetsLost ?? null;
        const now = performance.now();
        if (s.bytesReceived != null) {
          bitrateKbps = ((s.bytesReceived - prevBytes) * 8) / (now - prevTs);
          prevBytes = s.bytesReceived;
          prevTs = now;
        }
      }
      if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime != null) {
        rttMs = s.currentRoundTripTime * 1000;
      }
    });

    onStats({ e2eMs: lastE2e, fps, bitrateKbps, jitterMs, rttMs, packetsLost });
  }, 1000);

  return {
    stop() {
      clearInterval(statsTimer);
      try { remoteVideo.cancelVideoFrameCallback(rafId); } catch { /* нет активного колбэка */ }
      pc.close();
      stream.getTracks().forEach((t) => t.stop());
      localVideo.srcObject = null;
      remoteVideo.srcObject = null;
    },
  };
}
