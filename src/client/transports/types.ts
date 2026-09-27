// Общий интерфейс измеряемого канала: send + поток входящих сообщений.
// Сообщения дискретные (datagram/DataChannel) либо кадрированные поверх
// байтового потока (WebTransport stream, фрейминг [u32 длина][payload]).

export type ChannelMode = 'wt-stream' | 'wt-datagram' | 'rtc-reliable' | 'rtc-unreliable';

export const MODE_LABELS: Record<ChannelMode, string> = {
  'wt-stream': 'WebTransport / надёжный поток',
  'wt-datagram': 'WebTransport / дейтаграммы',
  'rtc-reliable': 'WebRTC DataChannel / надёжный',
  'rtc-unreliable': 'WebRTC DataChannel / ненадёжный',
};

export interface BenchChannel {
  mode: ChannelMode;
  /** Максимальный размер сообщения, байт (0 — без практического лимита) */
  maxMessageSize: number;
  send(data: Uint8Array): Promise<void>;
  onMessage(cb: (data: Uint8Array) => void): void;
  close(): Promise<void>;
}

export interface ConnectResult<T> {
  channel: T;
  setupMs: number;
}
