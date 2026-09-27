// WebRTC echo-сервер на основе node-datachannel (libdatachannel).
// Эхо-семантика: сообщения Data Channel и RTP-пакеты медиатреков
// возвращаются отправителю без изменений.
import ndc, { type PeerConnection } from 'node-datachannel';

const peers = new Set<PeerConnection>();

export interface SessionDescription {
  sdp: string;
  type: string;
}

export function handleWebRtcOffer(offerSdp: string): Promise<SessionDescription> {
  return new Promise((resolve, reject) => {
    const pc = new ndc.PeerConnection('echo-server', { iceServers: [] });
    peers.add(pc);

    const timeout = setTimeout(() => {
      peers.delete(pc);
      pc.close();
      reject(new Error('ICE gathering timeout'));
    }, 10_000);

    pc.onStateChange((state) => {
      if (state === 'closed' || state === 'failed' || state === 'disconnected') {
        peers.delete(pc);
      }
    });

    // Без trickle ICE: ждём завершения сбора кандидатов и отдаём полный answer.
    pc.onGatheringStateChange((state) => {
      if (state === 'complete') {
        clearTimeout(timeout);
        const desc = pc.localDescription();
        if (desc) {
          console.log('[RTC]  answer готов, data channels + media echo');
          resolve({ sdp: desc.sdp, type: desc.type });
        } else {
          reject(new Error('no local description'));
        }
      }
    });

    pc.onDataChannel((dc) => {
      console.log(`[RTC]  открыт data channel "${dc.getLabel()}"`);
      dc.onMessage((msg) => {
        try {
          if (typeof msg === 'string') dc.sendMessage(msg);
          else dc.sendMessageBinary(Buffer.from(msg as ArrayBuffer));
        } catch {
          // канал мог закрыться во время эха
        }
      });
    });

    pc.onTrack((track) => {
      console.log(`[RTC]  входящий медиатрек mid=${track.mid()}`);
      const rtcp = new ndc.RtcpReceivingSession();
      track.setMediaHandler(rtcp);
      track.onMessage((rtpPacket) => {
        try {
          if (track.isOpen()) track.sendMessageBinary(rtpPacket);
        } catch {
          // трек мог закрыться во время эха
        }
      });
    });

    try {
      pc.setRemoteDescription(offerSdp, 'offer');
    } catch (err) {
      clearTimeout(timeout);
      peers.delete(pc);
      reject(err);
    }
  });
}
