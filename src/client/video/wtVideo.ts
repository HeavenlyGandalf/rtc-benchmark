// Видеостриминг через WebTransport + WebCodecs: камера ->
// MediaStreamTrackProcessor -> VideoEncoder (VP8) -> надёжный QUIC-поток ->
// echo-сервер -> VideoDecoder -> canvas. Медиастек реализуется приложением,
// транспорт не знает о медиа (критерий 7 системы оценки).
import type { VideoStats, VideoSession } from './webrtcVideo.js';
import { connectWebTransport, fetchServerInfo } from '../transports/webtransport.js';

// Кадр на проводе: [u32 длина тела][u8 keyflag][u32 seq][f64 captureTs][данные]
const FRAME_HEADER = 13;

export async function startWtVideo(
  localVideo: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  onStats: (s: VideoStats) => void,
): Promise<VideoSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, frameRate: 30 },
  });
  localVideo.srcObject = stream;
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();
  canvas.width = settings.width ?? 640;
  canvas.height = settings.height ?? 480;
  const ctx = canvas.getContext('2d')!;

  const info = await fetchServerInfo();
  const { wt } = await connectWebTransport(info);
  const bidi = await wt.createBidirectionalStream();
  const writer = bidi.writable.getWriter();

  let stopped = false;
  let encodedSeq = 0;
  let decodedFrames = 0;
  let receivedBytes = 0;
  const e2eWindow: number[] = [];

  const decoder = new VideoDecoder({
    output: (frame) => {
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
      decodedFrames++;
    },
    error: (e) => console.error('decoder:', e),
  });
  decoder.configure({ codec: 'vp8' });

  const encoder = new VideoEncoder({
    output: (chunk) => {
      const body = new Uint8Array(chunk.byteLength);
      chunk.copyTo(body);
      const msg = new Uint8Array(FRAME_HEADER + body.length);
      const dv = new DataView(msg.buffer);
      dv.setUint32(0, body.length + FRAME_HEADER - 4);
      dv.setUint8(4, chunk.type === 'key' ? 1 : 0);
      dv.setUint32(5, encodedSeq++);
      dv.setFloat64(9, performance.now());
      msg.set(body, FRAME_HEADER);
      writer.ready
        .then(() => writer.write(msg))
        .catch(() => {});
    },
    error: (e) => console.error('encoder:', e),
  });
  encoder.configure({
    codec: 'vp8',
    width: canvas.width,
    height: canvas.height,
    bitrate: 1_500_000,
    framerate: 30,
    latencyMode: 'realtime',
  });

  // Захват кадров камеры -> энкодер
  const processor = new MediaStreamTrackProcessor({ track });
  let frameCount = 0;
  (async () => {
    const reader = processor.readable.getReader();
    for (;;) {
      const { done, value: frame } = await reader.read();
      if (done || stopped) { frame?.close(); break; }
      if (encoder.encodeQueueSize < 3) {
        encoder.encode(frame, { keyFrame: frameCount % 60 === 0 });
        frameCount++;
      }
      frame.close();
    }
  })().catch(() => {});

  // Приём эха -> декодер
  (async () => {
    const reader = bidi.readable.getReader();
    let buf = new Uint8Array(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done || stopped) break;
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf);
      merged.set(value, buf.length);
      buf = merged;
      for (;;) {
        if (buf.length < 4) break;
        const bodyLen = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
        if (buf.length < 4 + bodyLen) break;
        const dv = new DataView(buf.buffer, buf.byteOffset);
        const isKey = dv.getUint8(4) === 1;
        const captureTs = dv.getFloat64(9);
        const data = buf.slice(FRAME_HEADER, 4 + bodyLen);
        buf = buf.slice(4 + bodyLen);

        receivedBytes += data.byteLength;
        const e2e = performance.now() - captureTs;
        e2eWindow.push(e2e);
        if (e2eWindow.length > 90) e2eWindow.shift();

        if (decoder.state === 'configured') {
          decoder.decode(new EncodedVideoChunk({
            type: isKey ? 'key' : 'delta',
            timestamp: decodedFrames * 33_333,
            data,
          }));
        }
      }
    }
  })().catch(() => {});

  let prevDecoded = 0;
  let prevBytes = 0;
  const statsTimer = setInterval(() => {
    const fps = decodedFrames - prevDecoded;
    prevDecoded = decodedFrames;
    const bitrateKbps = ((receivedBytes - prevBytes) * 8) / 1000;
    prevBytes = receivedBytes;
    const e2eMs = e2eWindow.length
      ? e2eWindow.reduce((s, v) => s + v, 0) / e2eWindow.length
      : null;
    let jitter = 0;
    for (let i = 1; i < e2eWindow.length; i++) {
      jitter += (Math.abs(e2eWindow[i] - e2eWindow[i - 1]) - jitter) / 16;
    }
    onStats({
      e2eMs,
      fps,
      bitrateKbps,
      jitterMs: e2eWindow.length > 1 ? jitter : null,
      rttMs: null,
      packetsLost: null,
    });
  }, 1000);

  return {
    stop() {
      stopped = true;
      clearInterval(statsTimer);
      try { encoder.close(); } catch { /* уже закрыт */ }
      try { decoder.close(); } catch { /* уже закрыт */ }
      try { wt.close(); } catch { /* уже закрыт */ }
      track.stop();
      localVideo.srcObject = null;
    },
  };
}
