// ============ 音频引擎：解码 / Worker 分析调度 / 播放器（AudioContext.currentTime 主时钟） ============

import AnalysisWorker from './analysis.worker.js?worker&inline';
import { musicTimeAt, playAnchorMusicT } from './timeutil.js';

let _ctx = null;
export function getCtx() {
  if (!_ctx) {
    _ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  }
  return _ctx;
}

/**
 * 估算"听到的声音滞后于 ctx.currentTime"的量（秒）。
 * Android WebView 上 outputLatency 常达 100-250ms：不补偿则视觉/判定时钟
 * 超前于玩家听感，导致每次点按都被判"晚"（v1.5.0 修复的根因 bug）。
 * 返回值裁剪到 [0, 0.45] 防异常值。
 */
export function getAudioOutLatency(ctx) {
  try {
    const out = Number(ctx.outputLatency) || 0;
    const base = Number(ctx.baseLatency) || 0;
    let lat = out + base;
    if (!Number.isFinite(lat) || lat < 0) lat = 0;
    return Math.min(lat, 0.45);
  } catch (e) {
    return 0;
  }
}

/** 解码音频文件（Chromium 内部线程执行，不阻塞 UI 主线程） */
export async function decodeFile(arrayBuffer) {
  const ctx = getCtx();
  try {
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch (e) {
    throw new Error('音频解码失败（可能是不支持的编码，请尝试 mp3/wav/ogg）');
  }
}

/**
 * 把 AudioBuffer 送入 Worker 分析（拷贝 channel data 后 transfer，原 buffer 保持可播放）
 */
export function analyzeBuffer(audioBuffer, onProgress) {
  return new Promise((resolve, reject) => {
    const channels = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      channels.push(new Float32Array(audioBuffer.getChannelData(c))); // 拷贝，避免 detach
    }
    const worker = new AnalysisWorker();
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('分析超时'));
    }, 120000);
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        if (onProgress) onProgress(msg);
      } else if (msg.type === 'result') {
        clearTimeout(timeout);
        worker.terminate();
        resolve(msg.analysis);
      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error('分析 Worker 错误: ' + (e.message || 'unknown')));
    };
    worker.postMessage(
      { type: 'analyze', channels, sampleRate: audioBuffer.sampleRate, durationSec: audioBuffer.duration },
      channels.map((c) => c.buffer)
    );
  });
}

/**
 * 歌曲播放器：主时钟严格使用 AudioContext.currentTime
 * 暂停/恢复用 ctx.suspend()/resume()（时钟冻结，恢复后无漂移）
 * v1.7.0：变速（rate）与 seek（跳到任意音乐时间）——手录谱慢放/回退用。
 * 关键设计：time 始终返回"音乐内容时间"（不受 rate 影响），换算公式
 *   音乐时间 = 起点 + (ctx.currentTime - 起点ctx时刻) × rate
 * 慢放时 wall-clock 走 1 秒音乐只前进 rate 秒——录入时刻即音乐时间轴时刻，
 * 录出的谱在正常速度播放时对位不变。
 */
export class SongPlayer {
  constructor(buffer) {
    this.ctx = getCtx();
    this.buffer = buffer;
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.source = null;
    this.startedAtCtx = null; // 当前播放段 0 点对应的 ctx.currentTime
    this.startMusicT = 0;     // 播放段起点的音乐时间
    this.rate = 1;
    this.playing = false;
    this.paused = false;
  }
  setVolume(v) {
    this.gain.gain.value = Math.max(0, Math.min(1, v));
  }
  /** 变速（0.5x / 0.75x / 1x…，音调不变）。播放中调用即刻生效。 */
  setRate(r) {
    if (!Number.isFinite(r) || r <= 0) return;
    const t = this.time;                    // 先读当前音乐时间
    this.rate = r;
    if (this.source) {
      this.source.playbackRate.value = r;
      // 重锚段起点：让 time 连续
      this.startMusicT = t;
      this.startedAtCtx = this.ctx.currentTime;
    }
  }
  /** leadSec：开声前的倒计时秒数（此间 time 为负）。
   *  v1.7.1 修复：时钟锚定在【调用时刻】而非音频出声时刻。
   * 旧锚定（startedAtCtx=未来出声点）导致 time 在倒计时前段被 max(0,wall)
   * 钳死不动、且音乐出声早于倒计时结束整整 lead 秒——“321 还没走完歌就开始响”的根因，
   * 游玩页与手录页（自制谱）共用此路径。新锚定后：time 从 fromT-rate*lead 连续走到
   * fromT，音频恰在 time=fromT 的瞬间出声，倒计时与音乐严格同步（慢放下 lead 为墙钟时长）。 */
  play(leadSec = 2, fromT = 0) {
    if (this.source) { try { this.source.stop(); } catch (e) { /* noop */ } }
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    src.connect(this.gain);
    const startAt = this.ctx.currentTime + leadSec;
    src.start(startAt, Math.max(0, fromT));
    this.source = src;
    this.startedAtCtx = this.ctx.currentTime; // 锚定在调用时刻（过去）——time 即刻开始走
    this.startMusicT = playAnchorMusicT(fromT, leadSec, this.rate);
    this.playing = true;
    this.paused = false;
  }
  /** 跳到任意音乐时间。播放中：带 leadSec 倒计时重锚；暂停/未开播：仅更新锚点（恢复后从新位置继续） */
  seek(musicT, leadSec = 0.6) {
    const t = Math.max(0, Math.min(this.buffer.duration - 0.05, musicT));
    if (!this.playing || this.paused) {
      // v1.7.0 修复：暂停/未开播时直接更新锚点——旧实现 play 后立刻 pause，
      // 段起点会被 leadSec 拉回 t - rate*lead，seek 精度丢失（拖动滑块定位不准）。
      this.startMusicT = t;
      this.startedAtCtx = null;
      return;
    }
    this.play(t, leadSec);
  }
  /** AudioContext 基准的音乐内容时间（秒；含倒计时负值段；慢放时仍为音乐时间轴） */
  get time() {
    return musicTimeAt(this.startMusicT, this.startedAtCtx, this.ctx.currentTime, this.rate);
  }
  get duration() { return this.buffer.duration; }
  pause() {
    if (!this.paused && this.playing) {
      // 暂停时锚定当前音乐时间，恢复后无跳变
      this.startMusicT = this.time;
      this.startedAtCtx = null;
      if (this.source) { try { this.source.stop(); } catch (e) { /* noop */ } this.source = null; }
      this.paused = true;
      this.playing = false;
    }
  }
  resume() {
    if (this.paused) {
      this.paused = false;
      this.play(0, this.startMusicT);
    }
  }
  stop() {
    this.playing = false;
    if (this.source) { try { this.source.stop(); } catch (e) { /* noop */ } this.source = null; }
    this.startedAtCtx = null;
    this.startMusicT = 0;
  }
  destroy() {
    this.stop();
    try { this.gain.disconnect(); } catch (e) { /* noop */ }
  }
}

/** 合成打击音效（短 click，预生成 buffer 复用） */
let _clickBuf = null;
export function getClickBuffer() {
  const ctx = getCtx();
  if (_clickBuf) return _clickBuf;
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 0.045);
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 90);
    data[i] = env * (Math.sin(2 * Math.PI * 1900 * t) * 0.6 + (Math.random() * 2 - 1) * 0.35);
  }
  _clickBuf = buf;
  return buf;
}

export function playClick(volume = 0.5, freq = 1900) {
  const ctx = getCtx();
  const src = ctx.createBufferSource();
  src.buffer = getClickBuffer();
  if (freq !== 1900) src.playbackRate.value = freq / 1900;
  const g = ctx.createGain();
  g.gain.value = volume;
  src.connect(g);
  g.connect(ctx.destination);
  src.start();
}

/** 在精确的 ctx 时间点播放 click（延迟校准器用） */
export function scheduleClick(when, volume = 0.6) {
  const ctx = getCtx();
  const src = ctx.createBufferSource();
  src.buffer = getClickBuffer();
  const g = ctx.createGain();
  g.gain.value = volume;
  src.connect(g);
  g.connect(ctx.destination);
  src.start(when);
  return when;
}
