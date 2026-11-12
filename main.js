// 本地对比 x2.1 与 x2.1-flash：同一路输入画面、同一段提示词与参考图，左右各建一路实时连接，同时生成。
// 直接使用官方 SDK（未打任何补丁），API Key 只保存在本机浏览器的 localStorage。
import {
  RealtimeConfiguration,
  RealtimeConnectionState,
  RealtimeContext,
  RealtimeModel,
  RealtimeVideoFormat,
  VideoContentMode,
  XmaxClient,
  XmaxConfiguration,
  XmaxEnvironment,
  XmaxLoggerOption,
  XmaxRealtimeVideoView,
  supportedVideoFormats,
} from '@xmaxai/web-sdk';

const MODELS = [
  { id: RealtimeModel.x2_1, label: 'x2.1', note: '1 积分/秒' },
  { id: RealtimeModel.x2_1_flash, label: 'x2.1-flash', note: '0.6 积分/秒' },
];
const FPS = 30;
const $ = (id) => document.getElementById(id);

// ---------- 设置（API Key 只存本机） ----------
const STORAGE_KEY = 'xmax-compare-demo';
const saved = (() => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
})();
$('apiKey').value = saved.apiKey || '';
$('environment').value = saved.environment || 'china';
$('prompt').value = saved.prompt || $('prompt').value;
const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ apiKey: $('apiKey').value.trim(), environment: $('environment').value, prompt: $('prompt').value }));
  } catch { /* 无痕模式等：不保存 */ }
};
['apiKey', 'environment', 'prompt'].forEach((id) => $(id).addEventListener('change', persist));

let client = null;
let clientKey = '';
function getClient() {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) throw new Error('请先填写 API Key');
  const key = `${apiKey}|${$('environment').value}`;
  if (!client || clientKey !== key) {
    client = new XmaxClient(new XmaxConfiguration({
      apiKey,
      environment: $('environment').value === 'global' ? XmaxEnvironment.global : XmaxEnvironment.china,
      loggerOptions: XmaxLoggerOption.none,
    }));
    clientKey = key;
    referenceUrl = null; // 换了账号 / 环境，参考图需重新上传
  }
  return client;
}

// ---------- 输入画面：摄像头或本地视频（循环播放） ----------
const source = $('sourceVideo');
let sourceStream = null;
let isCamera = false;

function stopSource() {
  sourceStream?.getTracks().forEach((track) => track.stop());
  sourceStream = null;
  source.srcObject = null;
  if (source.src) {
    URL.revokeObjectURL(source.src);
    source.removeAttribute('src');
  }
}

async function waitForFrame() {
  if (source.videoWidth) return;
  await new Promise((resolve) => source.addEventListener('loadedmetadata', resolve, { once: true }));
}

function showSourceInfo() {
  $('sourceInfo').textContent = `${isCamera ? '摄像头' : '本地视频'} · ${source.videoWidth}×${source.videoHeight}`;
  source.style.transform = isCamera ? 'scaleX(-1)' : '';
}

$('cameraBtn').onclick = async () => {
  try {
    stopAll();
    stopSource();
    sourceStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    isCamera = true;
    source.srcObject = sourceStream;
    await source.play();
    await waitForFrame();
    showSourceInfo();
  } catch (error) {
    $('sourceInfo').textContent = `打开摄像头失败：${error.message || error}`;
  }
};

$('videoBtn').onclick = () => $('videoFile').click();
$('videoFile').onchange = async () => {
  const file = $('videoFile').files?.[0];
  $('videoFile').value = '';
  if (!file) return;
  stopAll();
  stopSource();
  isCamera = false;
  source.src = URL.createObjectURL(file);
  await source.play().catch(() => undefined);
  await waitForFrame();
  showSourceInfo();
};

// ---------- 参考图（可选）：首次生成时上传到存储，之后复用地址 ----------
let referenceFile = null;
let referenceUrl = null;

$('refBtn').onclick = () => $('refFile').click();
$('refFile').onchange = () => {
  const file = $('refFile').files?.[0];
  $('refFile').value = '';
  if (!file) return;
  referenceFile = file;
  referenceUrl = null;
  $('refThumb').src = URL.createObjectURL(file);
  $('refThumb').hidden = false;
  $('refClear').hidden = false;
};
$('refClear').onclick = () => {
  referenceFile = null;
  referenceUrl = null;
  $('refThumb').hidden = true;
  $('refClear').hidden = true;
};

async function buildContext() {
  const prompt = $('prompt').value.trim();
  if (!prompt) throw new Error('请填写提示词');
  if (referenceFile && !referenceUrl) {
    const stored = await getClient().createStorageService().uploadImage({
      data: referenceFile,
      fileName: referenceFile.name || 'reference.png',
      contentType: referenceFile.type || undefined,
    });
    referenceUrl = stored.url;
  }
  return new RealtimeContext({ prompt, referencePath: referenceUrl || undefined });
}

// ---------- 每个模型一路连接 ----------

// 选模型支持的、与输入画面比例最接近的尺寸。
function pickFormat(modelId, width, height) {
  const formats = supportedVideoFormats(modelId);
  const ratio = width / height;
  return formats.reduce((best, f) =>
    Math.abs(Math.log(f.width / f.height / ratio)) < Math.abs(Math.log(best.width / best.height / ratio)) ? f : best);
}

class Runner {
  constructor(model) {
    this.model = model;
    this.manager = null;
    this.localStream = null;
    this.view = null;
    this.canvasTrack = null;
    this.timers = [];
    this.startedAt = 0;
    this.firstFrameMs = null;
    this.lastFrames = 0;

    const panel = document.createElement('section');
    panel.className = 'card panel';
    panel.innerHTML = `
      <h2><span>${model.label}</span><span class="hint">${model.note}</span></h2>
      <div class="stage"></div>
      <div class="stats">
        <div><span>状态</span><b data-k="state">未开始</b></div>
        <div><span>首帧耗时</span><b data-k="first">—</b></div>
        <div><span>上行 / 输出</span><b data-k="size">—</b></div>
        <div><span>输出帧率 · 时长</span><b data-k="fps">—</b></div>
      </div>
      <div class="error"></div>`;
    $('panels').appendChild(panel);
    this.stage = panel.querySelector('.stage');
    this.errorEl = panel.querySelector('.error');
    this.fields = Object.fromEntries([...panel.querySelectorAll('[data-k]')].map((el) => [el.dataset.k, el]));
  }

  set(key, text, cls = '') {
    this.fields[key].textContent = text;
    this.fields[key].className = cls;
  }

  async start(sdkClient, context) {
    await this.stop();
    this.errorEl.textContent = '';
    this.firstFrameMs = null;
    this.set('first', '—');
    this.set('fps', '—');
    this.set('state', '连接中…');

    // 输入画面按该模型支持的尺寸等比铺满、居中裁剪后送出（两边各自用自己的原生尺寸）。
    const format = pickFormat(this.model.id, source.videoWidth, source.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = format.width;
    canvas.height = format.height;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      const vw = source.videoWidth;
      const vh = source.videoHeight;
      if (!vw || !vh) return;
      const scale = Math.max(canvas.width / vw, canvas.height / vh);
      const sw = canvas.width / scale;
      const sh = canvas.height / scale;
      ctx.drawImage(source, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
    };
    draw();
    this.timers.push(setInterval(draw, 1000 / FPS));
    this.canvasTrack = canvas.captureStream(FPS).getVideoTracks()[0];
    this.stage.style.aspectRatio = `${format.width} / ${format.height}`;

    // 关闭自适应画质：两边都按固定规格收发，便于对比。
    const manager = sdkClient.createRealtimeManager(new RealtimeConfiguration({ model: this.model.id, isAdaptiveQualityEnabled: false }));
    this.manager = manager;
    await manager.setStateListener((snapshot) => this.onState(manager, snapshot));
    this.localStream = await manager.createExternalVideoStream({
      videoTrack: this.canvasTrack,
      videoFormat: new RealtimeVideoFormat({ width: format.width, height: format.height, fps: FPS }),
    });

    this.view = new XmaxRealtimeVideoView({ videoContentMode: VideoContentMode.fit });
    this.view.element.style.transform = isCamera ? 'scaleX(-1)' : '';
    this.view.attach(this.stage);
    this.startedAt = performance.now();
    this.bind(await manager.startGeneration({ localStream: this.localStream, context }));

    // 每秒统计输出分辨率、实际帧率与运行时长。
    this.lastFrames = 0;
    this.timers.push(setInterval(() => this.tick(format), 1000));
  }

  async update(context) {
    if (!this.manager || !this.localStream) return;
    this.bind(await this.manager.startGeneration({ localStream: this.localStream, context }));
  }

  bind(remote) {
    const track = remote?.videoTrack;
    if (!this.view || !track) return;
    this.view.track = track;
    // 远端画面可能在订阅完成后才就绪：就绪后重新绑定一次。
    if (!track.mediaStreamTrack) {
      const manager = this.manager;
      manager.setRemoteMediaTracksListener((tracks) => {
        if (manager !== this.manager || !tracks?.videoTrack || !track.mediaStreamTrack || !this.view) return;
        this.view.track = undefined;
        this.view.track = track;
      });
    }
  }

  onState(manager, snapshot) {
    if (manager !== this.manager) return;
    const state = snapshot.connectionState;
    const failed = snapshot.reason?.kind === 'failure';
    this.set('state', failed ? '失败' : state, state === RealtimeConnectionState.generating ? 'status-ok' : failed ? 'status-err' : '');
    if (state === RealtimeConnectionState.generating && this.firstFrameMs === null) {
      this.firstFrameMs = performance.now() - this.startedAt;
      this.set('first', `${(this.firstFrameMs / 1000).toFixed(2)} 秒`);
    }
    if (failed) this.errorEl.textContent = snapshot.reason?.error?.message || '连接失败';
  }

  tick(format) {
    const video = this.view?.videoElement;
    const out = video?.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '—';
    this.set('size', `${format.width}×${format.height} / ${out}`);
    const frames = video?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    const fps = this.lastFrames ? frames - this.lastFrames : 0;
    this.lastFrames = frames;
    const seconds = Math.round((performance.now() - this.startedAt) / 1000);
    this.set('fps', `${fps} fps · ${seconds} 秒`);
  }

  async stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    const manager = this.manager;
    this.manager = null;
    this.localStream = null;
    if (this.view) {
      this.view.track = undefined;
      try { this.view.detach(); } catch { /* 已移除 */ }
      this.view = null;
    }
    this.canvasTrack?.stop();
    this.canvasTrack = null;
    if (manager) {
      await manager.close().catch(() => undefined);
      this.set('state', '已停止');
    }
  }
}

const runners = MODELS.map((model) => new Runner(model));

// ---------- 按钮 ----------
const setRunning = (running) => {
  $('startBtn').disabled = running;
  $('updateBtn').disabled = !running;
  $('stopBtn').disabled = !running;
};

$('startBtn').onclick = async () => {
  persist();
  try {
    if (!source.videoWidth) throw new Error('请先打开摄像头或选择本地视频');
    const sdkClient = getClient();
    setRunning(true);
    const context = await buildContext();
    const results = await Promise.allSettled(runners.map((runner) => runner.start(sdkClient, context)));
    results.forEach((result, i) => {
      if (result.status === 'rejected') runners[i].errorEl.textContent = result.reason?.message || String(result.reason);
    });
  } catch (error) {
    alert(error.message || error);
    setRunning(false);
  }
};

$('updateBtn').onclick = async () => {
  persist();
  try {
    const context = await buildContext();
    await Promise.allSettled(runners.map((runner) => runner.update(context)));
  } catch (error) {
    alert(error.message || error);
  }
};

function stopAll() {
  setRunning(false);
  return Promise.allSettled(runners.map((runner) => runner.stop()));
}
$('stopBtn').onclick = () => stopAll();
// 关闭页面时断开连接，停止计费。
window.addEventListener('pagehide', () => runners.forEach((runner) => runner.manager?.close().catch(() => undefined)));
