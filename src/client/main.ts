// UI экспериментального стенда: запуск сценариев, графики, экспорт CSV.
import { Chart, registerables } from 'chart.js';
import { BenchSession, runSetupTest, runRttTest, runThroughputTest } from './bench.js';
import { MODE_LABELS, type ChannelMode } from './transports/types.js';
import { fmt } from './util.js';
import { startWebRtcVideo, type VideoSession, type VideoStats } from './video/webrtcVideo.js';
import { startWtVideo } from './video/wtVideo.js';

Chart.register(...registerables);

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const log = (msg: string) => {
  const el = $('log');
  el.textContent = `${new Date().toLocaleTimeString()}  ${msg}\n` + el.textContent;
};

const MODES: ChannelMode[] = ['wt-stream', 'wt-datagram', 'rtc-reliable', 'rtc-unreliable'];
const MODE_COLORS: Record<ChannelMode, string> = {
  'wt-stream': '#2563eb',
  'wt-datagram': '#7c3aed',
  'rtc-reliable': '#16a34a',
  'rtc-unreliable': '#d97706',
};

// --- Накопитель результатов для таблицы и CSV ---
interface ResultRow {
  scenario: string;
  transport: string;
  params: string;
  metrics: Record<string, string>;
}
const results: ResultRow[] = [];

function addResult(row: ResultRow): void {
  results.push(row);
  const tbody = $('results-body');
  const tr = document.createElement('tr');
  const metrics = Object.entries(row.metrics)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
  tr.innerHTML = `<td>${row.scenario}</td><td>${row.transport}</td><td>${row.params}</td><td>${metrics}</td>`;
  tbody.prepend(tr);
}

function exportCsv(): void {
  const keys = new Set<string>();
  results.forEach((r) => Object.keys(r.metrics).forEach((k) => keys.add(k)));
  const header = ['Сценарий', 'Транспорт', 'Параметры', ...keys];
  const lines = [header.join(';')];
  for (const r of results) {
    lines.push([
      r.scenario,
      r.transport,
      r.params,
      ...[...keys].map((k) => r.metrics[k] ?? ''),
    ].join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rtc-benchmark-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.csv`;
  a.click();
}

// --- Графики ---
let rttChart: Chart | null = null;
let rttBarChart: Chart | null = null;
let tpChart: Chart | null = null;

function ensureRttChart(): Chart {
  rttChart ??= new Chart($('rtt-chart') as HTMLCanvasElement, {
    type: 'line',
    data: { datasets: [] },
    options: {
      animation: false,
      scales: {
        x: { type: 'linear', title: { display: true, text: '№ сообщения' } },
        y: { title: { display: true, text: 'RTT, мс' } },
      },
    },
  });
  return rttChart;
}

function ensureRttBarChart(): Chart {
  rttBarChart ??= new Chart($('rtt-bar-chart') as HTMLCanvasElement, {
    type: 'bar',
    data: {
      labels: ['Среднее', 'Медиана', 'P95', 'P99'],
      datasets: [],
    },
    options: {
      animation: false,
      scales: { y: { title: { display: true, text: 'мс' } } },
    },
  });
  return rttBarChart;
}

function ensureTpChart(): Chart {
  tpChart ??= new Chart($('tp-chart') as HTMLCanvasElement, {
    type: 'bar',
    data: { labels: [], datasets: [{ label: 'Мбит/с (скорость приёма эха)', data: [], backgroundColor: [] }] },
    options: {
      animation: false,
      indexAxis: 'y',
      scales: { x: { title: { display: true, text: 'Мбит/с' } } },
    },
  });
  return tpChart;
}

// --- Сценарий 1: установление соединения ---
async function onSetupTest(): Promise<void> {
  const reps = Number(($('setup-reps') as HTMLInputElement).value);
  const btn = $('btn-setup') as HTMLButtonElement;
  btn.disabled = true;
  try {
    for (const kind of ['wt', 'rtc'] as const) {
      const label = kind === 'wt' ? 'WebTransport' : 'WebRTC';
      log(`Сценарий 1: ${label}, ${reps} подключений...`);
      const r = await runSetupTest(kind, reps, (i) => {
        $('setup-progress').textContent = `${label}: ${i}/${reps}`;
      });
      $(`setup-${kind}`).textContent =
        `среднее ${fmt(r.mean)} мс, медиана ${fmt(r.median)} мс`;
      addResult({
        scenario: 'Установление соединения',
        transport: label,
        params: `${reps} повторов`,
        metrics: { 'среднее, мс': fmt(r.mean), 'медиана, мс': fmt(r.median) },
      });
      log(`Сценарий 1: ${label} — среднее ${fmt(r.mean)} мс`);
    }
    $('setup-progress').textContent = 'готово';
  } catch (err) {
    log(`Ошибка: ${err}`);
  } finally {
    btn.disabled = false;
  }
}

// --- Сценарий 2: RTT ---
async function onRttTest(): Promise<void> {
  const params = {
    count: Number(($('rtt-count') as HTMLInputElement).value),
    size: Number(($('rtt-size') as HTMLInputElement).value),
    intervalMs: Number(($('rtt-interval') as HTMLInputElement).value),
    warmup: 10,
  };
  const btn = $('btn-rtt') as HTMLButtonElement;
  btn.disabled = true;
  const session = new BenchSession();
  try {
    await session.init();
    const lineChart = ensureRttChart();
    const barChart = ensureRttBarChart();
    lineChart.data.datasets = [];
    barChart.data.datasets = [];

    for (const mode of MODES) {
      log(`Сценарий 2: ${MODE_LABELS[mode]}...`);
      const ch = await session.channel(mode);
      const stats = await runRttTest(ch, params, (done, total) => {
        $('rtt-progress').textContent = `${MODE_LABELS[mode]}: ${done}/${total}`;
      });

      lineChart.data.datasets.push({
        label: MODE_LABELS[mode],
        data: stats.samples.map((v, i) => ({ x: i + 1, y: v })),
        borderColor: MODE_COLORS[mode],
        backgroundColor: MODE_COLORS[mode],
        pointRadius: 1,
        borderWidth: 1.5,
      });
      barChart.data.datasets.push({
        label: MODE_LABELS[mode],
        data: [stats.mean, stats.median, stats.p95, stats.p99],
        backgroundColor: MODE_COLORS[mode],
      });

      addResult({
        scenario: 'RTT',
        transport: MODE_LABELS[mode],
        params: `${params.count} сообщ. × ${params.size} Б, интервал ${params.intervalMs} мс`,
        metrics: {
          'среднее, мс': fmt(stats.mean),
          'медиана, мс': fmt(stats.median),
          'p95, мс': fmt(stats.p95),
          'p99, мс': fmt(stats.p99),
          'разброс задержки (RFC 3550), мс': fmt(stats.jitter),
          'σ, мс': fmt(stats.stddev),
          'потери, %': fmt(stats.lossPct),
        },
      });
      log(`Сценарий 2: ${MODE_LABELS[mode]} — медиана ${fmt(stats.median)} мс, p95 ${fmt(stats.p95)} мс, потери ${fmt(stats.lossPct)}%`);
    }
    lineChart.update();
    barChart.update();
    $('rtt-progress').textContent = 'готово';
  } catch (err) {
    log(`Ошибка: ${err}`);
  } finally {
    await session.closeAll();
    btn.disabled = false;
  }
}

// --- Сценарий 3: пропускная способность ---
async function onThroughputTest(): Promise<void> {
  const params = {
    durationMs: Number(($('tp-duration') as HTMLInputElement).value) * 1000,
    size: Number(($('tp-size') as HTMLInputElement).value),
  };
  const btn = $('btn-tp') as HTMLButtonElement;
  btn.disabled = true;
  const session = new BenchSession();
  try {
    await session.init();
    const chart = ensureTpChart();
    chart.data.labels = [];
    (chart.data.datasets[0].data as number[]) = [];
    (chart.data.datasets[0].backgroundColor as string[]) = [];

    for (const mode of MODES) {
      log(`Сценарий 3: ${MODE_LABELS[mode]}...`);
      $('tp-progress').textContent = MODE_LABELS[mode];
      const ch = await session.channel(mode);
      const r = await runThroughputTest(ch, params);

      (chart.data.labels as string[]).push(MODE_LABELS[mode]);
      (chart.data.datasets[0].data as number[]).push(r.mbps);
      (chart.data.datasets[0].backgroundColor as string[]).push(MODE_COLORS[mode]);

      addResult({
        scenario: 'Пропускная способность',
        transport: MODE_LABELS[mode],
        params: `${params.durationMs / 1000} с, сообщения по ${params.size} Б`,
        metrics: {
          'Мбит/с': fmt(r.mbps),
          'отправлено сообщ.': String(r.sentMsgs),
          'получено сообщ.': String(r.receivedMsgs),
          'потери, %': fmt(r.lossPct),
        },
      });
      log(`Сценарий 3: ${MODE_LABELS[mode]} — ${fmt(r.mbps)} Мбит/с, потери ${fmt(r.lossPct)}%`);
    }
    chart.update();
    $('tp-progress').textContent = 'готово';
  } catch (err) {
    log(`Ошибка: ${err}`);
  } finally {
    await session.closeAll();
    btn.disabled = false;
  }
}

// --- Видео ---
let rtcVideoSession: VideoSession | null = null;
let wtVideoSession: VideoSession | null = null;

function renderVideoStats(el: HTMLElement, s: VideoStats): void {
  el.innerHTML = [
    `сквозная задержка: <b>${s.e2eMs != null ? fmt(s.e2eMs, 1) + ' мс' : '—'}</b>`,
    `кадров/с: <b>${s.fps != null ? fmt(s.fps, 0) : '—'}</b>`,
    `скорость приёма: <b>${s.bitrateKbps != null ? fmt(s.bitrateKbps, 0) + ' кбит/с' : '—'}</b>`,
    `разброс задержки: <b>${s.jitterMs != null ? fmt(s.jitterMs, 2) + ' мс' : '—'}</b>`,
    `RTT: <b>${s.rttMs != null ? fmt(s.rttMs, 1) + ' мс' : '—'}</b>`,
    `потери пакетов: <b>${s.packetsLost ?? '—'}</b>`,
  ].join(' · ');
}

async function toggleRtcVideo(): Promise<void> {
  const btn = $('btn-video-rtc') as HTMLButtonElement;
  if (rtcVideoSession) {
    rtcVideoSession.stop();
    rtcVideoSession = null;
    btn.textContent = 'Старт WebRTC-видео';
    return;
  }
  btn.disabled = true;
  try {
    rtcVideoSession = await startWebRtcVideo(
      $('rtc-local') as HTMLVideoElement,
      $('rtc-remote') as HTMLVideoElement,
      (s) => renderVideoStats($('rtc-video-stats'), s),
    );
    btn.textContent = 'Стоп WebRTC-видео';
    log('Видео WebRTC: камера → эхо-сервер (RTP туда и обратно) → экран');
  } catch (err) {
    log(`Ошибка видео WebRTC: ${err}`);
  } finally {
    btn.disabled = false;
  }
}

async function toggleWtVideo(): Promise<void> {
  const btn = $('btn-video-wt') as HTMLButtonElement;
  if (wtVideoSession) {
    wtVideoSession.stop();
    wtVideoSession = null;
    btn.textContent = 'Старт WebTransport-видео';
    return;
  }
  btn.disabled = true;
  try {
    wtVideoSession = await startWtVideo(
      $('wt-local') as HTMLVideoElement,
      $('wt-canvas') as HTMLCanvasElement,
      (s) => renderVideoStats($('wt-video-stats'), s),
    );
    btn.textContent = 'Стоп WebTransport-видео';
    log('Видео WebTransport: камера → WebCodecs VP8 → поток QUIC → эхо-сервер → декодер');
  } catch (err) {
    log(`Ошибка видео WebTransport: ${err}`);
  } finally {
    btn.disabled = false;
  }
}

// --- Инициализация ---
function checkSupport(): void {
  const issues: string[] = [];
  if (!('WebTransport' in window)) issues.push('WebTransport не поддерживается этим браузером');
  if (!('RTCPeerConnection' in window)) issues.push('WebRTC не поддерживается');
  if (!('VideoEncoder' in window)) issues.push('WebCodecs не поддерживается (видео через WebTransport недоступно)');
  if (!('MediaStreamTrackProcessor' in window)) issues.push('MediaStreamTrackProcessor недоступен (видео через WebTransport недоступно)');
  $('support').textContent = issues.length ? '⚠ ' + issues.join('; ') : '✓ Все необходимые API поддерживаются (Chromium)';
}

$('btn-setup').addEventListener('click', onSetupTest);
$('btn-rtt').addEventListener('click', onRttTest);
$('btn-tp').addEventListener('click', onThroughputTest);
$('btn-video-rtc').addEventListener('click', toggleRtcVideo);
$('btn-video-wt').addEventListener('click', toggleWtVideo);
$('btn-csv').addEventListener('click', exportCsv);
checkSupport();
log('Стенд готов. Запустите сценарии 1–3 и проверки видео.');
