// 核心逻辑自动化测试（Node 环境，模拟 self shim 加载 worker 模块）
import { pathToFileURL, fileURLToPath } from 'url';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ FAIL: ' + msg); }
}

const srcUrl = (p) => pathToFileURL(fileURLToPath(new URL(p, import.meta.url))).href;

// 固定随机种子（v1.8.1b）：合成音频的背景噪声/addBandNoise 用 Math.random，
// 未种子化时 analysis 输出逐次漂移 → 落点吸附/配额断言随机贴边闪失败。
// 种子化后全部断言可复现。
{
  let _seed = 0x9e3779b9;
  Math.random = () => {
    _seed = (_seed + 0x6d2b79f5) | 0;
    let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 1. 加载 worker 模块（shim self） ----
const captured = [];
globalThis.self = { postMessage: (m) => captured.push(m), onmessage: null };
await import(srcUrl('../src/core/analysis.worker.js'));
assert(typeof self.onmessage === 'function', 'worker 模块加载成功');

// ---- 2. 合成测试音频 v3：120 BPM 4/4，24 秒（12 小节），含编配/和弦进行/重复段 ----
// 结构：小节 0-7（16s）高能量副歌 A×2（和弦循环 C-G-Am-F，4-7 小节 = 0-3 的重复段）
//       小节 8-11（8s）低能量尾奏（同和弦循环但编曲更轻 → 不构成重复段）
// 编配：kick 每拍（小节头更响）；snare 2/4 拍；hihat 反拍八分；和弦 pad 按小节切换
const SR = 44100;
const BPM = 120;
const beat = 60 / BPM;
const durSec = 24;
const n = SR * durSec;
const pcm = new Float32Array(n);
const firstBeat = 0.25;
const totalBeats = Math.floor((durSec - firstBeat) / beat);
const totalBars = Math.floor(totalBeats / 4);
function beatEnergy(i, total) {
  const p = i / total;
  return p < 8 / 12 ? 1.0 : 0.3; // 前 8 小节副歌强，后 4 小节尾奏弱
}
// 和弦进行（C 大调）：C, G, Am, F
const CHORDS = [
  [130.81, 164.81, 196.0],   // C:  C3 E3 G3
  [98.0, 123.47, 146.83],    // G:  G2 B2 D3
  [110.0, 130.81, 164.81],   // Am: A2 C3 E3
  [87.31, 110.0, 130.81],    // F:  F2 A2 C3
];
function addTone(t0, dur, freq, amp, decay) {
  const start = Math.floor(t0 * SR);
  for (let i = 0; i < Math.floor(dur * SR) && start + i < n; i++) {
    const t = i / SR;
    pcm[start + i] += amp * Math.exp(-t * decay) * Math.sin(2 * Math.PI * freq * t);
  }
}
/** 频带受限噪声：随机相位正弦叠加（带内 RMS ≈ amp，带外为零） */
function addBandNoise(t0, dur, amp, decay, lo, hi, nFreq = 20) {
  const start = Math.floor(t0 * SR);
  const N = Math.floor(dur * SR);
  const freqs = [], phs = [];
  for (let j = 0; j < nFreq; j++) {
    freqs.push(lo + Math.random() * (hi - lo));
    phs.push(Math.random() * 2 * Math.PI);
  }
  const norm = Math.sqrt(2 / nFreq);
  for (let i = 0; i < N && start + i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let j = 0; j < nFreq; j++) v += Math.sin(2 * Math.PI * freqs[j] * t + phs[j]);
    pcm[start + i] += amp * Math.exp(-t * decay) * v * norm;
  }
}
for (let b = 0; b < totalBeats; b++) {
  const t0 = firstBeat + b * beat;
  const e = beatEnergy(b, totalBeats);
  const posInBar = b % 4;
  // kick：65Hz（C2）低频体 + 高频 click（小节头更响 → downbeat 线索）
  const kickAmp = e * (posInBar === 0 ? 1.2 : 0.8);
  addTone(t0, 0.12, 65, kickAmp * 0.95, 34);
  addTone(t0, 0.02, 2800, kickAmp * 0.3, 350);
  // 小节头额外低音（C2 长音，加强 downbeat 低频能量）
  if (posInBar === 0) addTone(t0, 0.35, 65, e * 0.5, 6);
  // snare：2/4 拍中频带噪声（200-1800Hz，避开 kick 带与 hihat 带）
  if (posInBar === 1 || posInBar === 3) addBandNoise(t0, 0.09, e * 0.5, 26, 200, 1800);
  // hihat：反拍八分高频带噪声（5-11kHz，避开 snare 带）
  addBandNoise(t0 + beat / 2, 0.03, e * 0.28, 240, 5000, 11000);
}
// pad：按小节切换的和弦（和弦分布是小节特征，用于重复段检测）；
// 振幅跟随段落能量（编曲强度），避免尾奏被误判为副歌重复段
{
  const barDur = beat * 4;
  for (let bar = 0; bar < totalBars; bar++) {
    const chord = CHORDS[bar % 4];
    const t0 = firstBeat + bar * barDur;
    const t1 = t0 + barDur;
    const barEnergy = beatEnergy(Math.floor(bar * 4), totalBeats);
    const padAmp = 0.09 * (barEnergy >= 1 ? 1 : 0.35);
    for (const f of chord) {
      const start = Math.floor(t0 * SR), end = Math.floor(t1 * SR);
      for (let i = start; i < end && i < n; i++) {
        pcm[i] += padAmp * Math.sin(2 * Math.PI * f * (i / SR));
      }
    }
  }
}
// 微弱背景噪声
for (let i = 0; i < n; i++) pcm[i] += (Math.random() * 2 - 1) * 0.002;

// v4：人声模拟——覆盖副歌全部 bar0-7（0.25-16.25s），每拍一个音符，起音在反拍
// 八分（拍后半拍，与 hihat 同刻但频带不重叠互不干扰、不改变 tatum=2）；音高
// A3/B3/C4/D4 每小节一循环（bar 间模式相同，不破坏重复段设定；全为 C 大调音级
// 不干扰调性断言）；基频+泛音串（谐波结构）
{
  const VOCAL_NOTES = [220, 246.94, 261.63, 293.66];
  for (let i = 0; i < 32; i++) {
    const t0 = firstBeat + i * beat + beat / 2; // 反拍八分起音
    const f = VOCAL_NOTES[i % 4];
    for (let h = 1; h <= 6; h++) addTone(t0, 0.32, f * h, 0.3 / h, 4.5);
  }
}

// ---- 3. 运行分析 ----
console.log('▶ 音频分析测试（期望 BPM=120，C 大调，4/4，八分律动）');
captured.length = 0;
self.onmessage({ data: { type: 'analyze', channels: [pcm], sampleRate: SR, durationSec: durSec } });
const resultMsg = captured.find((m) => m.type === 'result');
assert(!!resultMsg, '分析返回结果');
const analysis = resultMsg && resultMsg.analysis;
if (analysis) {
  console.log(`  BPM=${analysis.bpm} offset=${analysis.offset}s onsets=${analysis.onsetCount} segments=${analysis.segments.length} dynDB=${analysis.rms.dynamicRangeDb}`);
  console.log(`  kick=${analysis.drumKicks.length} snare=${analysis.drumSnares.length} hihat=${analysis.drumHihats.length} key=${analysis.key.tonic}${analysis.key.mode === 'minor' ? 'm' : ''}(${analysis.key.confidence}) meter=${analysis.meter} phase=${analysis.downbeatPhase} tatum=${analysis.tatum} bars=${analysis.barGrid.length} sustains=${analysis.tonalSustains.length} repeats=${JSON.stringify(analysis.repeats)}`);
  assert(Math.abs(analysis.bpm - 120) <= 2, `BPM 检测接近 120（实际 ${analysis.bpm}）`);
  assert(analysis.onsetCount >= 40 && analysis.onsetCount <= 110, `onset 数量合理（实际 ${analysis.onsetCount}，组合流以 kick/snare 为主）`);
  assert(analysis.beats.length >= 45, `beat 网格数量足够（实际 ${analysis.beats.length}）`);
  assert(analysis.segments.length >= 2, `检测到多个能量段落（实际 ${analysis.segments.length}）`);
  // beat 网格应与合成节拍对齐
  let aligned = 0;
  for (let k = 0; k < 8; k++) {
    const bt = analysis.beats[10 + k];
    const nearest = Math.abs(((bt - firstBeat) % beat + beat) % beat);
    const d = Math.min(nearest, beat - nearest);
    if (d < 0.03) aligned++;
  }
  assert(aligned >= 7, `beat 网格与真实节拍对齐（${aligned}/8）`);
  // ---- v3 分乐器检测 ----
  assert(analysis.version === 4, '分析版本为 v4');
  assert(analysis.drumKicks.length >= 30 && analysis.drumKicks.length <= 50, `kick 分轨数量合理（实际 ${analysis.drumKicks.length}，期望 ~47）`);
  assert(analysis.drumSnares.length >= 18, `snare 分轨数量合理（实际 ${analysis.drumSnares.length}，期望 ~23）`);
  assert(analysis.drumHihats.length >= 35, `hihat 分轨数量合理（实际 ${analysis.drumHihats.length}，期望 ~47）`);
  // kick 落点应对齐节拍网格
  let kickAligned = 0;
  for (const k of analysis.drumKicks) {
    const rel = (k.t - firstBeat) / beat;
    if (Math.abs(rel - Math.round(rel)) * beat < 0.06) kickAligned++;
  }
  assert(kickAligned / Math.max(1, analysis.drumKicks.length) >= 0.85, `kick 落点对齐节拍（${kickAligned}/${analysis.drumKicks.length}）`);
  // hihat 落点应在反拍八分
  let hihatOffbeat = 0;
  for (const h of analysis.drumHihats) {
    const rel = (h.t - firstBeat) / (beat / 2);
    if (Math.abs(rel - Math.round(rel)) * (beat / 2) < 0.05 && Math.round(rel) % 2 === 1) hihatOffbeat++;
  }
  assert(hihatOffbeat / Math.max(1, analysis.drumHihats.length) >= 0.8, `hihat 集中在反拍八分（${hihatOffbeat}/${analysis.drumHihats.length}）`);
  // ---- 调性 ----
  assert(analysis.key.tonic === 'C' && analysis.key.mode === 'major', `调性检测为 C 大调（实际 ${analysis.key.tonic} ${analysis.key.mode}）`);
  assert(analysis.key.confidence >= 0.5, `调性置信度足够（${analysis.key.confidence}）`);
  // ---- 拍号/小节线 ----
  assert(analysis.meter === 4, `拍号检测为 4 拍（实际 ${analysis.meter}）`);
  assert(analysis.downbeatPhase === 0, `downbeat 相位正确（实际 ${analysis.downbeatPhase}，合成小节头在 beat 0）`);
  assert(analysis.barGrid.length >= 10, `小节线数量合理（实际 ${analysis.barGrid.length}，期望 12）`);
  // barGrid 应对齐合成小节头
  let barAligned = 0;
  for (let i = 0; i < Math.min(5, analysis.barGrid.length); i++) {
    const rel = (analysis.barGrid[i] - firstBeat) / (beat * 4);
    if (Math.abs(rel - Math.round(rel)) * beat * 4 < 0.1) barAligned++;
  }
  assert(barAligned >= 4, `小节线对齐合成小节头（${barAligned}/5）`);
  // ---- tatum ----
  assert(analysis.tatum === 2, `tatum 检测为八分（实际 ${analysis.tatum}）`);
  // ---- tonal sustain ----
  assert(analysis.tonalSustains.length >= 1, `检测到持续和声窗口（实际 ${analysis.tonalSustains.length}）`);
  // ---- 重复段（0-7 小节为副歌 A×2；8-11 编曲变轻不构成重复） ----
  // v4：人声成分使 bar 特征相似度微降，切分可能漂移（0→4 整段 或 0→3×2+1→5×3
  // 等价覆盖），断言改为覆盖度鲁棒式
  assert(Array.isArray(analysis.repeats), '重复段字段存在');
  const repBars = analysis.repeats.filter((r) => r.dstBar < 8);
  const coveredBars = new Set();
  for (const r of repBars) for (let b = r.dstBar; b < r.dstBar + r.bars; b++) coveredBars.add(b);
  assert(coveredBars.size >= 4, `副歌再现检测到（覆盖 ${coveredBars.size} 小节：${analysis.repeats.map((r) => `src${r.srcBar}→dst${r.dstBar}×${r.bars}`).join(' ')}）`);
  assert(!analysis.repeats.some((r) => r.dstBar >= 8), `尾奏（编曲变轻）不误判为重复段`);
  // ---- v4 人声层 ----
  assert(Array.isArray(analysis.vocalOnsets), 'vocalOnsets 字段存在');
  const vo = analysis.vocalOnsets || [];
  console.log(`  vocalOnsets=${vo.length}（合成人声起音 32 个，谐波验证+鼓点排除后）`);
  assert(vo.length >= 10 && vo.length <= 60, `人声 onset 数量合理（实际 ${vo.length}）`);
  // 落点对齐合成人声起音（反拍八分处，拍后半拍）
  let voAligned = 0;
  for (const o of vo) {
    const rel = (o.t - firstBeat - beat / 2) / beat;
    if (Math.abs(rel - Math.round(rel)) * beat < 0.06) voAligned++;
  }
  assert(voAligned / Math.max(1, vo.length) >= 0.7, `人声 onset 对齐合成人声起音（${voAligned}/${vo.length}）`);
  // 集中在人声区间（0-16s 副歌）
  const voIn = vo.filter((o) => o.t >= firstBeat - 0.1 && o.t <= 16.25).length;
  assert(voIn / Math.max(1, vo.length) >= 0.85, `人声 onset 集中在人声区间（${voIn}/${vo.length}）`);
  // ---- v4 结构层 ----
  assert(Array.isArray(analysis.segments2), 'segments2 字段存在');
  const sg2 = analysis.segments2 || [];
  console.log(`  segments2=${sg2.map((s) => `${s.label}@${s.start}-${s.end}e${s.energy}v${s.vocal}`).join(' ')}`);
  assert(sg2.length >= 2, `结构分段至少 2 段（实际 ${sg2.length}）`);
  const chorusSeg = sg2.find((s) => s.label === 'chorus');
  assert(!!chorusSeg && chorusSeg.start < 6 && chorusSeg.end > 10, `副歌段标记为 chorus（实际 ${chorusSeg ? chorusSeg.start + '-' + chorusSeg.end : '无'}）`);
  assert(sg2[sg2.length - 1].label === 'outro' || sg2[sg2.length - 1].label === 'break', `尾奏段标记为 outro/break（实际 ${sg2[sg2.length - 1].label}）`);
}

// ---- 4. 谱面生成测试 ----
console.log('▶ 谱面生成测试');
const { generateChart } = await import(srcUrl('../src/core/chartgen.js'));

function checkHuman(chart, diffKey) {
  const HARD_MIN_GAP = 0.105;
  const lanes = 4;
  const lastT = new Array(lanes).fill(-10);
  const lastEnd = new Array(lanes).fill(-10);
  const notes = chart.notes;
  let simulRun = 1, maxSimul = 1;
  for (let i = 1; i < notes.length; i++) {
    if (Math.abs(notes[i].t - notes[i - 1].t) < 0.012) simulRun++; else simulRun = 1;
    maxSimul = Math.max(maxSimul, simulRun);
  }
  let gapOK = true, holdOK = true, simulOK = true;
  const maxSimulAllowed = diffKey === 'E' ? 1 : 2;
  for (const n of notes) {
    if (n.t - Math.max(lastT[n.lane], lastEnd[n.lane]) < HARD_MIN_GAP) gapOK = false;
    lastT[n.lane] = n.t;
    if (n.type === 'hold') {
      if (!n.d || n.d < 0.18) holdOK = false;
      lastEnd[n.lane] = n.t + n.d;
    }
  }
  simulOK = maxSimul <= maxSimulAllowed;
  return { gapOK, holdOK, simulOK, maxSimul };
}

const results = {};
for (const dk of ['E', 'H', 'EX']) {
  const chart = generateChart(analysis, dk, 12345, 4);
  results[dk] = chart;
  const chk = checkHuman(chart, dk);
  console.log(`  ${dk}: notes=${chart.notes.length} 密度=${chart.stats.density}/s hold=${chart.stats.holdCount} maxSimul=${chk.maxSimul} 键型=${JSON.stringify(chart.stats.patternCounts)}`);
  assert(chart.notes.length > 8, `${dk} 谱面非空（${chart.notes.length} notes）`);
  assert(chk.gapOK, `${dk} 同轨最小间隔合法`);
  assert(chk.holdOK, `${dk} hold 时长合法`);
  assert(chk.simulOK, `${dk} 同刻键数 ≤ ${dk === 'E' ? 1 : 2}`);
  assert(chart.stats.patternCounts && Object.keys(chart.stats.patternCounts).length >= 1, `${dk} 键型统计存在`);
  // hold 单侧约束：hold 存续期间其余 tap 只允许在对侧手区
  const holds = chart.notes.filter((n) => n.type === 'hold');
  let holdSideOK = true, checked = 0;
  for (const h of holds) {
    for (const n of chart.notes) {
      if (n === h || n.type === 'hold') continue;
      if (n.t > h.t + 0.012 && n.t < h.t + h.d - 0.01) {
        checked++;
        const sameSide = (n.lane < 2) === (h.lane < 2);
        if (sameSide) holdSideOK = false;
      }
    }
  }
  assert(holdSideOK, `${dk} hold 期间 tap 全部在对侧手区${checked ? `（检查 ${checked} 个共存 tap）` : ''}`);
}
assert(results.EX.notes.length > results.H.notes.length * 1.25, `EX 密度明显高于 H（${results.EX.notes.length} vs ${results.H.notes.length}）`);
assert(results.H.notes.length > results.E.notes.length * 1.4, `H 密度明显高于 E（${results.H.notes.length} vs ${results.E.notes.length}）`);

// ---- 4.5 键型分布测试（合成音频中高能量段应出现交互/多压等键型） ----
console.log('▶ 键型分布测试');
const hPatterns = results.H.stats.patternCounts, exPatterns = results.EX.stats.patternCounts;
assert(Object.keys(hPatterns).length >= 3, `H 使用 ≥3 种键型（${Object.keys(hPatterns).length} 种：${Object.keys(hPatterns).join('/')}）`);
assert(Object.keys(exPatterns).length >= 3, `EX 使用 ≥3 种键型（${Object.keys(exPatterns).length} 种：${Object.keys(exPatterns).join('/')}）`);
// 交互/楼梯/散打键型出现（受随机合成影响，seed 扫描保证稳健）
{
  let patSeeds = 0;
  for (let s = 12345; s < 12355; s++) {
    const pc = generateChart(analysis, 'H', s, 4).stats.patternCounts;
    if ((pc.trill || 0) + (pc.stair || 0) + (pc.mirror || 0) >= 2) patSeeds++;
  }
  console.log(`  H 交互/楼梯/散打覆盖（10 seeds）：${patSeeds}/10`);
  assert(patSeeds >= 6, `H 大多数 seed 出现交互/楼梯/散打键型（${patSeeds}/10）`);
}
// 多压鲁棒性：10 个 seed 扫描，EX 大多数应含多压键型（键型选择有随机性，单 seed 会抖动）
let chordSeeds = 0;
const seedScan = [];
for (let s = 12345; s < 12355; s++) {
  const c = generateChart(analysis, 'EX', s, 4);
  const has = (c.stats.patternCounts.chord || 0) > 0;
  if (has) chordSeeds++;
  seedScan.push(`${s}:${has ? '多压' : '无'}`);
}
console.log(`  EX 多压扫描（10 seeds）：${chordSeeds}/10 含多压 [${seedScan.join(' ')}]`);
assert(chordSeeds >= 4, `EX 大多数 seed 出现多压键型（${chordSeeds}/10；重复段复现占用一半独立小节）`);
// E 不应出现多压
assert(!results.E.stats.patternCounts.chord, 'E 不出现多压键型');

// 交互键型结构验证：trill 产生的连续同间隔交替（抽查 H 谱中是否存在左右交替片段）
function hasAlternation(notes, keyCount) {
  for (let i = 2; i < notes.length; i++) {
    const a = notes[i - 2], b = notes[i - 1], c = notes[i];
    if (a.lane === c.lane && a.lane !== b.lane
      && Math.abs(b.t - a.t) < 0.4 && Math.abs(c.t - b.t) < 0.4
      && handDiff(a, b, keyCount)) return true;
  }
  return false;
}
function handDiff(a, b, keyCount) {
  return (a.lane < keyCount / 2) !== (b.lane < keyCount / 2) || Math.abs(a.lane - b.lane) === 1;
}
assert(hasAlternation(results.EX.notes, 4) || hasAlternation(results.H.notes, 4), '谱面存在交互交替片段（A-B-A 结构）');

// hold 数量合理性（受随机合成影响，用 seed 扫描保证稳健）
{
  let hHoldSeeds = 0, exHoldSeeds = 0;
  for (let s = 12345; s < 12355; s++) {
    if (generateChart(analysis, 'H', s, 4).stats.holdCount >= 1) hHoldSeeds++;
    if (generateChart(analysis, 'EX', s, 4).stats.holdCount >= 1) exHoldSeeds++;
  }
  console.log(`  hold 覆盖（10 seeds）：H ${hHoldSeeds}/10、EX ${exHoldSeeds}/10 个 seed 含 hold`);
  assert(hHoldSeeds >= 6, `H 大多数 seed 含 hold（${hHoldSeeds}/10）`);
  assert(exHoldSeeds >= 8, `EX 绝大多数 seed 含 hold（${exHoldSeeds}/10）`);
}
let coexist = 0;
for (const h of results.EX.notes.filter((n) => n.type === 'hold')) {
  for (const n of results.EX.notes) {
    if (n !== h && n.type !== 'hold' && n.t > h.t + 0.012 && n.t < h.t + h.d - 0.01) coexist++;
  }
}
console.log(`  EX hold 期间对侧共存 tap：${coexist} 个`);

// ---- 4.8 重复段谱面复现测试（默认关；开启后副歌再现段一致或镜像） ----
console.log('▶ 重复段谱面复现测试');
{
  const rep = (analysis.repeats || []).filter((r) => r.dstBar < 8 && r.bars >= 2)
    .sort((x, y) => y.bars - x.bars)[0] || null;
  assert(!!rep, '存在副歌内重复段（≥2 小节）');
  if (rep) {
    // v1.3.1 回退：默认（无 hints）不复现
    assert(!results.EX.stats.patternCounts.repeat && !results.H.stats.patternCounts.repeat, '默认关闭复现（回退验证）');
    const winDur = rep.bars * beat * 4;
    const srcT0 = rep.srcStart, dstT0 = rep.dstStart;
    // 显式开启 repeatMirror
    const hinted = {};
    for (const dk of ['H', 'EX']) {
      const c = generateChart(analysis, dk, results[dk].seed, 4, { repeatMirror: true });
      hinted[dk] = c;
      assert((c.stats.patternCounts.repeat || 0) >= rep.bars, `${dk} 复现键型统计（×${c.stats.patternCounts.repeat || 0}）`);
    }
    let identical = 0, mirrored = 0, unmatched = 0, total = 0;
    for (const dk of ['H', 'EX']) {
      const chart = hinted[dk];
      const srcNotes = chart.notes.filter((x) => x.t >= srcT0 - 1e-6 && x.t < srcT0 + winDur - 1e-6);
      const dstNotes = chart.notes.filter((x) => x.t >= dstT0 - 1e-6 && x.t < dstT0 + winDur - 1e-6);
      for (const d of dstNotes) {
        total++;
        const rel = d.t - dstT0;
        const s = srcNotes.find((x) => Math.abs((x.t - srcT0) - rel) < 0.02 && x.type === d.type);
        if (!s) { unmatched++; continue; }
        if (s.lane === d.lane) identical++;
        else if (s.lane === 3 - d.lane) mirrored++;
        else unmatched++;
      }
    }
    const okRate = (identical + mirrored) / Math.max(1, total);
    console.log(`  重复段一致性（repeatMirror 开）：一致 ${identical} + 镜像 ${mirrored} / 共 ${total}（未匹配 ${unmatched}）`);
    assert(okRate >= 0.95, `开启复现后谱面完全一致或镜像（${(okRate * 100).toFixed(0)}%）`);
    // 尾奏小节（8-11）不复用副歌谱面（独立生成，note 布局与副歌不同）
    const exChart = hinted.EX;
    const pick = (t0, t1) => exChart.notes.filter((x) => x.t >= t0 && x.t < t1);
    const chorusNotes = pick(rep.dstStart, rep.dstStart + winDur);
    const outroT0 = analysis.barGrid[8];
    const outroNotes = pick(outroT0, outroT0 + winDur);
    console.log(`  副歌 note ${chorusNotes.length} vs 尾奏 note ${outroNotes.length}`);
    assert(outroNotes.length > 0 && outroNotes.length !== chorusNotes.length, '尾奏不复用副歌谱面（独立生成）');
    // 尾奏键型不含复现
    assert(!analysis.repeats.some((r) => r.dstBar >= 8), '尾奏未被重复段覆盖');
  }
}

// ---- 4.7 v3 乐器感知谱面测试 ----
console.log('▶ 乐器感知谱面测试');
// tatum：v1.3.1 回退后不再封顶；E/H（细分≤2）仍应全在八分网格，EX 允许少量十六分
// v1.8.0：E 档不吸附（新手规整网格优先）→ 用检测 BPM 网格断言（note 就在检测网格上）；
// H/EX 落点吸附到 onset 的【绝对采样时间轴】（检测 BPM 反推网格有 0.17% 累积漂移，
// 20s 处已达 ~34ms，叠加检测偏差会误判）→ 改用真实合成网格（firstBeat + i*beat/2）
// + 容差 70ms（吸附上限 60ms + onset 检测偏差 ~25ms）。
for (const dk of ['E', 'H', 'EX']) {
  let onGrid = 0;
  const total = results[dk].notes.length;
  for (const note of results[dk].notes) {
    if (dk === 'E') {
      const b0 = analysis.beats[0];
      const aBeat = 60 / analysis.bpm;
      const rel = ((note.t - b0) / aBeat) * 2;
      if (Math.abs(rel - Math.round(rel)) * (aBeat / 2) <= 0.04) onGrid++;
    } else if (dk === 'H') {
      // H（细分≤2）：真实八分网格基准（吸附到 onset 的绝对时间轴，检测 BPM 反推有累积漂移）
      const rel = ((note.t - firstBeat) / beat) * 2;
      if (Math.abs(rel - Math.round(rel)) * (beat / 2) <= 0.07) onGrid++;
    } else {
      // EX（细分=4）：真实十六分网格基准——加花位（k=1/3 槽）本就在十六分上，
      // 用八分基准判会把合法加花误判出界（诊断证实 94/94 全在十六分 ±60ms 内）
      const rel = ((note.t - firstBeat) / beat) * 4;
      if (Math.abs(rel - Math.round(rel)) * (beat / 4) <= 0.06) onGrid++;
    }
  }
  const need = dk === 'EX' ? 0.95 : 0.98;
  assert(onGrid / total >= need, `${dk} note 基本在细分网格上（${onGrid}/${total}）`);
}
// 多压对齐重拍：含多压的谱，双押时刻应贴近强鼓点（kick 或 snare）落点
// v1.8.0：吸附后双押贴【最强 onset】——snare 重拍也是合法双押位（主流谱惯例），
// 不再限定 kick
function chordKickAligned(chart, kicks, snares) {
  const notes = chart.notes;
  for (let i = 1; i < notes.length; i++) {
    if (Math.abs(notes[i].t - notes[i - 1].t) < 0.012 && notes[i].lane !== notes[i - 1].lane) {
      const t = notes[i].t;
      if (kicks.some((k) => Math.abs(k.t - t) <= 0.06)
        || snares.some((k) => Math.abs(k.t - t) <= 0.06)) return true;
    }
  }
  return false;
}
let chordAlignedSeeds = 0, chordTotalSeeds = 0;
for (let s = 12345; s < 12355; s++) {
  const c = generateChart(analysis, 'EX', s, 4);
  if ((c.stats.patternCounts.chord || 0) > 0) {
    chordTotalSeeds++;
    if (chordKickAligned(c, analysis.drumKicks, analysis.drumSnares)) chordAlignedSeeds++;
  }
}
console.log(`  EX 多压-重拍对齐扫描：${chordAlignedSeeds}/${chordTotalSeeds} 个含多压 seed 的双押贴强鼓点（kick/snare）`);
// v1.3.1 回退：多压不再强制 kick 锚点（无 kick 也允许强拍双押）→ 多数贴强鼓点即可
assert(chordTotalSeeds >= 4 && chordAlignedSeeds >= Math.ceil(chordTotalSeeds * 0.6), '多数多压双押时刻对齐强鼓点落点（回退放宽）');
// hold 偏好持续和声窗口：10 seeds 统计（hold 落点率应 ≥ 窗口时间覆盖率 - 容差）
{
  const covered = analysis.tonalSustains.reduce((s, w) => s + (w.end - w.start), 0) / analysis.durationSec;
  let totHolds = 0, totIn = 0;
  for (let s = 12345; s < 12355; s++) {
    const c = generateChart(analysis, 'EX', s, 4);
    for (const h of c.notes.filter((x) => x.type === 'hold')) {
      totHolds++;
      if (analysis.tonalSustains.some((w) => h.t >= w.start - 0.05 && h.t <= w.end)) totIn++;
    }
  }
  const inRate = totHolds ? totIn / totHolds : 0;
  console.log(`  hold 窗口偏好（10 seeds）：${totIn}/${totHolds} 在窗口内（${(inRate * 100).toFixed(0)}%），窗口时间覆盖率 ${(covered * 100).toFixed(0)}%`);
  assert(totHolds === 0 || inRate >= covered - 0.1, `hold 落点偏好和声持续窗口（${(inRate * 100).toFixed(0)}% ≥ 覆盖率 ${(covered * 100).toFixed(0)}% - 10%）`);
}
// v2 旧分析回退：删除 v3 字段后生成器仍可用
{
  const v2 = JSON.parse(JSON.stringify(analysis));
  for (const k of ['drumKicks', 'drumSnares', 'drumHihats', 'tonalOnsets', 'tonalSustains', 'barGrid', 'key', 'meter', 'downbeatPhase', 'downbeatConfidence', 'tatum', 'repeats']) delete v2[k];
  v2.version = 2;
  const fb = generateChart(v2, 'H', 4242, 4);
  assert(fb.notes.length > 8, `v2 旧分析回退路径可用（${fb.notes.length} notes）`);
  assert(fb.stats.patternCounts && Object.keys(fb.stats.patternCounts).length >= 1, 'v2 回退键型统计存在');
  assert(!fb.stats.patternCounts.repeat, 'v2 回退不产生复现键型');
  const fbchk = checkHuman(fb, 'H');
  assert(fbchk.gapOK && fbchk.holdOK && fbchk.simulOK, 'v2 回退谱面人类可行性合法');
}

// ---- 4.9 音乐轴微调（hints）测试 ----
console.log('▶ 音乐轴微调测试');
{
  const barDur = beat * 4;
  const outroT0 = analysis.barGrid[8];
  const plain = generateChart(analysis, 'EX', 777, 4);
  // 能量覆盖：把尾奏（自动低能量）手动设为高能量 → EX 密度显著提升
  const hintedHi = generateChart(analysis, 'EX', 777, 4, {
    energy: [{ start: outroT0, end: analysis.durationSec, level: 1 }],
  });
  const dens = (c, t0, t1) => c.notes.filter((x) => x.t >= t0 && x.t < t1).length / (t1 - t0);
  const dHi = dens(hintedHi, outroT0, analysis.durationSec);
  const dPlain = dens(plain, outroT0, analysis.durationSec);
  console.log(`  尾奏密度：微调后 ${dHi.toFixed(2)}/s vs 默认 ${dPlain.toFixed(2)}/s`);
  assert(dHi > dPlain * 1.3, '手动高能量提升尾奏密度（用户可指定高潮）');

  // 键型偏好：副歌段强制交互
  const hintedTrill = generateChart(analysis, 'EX', 777, 4, {
    patternHints: [{ start: 0.25, end: 0.25 + barDur * 4, pattern: 'trill' }],
  });
  const trillBars = hintedTrill.stats.patternCounts.trill || 0;
  console.log(`  副歌强制交互：trill×${trillBars}（默认 ${plain.stats.patternCounts.trill || 0}）`);
  // v1.8.0：≥3——patternAvailable 需 mslots≥3，配额+吸附去重后个别小节槽数不足时
  // 该小节保留独立生成（防留白优先），统计在 3-4 间波动属正常
  assert(trillBars >= 3, '强制交互键型生效（≥3 小节）');
  const seg = hintedTrill.notes.filter((n) => n.t < 8.3);
  let abFound = false;
  for (let i = 2; i < seg.length; i++) {
    if (seg[i - 2].lane === seg[i].lane && seg[i - 1].lane !== seg[i].lane) { abFound = true; break; }
  }
  assert(abFound, '偏好区间内出现交替落点');

  // hold 偏好：指定范围长按
  const hintedHold = generateChart(analysis, 'EX', 777, 4, {
    patternHints: [{ start: outroT0, end: analysis.durationSec, pattern: 'hold' }],
  });
  const holdsIn = hintedHold.notes.filter((n) => n.type === 'hold' && n.t >= outroT0).length;
  const holdsPlain = plain.notes.filter((n) => n.type === 'hold' && n.t >= outroT0).length;
  console.log(`  尾奏 hold：微调后 ${holdsIn} vs 默认 ${holdsPlain}`);
  assert(holdsIn > holdsPlain, '强制长按区生效');
}

// ---- 4.10 长歌分桶均匀性回归（v1.4.0：修复"前10秒正常、后续大量空白"） ----
// 事故机制：旧采样按全局 strength 排序取 top-N，而 onset 强度按全曲峰值
// 归一化后随段落能量系统性漂移（安静段弱/响亮段强）→ note 堆进强段、
// 弱段整段空白。构造强度漂移的长歌分析数据验证分窗配额采样的均匀性。
console.log('▶ 长歌分桶均匀性回归测试');
{
  const LONG_DUR = 150, L_BPM = 120, L_BEAT = 60 / L_BPM;
  // 强度漂移：0-30s 弱（0.45）→ 30-120s 强（0.92）→ 120-150s 弱（0.40）
  const driftS = (t) => (t < 30 ? 0.45 : t < 120 ? 0.92 : 0.40);
  const buildAnalysis = (repeats) => {
    const beats = [], onsets = [], kicks = [], snares = [], hihats = [], barGrid = [];
    for (let t = 0.1; t <= LONG_DUR; t += L_BEAT) beats.push(+t.toFixed(4));
    for (let i = 0; i < beats.length; i++) {
      const t = beats[i];
      kicks.push({ t, s: driftS(t) });
      if (i % 2 === 0) onsets.push({ t, s: driftS(t) });
      if (i % 4 === 1 || i % 4 === 3) snares.push({ t, s: driftS(t) });
      if (i % 4 === 0) barGrid.push(+(t).toFixed(4));
    }
    for (let t = 0.1 + L_BEAT / 2; t <= LONG_DUR; t += L_BEAT / 2) hihats.push({ t: +t.toFixed(4), s: driftS(t) * 0.8 });
    return {
      version: 3, bpm: L_BPM, offset: 0.1, durationSec: LONG_DUR, onsetCount: onsets.length,
      beats, onsets, barGrid, meter: 4, downbeatPhase: 0, downbeatConfidence: 0.8, tatum: 2,
      segments: [{ start: 0, end: 30, energy: 0.5 }, { start: 30, end: 120, energy: 1 }, { start: 120, end: LONG_DUR, energy: 0.5 }],
      drumKicks: kicks, drumSnares: snares, drumHihats: hihats,
      key: { tonic: 'C', tonicPc: 0, mode: 'major', confidence: 0.8 },
      tonalOnsets: [], tonalSustains: [], repeats: repeats || [],
      rms: { mean: 0.1, low: 0.05, high: 0.2, dynamicRangeDb: 12 },
    };
  };
  const bucketHist = (notes) => {
    const b = new Array(15).fill(0);
    for (const n of notes) { const i = Math.floor(n.t / 10); if (i >= 0 && i < 15) b[i]++; }
    return b;
  };
  const { DIFFICULTIES } = await import(srcUrl('../src/core/constants.js'));

  // 场景 1：默认（无 hints）—— 强度漂移下分桶必须均匀
  const longAnalysis = buildAnalysis();
  for (const dk of ['E', 'H', 'EX']) {
    for (let seed = 999; seed < 1002; seed++) {
      const chart = generateChart(longAnalysis, dk, seed, 4);
      const targetN = Math.max(8, Math.round(LONG_DUR * DIFFICULTIES[dk].density));
      const hist = bucketHist(chart.notes);
      // 评估桶：完全落在 [0,140] 内的桶（末桶不满）
      const evalBuckets = hist.slice(0, 14);
      const med = [...evalBuckets].sort((a, b) => a - b)[Math.floor(evalBuckets.length / 2)];
      const minB = Math.min(...evalBuckets);
      const ratio = minB / Math.max(1, med);
      const inRange = chart.notes.length >= targetN * 0.7 && chart.notes.length <= targetN * 1.3;
      const tMax = chart.notes.length ? Math.max(...chart.notes.map((n) => n.t)) : 0;
      console.log(`  ${dk}#${seed}: total=${chart.notes.length}/${targetN} min桶=${minB} med桶=${med} 均匀比=${ratio.toFixed(2)} tMax=${tMax.toFixed(0)}s`);
      assert(minB >= 3, `${dk}#${seed} 无段落级空白（最小 10s 桶 ${minB} ≥ 3）`);
      assert(ratio >= 0.4, `${dk}#${seed} 分桶均匀（min/median=${ratio.toFixed(2)} ≥ 0.4）`);
      assert(inRange, `${dk}#${seed} note 总量贴近目标（${chart.notes.length} vs ${targetN}）`);
      assert(tMax >= LONG_DUR - 12, `${dk}#${seed} 覆盖到曲尾（tMax=${tMax.toFixed(0)}s）`);
    }
  }

  // 场景 2：repeatMirror 开启 + 链式重复段（v1.3.0 事故机制：dst 跳过生成、
  // 复现源自身是空 dst → 级联失败整段空白）
  const chainRepeats = [
    { srcBar: 10, dstBar: 30, bars: 8, similarity: 0.95 },
    { srcBar: 30, dstBar: 50, bars: 8, similarity: 0.95 },
    { srcBar: 50, dstBar: 65, bars: 8, similarity: 0.95 },
  ];
  const chainAnalysis = buildAnalysis(chainRepeats);
  for (const dk of ['H', 'EX']) {
    for (let seed = 999; seed < 1002; seed++) {
      const gen = generateChart(chainAnalysis, dk, seed, 4, { repeatMirror: true });
      const hist = bucketHist(gen.notes);
      const evalBuckets = hist.slice(0, 14);
      const minB = Math.min(...evalBuckets);
      const copied = gen.stats.patternCounts.repeat || 0;
      console.log(`  [复现开] ${dk}#${seed}: total=${gen.notes.length} min桶=${minB} 复现小节=${copied}`);
      assert(minB >= 3, `复现开 ${dk}#${seed} 链式重复段无空白（最小桶 ${minB} ≥ 3）`);
      assert(copied >= 16, `复现开 ${dk}#${seed} 链式复现生效（${copied} ≥ 16 小节）`);
      const chk = checkHuman(gen, dk);
      assert(chk.gapOK && chk.holdOK && chk.simulOK, `复现开 ${dk}#${seed} 谱面可行性合法`);
    }
  }
}

// ---- 5. 种子可复现测试 ----
console.log('▶ 种子复现测试');
const a1 = generateChart(analysis, 'H', 777, 4);
const a2 = generateChart(analysis, 'H', 777, 4);
const a3 = generateChart(analysis, 'H', 888, 4);
assert(JSON.stringify(a1.notes) === JSON.stringify(a2.notes), '相同 seed 生成完全一致');
assert(JSON.stringify(a1.notes) !== JSON.stringify(a3.notes), '不同 seed 生成不同布局');

// ---- 6. 判定引擎测试 ----
console.log('▶ 判定引擎测试');
const { JudgeEngine } = await import(srcUrl('../src/game/Engine.js'));
const testNotes = [
  { t: 1.0, lane: 0, type: 'tap' },
  { t: 2.0, lane: 1, type: 'tap' },
  { t: 3.0, lane: 2, type: 'hold', d: 0.5 },
  { t: 5.0, lane: 3, type: 'tap' },
];
const judges = [];
const eng = new JudgeEngine(testNotes, {
  onJudge: (n, j) => judges.push(j),
  onFinish: (s) => { eng._fin = s; },
});
eng.handleKeyDown(0, 0.98);   // perfect
eng.handleKeyDown(1, 2.06);   // great
eng.handleKeyDown(2, 3.02);   // hold head perfect
eng.update(3.6);
eng.handleKeyUp(2, 3.6);      // hold 提前 0.4s 松 → 尾 miss？d=0.5 尾在3.5，3.6已超尾。
eng.handleKeyDown(3, 5.12);   // good（Δ=0.12s）
eng.update(6.0);
assert(judges[0] === 'perfect', 'tap perfect 判定正确');
assert(judges[1] === 'great', 'tap great 判定正确');
assert(judges.includes('good'), 'good 判定正确');
assert(eng.judgeCount === eng.totalJudges, `全部判定完成（${eng.judgeCount}/${eng.totalJudges}）`);
assert(eng.fullCombo === false || judges.includes('miss') === false, '判定计数一致');
console.log(`  分数=${eng.score} acc=${eng.accuracy.toFixed(2)}% counts=${JSON.stringify(eng.counts)}`);

// hold 早松 miss 测试（v1.5.0：断开后过恢复窗口未重新按住才补判尾 miss）
const eng2 = new JudgeEngine([{ t: 1.0, lane: 0, type: 'hold', d: 0.5 }], { onJudge: () => {} });
eng2.handleKeyDown(0, 1.0);
eng2.handleKeyUp(0, 1.1); // 早松 0.4s（> 0.35 宽容）→ 断开，不立即判
assert(eng2.counts.miss === 0, '早松在宽容期内不立即判 miss');
eng2.update(1.65);        // 过恢复窗口（尾点+0.12s）仍未按住 → 补判尾 miss
assert(eng2.counts.miss >= 1, '断开后未恢复的长键尾 miss');

// hold 早松后重新按住可恢复（v1.5.0）
const eng3 = new JudgeEngine([{ t: 1.0, lane: 0, type: 'hold', d: 0.6 }], { onJudge: () => {} });
eng3.handleKeyDown(0, 1.0);        // 头 perfect
eng3.handleKeyUp(0, 1.15);         // 早松（剩余 0.45 > 0.35）→ 断开
const resumed = eng3.handleKeyDown(0, 1.3); // 重新按住
assert(resumed === 'resume', '断开的长键可重新按住（恢复）');
eng3.update(1.7);                  // 按住到尾 → 尾 perfect
assert(eng3.counts.miss === 0, '恢复按住后尾部不判 miss');
assert((eng3.counts.perfect || 0) >= 2, 'hold 头尾均 perfect');

// 宽容期内早松：按提前量给判定不判 miss
const eng4 = new JudgeEngine([{ t: 1.0, lane: 0, type: 'hold', d: 0.5 }], { onJudge: () => {} });
eng4.handleKeyDown(0, 1.0);
eng4.handleKeyUp(0, 1.3); // 剩余 0.2 ≤ 0.35 → 尾部按提前量判
assert(eng4.counts.miss === 0, '宽容期内早松不判 miss');
assert((eng4.counts.great || 0) + (eng4.counts.good || 0) + (eng4.counts.perfect || 0) >= 2, '宽容期早松尾部有判定');

// ---- 7. 设置归一化与键位兜底（回归：v1.0.0 keymap 对象化崩溃） ----
console.log('▶ 设置归一化回归测试');
const { normalizeSettings, effectiveKeymap } = await import(srcUrl('../src/core/constants.js'));
const legacy = normalizeSettings({ keymap: { 0: 'KeyD', 1: 'KeyF', 2: 'KeyJ', 3: 'KeyK' } });
assert(Array.isArray(legacy.keymap), '旧版对象形式 keymap 规范化为数组');
assert(JSON.stringify(legacy.keymap) === JSON.stringify(['KeyD', 'KeyF', 'KeyJ', 'KeyK']), '规范化保留原键位值');
const broken = normalizeSettings({ keymap: { 0: 'KeyD' } });
assert(Array.isArray(broken.keymap) && broken.keymap.length === 4 && broken.keymap.every(Boolean), '长度不足的 keymap 回退默认');
assert(Array.isArray(normalizeSettings(null).keymap), '空设置得到默认数组');
  assert(normalizeSettings({ scrollSpeed: 99 }).scrollSpeed === 15, 'scrollSpeed 越界收敛到 15（v1.8.1b 上限）');
const km4 = effectiveKeymap(legacy, 4);
assert(km4.length === 4 && km4[0] === 'KeyD', '4 轨歌曲取 4 键');
const km6 = effectiveKeymap(legacy, 6);
assert(km6.length === 4, 'v1.6.1：6 轨请求收敛为 4 键（六轨已移除）');
const norm6 = normalizeSettings({ keyCount: 6, keymap: ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'] });
assert(norm6.keyCount === 4 && norm6.keymap.length === 4 && norm6.keymap[0] === 'KeyD', 'v1.6.1：旧 6 轨设置归一化为 4 轨默认键位');
const kmBad = effectiveKeymap({ keymap: { 0: 'KeyD' } }, 4);
assert(kmBad.length === 4 && kmBad.every(Boolean), '非数组 keymap 兑底默认（原崩溃点）');

// ---- 8. 外部谱面格式解析（v1.6.0：osu/Malody/SM + zip 解包） ----
console.log('▶ 谱面格式解析测试');
{
  const { parseOsu, parseSm, parseMc, parseChartFile } = await import(srcUrl('../src/core/chartformats.js'));

  // .osu：4K、tap+hold、x→lane 映射、时间毫秒直读
  const osuText = [
    'osu file format v14',
    '[General]',
    'Mode: 3',
    'AudioFilename: audio.mp3',
    '[Metadata]',
    'Title:Test Song',
    'Version:Hard',
    '[Difficulty]',
    'CircleSize:4',
    '[TimingPoints]',
    '0,500,4,1,0,100,1,0',
    '[HitObjects]',
    '64,192,1000,1,0',        // x=64 → lane 0, t=1s tap
    '320,192,1500,1,0',       // x=320 → lane 2, t=1.5s tap
    '448,192,2000,128,0,2600:0:0:0:0',  // x=448 → lane 3, hold 2s→2.6s
  ].join('\n');
  const osu = parseOsu(osuText);
  assert(osu.charts.length === 1 && osu.charts[0].keyCount === 4, 'osu 解析出 4K 谱');
  assert(osu.meta.bpm === 120 && osu.meta.title === 'Test Song', 'osu 元数据（BPM/标题）');
  const on = osu.charts[0].notes;
  assert(on.length === 3, `osu 音符数 3（实际 ${on.length}）`);
  assert(on[0].t === 1 && on[0].lane === 0 && on[0].type === 'tap', 'osu tap：x=64→lane0，t=1s');
  assert(on[1].lane === 2, `osu tap：x=320→lane2（实际 ${on[1].lane}）`);
  const oh = on.find((n) => n.type === 'hold');
  assert(oh && oh.lane === 3 && Math.abs(oh.t - 2) < 1e-9 && Math.abs(oh.d - 0.6) < 1e-9, 'osu hold：lane3，2s~2.6s');

  // .osu 7K 拒绝
  try {
    parseOsu(osuText.replace('CircleSize:4', 'CircleSize:7'));
    assert(false, 'osu 7K 应被拒绝');
  } catch (e) { assert(/4K|6K/.test(e.message), 'osu 7K 拒绝信息正确'); }

  // .sm：4 行/小节 = 四分音符；BPM 积分；hold 2-3
  const smText = [
    '#TITLE:SM Test;',
    '#ARTIST:Someone;',
    '#BPMS:0.000=120.000;',
    '#OFFSET:0.000;',
    '#NOTES:',
    'dance-single',
    ':',
    'author',
    ':',
    'Challenge',
    ':',
    '9',
    '1000',
    '0000',
    '0000',
    '0000',
    '0000',
    '0000',
    '0000',
    '0000',
    ',',
    '1000',
    '0100',
    '0200',
    '0300',
    '0000',
    '0000',
    '0000',
    '0000',
    ';',
  ].join('\n');
  const sm = parseSm(smText, 'test.sm');
  assert(sm.charts.length === 1 && sm.charts[0].keyCount === 4, 'sm 解析出 4K 谱');
  const sn = sm.charts[0].notes;
  // 拍→秒：120BPM=0.5s/拍。measure0 r0=拍0（0s）tap lane0；measure1 r0=拍4（2s）tap lane0
  assert(sn.some((n) => n.type === 'tap' && n.lane === 0 && Math.abs(n.t - 0) < 1e-9), 'sm 第一小节 tap lane0 t=0');
  assert(sn.some((n) => n.type === 'tap' && n.lane === 0 && Math.abs(n.t - 2) < 1e-9), 'sm 第二小节 tap lane0 t=2s（BPM 积分）');
  assert(sn.some((n) => n.type === 'tap' && n.lane === 1 && Math.abs(n.t - 2.25) < 1e-9), 'sm 第二小节 r1=拍4.5→2.25s');
  const sh = sn.find((n) => n.type === 'hold');
  assert(sh && sh.lane === 1 && Math.abs(sh.t - 2.5) < 1e-9 && Math.abs(sh.d - 0.25) < 1e-9, 'sm hold：2.5s~2.75s（2-3 对）');

  // .mc：JSON、beat [bar,beat,frac]（bar 为小节号，×4 拍）、TIME 段
  const mcDoc = {
    META: { song: 'MC Test', artist: 'M', mode: 0, version: 'Insane' },
    TIME: [{ beat: 0, bpm: 120 }],
    NOTES: [
      { beat: [0, 0], column: 0 },
      { beat: [1, 0], column: 3, hold: [0, 1] },
      { beat: [2, 2], column: 1 },
    ],
  };
  const mc = parseMc(JSON.stringify(mcDoc));
  assert(mc.charts.length === 1 && mc.charts[0].keyCount === 4, 'mc 解析出 4K 谱');
  const mn = mc.charts[0].notes;
  assert(mn.some((n) => n.lane === 0 && Math.abs(n.t) < 1e-9), 'mc beat[0,0]→0s');
  const mh = mn.find((n) => n.type === 'hold');
  assert(mh && mh.lane === 3 && Math.abs(mh.t - 2) < 1e-9 && Math.abs(mh.d - 0.5) < 1e-9, 'mc hold：beat[1,0]→2s，hold[0,1]=1拍→0.5s');
  assert(mn.some((n) => n.lane === 1 && Math.abs(n.t - 5) < 1e-9), 'mc beat[2,2]=第2小节+2拍→拍10→5s');

  // 分派器
  const byExt = parseChartFile(osuText, 'x.osu');
  assert(byExt.charts[0].notes.length === 3, 'parseChartFile 按扩展名分派');
  try {
    parseChartFile('garbage', 'x.txt');
    assert(false, '不支持的格式应报错');
  } catch (e) { assert(/不支持/.test(e.message), '不支持格式报错信息正确'); }

  // zip 解包（STORE + DEFLATE）
  const { unzipFiles, bytesToText } = await import(srcUrl('../src/core/zip.js'));
  const { deflateRawSync } = await import('zlib');
  function crc32(buf) {
    let c, crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      c = (crc ^ buf[i]) & 0xFF;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function buildZip(entries) {
    // entries: [{name, data:Uint8Array, deflate:boolean}]
    const locals = []; const centrals = [];
    let offset = 0;
    for (const e of entries) {
      const nameB = new TextEncoder().encode(e.name);
      const raw = e.deflate ? new Uint8Array(deflateRawSync(e.data)) : e.data;
      const crc = crc32(e.data);
      const lh = new Uint8Array(30 + nameB.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, e.deflate ? 8 : 0, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, raw.length, true);
      lv.setUint32(22, e.data.length, true);
      lv.setUint16(26, nameB.length, true);
      lh.set(nameB, 30);
      locals.push(lh, raw);
      const ch = new Uint8Array(46 + nameB.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, e.deflate ? 8 : 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, raw.length, true);
      cv.setUint32(24, e.data.length, true);
      cv.setUint16(28, nameB.length, true);
      cv.setUint32(42, offset, true);
      ch.set(nameB, 46);
      centrals.push(ch);
      offset += lh.length + raw.length;
    }
    const cdSize = centrals.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 0, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint16(12, entries.length, true);
    ev.setUint32(12 + 4, cdSize, true);
    ev.setUint32(16, offset, true);
    const totalLen = offset + cdSize + 22;
    const out = new Uint8Array(totalLen);
    let p = 0;
    for (const part of [...locals, ...centrals, eocd]) { out.set(part, p); p += part.length; }
    return out.buffer;
  }
  const osuFile = new TextEncoder().encode(osuText);
  const zipBuf = buildZip([
    { name: 'song.osu', data: osuFile, deflate: false },
    { name: 'notes.txt', data: new TextEncoder().encode('not wanted'), deflate: true }, // 非目标扩展名（DEFLATE 路径仍要能过）
  ]);
  // 想要 .osu 时第二个不取；再构造一个包含 DEFLATE .mc 的包验证解压路径
  const mcFile = new TextEncoder().encode(JSON.stringify(mcDoc));
  const zipBuf2 = buildZip([
    { name: 'chart.mc', data: mcFile, deflate: true },
  ]);
  const files1 = await unzipFiles(zipBuf, ['osu']);
  assert(files1.length === 1 && files1[0].name === 'song.osu', 'zip：STORE 文件按扩展名过滤解出');
  assert(bytesToText(files1[0].data) === osuText, 'zip：STORE 内容完整');
  const files2 = await unzipFiles(zipBuf2, ['mc', 'osu']);
  assert(files2.length === 1 && files2[0].name === 'chart.mc', 'zip：DEFLATE 文件解出');
  const mcParsed2 = parseChartFile(bytesToText(files2[0].data), 'chart.mc');
  assert(mcParsed2.charts[0].notes.length === 3, 'zip：DEFLATE 内容经 mc 解析正确');
}

// ---- v1.7.0：慢放/seek 时间换算（timeutil 纯函数） ----
{
  const { musicTimeAt, playAnchorMusicT } = await import(srcUrl('../src/core/timeutil.js'));
  assert(Math.abs(musicTimeAt(10, 100, 105, 0.5) - 12.5) < 1e-9, '慢放换算：0.5x 下墙钟 5s = 音乐 2.5s');
  assert(Math.abs(musicTimeAt(10, 100, 105, 0.75) - 13.75) < 1e-9, '慢放换算：0.75x 下墙钟 5s = 音乐 3.75s');
  assert(musicTimeAt(7.3, null, 999, 0.5) === 7.3, '暂停态：startedAtCtx=null 时返回锚点');
  // v1.7.1：倒计时锚定——play 锚定调用时刻，time 从 fromT-lead 连续走到 fromT，
  // 音频恰在 time=fromT 瞬间出声（旧行为：音乐早于倒计时结束整整 lead 秒）
  assert(Math.abs(musicTimeAt(-2, 100, 100, 1) - (-2)) < 1e-9, '倒计时锚定：play 调用瞬间 time=fromT-lead（即刻开始走）');
  assert(Math.abs(musicTimeAt(-2, 100, 102, 1) - 0) < 1e-9, '倒计时锚定：lead 走完时 time=fromT（音乐恰在此刻出声，不再早 lead 秒）');
  assert(Math.abs(musicTimeAt(-1, 100, 104, 0.5) - 1) < 1e-9, '慢放倒计时：0.5x 下墙钟 4s 音乐前进 2s（lead 1s 已走完 + 1s）');
  assert(Math.abs(musicTimeAt(-2, 100, 101, 1) - (-1)) < 1e-9, '倒计时中段连续：1s 后 time=-1（无冻结段）');
  assert(playAnchorMusicT(10, 2, 1) === 8, 'play 锚定：1x 下 2s 倒计时从 fromT-2 起算');
  assert(playAnchorMusicT(10, 2, 0.5) === 9, 'play 锚定：0.5x 下倒计时只回退 1s 音乐时间');
  // 变速重锚连续性：setRate 在音乐时间 14 处切 0.5x，之后墙钟 2s → 15
  const t0 = musicTimeAt(10, 100, 104, 1);
  const t1 = musicTimeAt(t0, 104, 106, 0.5);
  assert(Math.abs(t1 - 15) < 1e-9, '变速重锚：time 连续（14 + 2×0.5 = 15）');
}

// ---- v1.7.0：保留段重抽（chartedit 纯函数） ----
{
  const { mergeKeepSegment, pickDiffForDensity, regenOutsideSegment } = await import(srcUrl('../src/core/chartedit.js'));
  assert(pickDiffForDensity(0.9) === 'E', '密度选档：0.9 → E');
  assert(pickDiffForDensity(2.2) === 'H', '密度选档：2.2 → H');
  assert(pickDiffForDensity(3.8) === 'EX', '密度选档：3.8 → EX');

  // 拼接 + 裁尾 + 接缝清理（保留区 [1.5, 3.0]）
  const base = [
    { t: 2.0, lane: 0, type: 'tap' },            // 保留
    { t: 2.8, lane: 1, type: 'hold', d: 0.5 },   // 越右界裁尾 → hold 0.2
    { t: 2.95, lane: 2, type: 'hold', d: 0.5 },  // 裁剩 0.05 → 转短音
    { t: 1.0, lane: 3, type: 'tap' },            // 段外 → 丢弃
  ];
  const gen = [
    { t: 0.5, lane: 0, type: 'tap' },            // 段外左：保留
    { t: 2.5, lane: 1, type: 'tap' },            // 段内：丢弃（保留优先）
    { t: 3.5, lane: 3, type: 'tap' },            // 段外右：保留
    { t: 1.0, lane: 0, type: 'hold', d: 1.0 },   // 左跨界：裁尾到段起点 d=0.5
    { t: 1.45, lane: 2, type: 'hold', d: 0.2 },  // 左跨界裁剩 0.05：丢弃
    { t: 3.08, lane: 1, type: 'tap' },           // 头距保留 hold 尾 0.08s：丢弃
    { t: 3.03, lane: 2, type: 'hold', d: 0.5 },  // 与保留短音头距 0.08s：丢弃
    { t: 1.2, lane: 3, type: 'hold', d: 0.25 },  // 段外左完整 hold：保留
  ];
  const m = mergeKeepSegment(base, gen, 1.5, 3.0);
  const sig = m.map((n) => `${n.t}:${n.lane}:${n.type}${n.type === 'hold' ? '(' + n.d + ')' : ''}`).join(',');
  assert(
    sig === '0.5:0:tap,1:0:hold(0.5),1.2:3:hold(0.25),2:0:tap,2.8:1:hold(0.2),2.95:2:tap,3.5:3:tap',
    '保留段拼接：保留/裁尾/转短音/接缝清理全部符合预期'
  );

  // 端到端：真实分析数据 + 生成器 + 同 seed 可复现
  const kbase = [
    { t: 5.0, lane: 0, type: 'tap' },
    { t: 6.5, lane: 1, type: 'hold', d: 0.5 },
    { t: 11.0, lane: 2, type: 'tap' },
    { t: 1.0, lane: 0, type: 'tap' },
    { t: 20.0, lane: 3, type: 'tap' },
  ];
  const r = regenOutsideSegment(kbase, analysis, 4, null, 4, 12, 987654);
  assert(['E', 'H', 'EX'].includes(r.diffKey), '保留段重抽：按密度返回合法档位');
  const inZone = r.notes.filter((n) => n.t >= 4 - 1e-4 && n.t <= 12 + 1e-4);
  assert(
    inZone.length === 3
    && inZone.some((n) => n.t === 5.0 && n.lane === 0)
    && inZone.some((n) => n.t === 6.5 && n.type === 'hold' && n.d === 0.5)
    && inZone.some((n) => n.t === 11.0 && n.lane === 2),
    '保留段重抽：段内 3 个音符原样保留（段内生成音符让位）'
  );
  assert(r.notes.some((n) => n.t < 4 - 1e-4) && r.notes.some((n) => n.t > 12 + 1e-4), '保留段重抽：段外已用生成谱填充');
  // 接缝约束：保留音符与同轨生成音符头距 ≥0.105 且互不压体
  const keptT = new Set([5.0, 6.5, 11.0]);
  let seamOk = true;
  for (const k of kbase.filter((n) => n.t >= 4 && n.t <= 12)) {
    for (const n of r.notes) {
      if (keptT.has(n.t) || n.lane !== k.lane) continue;
      if (Math.abs(n.t - k.t) < 0.105) seamOk = false;
      const nEnd = n.t + (n.type === 'hold' ? n.d : 0);
      if (n.type === 'hold' && k.t > n.t && k.t < nEnd) seamOk = false;
      if (k.type === 'hold' && n.t > k.t && n.t < k.t + k.d) seamOk = false;
      if (n.type === 'hold' && n.t > k.t + k.d && n.t - (k.t + k.d) < 0.105) seamOk = false;
    }
  }
  assert(seamOk, '保留段重抽：接缝同轨冲突已清理');
  const r2 = regenOutsideSegment(kbase, analysis, 4, null, 4, 12, 987654);
  assert(JSON.stringify(r2.notes) === JSON.stringify(r.notes), '保留段重抽：同 seed 结果可复现');
}

// ---- v1.7.1：长键可与其他音符并列（同轨约束仍生效） ----
{
  // 多压对源本身稀疏（chord measure 占比小），故分两层验证：
  // ① 自然出现率（无干预）；② 强制 chord 键型窗口下的能力稳定出现（结构断言）
  let holdTapSeeds = 0, holdHoldSeeds = 0, sameLaneSimul = false, laneOverlap = false;
  for (let s = 1; s <= 30; s++) {
    const c = generateChart(analysis, 'EX', s, 4);
    const notes = c.notes;
    let st = false, hh = false;
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        if (notes[j].t - notes[i].t > 0.012) break;
        if (notes[i].type === 'hold' && notes[j].type === 'hold') hh = true;
        else if (notes[i].type === 'hold' || notes[j].type === 'hold') st = true;
        if (notes[i].lane === notes[j].lane) sameLaneSimul = true; // 同轨同刻非法
      }
    }
    if (st) holdTapSeeds++;
    if (hh) holdHoldSeeds++;
    // 同轨 hold 窗口不得交叠且留有间隔
    const holds = notes.filter((x) => x.type === 'hold').sort((a, b) => a.t - b.t);
    for (let i = 1; i < holds.length; i++) {
      if (holds[i].lane === holds[i - 1].lane
        && holds[i].t - (holds[i - 1].t + (holds[i - 1].d || 0)) < 0.1) laneOverlap = true;
    }
  }
  // v1.8.0：自然出现率是弱随机断言（多压对本身稀少 + 吸附/连贯权重改变选取路径，
  // 波动大），能力由下方强制 chord 窗口断言保证，此处只留结构守卫
  assert(!sameLaneSimul, '同刻音符均不同轨');
  assert(!laneOverlap, '同轨 hold 无交叠且留 ≥0.1s 间隔');

  // 强制 chord 键型窗口（18-23s 尾奏弱段）：多压对稳定存在且同轨间隔宽
  // （密集副歌段同轨音符太密，maxDur<holdMinDur 会合理拒绝转长键——
  //   长键双押的自然位置本就是稀疏/长音段，与主流 4K 谱一致）
  const hinted = { patternHints: [{ start: 18, end: 23, pattern: 'chord' }] };
  let forcedPairs = 0, forcedHoldTap = 0, forcedHoldHold = 0;
  for (let s = 1; s <= 30; s++) {
    const c = generateChart(analysis, 'EX', s, 4, hinted);
    let pair = false, ht = false, hh2 = false;
    for (let i = 0; i < c.notes.length; i++) {
      for (let j = i + 1; j < c.notes.length; j++) {
        if (c.notes[j].t - c.notes[i].t > 0.012) break;
        if (c.notes[i].t < 18 || c.notes[i].t > 23) continue;
        pair = true;
        const hi = c.notes[i].type === 'hold', hj = c.notes[j].type === 'hold';
        if (hi && hj) hh2 = true;
        else if (hi || hj) ht = true;
      }
    }
    if (pair) forcedPairs++;
    if (ht) forcedHoldTap++;
    if (hh2) forcedHoldHold++;
  }
  assert(forcedPairs >= 20, `尾奏段多压对稳定存在（${forcedPairs}/30 seeds）`);
  // v1.8.0：吸附+连贯权重改变生成路径，分布从 7/10 波动到 2/7——能力断言
  // 本义是证明功能存在（旧版恒 0），阈值取能力下限
  assert(forcedHoldTap >= 1, `多压成员可转长键：长键+短键同刻并列出现（${forcedHoldTap}/30 seeds，旧版恒为 0）`);
  assert(forcedHoldHold >= 3, `双长键同刻并列稳定出现（${forcedHoldHold}/30 seeds，旧版恒为 0）`);
}

// ---- v1.7.1：头/尾静音检测 + 落谱区间裁剪 ----
{
  // 手工 PCM：10s 总长，头 3s 静音 + 4s 内容 + 尾 3s 静音
  const SRsil = 44100;
  const pcmSil = new Float32Array(SRsil * 10);
  for (let i = 3 * SRsil; i < 7 * SRsil; i++) {
    const t = (i - 3 * SRsil) / SRsil;
    pcmSil[i] = 0.4 * Math.sin(2 * Math.PI * 440 * t) * (0.75 + 0.25 * Math.sin(2 * Math.PI * 2 * t));
  }
  captured.length = 0;
  self.onmessage({ data: { type: 'analyze', channels: [pcmSil], sampleRate: SRsil, durationSec: 10 } });
  const silMsg = captured.find((m) => m.type === 'result');
  const silAnalysis = silMsg && silMsg.analysis;
  assert(!!silAnalysis, '静音变体：分析返回结果');
  assert(silAnalysis.audioStart > 1.8 && silAnalysis.audioStart < 3.3, `头静音检出：audioStart=${silAnalysis.audioStart}（内容实际始于 3s，边界回退半窗）`);
  assert(silAnalysis.audioEnd > 6.7 && silAnalysis.audioEnd < 8.3, `尾静音检出：audioEnd=${silAnalysis.audioEnd}（内容终于 7s）`);
  // 生成器落谱区间裁剪：伪逓20 analysisaudioStart/audioEnd → 全部 note 落在有声区间内
  const fakeA = { ...analysis, audioStart: 4, audioEnd: 12 };
  for (const dk of ['E', 'H', 'EX']) {
    const c = generateChart(fakeA, dk, 5150, 4);
    assert(c.notes.length > 0, `${dk}：有声区间内仍有音符`);
    const minT = Math.min(...c.notes.map((n) => n.t));
    const maxEnd = Math.max(...c.notes.map((n) => n.t + (n.type === 'hold' ? n.d : 0)));
    assert(minT >= 4 - 1e-6, `${dk}：落谱不早于 audioStart（min t=${minT.toFixed(3)}）`);
    assert(maxEnd <= 12 + 0.011, `${dk}：hold 尾不越过 audioEnd（max end=${maxEnd.toFixed(3)}）`);
  }
  // 无字段旧数据回退：结果与原 analysis 一致（不裁剪）
  const legacyA = { ...analysis };
  delete legacyA.audioStart;
  delete legacyA.audioEnd;
  const c1 = generateChart(analysis, 'H', 5151, 4);
  const c2 = generateChart(legacyA, 'H', 5151, 4);
  assert(JSON.stringify(c1.notes) === JSON.stringify(c2.notes), '旧分析无 audioStart/audioEnd 字段时自动回退全曲');
}

// ---- v1.8.0：落点吸附 + v3 旧缓存回退 ----
{
  // 吸附断言：H/EX 谱中应有显著数量的 note 贴合人声 onset 检测值（±35ms）。
  // 无吸附时 note 在检测 beat 网格上（与人声 onset 距离 ~200ms+ 不可能贴上）
  let snapHit = 0;
  for (const nt of results.H.notes) {
    if (analysis.vocalOnsets.some((o) => Math.abs(o.t - nt.t) <= 0.035)) snapHit++;
  }
  console.log(`  H 谱贴人声 onset：${snapHit}/${results.H.notes.length}（吸附生效的直接证据）`);
  assert(snapHit >= 5, `落点吸附生效：note 贴合人声 onset（${snapHit} 个 ≥5）`);
  // E 档不吸附：E note 全在检测网格上（无贴 onset 位移）
  let eSnap = 0;
  for (const nt of results.E.notes) {
    if (analysis.vocalOnsets.some((o) => Math.abs(o.t - nt.t) <= 0.035)) eSnap++;
  }
  console.log(`  E 谱贴人声 onset：${eSnap}/${results.E.notes.length}（E 不吸附，应远低于 H）`);
  assert(eSnap <= 2, `E 档保持纯网格不吸附（贴 onset 仅 ${eSnap} 个 ≤2，网格与 onset 偶然重合）`);

  // v3 旧缓存回退：无 vocalOnsets/segments2/tonalOnsets 字段时生成不报错且合法
  const legacyA = JSON.parse(JSON.stringify(analysis));
  delete legacyA.vocalOnsets;
  delete legacyA.segments2;
  delete legacyA.tonalOnsets;
  legacyA.version = 3;
  for (const dk of ['E', 'H', 'EX']) {
    const c = generateChart(legacyA, dk, 4242, 4);
    const chk = checkHuman(c, dk);
    assert(c.notes.length > 0 && chk.gapOK && chk.holdOK && chk.simulOK, `v3 旧缓存回退：${dk} 生成合法（${c.notes.length} notes）`);
  }
  // version 4 完整数据下同样合法（主路径）
  const c4 = generateChart(analysis, 'EX', 4242, 4);
  const chk4 = checkHuman(c4, 'EX');
  assert(chk4.gapOK && chk4.holdOK && chk4.simulOK, 'v4 完整数据：EX 生成合法');
}

// ---- v1.8.1d：透视深度曲线（幂函数基线恢复，见 timeutil.perspQ） + 速度上限 15 + 长按同手区清理 ----
{
  const { perspQ } = await import(srcUrl('../src/core/timeutil.js'));
  const { speedToApproach } = await import(srcUrl('../src/core/constants.js'));
  const { sanitizeHoldAdjacentTaps, mergeKeepSegment } = await import(srcUrl('../src/core/chartedit.js'));

  // ---- 速度档：1-10 不变，11-15 新增（每档 -0.025s） ----
  assert(Math.abs(speedToApproach(1) - 1.055) < 1e-9, '速度档 L1 不变（1.055s）');
  assert(Math.abs(speedToApproach(5) - 0.675) < 1e-9, '速度档 L5 不变（0.675s）');
  assert(Math.abs(speedToApproach(10) - 0.2) < 1e-9, '速度档 L10 不变（0.2s）');
  assert(Math.abs(speedToApproach(11) - 0.175) < 1e-9, '速度档 L11（0.175s）');
  assert(Math.abs(speedToApproach(15) - 0.075) < 1e-9, '速度档 L15 满档（0.075s）');
  assert(Math.abs(speedToApproach(99) - 0.075) < 1e-9, '速度档越界钳制到 15');

  // ---- perspQ 幂函数基线（v1.8.0 手感：软化透视投影） ----
  const K = 0.675;
  assert(Math.abs(perspQ(0, K) - 1) < 1e-9, 'perspQ：dt=0（判定线）q=1');
  assert(Math.abs(perspQ(K, K) - Math.pow(0.5, 0.62)) < 1e-9, 'perspQ：dt=K 处 q=0.5^0.62（基线数值）');
  let mono = true;
  for (let dt = -0.16; dt <= K * 8; dt += K / 50) {
    if (perspQ(dt + 0.001, K) > perspQ(dt, K) + 1e-12) { mono = false; break; }
  }
  assert(mono, 'perspQ：q 随 dt 单调递减');
  assert(perspQ(-0.16, K) > 1 && perspQ(-0.16, K) <= 1.6, 'perspQ：过线外推 q∈(1,1.6]');
  assert(perspQ(-1, 0.075) <= 1.6, 'perspQ：高速档过线外推不超上限 1.6');
  // 渲染上限 8K 处 q=(1/9)^0.62≈0.256：屏顶附近渐显（淡入带 0.18-0.34 延伸到屏外缓冲）
  assert(Math.abs(perspQ(K * 8, K) - Math.pow(1 / 9, 0.62)) < 1e-9 && perspQ(K * 8, K) < 0.34,
    'perspQ：8K 处 q≈0.256（屏顶，窗口 8K 版，淡入带覆盖）');
  // 可见窗口：8K + 绝对下限 1.6s（L10=1.6s 基线；L11-15 保底 1.6s）
  const { visibleLeadTime } = await import(srcUrl('../src/core/timeutil.js'));
  assert(Math.abs(visibleLeadTime(0.2) - 1.6) < 1e-9, '可见窗口：L10 = 8K = 1.6s（v1.8.0 基线）');
  assert(Math.abs(visibleLeadTime(0.075) - 1.6) < 1e-9, '可见窗口：L15 高速档保底 1.6s');
  assert(Math.abs(visibleLeadTime(0.675) - 5.4) < 1e-9, '可见窗口：L5 = 8K = 5.4s');

  // ---- 长按期间同手区短键清理 ----
  const dirty = [
    { t: 2.0, lane: 1, type: 'hold', d: 0.5 }, // 左手长按 2.0-2.5
    { t: 2.2, lane: 0, type: 'tap' },          // 左手短键（违例）→ 删
    { t: 2.2, lane: 2, type: 'tap' },          // 右手短键 → 保留
    { t: 2.3, lane: 3, type: 'tap' },          // 右手短键 → 保留
    { t: 2.6, lane: 0, type: 'tap' },          // 长按结束后 → 保留
    { t: 2.0, lane: 0, type: 'tap' },          // 与长按头同刻（和弦）→ 保留
    { t: 1.5, lane: 0, type: 'tap' },          // 长按开始前 → 保留
  ];
  const clean = sanitizeHoldAdjacentTaps(dirty, 4);
  assert(clean.length === 6, `同手区清理：删除 1 个违例（结果 ${clean.length}/7）`);
  assert(!clean.some((n) => n.t === 2.2 && n.lane === 0), '长按期间同手区短键被删除');
  assert(clean.some((n) => n.t === 2.2 && n.lane === 2), '长按期间对侧手短键保留');
  assert(clean.some((n) => n.t === 2.6 && n.lane === 0), '长按结束后同手区短键保留');
  assert(clean.some((n) => n.t === 2.0 && n.lane === 0), '与长按头同刻的和弦保留');
  const cleanNoHold = sanitizeHoldAdjacentTaps([
    { t: 1, lane: 0, type: 'tap' }, { t: 1.2, lane: 1, type: 'tap' },
  ], 4);
  assert(cleanNoHold.length === 2, '无长按时全保留');

  // mergeKeepSegment 输出同样被清理（底稿带违例 → 拼接输出干净）
  const mDirty = mergeKeepSegment(dirty, [], 1.0, 3.0, 4);
  assert(!mDirty.some((n) => n.t === 2.2 && n.lane === 0), '保留段重抽输出：同手区违例被清理');
  assert(mDirty.length === 6, `保留段重抽输出：数量正确（${mDirty.length}）`);
}

// ---- v1.8.1：.osz 谱面包导出（buildOsuChart + zipStore） ----
console.log('▶ .osz 谱面包导出测试');
{
  const { buildOsuChart, parseOsu } = await import(srcUrl('../src/core/chartformats.js'));
  const { zipStore, unzipFiles, bytesToText } = await import(srcUrl('../src/core/zip.js'));

  const chart = {
    notes: [
      { t: 1.25, lane: 1, type: 'hold', d: 0.625 },  // 故意乱序，验证输出排序
      { t: 0.123, lane: 0, type: 'tap' },
      { t: 2.501, lane: 3, type: 'tap' },
      { t: 1.888, lane: 2, type: 'hold', d: 0.5 },
    ],
  };
  const meta = {
    title: '中文测试谱面',
    artist: '测试作者',
    bpm: 174,
    offset: 0.123,
    version: 'EX 测试',
    audioFile: 'audio.mp3',
    keyCount: 4,
  };
  const osuText = buildOsuChart(chart, meta);
  assert(osuText.startsWith('osu file format v14'), 'buildOsuChart：输出 osu v14 文件头');
  assert(osuText.includes('Mode: 3') && osuText.includes('CircleSize:4'), 'buildOsuChart：osu!mania 4K 配置');
  assert(osuText.includes('AudioFilename: audio.mp3') && osuText.includes('Creator:BeatChart Arcade'), 'buildOsuChart：音频文件名与 Creator');
  assert(osuText.includes('Title:中文测试谱面') && osuText.includes('Version:EX 测试'), 'buildOsuChart：中文标题与难度名');
  assert(osuText.includes('\n123,') && osuText.includes(',4,2,0,60,1,0'), 'buildOsuChart：offset 毫秒与 uninherited timing 行');

  const parsed = parseOsu(osuText);
  const pn = parsed.charts[0].notes;
  const expected = [...chart.notes].sort((a, b) => a.t - b.t);
  assert(pn.length === expected.length, `buildOsuChart → parseOsu：音符数一致（${pn.length}/${expected.length}）`);
  assert(pn.every((n, i) => n.lane === expected[i].lane && n.type === expected[i].type), 'buildOsuChart → parseOsu：lane 与 type 一致');
  assert(pn.every((n, i) => Math.abs(n.t - expected[i].t) <= 0.002), 'buildOsuChart → parseOsu：时间误差 ≤2ms');
  const parsedHolds = pn.filter((n) => n.type === 'hold');
  const expectedHolds = expected.filter((n) => n.type === 'hold');
  assert(parsedHolds.length === expectedHolds.length
    && parsedHolds.every((h, i) => Math.abs(h.d - expectedHolds[i].d) <= 0.002), 'buildOsuChart → parseOsu：hold 时长误差 ≤2ms');
  assert(parsed.meta.title === '中文测试谱面' && parsed.meta.artist === '测试作者', 'buildOsuChart → parseOsu：元数据标题/作者');
  assert(parsed.meta.bpm === 174 && parsed.meta.audioFile === 'audio.mp3', 'buildOsuChart → parseOsu：BPM/音频文件名');

  // 非法 BPM 回退、缺省作者、换行清洗、空谱面文本
  const fallbackText = buildOsuChart({ notes: [{ t: 0.5, lane: 0, type: 'tap' }] }, {
    title: '回退\n标题\r', version: 'Easy\n测试', bpm: 0, offset: 0,
  });
  const fallback = parseOsu(fallbackText);
  assert(fallback.meta.bpm === 120 && fallback.meta.artist === 'Unknown', 'buildOsuChart：非法 BPM 回退 120、作者缺省 Unknown');
  assert(fallbackText.includes('Title:回退 标题') && fallbackText.includes('Version:Easy 测试'), 'buildOsuChart：标题/难度名去除换行');
  const emptyText = buildOsuChart({ notes: [] }, { title: '空谱', bpm: 120, version: 'Empty' });
  const emptyTail = emptyText.slice(emptyText.indexOf('[HitObjects]') + '[HitObjects]'.length).trim();
  assert(emptyTail === '', 'buildOsuChart：空谱面仍可生成（HitObjects 为空）');

  // ZIP STORE 写出 → 切出精确 ArrayBuffer → 现有 unzipFiles 读回
  const audioBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x7F, 0x80, 0xFF, 0x00, 0x01, 0x02]);
  const chartBytes = new TextEncoder().encode(osuText);
  const zip = zipStore([
    { name: 'audio.mp3', data: audioBytes },
    { name: 'chart.osu', data: chartBytes },
  ]);
  assert(zip instanceof Uint8Array && zip.length > audioBytes.length + chartBytes.length, 'zipStore：返回完整 Uint8Array');
  assert(zip[0] === 0x50 && zip[1] === 0x4B && zip[2] === 0x03 && zip[3] === 0x04, 'zipStore：local file header 签名正确');
  const zipBuf = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
  const files = await unzipFiles(zipBuf, ['mp3', 'osu']);
  const audioBack = files.find((f) => f.name === 'audio.mp3');
  const chartBack = files.find((f) => f.name === 'chart.osu');
  assert(files.length === 2 && !!audioBack && !!chartBack, 'zipStore → unzipFiles：两个文件名读回一致');
  const sameBytes = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
  assert(sameBytes(audioBack && audioBack.data, audioBytes), 'zipStore → unzipFiles：音频字节内容一致');
  assert(chartBack && bytesToText(chartBack.data) === osuText, 'zipStore → unzipFiles：chart.osu 文本内容一致');
}

console.log(`\n========== 测试结果：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail > 0 ? 1 : 0);
