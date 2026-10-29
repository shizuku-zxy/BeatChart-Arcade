// ============ 音频分析 Worker v4 ============
// 在 Worker 线程执行全部重计算，不阻塞 UI。
//
// 输出维度：
//   节拍层：BPM / offset / beat 网格 / meter（拍号，3 或 4）
//           downbeatPhase / barGrid（小节线）/ tatum（最小律动单元，每拍细分）
//   乐器层：drumKicks（低频瞬态 ≈ 底鼓）/ drumSnares（中宽带瞬态 ≈ 军鼓·拍手）
//           drumHihats（高频瞬态 ≈ 踩镲·碎镲）
//   人声层（v4）：vocalOnsets（人声带瞬态 + 谐波验证 + 鼓点排除，进唱/换句事件）
//   音高层：chromagram → key（Krumhansl-Schmuckler 调性）
//           tonalOnsets（和声变化事件）/ tonalSustains（持续和声窗口，hold 候选）
//   能量层：RMS 动态 / 段落能量（3 均值聚类）
//   结构层（v4）：segments2（小节对齐变化点分段 + intro/verse/chorus/break/inst/outro 标签）

const TARGET_SR = 22050;
const FFT_SIZE = 1024;
const HOP = 256;
const FRAME_RATE = TARGET_SR / HOP; // ≈ 86.13 fps
const BIN_FREQ = TARGET_SR / FFT_SIZE; // ≈ 21.53 Hz

// 频带（bin 区间 [lo, hi)）
const BAND_KICK = [1, 7];      // ~30-130 Hz    底鼓/低音瞬态
const BAND_SNARE = [8, 94];    // ~180-2000 Hz  军鼓/拍手
const BAND_HIHAT = [232, 512]; // ~5-11 kHz     踩镲/碎镲
const BAND_CHROMA = [4, 233];  // ~80-5000 Hz   音高内容
const BAND_VOCAL = [7, 38];    // ~150-820 Hz   人声基频区（v4；与 snare 带重叠，独立累计）
const BAND_SNARE_HI = [38, 94]; // ~820-2000 Hz 军鼓带上半（v4：人声/鼓判别用）

// ---------- FFT（radix-2 迭代实现） ----------
class FFT {
  constructor(n) {
    this.n = n;
    this.levels = Math.log2(n) | 0;
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0, x = i;
      for (let j = 0; j < this.levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
      this.rev[i] = r;
    }
  }
  transform(re, im) {
    const n = this.n, rev = this.rev, cosT = this.cos, sinT = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cosT[k] + im[l] * sinT[k];
          const tim = -re[l] * sinT[k] + im[l] * cosT[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  }
}

// ---------- 工具 ----------
function post(stage, pct) { self.postMessage({ type: 'progress', stage, pct }); }

function mixdown(channels) {
  if (channels.length === 1) return channels[0];
  const len = channels[0].length;
  const out = new Float32Array(len);
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c];
    for (let i = 0; i < len; i++) out[i] += ch[i];
  }
  const inv = 1 / channels.length;
  for (let i = 0; i < len; i++) out[i] *= inv;
  return out;
}

function resample(input, fromSR, toSR) {
  if (Math.abs(fromSR - toSR) < 1) return { data: input, sr: fromSR };
  const n = input.length;
  const smooth = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) smooth[i] = 0.25 * input[i - 1] + 0.5 * input[i] + 0.25 * input[i + 1];
  if (n > 1) { smooth[0] = input[0]; smooth[n - 1] = input[n - 1]; }
  const ratio = fromSR / toSR;
  const outLen = Math.max(1, Math.floor(n / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos), i1 = Math.min(n - 1, i0 + 1);
    const f = pos - i0;
    out[i] = smooth[i0] * (1 - f) + smooth[i1] * f;
  }
  return { data: out, sr: toSR };
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = Float32Array.from(arr).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function envAt(env, frame) {
  if (frame < 0) return 0;
  if (frame >= env.length - 1) return 0;
  const i = Math.floor(frame), f = frame - i;
  return env[i] * (1 - f) + env[i + 1] * f;
}

function smoothArray(arr, win) {
  const n = arr.length;
  const out = new Float32Array(n);
  const half = Math.max(1, Math.floor(win / 2));
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + arr[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
    out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
  }
  return out;
}

function pearson(a, b) {
  const n = a.length;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  const cov = sxy / n - (sx / n) * (sy / n);
  const vx = sxx / n - (sx / n) * (sx / n);
  const vy = syy / n - (sy / n) * (sy / n);
  if (vx <= 1e-12 || vy <= 1e-12) return 0;
  return cov / Math.sqrt(vx * vy);
}

// ---------- 通用 onset 检测（自适应阈值 + 抛物线细化 + 去重） ----------
function detectOnsets(sig, opts = {}) {
  const { winSec = 10, kStd = 0.9, kFloor = 0.02, dedupGapSec = 0.05, frameRate = FRAME_RATE } = opts;
  const n = sig.length;
  if (n < 3) return [];
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = sig[Math.max(0, i - 1)], b = sig[i], c = sig[Math.min(n - 1, i + 1)];
    sm[i] = (a + b + c) / 3;
  }
  const fluxMax = Math.max(1e-9, percentile(sm, 99.5));
  const winFrames = Math.max(8, Math.round(winSec * frameRate));
  const onsets = [];
  for (let i = 1; i < n - 1; i++) {
    if (!(sm[i] > sm[i - 1] && sm[i] >= sm[i + 1])) continue;
    const wS = Math.max(0, i - winFrames), wE = Math.min(n, i + winFrames);
    let mean = 0, cnt = 0;
    for (let j = wS; j < wE; j += 4) { mean += sm[j]; cnt++; }
    mean /= Math.max(1, cnt);
    let vari = 0;
    for (let j = wS; j < wE; j += 4) { const d = sm[j] - mean; vari += d * d; }
    const std = Math.sqrt(vari / Math.max(1, cnt));
    const thr = mean + kStd * std + kFloor * fluxMax;
    if (sm[i] <= thr) continue;
    const denom = sm[i - 1] - 2 * sm[i] + sm[i + 1];
    const shift = denom !== 0 ? (0.5 * (sm[i - 1] - sm[i + 1])) / denom : 0;
    const t = (i + shift) / frameRate;
    if (t < 0) continue;
    onsets.push({ t, s: Math.min(1, sm[i] / fluxMax) });
  }
  const deduped = [];
  for (const o of onsets) {
    const last = deduped[deduped.length - 1];
    if (last && o.t - last.t < dedupGapSec) {
      if (o.s > last.s) deduped[deduped.length - 1] = o;
    } else deduped.push(o);
  }
  return deduped;
}

// ---------- Krumhansl-Schmuckler 调性模板 ----------
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.19, 2.39, 3.66, 2.29, 2.88, 3.34, 2.74, 3.57, 4.10];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function detectKey(aggChroma) {
  let best = { tonic: 'C', tonicPc: 0, mode: 'major', corr: -Infinity };
  let second = -Infinity;
  for (let pc = 0; pc < 12; pc++) {
    for (const [mode, profile] of [['major', KS_MAJOR], ['minor', KS_MINOR]]) {
      const rotated = new Array(12);
      for (let i = 0; i < 12; i++) rotated[i] = profile[(i - pc + 12) % 12];
      const corr = pearson(aggChroma, rotated);
      if (corr > best.corr) { second = best.corr; best = { tonic: NOTE_NAMES[pc], tonicPc: pc, mode, corr }; }
      else if (corr > second) second = corr;
    }
  }
  const confidence = Math.max(0, Math.min(1, (best.corr - 0.45) / 0.5));
  return { tonic: best.tonic, tonicPc: best.tonicPc, mode: best.mode, confidence: +confidence.toFixed(3) };
}

// ---------- 拍号 / 小节线 ----------
function seqCorr(E, lag) {
  const n = E.length - lag;
  if (n < 8) return 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = lag; i < E.length; i++) {
    const x = E[i - lag], y = E[i];
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  const cov = sxy / n - (sx / n) * (sy / n);
  const vx = sxx / n - (sx / n) * (sx / n);
  const vy = syy / n - (sy / n) * (sy / n);
  if (vx <= 1e-12 || vy <= 1e-12) return 0;
  return cov / Math.sqrt(vx * vy);
}

function detectDownbeat(beats, kickEnvSm) {
  const E = beats.map((t) => envAt(kickEnvSm, t * FRAME_RATE));
  if (E.length < 12) return { meter: 4, downbeatPhase: 0, downbeatConfidence: 0, barGrid: beats.slice() };
  const c4 = seqCorr(E, 4), c3 = seqCorr(E, 3);
  const meter = c3 > c4 * 1.25 && c3 > 0.25 ? 3 : 4;
  const scores = [];
  for (let p = 0; p < meter; p++) {
    let s = 0, c = 0;
    for (let i = p; i < E.length; i += meter) { s += E[i]; c++; }
    scores.push(c ? s / c : 0);
  }
  let bestP = 0;
  for (let p = 1; p < meter; p++) if (scores[p] > scores[bestP]) bestP = p;
  const sorted = [...scores].sort((a, b) => b - a);
  const conf = Math.max(0, Math.min(1, (sorted[0] - (sorted[1] || 0)) / (sorted[0] + 1e-9)));
  const barGrid = beats.filter((_, i) => i % meter === bestP).map((t) => +t.toFixed(4));
  return { meter, downbeatPhase: bestP, downbeatConfidence: +conf.toFixed(3), barGrid };
}

// ---------- tatum（最小律动单元） ----------
function gridCoverage(onsets, beats, beatSec, s) {
  if (!onsets.length || !beats.length) return 0;
  const tol = Math.max(0.02, (beatSec / s) * 0.18);
  let hit = 0;
  const b0 = beats[0];
  for (const o of onsets) {
    const rel = ((o.t - b0) / beatSec) * s;
    const dTime = Math.abs(rel - Math.round(rel)) * (beatSec / s);
    if (dTime <= tol) hit++;
  }
  return hit / onsets.length;
}

function detectTatum(onsets, beats, beatSec) {
  if (!onsets.length || !beats.length) return 4;
  const cand = [1, 2, 3, 4, 6, 8];
  const covs = cand.map((s) => ({ s, c: gridCoverage(onsets, beats, beatSec, s) }));
  const first = covs.find((x) => x.c >= 0.82);
  if (first) return first.s;
  const best = covs.reduce((a, b) => (b.c > a.c ? b : a));
  return best.c >= 0.5 ? best.s : 2;
}

// ---------- 重复段检测 ----------
function countIn(arr, t0, t1) {
  let c = 0;
  for (const o of arr) if (o.t >= t0 && o.t < t1) c++;
  return c;
}

function cosSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na <= 1e-12 || nb <= 1e-12) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * 小节级重复段检测：贪心最长匹配。
 * 输出 repeats: [{srcBar, dstBar, bars, srcStart, srcEnd, dstStart, dstEnd, similarity}]
 * 含义：dstBar 起的 bars 个小节是 srcBar 起的同一段音乐（副歌再现等）。
 */
function detectRepeats(barGrid, durationSec, kicks, snares, hihats, chroma, nCFrames, chromaFR, rmsFrames) {
  const nBars = barGrid.length;
  if (nBars < 4) return [];
  const barDur = nBars > 1 ? barGrid[1] - barGrid[0] : 2;

  // 小节特征
  const feats = [];
  let maxK = 1, maxS = 1, maxH = 1, maxE = 1e-9;
  for (let b = 0; b < nBars; b++) {
    const t0 = barGrid[b];
    const t1 = b + 1 < nBars ? barGrid[b + 1] : durationSec;
    const ch = new Float64Array(12);
    const f0 = Math.floor(t0 * chromaFR), f1 = Math.min(nCFrames, Math.ceil(t1 * chromaFR));
    for (let f = f0; f < f1; f++) for (let i = 0; i < 12; i++) ch[i] += chroma[f * 12 + i];
    const kc = countIn(kicks, t0, t1), sc = countIn(snares, t0, t1), hc = countIn(hihats, t0, t1);
    let en = 0, enC = 0;
    for (let f = Math.floor(t0 * FRAME_RATE); f < Math.min(rmsFrames.length, Math.ceil(t1 * FRAME_RATE)); f++) { en += rmsFrames[f]; enC++; }
    feats.push({ ch, kc, sc, hc, en: enC ? en / enC : 0 });
    maxK = Math.max(maxK, kc); maxS = Math.max(maxS, sc); maxH = Math.max(maxH, hc);
    maxE = Math.max(maxE, feats[b].en);
  }
  const drumVec = (f) => [f.kc / maxK, f.sc / maxS, f.hc / maxH];
  // 能量相似度（dB 域）：编曲强度（响度）差 6dB 以上视为不同段落；
  // 安静主歌 vs 加满编曲的响亮副歌即使和弦相同，也不是"同一段音乐"
  const enSim = (a, b) => {
    const dbA = 20 * Math.log10(a.en + 1e-6);
    const dbB = 20 * Math.log10(b.en + 1e-6);
    return Math.max(0, 1 - Math.abs(dbA - dbB) / 6);
  };
  const sim = (a, b) => {
    const c = cosSim(a.ch, b.ch);
    const d = cosSim(drumVec(a), drumVec(b));
    const e = enSim(a, b);
    return c * 0.5 + d * 0.25 + e * 0.25;
  };

  const TH = 0.93, MIN_BARS = 2;
  const reps = [];
  let i = 1;
  while (i < nBars) {
    let best = null;
    for (let j = 0; j < i; j++) {
      if (sim(feats[i], feats[j]) < TH) continue;
      let L = 1, sSum = sim(feats[i], feats[j]);
      while (i + L < nBars && j + L < i && sim(feats[i + L], feats[j + L]) >= TH) {
        sSum += sim(feats[i + L], feats[j + L]);
        L++;
      }
      if (L >= MIN_BARS && (!best || L > best.L)) best = { j, i, L, s: sSum / L };
    }
    if (best) {
      const srcStart = barGrid[best.j];
      const dstStart = barGrid[best.i];
      reps.push({
        srcBar: best.j, dstBar: best.i, bars: best.L,
        srcStart: +srcStart.toFixed(3),
        srcEnd: +(srcStart + best.L * barDur).toFixed(3),
        dstStart: +dstStart.toFixed(3),
        dstEnd: +(dstStart + best.L * barDur).toFixed(3),
        similarity: +best.s.toFixed(3),
      });
      i += best.L;
    } else i++;
  }
  return reps;
}

// ---------- 主分析 ----------
function analyze(channels, sampleRate, durationSec) {
  post('mixdown', 5);
  const mono = mixdown(channels);
  post('resample', 12);
  const rs = resample(mono, sampleRate, TARGET_SR);
  const pcm = rs.data;
  const nSamples = pcm.length;

  // ---- STFT + 全带/分频带 flux + chromagram ----
  post('stft', 18);
  const fft = new FFT(FFT_SIZE);
  const window = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  const nFrames = Math.max(1, Math.floor((nSamples - FFT_SIZE) / HOP) + 1);

  const flux = new Float32Array(nFrames);
  const kickFlux = new Float32Array(nFrames);
  const snareFlux = new Float32Array(nFrames);
  const hihatFlux = new Float32Array(nFrames);
  const vocalFlux = new Float32Array(nFrames); // v4：人声基频区通量
  const snareHighFlux = new Float32Array(nFrames); // v4：军鼓带上半通量（人声/鼓判别）
  const kickEnv = new Float32Array(nFrames);
  const rmsFrames = new Float32Array(nFrames);

  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const prevMag = new Float32Array(FFT_SIZE / 2);
  const mag = new Float32Array(FFT_SIZE / 2);
  let prevKick = 0, prevSnare = 0, prevHihat = 0, prevVocal = 0, prevSnareHigh = 0;

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    let rms = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = pcm[off + i] || 0;
      rms += s * s;
      re[i] = s * window[i];
      im[i] = 0;
    }
    rmsFrames[f] = Math.sqrt(rms / FFT_SIZE);
    fft.transform(re, im);
    let fl = 0, kickSum = 0, snareSum = 0, hihatSum = 0, vocalSum = 0, snareHighSum = 0;
    for (let k = 0; k < FFT_SIZE / 2; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mag[k] = m;
      const d = m - prevMag[k];
      if (d > 0) fl += d;
      prevMag[k] = m;
      if (k >= BAND_KICK[0] && k < BAND_KICK[1]) kickSum += m;
      else if (k >= BAND_SNARE[0] && k < BAND_SNARE[1]) snareSum += m;
      else if (k >= BAND_HIHAT[0]) hihatSum += m;
      // v4：人声基频区独立累计（与 snare 带重叠，不进 else 链）
      if (k >= BAND_VOCAL[0] && k < BAND_VOCAL[1]) vocalSum += m;
      if (k >= BAND_SNARE_HI[0] && k < BAND_SNARE_HI[1]) snareHighSum += m;
    }
    flux[f] = fl / (FFT_SIZE / 2);
    kickFlux[f] = Math.max(0, kickSum - prevKick);
    snareFlux[f] = Math.max(0, snareSum - prevSnare);
    hihatFlux[f] = Math.max(0, hihatSum - prevHihat);
    vocalFlux[f] = Math.max(0, vocalSum - prevVocal);
    snareHighFlux[f] = Math.max(0, snareHighSum - prevSnareHigh);
    kickEnv[f] = kickSum;
    prevKick = kickSum; prevSnare = snareSum; prevHihat = hihatSum; prevVocal = vocalSum; prevSnareHigh = snareHighSum;
  }

  // ---- chroma 独立通道（4096 窗口 / 1024 hop ≈ 21.5fps） ----
  // 频率分辨率 5.4Hz/bin：相邻半音（低频仅 ~9-30Hz）可分辨；1024 窗口下 C3-E3
  // 仅差 1.6 bin（汉宁主瓣 4 bin）会被溶成一个峰，导致音级错位。
  const CHROMA_FFT_SIZE = 4096;
  const CHROMA_HOP2 = 1024;
  const CHROMA_FR = TARGET_SR / CHROMA_HOP2;
  const BIN_FREQ_C = TARGET_SR / CHROMA_FFT_SIZE; // ≈ 5.38 Hz
  const nCFrames = Math.max(1, Math.floor((nSamples - CHROMA_FFT_SIZE) / CHROMA_HOP2) + 1);
  const chroma = new Float32Array(nCFrames * 12);
  const chromaRms = new Float32Array(nCFrames);
  const fftC = new FFT(CHROMA_FFT_SIZE);
  const winC = new Float32Array(CHROMA_FFT_SIZE);
  for (let i = 0; i < CHROMA_FFT_SIZE; i++) winC[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (CHROMA_FFT_SIZE - 1)));
  const reC = new Float32Array(CHROMA_FFT_SIZE);
  const imC = new Float32Array(CHROMA_FFT_SIZE);
  const magC = new Float32Array(CHROMA_FFT_SIZE / 2);
  const chF = new Float32Array(12);
  const C_BIN_LO = Math.max(2, Math.round(80 / BIN_FREQ_C));
  const C_BIN_HI = Math.min(CHROMA_FFT_SIZE / 2 - 2, Math.round(5000 / BIN_FREQ_C));
  for (let f = 0; f < nCFrames; f++) {
    const off = f * CHROMA_HOP2;
    let rms = 0;
    for (let i = 0; i < CHROMA_FFT_SIZE; i++) {
      const s = pcm[off + i] || 0;
      rms += s * s;
      reC[i] = s * winC[i];
      imC[i] = 0;
    }
    chromaRms[f] = Math.sqrt(rms / CHROMA_FFT_SIZE);
    fftC.transform(reC, imC);
    for (let k = 0; k < CHROMA_FFT_SIZE / 2; k++) {
      magC[k] = Math.sqrt(reC[k] * reC[k] + imC[k] * imC[k]);
    }
    // 谱峰 chroma：抛物线插值峰频率 → 音级
    chF.fill(0);
    for (let k = C_BIN_LO; k <= C_BIN_HI; k++) {
      if (!(magC[k] > magC[k - 1] && magC[k] >= magC[k + 1])) continue;
      if (magC[k] < 1.0) continue;
      const den = magC[k - 1] - 2 * magC[k] + magC[k + 1];
      const delta = den !== 0 ? (0.5 * (magC[k - 1] - magC[k + 1])) / den : 0;
      const freq = (k + Math.max(-1, Math.min(1, delta))) * BIN_FREQ_C;
      const midi = 69 + 12 * Math.log2(freq / 440);
      if (midi < 21 || midi > 108) continue;
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chF[pc] += Math.log(1 + magC[k]);
    }
    for (let i = 0; i < 12; i++) chroma[f * 12 + i] = chF[i];
  }

  // ---- 合并流 onset（全带） ----
  post('onset', 42);
  const onsets = detectOnsets(flux, {});

  // ---- 分乐器 onset ----
  post('drums', 50);
  const drumKicks = detectOnsets(kickFlux, { kStd: 0.8, kFloor: 0.03 });
  const drumSnaresRaw = detectOnsets(snareFlux, { kStd: 1.0, kFloor: 0.03 });
  const drumHihats = detectOnsets(hihatFlux, { kStd: 0.85, kFloor: 0.02, dedupGapSec: 0.045 });

  // ---- 人声/军鼓判别（v4）：瞬态带宽比 ----
  // 人声与军鼓同为中频瞬态（频带重叠），谐波验证不可行（和声 pad 持续存在，
  // 任何时刻 chroma 都集中）。正确判别特征是【瞬态的带宽分布】：
  //   人声能量集中在基频区（150-820Hz，基频+2/3 泛音），820-2000Hz 仅弱泛音
  //   军鼓是宽带噪声，150-820 与 820-2000 均匀铺满
  // ratio = vocalFlux / (vocalFlux + snareHighFlux)：人声起音 ≈0.75、军鼓 ≈0.36，
  // 阈值 0.55 分界（pad 稳态无通量、不干扰）。
  const VOCAL_RATIO_TH = 0.55;
  const transientRatioAt = (t) => {
    const f = Math.max(0, Math.min(nFrames - 1, Math.round(t * FRAME_RATE)));
    const v = vocalFlux[f], sh = snareHighFlux[f];
    return v / (v + sh + 1e-9);
  };
  // 军鼓剔除人声冒充（人声泛音全落在 snare 带内，会被 snareFlux 检出）
  const drumSnares = drumSnaresRaw.filter((o) => transientRatioAt(o.t) < VOCAL_RATIO_TH);

  // ---- 人声 onset（v4）：人声基频区瞬态 + 带宽比 + 谐波验证 + 军鼓排除 ----
  post('vocal', 54);
  const vocalRaw = detectOnsets(vocalFlux, { kStd: 1.05, kFloor: 0.012, dedupGapSec: 0.09 });
  const chromaRmsMed = percentile(chromaRms, 50);
  const vocalOnsets = [];
  for (const o of vocalRaw) {
    if (transientRatioAt(o.t) < VOCAL_RATIO_TH) continue; // 宽带瞬态（鼓/噪声）非人声
    // 谐波验证：该时刻有音高内容（排除纯噪声瞬态；pad 稳态不产生通量峰不干扰）
    const cf = Math.min(nCFrames - 1, Math.max(0, Math.round(o.t * CHROMA_FR)));
    if (chromaRms[cf] <= chromaRmsMed * 0.45) continue;
    // 军鼓排除（drumSnares 已剔除人声冒充，只剩真鼓）
    let isDrum = false;
    for (const sn of drumSnares) {
      if (Math.abs(sn.t - o.t) < 0.05) { isDrum = true; break; }
    }
    if (isDrum) continue;
    vocalOnsets.push({ t: +o.t.toFixed(4), s: o.s });
  }

  // ---- BPM：自相关 + 倍频修正 + 梳状校验 ----
  post('bpm', 58);
  const sm = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    const a = flux[Math.max(0, i - 1)], b = flux[i], c = flux[Math.min(nFrames - 1, i + 1)];
    sm[i] = (a + b + c) / 3;
  }
  let fMean = 0;
  for (let i = 0; i < nFrames; i++) fMean += sm[i];
  fMean /= nFrames;
  const centered = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) centered[i] = sm[i] - fMean;

  const minLag = Math.floor((60 / 200) * FRAME_RATE);
  const maxLag = Math.ceil((60 / 60) * FRAME_RATE);
  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < nFrames; i++) s += centered[i] * centered[i + lag];
    ac[lag] = s / (nFrames - lag);
  }
  const peaks = [];
  const searched = new Set();
  for (let iter = 0; iter < 6; iter++) {
    let best = -1, bestV = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (searched.has(lag)) continue;
      if (ac[lag] > bestV) { bestV = ac[lag]; best = lag; }
    }
    if (best < 0) break;
    peaks.push({ lag: best, v: bestV });
    for (let d = -6; d <= 6; d++) searched.add(best + d);
  }
  const bpmPreference = (bpm) => {
    if (bpm < 55 || bpm > 240) return 0;
    if (bpm >= 90 && bpm <= 180) return 1.0;
    if (bpm >= 75 && bpm < 90) return 0.72;
    if (bpm > 180 && bpm <= 200) return 0.68;
    return 0.3;
  };
  let bestScore = -Infinity, bestBpm = 120;
  for (const p of peaks) {
    const baseBpm = 60 / (p.lag / FRAME_RATE);
    for (const mult of [0.5, 1, 2]) {
      const bpm = baseBpm * mult;
      if (bpm < 55 || bpm > 240) continue;
      const pref = bpmPreference(bpm);
      const period = (60 / bpm) * FRAME_RATE;
      const phase = bestPhase(centered, period, nFrames);
      let comb = 0, cnt = 0;
      for (let t = phase; t < nFrames; t += period) { comb += envAt(centered, t); cnt++; }
      comb = cnt ? comb / cnt : 0;
      const score = Math.sqrt(Math.max(0, p.v)) * pref * (0.4 + 0.6 * comb);
      if (score > bestScore) { bestScore = score; bestBpm = bpm; }
    }
  }
  bestBpm = Math.round(bestBpm * 10) / 10;

  // ---- offset：相位搜索 + onset 吸附修正 ----
  const period = (60 / bestBpm) * FRAME_RATE;
  let phase = bestPhase(centered, period, nFrames);
  let offset = (phase * HOP) / TARGET_SR;
  if (onsets.length > 8) {
    const diffs = [];
    for (const o of onsets) {
      const beatIdx = Math.round((o.t - offset) / (60 / bestBpm));
      const beatT = offset + beatIdx * (60 / bestBpm);
      let d = o.t - beatT;
      const half = (60 / bestBpm) / 2;
      if (d > half) d -= 60 / bestBpm;
      if (d < -half) d += 60 / bestBpm;
      // 只统计贴近节拍的 onset（排除反拍事件，防止 hihat 主导的歌把 offset 拉偏半拍）
      if (Math.abs(d) < (60 / bestBpm) * 0.2) diffs.push(d);
    }
    if (diffs.length >= 8) {
      diffs.sort((a, b) => a - b);
      offset += diffs[Math.floor(diffs.length / 2)] * 0.7;
    }
  }
  const beatSec = 60 / bestBpm;
  offset = ((offset % beatSec) + beatSec) % beatSec;

  const beats = [];
  for (let t = offset; t <= durationSec + beatSec; t += beatSec) {
    beats.push(+Math.max(0, t).toFixed(4));
  }

  // ---- 拍号 / 小节线 ----
  post('downbeat', 66);
  const kickEnvSm = smoothArray(kickEnv, Math.round(0.12 * FRAME_RATE));
  const { meter, downbeatPhase, downbeatConfidence, barGrid } = detectDownbeat(beats, kickEnvSm);

  // ---- 调性 / tonal onset / sustain ----
  post('tonal', 72);
  const aggChroma = new Float64Array(12);
  const rmsMedian = percentile(chromaRms, 50);
  for (let f = 0; f < nCFrames; f++) {
    if (chromaRms[f] > rmsMedian * 0.4) {
      for (let i = 0; i < 12; i++) aggChroma[i] += chroma[f * 12 + i];
    }
  }
  const key = detectKey(aggChroma);

  // chroma 帧归一化 → 变化量
  const chg = new Float32Array(nCFrames);
  for (let f = 1; f < nCFrames; f++) {
    let s0 = 0, s1 = 0;
    for (let i = 0; i < 12; i++) {
      s0 += chroma[(f - 1) * 12 + i];
      s1 += chroma[f * 12 + i];
    }
    if (s0 < 1e-9 || s1 < 1e-9) { chg[f] = 0; continue; }
    let d = 0;
    for (let i = 0; i < 12; i++) {
      d += Math.abs(chroma[f * 12 + i] / s1 - chroma[(f - 1) * 12 + i] / s0);
    }
    chg[f] = d * 0.5;
  }
  const tonalOnsets = detectOnsets(chg, { kStd: 1.1, kFloor: 0.012, dedupGapSec: 0.08, frameRate: CHROMA_FR });

  // 持续和声窗口（hold 候选）
  const chgSm = smoothArray(chg, Math.round(0.35 * CHROMA_FR));
  const rmsFloor = percentile(chromaRms, 20) * 0.6;
  const tonalSustains = [];
  {
    let start = -1;
    for (let f = 0; f <= nCFrames; f++) {
      const ok = f < nCFrames && 1 - Math.min(1, chgSm[f] * 2.4) >= 0.72 && chromaRms[f] > rmsFloor;
      if (ok && start < 0) start = f;
      else if (!ok && start >= 0) {
        const t0 = start / CHROMA_FR, t1 = f / CHROMA_FR;
        if (t1 - t0 >= 0.6) tonalSustains.push({ start: +t0.toFixed(3), end: +t1.toFixed(3) });
        start = -1;
      }
    }
  }

  // ---- tatum：合并打击乐分轨 + 组合事件求最小律动单元 ----
  // （tonal 事件是和声变化、长窗时间量化差，不参与节奏网格；组合全带 flux
  //   对弱高频事件不敏感，需并入分轨才能看到反拍/细分律动）
  const mergedEvents = [...onsets, ...drumKicks, ...drumSnares, ...drumHihats]
    .sort((a, b) => a.t - b.t);
  const mergedEv = [];
  for (const o of mergedEvents) {
    const last = mergedEv[mergedEv.length - 1];
    if (last && o.t - last.t < 0.03) {
      if (o.s > last.s) mergedEv[mergedEv.length - 1] = o;
    } else mergedEv.push(o);
  }
  const tatum = detectTatum(mergedEv, beats, beatSec);

  // ---- 重复段检测（副歌/主歌再现 → 谱面复现/镜像的依据） ----
  // 每小节特征：chroma 分布（旋律/和声）+ 鼓组计数 + RMS 能量；
  // 两小节相似 = chroma 余弦 0.5 + 鼓向量余弦 0.25 + 能量相似 0.25
  // （旋律、鼓型、编曲强度都相同才认定"同一段音乐"）
  post('repeats', 76);
  const repeats = detectRepeats(
    barGrid, durationSec,
    drumKicks, drumSnares, drumHihats,
    chroma, nCFrames, CHROMA_FR, rmsFrames
  );

  // ---- RMS 动态 + 段落能量 ----
  post('segments', 80);
  const rmsArr = Array.from(rmsFrames);
  const p5 = percentile(rmsArr, 5), p50 = percentile(rmsArr, 50), p95 = percentile(rmsArr, 95);
  const dynamicRangeDb = p5 > 1e-6 ? +(20 * Math.log10(p95 / p5)).toFixed(2) : 0;

  const beatRms = beats.map((t) => Math.max(0, envAt(rmsFrames, t * FRAME_RATE)));
  const smoothBeat = beatRms.map((_, i) => {
    let s = 0, c = 0;
    for (let j = i - 2; j <= i + 2; j++) {
      if (j >= 0 && j < beatRms.length) { s += beatRms[j]; c++; }
    }
    return s / Math.max(1, c);
  });
  const sMin = percentile(smoothBeat, 5), sMax = percentile(smoothBeat, 95);
  let centers = [sMin, (sMin + sMax) / 2, sMax];
  const layer = new Array(smoothBeat.length).fill(1);
  for (let iter = 0; iter < 12; iter++) {
    const sums = [0, 0, 0], cnts = [0, 0, 0];
    for (let i = 0; i < smoothBeat.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(smoothBeat[i] - centers[c]);
        if (d < bd) { bd = d; best = c; }
      }
      layer[i] = best;
      sums[best] += smoothBeat[i]; cnts[best]++;
    }
    for (let c = 0; c < 3; c++) if (cnts[c] > 0) centers[c] = sums[c] / cnts[c];
  }
  const rawSegs = [];
  {
    let cur = null;
    for (let i = 0; i < layer.length; i++) {
      const energy = layer[i] / 2;
      if (cur && cur.energy === energy) cur.endIdx = i;
      else { cur = { startIdx: i, endIdx: i, energy }; rawSegs.push(cur); }
    }
  }
  const merged = [];
  for (const s of rawSegs) {
    const beatsLen = s.endIdx - s.startIdx + 1;
    const last = merged[merged.length - 1];
    if (last && beatsLen < 4) last.endIdx = s.endIdx;
    else merged.push(s);
  }
  const segments = merged.map((s) => ({
    start: +beats[s.startIdx].toFixed(3),
    end: +beats[Math.min(s.endIdx + 1, beats.length - 1)].toFixed(3),
    energy: s.energy,
  }));

  // ---- 结构分段（v4）：小节对齐变化点检测 + 段落标签 ----
// 特征向量（每小节）：[能量, 人声活跃, onset 密度]（归一化）；边界 = 相邻小节
// 特征距离 > mean+1σ（自适应）；<2 小节的短段并入邻段。
// 标签：intro（曲首低能低声）/ verse（人声主导中低能）/ chorus（高能高声）/
//       inst（高能无人声，drop/solo）/ break（中段低能）/ outro（曲尾低能）。
  post('structure', 88);
  let segments2 = [];
  if (Array.isArray(barGrid) && barGrid.length >= 3) {
    const bars = barGrid.filter((bt) => bt <= durationSec - 0.2);
    const feats = [];
    for (let bi = 0; bi < bars.length; bi++) {
      const bt = bars[bi];
      const bt1 = bi + 1 < bars.length ? bars[bi + 1] : durationSec;
      let eS = 0, vS = 0, eC = 0;
      const f0 = Math.floor(bt * FRAME_RATE), f1 = Math.min(rmsFrames.length, Math.ceil(bt1 * FRAME_RATE));
      for (let f = f0; f < f1; f++) { eS += rmsFrames[f]; vS += vocalFlux[f]; eC++; }
      let oC = 0;
      for (const o of mergedEv) { if (o.t >= bt && o.t < bt1) oC++; }
      feats.push({ t: bt, t1: bt1, e: eC ? eS / eC : 0, v: eC ? vS / eC : 0, o: oC });
    }
    const norm = (arr) => {
      let mn = Infinity, mx = -Infinity;
      for (const x of arr) { if (x < mn) mn = x; if (x > mx) mx = x; }
      return arr.map((x) => (mx - mn > 1e-12 ? (x - mn) / (mx - mn) : 0.5));
    };
    const eN = norm(feats.map((x) => x.e));
    const vN = norm(feats.map((x) => x.v));
    const oN = norm(feats.map((x) => x.o));
    const dists = [];
    for (let i = 1; i < feats.length; i++) {
      dists.push(Math.sqrt(
        (eN[i] - eN[i - 1]) ** 2 + (vN[i] - vN[i - 1]) ** 2 + (oN[i] - oN[i - 1]) ** 2
      ));
    }
    const dMean = dists.reduce((a, b) => a + b, 0) / Math.max(1, dists.length);
    const dVar = dists.reduce((a, b) => a + (b - dMean) ** 2, 0) / Math.max(1, dists.length);
    const dStd = Math.sqrt(dVar);
    const cuts = [0];
    for (let i = 0; i < dists.length; i++) {
      if (dists[i] > dMean + dStd) cuts.push(i + 1);
    }
    cuts.push(feats.length);
    // 段构造：<2 小节的段并入前段（首段并入后段）
    const raw = [];
    for (let ci = 0; ci + 1 < cuts.length; ci++) {
      const lo = cuts[ci], hi = cuts[ci + 1];
      if (hi - lo < 2) {
        if (raw.length) raw[raw.length - 1].hi = hi;
        else if (ci + 2 < cuts.length) { cuts[ci + 1] = lo; } // 首短段：并入下一段（重置其起点）
        continue;
      }
      raw.push({ lo, hi });
    }
    // 首短段并入后段后，可能出现首段起点已变——重新校一遍 raw（首段 lo 应为 0）
    if (raw.length && raw[0].lo !== 0) raw[0].lo = 0;
    // 标签
    segments2 = raw.map((seg, si) => {
      let eA = 0, vA = 0;
      for (let i = seg.lo; i < seg.hi; i++) { eA += eN[i]; vA += vN[i]; }
      eA /= (seg.hi - seg.lo); vA /= (seg.hi - seg.lo);
      let label;
      if (si === raw.length - 1 && eA < 0.4) label = 'outro';
      else if (eA < 0.35) label = vA >= 0.45 ? 'verse' : (si === 0 ? 'intro' : 'break');
      else label = vA >= 0.5 ? 'chorus' : 'inst';
      return {
        start: +feats[seg.lo].t.toFixed(3),
        end: +feats[seg.hi - 1].t1.toFixed(3),
        label, energy: +eA.toFixed(3), vocal: +vA.toFixed(3),
      };
    });
  }

  // ---- 头/尾静音检测（v1.7.1：落谱区间 = 实际有声区间） ----
  // 现象：歌已唱完（编码尾巴/fade-out 后的静音）谱还在落、前奏无声段也落谱。
  // 检测：短窗平滑 RMS 低于【p95 的 6% 与绝对底噪 5e-4 取大】且持续 ≥1.2s 判静音；
  // 边界回退半个窗防削掉起音/收音。全曲有声时回退 0 / durationSec（旧歌库自动兼容）。
  post('silence', 84);
  const rmsSm = smoothArray(rmsFrames, Math.round(0.25 * FRAME_RATE));
  const silenceThresh = Math.max(p95 * 0.06, 5e-4);
  const SIL_MIN_SEC = 1.2;
  const silWin = Math.round(SIL_MIN_SEC * FRAME_RATE);
  let audioStart = 0;
  let audioEnd = durationSec;
  {
    let f = 0;
    for (; f < nFrames; f++) if (rmsSm[f] > silenceThresh) break;
    if (f >= silWin) audioStart = Math.max(0, (f - silWin * 0.5) / FRAME_RATE);
  }
  {
    let f = nFrames - 1;
    for (; f >= 0; f--) if (rmsSm[f] > silenceThresh) break;
    if (nFrames - 1 - f >= silWin) audioEnd = Math.min(durationSec, (f + silWin * 0.5) / FRAME_RATE);
  }
  audioStart = +audioStart.toFixed(3);
  audioEnd = +audioEnd.toFixed(3);

  post('done', 100);
  return {
    version: 4,
    bpm: bestBpm,
    offset: +offset.toFixed(4),
    durationSec: +durationSec.toFixed(3),
    // v1.7.1：实际有声区间（头/尾静音裁剪后）；生成器落谱上限/hold 裁剪改用此值
    audioStart,
    audioEnd,
    onsetCount: onsets.length,
    onsets: onsets.map((o) => ({ t: +o.t.toFixed(4), s: o.s })),
    beats,
    segments,
    rms: {
      mean: +p50.toFixed(5),
      low: +p5.toFixed(5),
      high: +p95.toFixed(5),
      dynamicRangeDb,
    },
    // 节拍层级
    meter,
    downbeatPhase,
    downbeatConfidence,
    barGrid,
    tatum,
    // 重复段（副歌/主歌再现）
    repeats,
    // 乐器分轨
    drumKicks: drumKicks.map((o) => ({ t: +o.t.toFixed(4), s: o.s })),
    drumSnares: drumSnares.map((o) => ({ t: +o.t.toFixed(4), s: o.s })),
    drumHihats: drumHihats.map((o) => ({ t: +o.t.toFixed(4), s: o.s })),
    // 人声层（v4）：进唱/换句事件（人声带瞬态 + 谐波验证 + 鼓点排除）
    vocalOnsets,
    // 结构层（v4）：小节对齐变化点分段 + 段落标签（intro/verse/chorus/inst/break/outro）
    segments2,
    // 音高层
    key,
    tonalOnsets: tonalOnsets.map((o) => ({ t: +o.t.toFixed(4), s: o.s })),
    tonalSustains,
    analysisMeta: {
      targetSr: TARGET_SR,
      fftSize: FFT_SIZE,
      hop: HOP,
      frameRate: +FRAME_RATE.toFixed(3),
      bands: { kick: BAND_KICK, snare: BAND_SNARE, hihat: BAND_HIHAT, chroma: BAND_CHROMA },
    },
  };
}

function bestPhase(env, period, nFrames) {
  let bestPh = 0, bestV = -Infinity;
  const steps = Math.max(8, Math.round(period * 4));
  for (let i = 0; i < steps; i++) {
    const ph = (i / steps) * period;
    let s = 0, c = 0;
    for (let t = ph; t < nFrames; t += period) { s += envAt(env, t); c++; }
    const v = c ? s / c : 0;
    if (v > bestV) { bestV = v; bestPh = ph; }
  }
  return bestPh;
}

// ---------- 消息入口 ----------
self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type !== 'analyze') return;
  try {
    const analysis = analyze(msg.channels, msg.sampleRate, msg.durationSec);
    self.postMessage({ type: 'result', analysis });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
};
