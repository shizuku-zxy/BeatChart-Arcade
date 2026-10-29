// ============ 谱面生成器 v3：键型驱动 + 乐器感知 ============
//
// 架构：slot 骨架（时间+强度+乐器标记，密度受控，tatum 封顶）
//       → 按小节（barGrid/downbeat 对齐）分组 → 每 measure 从键型库选取
//       → 实例化轨道分配 → hold 转换（单侧约束 + sustain/kick 感知）
//       → 人类可行性硬校验 → 统计（含键型构成）
//
// 键型库（参考 osu!mania / BMS 社区术语）：
//   flow 流动 / stair 楼梯 / trill 交互 / jack 纵连
//   chord 多压（kick 锚定）/ mirror 散打（镜像周期）/ roll 急楼梯（hihat 密集区）
//
// 乐器感知（v3 分析数据，旧数据自动回退 v2 行为）：
//   chord 锚点 = kick 命中（优先小节头）   trill/roll 权重随 hihat 密度提升
//   stair 权重随 snare 反拍提升            hold 落点偏好 tonal 持续窗口、避开 kick
//   measure 分组对齐 barGrid（小节线）      细分上限受 tatum 封顶（不违背歌曲律动）

import { DIFFICULTIES } from './constants.js';
import { makeRng } from './prng.js';

const HARD_MIN_GAP = 0.105; // 人类同轨绝对下限（秒）

// ---------- 用户微调（音乐轴编辑器写入 song.hints，重抽时传入） ----------
/** hints = { energy: [{start,end,level}], patternHints: [{start,end,pattern}], repeatMirror } */

// ---------- 工具 ----------
function energyAt(segments, t, fallback = 0.5, hintsEnergy) {
  if (hintsEnergy) {
    for (const s of hintsEnergy) {
      if (t >= s.start && t <= s.end) return s.level;
    }
  }
  for (const s of segments) {
    if (t >= s.start && t <= s.end) return s.energy;
  }
  return fallback;
}

function onsetStrengthAt(onsets, t) {
  let best = 0;
  let lo = 0, hi = onsets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid].t < t) lo = mid + 1;
    else hi = mid - 1;
  }
  for (let i = Math.max(0, lo - 2); i < Math.min(onsets.length, lo + 2); i++) {
    const d = Math.abs(onsets[i].t - t);
    if (d < 0.12) best = Math.max(best, onsets[i].s * (1 - d / 0.12));
  }
  return best;
}

/** 最近 onset 强度（tol 内命中返回强度，否则 0） */
function onsetNear(arr, t, tol) {
  if (!arr || !arr.length) return 0;
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid + 1;
    else hi = mid - 1;
  }
  let best = 0;
  for (let i = Math.max(0, lo - 1); i <= Math.min(arr.length - 1, lo); i++) {
    const d = Math.abs(arr[i].t - t);
    if (d <= tol) best = Math.max(best, arr[i].s);
  }
  return best;
}

function allowedSubdiv(diff, energy) {
  if (energy >= 1) return diff.subdivHigh;
  if (energy >= 0.5) return diff.subdivMid;
  return diff.subdivLow;
}

/** 手区：0=左半 1=右半 */
function handRegion(lane, keyCount) {
  return lane < keyCount / 2 ? 0 : 1;
}

// ============================================================
// 键型实现
// ============================================================

/** 流动：单键自然流（同轨避让 + 邻轨/换手偏好） */
function assignFlow(ctx) {
  const { rng, mslots, keyCount, diff, prevLane } = ctx;
  const notes = [];
  const lastT = new Array(keyCount).fill(-10);
  let pl = prevLane;
  for (const s of mslots) {
    const cands = [];
    for (let l = 0; l < keyCount; l++) {
      if (s.t - lastT[l] < diff.sameLaneMinGap) continue;
      let w = 1;
      if (l === pl) w *= 0.3;
      else if (pl >= 0 && Math.abs(pl - l) === 1) w *= 1.4;
      if (pl >= 0 && handRegion(l, keyCount) !== handRegion(pl, keyCount)) w *= 1.2;
      cands.push({ v: l, w });
    }
    if (!cands.length) {
      for (let l = 0; l < keyCount; l++) {
        if (s.t - lastT[l] >= HARD_MIN_GAP) cands.push({ v: l, w: 1 });
      }
      if (!cands.length) continue;
    }
    const l = rng.weighted(cands);
    notes.push({ t: s.t, lane: l });
    lastT[l] = s.t;
    pl = l;
  }
  return notes;
}

/** 楼梯：折返阶梯 0-1-2-3-2-1-0…（起始方向随机；measure 已对齐小节） */
function assignStair(ctx) {
  const { rng, mslots, keyCount } = ctx;
  if (mslots.length < 3) return assignFlow(ctx);
  let dir = rng.chance(0.5) ? 1 : -1;
  let lane = dir === 1 ? 0 : keyCount - 1;
  const notes = [];
  for (const s of mslots) {
    notes.push({ t: s.t, lane });
    if (dir === 1 && lane === keyCount - 1) dir = -1;
    else if (dir === -1 && lane === 0) dir = 1;
    lane += dir;
  }
  return notes;
}

/** 交互：左右交替落点（相邻对为主，跨手对为辅） */
function assignTrill(ctx) {
  const { rng, mslots, keyCount } = ctx;
  if (mslots.length < 3) return assignFlow(ctx);
  const pairs = keyCount === 4
    ? [
        { v: [1, 2], w: 3.0 }, { v: [0, 2], w: 1.2 }, { v: [1, 3], w: 1.2 },
        { v: [0, 3], w: 0.7 }, { v: [0, 1], w: 0.4 }, { v: [2, 3], w: 0.4 },
      ]
    : [
        { v: [2, 3], w: 3.0 }, { v: [1, 4], w: 1.5 }, { v: [0, 5], w: 1.0 },
        { v: [2, 4], w: 0.8 }, { v: [1, 3], w: 0.8 },
      ];
  const pair = rng.weighted(pairs);
  const start = rng.int(0, 1);
  return mslots.map((s, i) => ({ t: s.t, lane: pair[(i + start) % 2] }));
}

/** 纵连：同轨连续 2~N 键（放在间隔足够的连续段上），其余位置流动填充 */
function assignJack(ctx) {
  const { rng, mslots, keyCount, diff, prevLane } = ctx;
  if (mslots.length < 2) return assignFlow(ctx);
  const need = Math.max(HARD_MIN_GAP + 0.01, diff.sameLaneMinGap);
  let bestStart = 0, bestLen = 1, curStart = 0, curLen = 1;
  for (let i = 1; i < mslots.length; i++) {
    if (mslots[i].t - mslots[i - 1].t >= need) curLen++;
    else { curStart = i; curLen = 1; }
    if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
  }
  if (bestLen < 2) return assignFlow(ctx);
  const run = Math.min(bestLen, rng.int(2, Math.max(2, diff.jackMaxRun)));
  const j0 = bestStart + rng.int(0, bestLen - run);
  const cands = [];
  for (let l = 0; l < keyCount; l++) if (l !== prevLane) cands.push(l);
  const lane = rng.pick(cands.length ? cands : [0]);
  const jackTimes = new Set(mslots.slice(j0, j0 + run).map((s) => s.t));

  const notes = [];
  const lastT = new Array(keyCount).fill(-10);
  let pl = prevLane;
  for (let i = j0; i < j0 + run; i++) {
    notes.push({ t: mslots[i].t, lane });
    lastT[lane] = mslots[i].t;
  }
  for (const s of mslots) {
    if (jackTimes.has(s.t)) continue;
    const fc = [];
    for (let l = 0; l < keyCount; l++) {
      if (s.t - lastT[l] < diff.sameLaneMinGap) continue;
      let w = 1;
      if (l === pl) w *= 0.3;
      else if (pl >= 0 && Math.abs(pl - l) === 1) w *= 1.4;
      if (w > 0) fc.push({ v: l, w });
    }
    if (!fc.length) continue;
    const l = rng.weighted(fc);
    notes.push({ t: s.t, lane: l });
    lastT[l] = s.t;
    pl = l;
  }
  notes.sort((a, b) => a.t - b.t);
  return notes;
}

/** 多压：流动分配后，在最强锚点（kick 命中 > 小节头 > 强度）加对称双押 */
function assignChord(ctx) {
  const { mslots, keyCount, diff, rich } = ctx;
  const notes = assignFlow(ctx);
  if (!notes.length || diff.maxSimul < 2) return notes;
  // 选双押锚点
  let best = null;
  for (const n of notes) {
    const s = mslots.find((x) => x.t === n.t);
    if (!s) continue;
    const score = (s.hasKick ? 1.3 + (s.kickS || 0) * 0.5 : 0)
      + (rich && s.posInBar === 0 ? 0.4 : 0)
      + (s.onBeat ? 0.35 : 0)
      + s.strength * 0.6;
    if (!best || score > best.score) best = { n, s, score };
  }
  if (!best) return notes;
  // v1.3.1 回退：kick 只是加成不是硬门槛——无 kick 时降回强度判定，
  // 避免真实歌 kick 检测不稳导致重音段整段不出双押
  if (rich && !best.s.hasKick && best.s.strength < 0.28) return notes;
  if (!rich && best.s.strength < 0.28) return notes;
  const partner = keyCount - 1 - best.n.lane;   // 对称组合 0+3 / 1+2
  const t = best.n.t;
  let ok = true;
  for (const n of notes) {
    if (n.lane === partner && Math.abs(n.t - t) < diff.sameLaneMinGap + 0.02) ok = false;
  }
  if (ok) {
    notes.push({ t, lane: partner });
    notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
  }
  return notes;
}

/** 散打：4 键基础序列 + 左右镜像，周期重复（measure 已对齐小节） */
function assignMirror(ctx) {
  const { rng, mslots, keyCount } = ctx;
  if (mslots.length < 5) return assignFlow(ctx);
  const perm = Array.from({ length: keyCount }, (_, i) => i);
  for (let i = perm.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let tries = 0; tries < 4 && keyCount - 1 - perm[0] === perm[perm.length - 1]; tries++) {
    [perm[0], perm[1]] = [perm[1], perm[0]];
  }
  const seq = [...perm, ...perm.map((l) => keyCount - 1 - l)];
  return mslots.map((s, i) => ({ t: s.t, lane: seq[i % seq.length] }));
}

/** 急楼梯：密集区快速折返（仅 EX 高能量 + hihat 密集 measure） */
function assignRoll(ctx) {
  return assignStair(ctx);
}

// ---------- 键型库与选择 ----------

const PATTERN_LABELS = {
  flow: '流动', stair: '楼梯', trill: '交互', jack: '纵连',
  chord: '多压', mirror: '散打', roll: '急楼梯', repeat: '复现',
};
export { PATTERN_LABELS };

function patternAvailable(name, mslots, keyCount, beatSec) {
  const n = mslots.length;
  switch (name) {
    case 'stair': return n >= 3;
    case 'trill': return n >= 3;
    case 'mirror': return n >= 5;
    case 'jack': return n >= 2;
    case 'chord': return n >= 2;
    case 'roll': {
      if (n < 6) return false;
      let minGap = Infinity;
      for (let i = 1; i < n; i++) minGap = Math.min(minGap, mslots[i].t - mslots[i - 1].t);
      return minGap <= beatSec / 3 + 0.001;
    }
    default: return true;
  }
}

/**
 * 键型权重池（v1.8.1：v2/v3 回退分支删除，统一乐器感知路径）
 * @param m 乐器统计 {kickCount, snareCount, hihatCount}（v4 时代必有；缺字段按 0）
 * @param v4 事件驱动（{vs 人声活跃度 0-1, tonalD 和声 onset 密度 0-1}；旧数据 null）
 */
function patternPool(diffKey, energy, m, rich, v4) {
  const kickW = m.kickCount >= 1 ? 0.6 + Math.min(m.kickCount, 4) * 0.28 : 0.06;
  const trillW = Math.min(1.8, m.hihatCount * 0.22);
  const stairW = m.snareCount >= 2 ? 0.8 : 0;
  if (diffKey === 'E') {
    if (energy < 0.5) return [{ v: 'flow', w: 6 }, { v: 'stair', w: 1.5 }, { v: 'mirror', w: 1 }];
    return [{ v: 'flow', w: 5 }, { v: 'stair', w: 2 + stairW }, { v: 'mirror', w: 1.5 }];
  }
  if (diffKey === 'H') {
    if (energy < 0.5) return [{ v: 'flow', w: 4 }, { v: 'stair', w: 1.5 }, { v: 'mirror', w: 1 }, { v: 'trill', w: 0.8 + trillW * 0.4 }];
    if (energy < 1) return [{ v: 'flow', w: 3 }, { v: 'stair', w: 2 + stairW }, { v: 'trill', w: 2 + trillW }, { v: 'mirror', w: 1.5 }, { v: 'chord', w: kickW * 0.9 }, { v: 'jack', w: 0.5 }];
    return [{ v: 'flow', w: 2 }, { v: 'stair', w: 2 + stairW }, { v: 'trill', w: 2.5 + trillW }, { v: 'mirror', w: 1.5 }, { v: 'chord', w: kickW * 1.3 }, { v: 'jack', w: 0.8 }];
  }
  // EX
  if (energy < 0.5) return [{ v: 'flow', w: 3 }, { v: 'stair', w: 1.5 }, { v: 'mirror', w: 1 }, { v: 'trill', w: 1 + trillW * 0.5 }];
  if (energy < 1) return [{ v: 'flow', w: 2 }, { v: 'stair', w: 2 + stairW }, { v: 'trill', w: 2.5 + trillW }, { v: 'mirror', w: 2 }, { v: 'chord', w: kickW * 1.2 }, { v: 'jack', w: 1 }];
  return [
    { v: 'flow', w: 1.5 }, { v: 'stair', w: 2 + stairW }, { v: 'trill', w: 2.5 + trillW },
    { v: 'mirror', w: 2 }, { v: 'chord', w: kickW * 1.6 }, { v: 'jack', w: 1.5 },
    { v: 'roll', w: m.hihatCount >= 6 ? 1.5 : 0 },
  ];
}

const ASSIGNERS = {
  flow: assignFlow, stair: assignStair, trill: assignTrill,
  jack: assignJack, chord: assignChord, mirror: assignMirror, roll: assignRoll,
};

// ============================================================
// hold 转换（单侧约束 + 乐器感知）
// ============================================================

/**
 * hold 转换（乐器感知）。
 * v1.7.1：长键可与其他音符并列（对齐主流 4K 音游）：
 *   - 删除旧 hasSimul 跳过（凡与任何音符同刻 ±12ms 的 tap 一律不转 hold →
 *     多压成员永远成不了长键）；
 *   - 全局“同一时刻最多一个 hold”约束改为【同轨】约束：跨轨 hold 可并存
 *     （含同刻 hold+hold 双押），同轨 hold 存续期间禁新 hold、尾巴不得压
 *     同轨后续 hold 的头；同刻数量仍由 validateAndFix 的 maxSimul 管住。
 * 保留不变：hold 期间同手区 tap 截短（单侧可玩性护栏）、同轨 min-gap、
 * sustain 窗口概率提升、kick 落点偏好 tap、用户 holdBoost。
 * v3：sustain 窗口内概率 ×2.4（和声持续 → 长键），kick 命中 ×0.5（重拍出 tap）。
 */
function convertHolds(notes, diff, keyCount, durationSec, rng, holdCtx) {
  const sorted = notes.map((n) => ({ ...n })).sort((a, b) => a.t - b.t);
  const half = keyCount / 2;
  const regionOf = (l) => (l < half ? 0 : 1);
  const held = []; // { start, end, lane }
  const { sustainWindows, kickTimes, holdBoostRanges } = holdCtx;

  const insideSustain = (t) => {
    if (!sustainWindows || !sustainWindows.length) return false;
    for (const w of sustainWindows) {
      if (t >= w.start - 0.05 && t <= w.end) return true;
    }
    return false;
  };
  const nearKick = (t) => kickTimes && onsetNear(kickTimes.map((k) => ({ t: k, s: 1 })), t, 0.05) > 0;
  const inHoldBoost = (t) => {
    if (!holdBoostRanges || !holdBoostRanges.length) return false;
    for (const r of holdBoostRanges) {
      if (t >= r.start && t < r.end) return true;
    }
    return false;
  };

  // v1.7.1：抽成内部函数以支持“同刻对称伙伴伴生转换”——多压对一端转长键后，
  // 另一端以伴生概率跟进转长键（双长键并列，主流 4K 音游标准手法）。
  const tryConvert = (n, pBase, opts) => {
    let p = pBase != null ? pBase : diff.holdProb;
    if (insideSustain(n.t)) p *= 2.4;
    // kick 落点偏好 tap（保持每档 hold 数量合理）；伴生转换是有意设计，
    // 不受 kick 抑制（多压锚点本就是 kick 命中，双重压制会让双长键几乎不可能）
    if (nearKick(n.t) && !(opts && opts.noKickPenalty)) p *= 0.5;
    if (inHoldBoost(n.t)) p = Math.max(p, 0.85); // 用户指定“长按”区：高概率转 hold
    if (p > 1) p = 1;
    if (!rng.chance(p)) return false;

    let nextSame = durationSec;
    for (const x of sorted) {
      if (x.lane === n.lane && x.t > n.t + 0.001) { nextSame = x.t; break; }
    }
    let maxDur = Math.min(diff.holdMaxDur, nextSame - n.t - diff.sameLaneMinGap - 0.02, durationSec - n.t);

    // v1.7.1：仅同轨约束（跨轨 hold 可并存；同轨 hold 不得交叠、尾不压后续同轨 hold 头）
    for (const h of held) {
      if (h.lane !== n.lane) continue;
      if (n.t < h.start) maxDur = Math.min(maxDur, h.start - n.t - 0.06);
      else if (n.t < h.end) maxDur = 0;
    }

    // 单侧约束：窗口内同手区 tap 会把 hold 截短（可玩性护栏，保留）
    for (const x of sorted) {
      if (x === n) continue;
      if (x.t > n.t + 0.012 && x.t < n.t + maxDur) {
        if (regionOf(x.lane) === regionOf(n.lane)) {
          maxDur = x.t - n.t - 0.05;
        }
      }
    }

    if (maxDur < diff.holdMinDur) return false;
    const dur = diff.holdMinDur + rng.next() * (maxDur - diff.holdMinDur);
    n.type = 'hold';
    n.d = +dur.toFixed(4);
    held.push({ start: n.t, end: n.t + dur, lane: n.lane });
    return true;
  };

  for (const n of sorted) {
    if (n.type === 'hold') continue;
    const ok = tryConvert(n);
    if (ok) {
      // 伴生：找同刻（±12ms）跨轨短音伙伴（多压对称对 0+3 / 1+2；短音 type 为
      // undefined 而非 'tap'——assign* 生成的 note 只在转 hold 时才写 type）
      // 有意设计双长键：0.75 概率同步转长键且不受 kick 抑制（失败时保持 hold+tap 并列）
      for (const x of sorted) {
        if (x === n || x.type === 'hold') continue;
        if (Math.abs(x.t - n.t) < 0.012 && x.lane !== n.lane) {
          tryConvert(x, 0.75, { noKickPenalty: true });
          break;
        }
      }
    }
  }
  return sorted;
}

// ============================================================
// 主生成函数
// ============================================================

export function generateChart(analysis, diffKey, seed, keyCount, hints) {
  const diff = DIFFICULTIES[diffKey];
  const rng = makeRng(seed);
  const { beats, onsets, segments, durationSec, bpm } = analysis;
  const beatSec = 60 / bpm;

  // v1.7.1：落谱区间 = 实际有声区间（头/尾静音不落谱）。旧分析无字段自动回退全曲。
  // audioEnd 需比 audioStart 长出足够余量才生效（防异常数据把谱面剪没）。
  const audioStart = Number.isFinite(analysis.audioStart) && analysis.audioStart > 0.2 ? analysis.audioStart : 0;
  const audioEnd = (Number.isFinite(analysis.audioEnd) && analysis.audioEnd > audioStart + 4)
    ? analysis.audioEnd : durationSec;

  // 用户微调（音乐轴编辑器）
  const hintsEnergy = hints && Array.isArray(hints.energy) ? hints.energy : null;
  const patternHints = hints && Array.isArray(hints.patternHints) ? hints.patternHints : null;
  const repeatMirror = !!(hints && hints.repeatMirror); // v1.3.1：重复段复现默认关，用户显式开启
  const holdBoostRanges = patternHints
    ? patternHints.filter((p) => p.pattern === 'hold')
    : [];

  // v3 乐器感知（旧分析自动回退 v2）
  // v1.8.1：v2/v3 回退路径删除——drumKicks/barGrid/meter 等字段级容错直读
  //（v4 分析必有；测试/异常数据缺字段时按默认值安全降级，不再切换行为分支）
  const rich = !!(analysis.drumKicks && analysis.barGrid);
  const meter = analysis.meter || 4;
  const dbp = analysis.downbeatPhase || 0;
  const tatum = analysis.tatum || 4;
  const kicks = Array.isArray(analysis.drumKicks) ? analysis.drumKicks : null;
  const snares = Array.isArray(analysis.drumSnares) ? analysis.drumSnares : null;
  const hihats = Array.isArray(analysis.drumHihats) ? analysis.drumHihats : null;
  const sustainWindows = Array.isArray(analysis.tonalSustains) ? analysis.tonalSustains : null;
  const kickTimes = kicks ? kicks.map((o) => o.t) : null;
  const repeats = Array.isArray(analysis.repeats) ? analysis.repeats : [];
  const barGrid = Array.isArray(analysis.barGrid) ? analysis.barGrid : null;
  // v1.8.0：v4 事件层（人声/结构）；v3 的 tonalOnsets 此前检测了但从未接入——一并接入
  const vocalOnsets = Array.isArray(analysis.vocalOnsets) ? analysis.vocalOnsets : null;
  const tonalOnsets = Array.isArray(analysis.tonalOnsets) ? analysis.tonalOnsets : null;

  // ---- 1. slot 骨架（乐器标记 + 小节相位；v1.3.1：tatum 仅在四分音符歌封顶） ----
  let slots = [];
  for (let b = 0; b < beats.length; b++) {
    const bt = beats[b];
    if (bt > audioEnd - 0.5) break;
    const energy = energyAt(segments, bt, 0.5, hintsEnergy);
    let subdiv = allowedSubdiv(diff, energy);
    if (rich && tatum === 1) subdiv = 1; // 回退：只在歌确实只有四分音符时才限四分；八分/十六分不封顶（防误判压稀谱面）
    for (let k = 0; k < subdiv; k++) {
      const t = bt + (k / subdiv) * beatSec;
      if (t < audioStart + 0.1 || t > audioEnd - 0.15) continue;
      const onBeat = k === 0;
      // v1.8.0：槽位分层——beat/eighth 为主位（吸附微调对齐音乐事件），
      // sixteenth 为加花位（保持纯网格，不被吸附拉偏）。
      // k*2===subdiv 判八分位：subdiv=4 时 k=2 才是反拍八分（k=1/3 为十六分）
      const sub = onBeat ? 'beat' : (k * 2 === subdiv ? 'eighth' : 'sixteenth');
      const os = onsetStrengthAt(onsets, t);
      const strength = os * 0.62 + (onBeat ? 0.26 : 0.06) + energy * 0.12;
      const kickS = kicks ? onsetNear(kicks, t, 0.05) : 0;
      const snareS = snares ? onsetNear(snares, t, 0.05) : 0;
      const hihatS = hihats ? onsetNear(hihats, t, 0.04) : 0;
      const posInBar = ((b - dbp) % meter + meter) % meter;
      slots.push({
        t, strength, onBeat, energy, beatIdx: b,
        posInBar, sub,
        hasKick: kickS > 0, kickS,
        hasSnare: snareS > 0, snareS,
        hasHihat: hihatS > 0, hihatS,
      });
    }
  }
  if (!slots.length) return { seed, notes: [], stats: { noteCount: 0, holdCount: 0, density: 0, patternCounts: {} } };

  // ---- 1.5 落点吸附（v1.8.0：DDC OnsetNet 的规则近似） ----
  // slot 时间向 ±60ms 内最强 onset 微调（onset 源 = 全带 + 人声 + 和声）。
  // 网格先验保持：仅强 onset（s>0.3）才吸、同 beat 内吸附后重叠的槽丢弱者——
  // 谱面可读性（小节结构）不被破坏，但落点与实际音乐事件对齐更准。
  // E 档不吸附：新手档规整网格优先（难度分层设计）。
  if (diffKey !== 'E') {
    const snapPool = [];
    for (const o of onsets) if (o.s > 0.3) snapPool.push(o);
    if (vocalOnsets) for (const o of vocalOnsets) if (o.s > 0.3) snapPool.push(o);
    if (tonalOnsets) for (const o of tonalOnsets) if (o.s > 0.3) snapPool.push(o);
    snapPool.sort((a, b) => a.t - b.t);
    if (snapPool.length >= 3) {
      const SNAP = 0.04; // 吸附幅度 40ms（网格↔onset 典型偏差 20-40ms；大幅吸附反损精度）
      const byBeat = new Map();
      for (const s of slots) {
        if (s.sub === 'sixteenth') { // 加花位不吸附（保网格）
          if (!byBeat.has(s.beatIdx)) byBeat.set(s.beatIdx, []);
          byBeat.get(s.beatIdx).push(s);
          continue;
        }
        // 二分定位邻近区间，向两侧扩展找区间内最强
        let lo = 0, hi = snapPool.length - 1, best = null;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (Math.abs(snapPool[mid].t - s.t) <= SNAP) {
            best = snapPool[mid];
            let l = mid - 1, r = mid + 1;
            while (l >= 0 && Math.abs(snapPool[l].t - s.t) <= SNAP) { if (snapPool[l].s > best.s) best = snapPool[l]; l--; }
            while (r < snapPool.length && Math.abs(snapPool[r].t - s.t) <= SNAP) { if (snapPool[r].s > best.s) best = snapPool[r]; r++; }
            break;
          }
          if (snapPool[mid].t < s.t) lo = mid + 1; else hi = mid - 1;
        }
        const ns = best ? { ...s, t: +best.t.toFixed(4) } : s;
        if (!byBeat.has(s.beatIdx)) byBeat.set(s.beatIdx, []);
        byBeat.get(s.beatIdx).push(ns);
      }
      // 同 beat 内吸附重叠去重（相邻槽时间差 < 半个细分步长 → 丢弱）
      const deduped = [];
      for (const [, group] of byBeat) {
        group.sort((a, b) => a.t - b.t || b.strength - a.strength);
        for (let i = 0; i < group.length; i++) {
          const nxt = group[i + 1];
          if (nxt && nxt.t - group[i].t < beatSec / (tatum * 2)) continue; // 吸附重叠除弱
          deduped.push(group[i]);
        }
      }
      if (deduped.length) slots = deduped.sort((a, b) => a.t - b.t);
    }
  }

  // ---- 2. 密度控制采样（v1.4.0：分窗配额，消灭段落级空白） ----
  // 旧算法：全部 slot 按全局 strength 排序取 top-N。onset 强度按全曲峰值
  // 归一化后随段落能量系统性漂移（安静段普遍偏低），top-N 会把 note 全部
  // 堆进强段、掏空白段（实测 3.5 分钟的歌某 10s 窗口只剩 1 个 note）。
  // 新算法：时间分窗 → 每窗按 duration×density 分配配额（energy 加权
  // 0.65~1.5，归一化保证总和 = targetN；安静段仍保底配额永不留白，
  // 响亮段/手动高能量段最多 2.3 倍密度差）→ 窗内按 strength 降序取配额
  // （局部强拍优先，保留音乐性）→ 落选者进全局池按分数补齐。全局密度均匀。
  const targetN = Math.max(8, Math.round(durationSec * diff.density));
  const globalMinGap = diff.key === 'EX' ? 0.075 : diff.key === 'H' ? 0.115 : 0.21;
  const WIN_SEC = 8;
  const scored = slots.map((s) => ({ s, k: s.strength * (0.55 + rng.next() * 0.45) }));

  // 按时间分窗（无 slot 的静音窗不参与配额）
  const nWin = Math.max(1, Math.ceil(durationSec / WIN_SEC));
  const winSlots = Array.from({ length: nWin }, () => []);
  for (const it of scored) winSlots[Math.min(nWin - 1, Math.floor(it.s.t / WIN_SEC))].push(it);
  const activeWins = [];
  for (let w = 0; w < nWin; w++) if (winSlots[w].length) activeWins.push(w);

  // 配额计算：targetN × 能量权重 / 权重和，最大余数法取整
  const winQuota = new Array(nWin).fill(0);
  if (activeWins.length) {
    const wSum = activeWins.reduce((acc, w) => {
      const avgE = winSlots[w].reduce((x, y) => x + y.s.energy, 0) / winSlots[w].length;
      return acc + 0.65 + 0.85 * Math.min(1, Math.max(0, avgE));
    }, 0);
    const exact = activeWins.map((w) => {
      const avgE = winSlots[w].reduce((x, y) => x + y.s.energy, 0) / winSlots[w].length;
      return (targetN * (0.65 + 0.85 * Math.min(1, Math.max(0, avgE)))) / wSum;
    });
    const base = exact.map(Math.floor);
    let rem = targetN - base.reduce((a, b) => a + b, 0);
    const order = exact
      .map((e, i) => ({ i, f: e - Math.floor(e) }))
      .sort((a, b) => b.f - a.f);
    for (let j = 0; rem > 0 && j < order.length; j++) { base[order[j].i]++; rem--; }
    activeWins.forEach((w, idx) => { winQuota[w] = Math.min(base[idx], winSlots[w].length); });
  }

  // 逐窗选取（窗内按分数降序）+ 全局 min-gap；落选者进补选池
  const chosen = [];
  const leftovers = [];
  const okGap = (t) => {
    for (const c of chosen) {
      const d = Math.abs(t - c.t);
      if (d > 0.001 && d < globalMinGap) return false;
    }
    return true;
  };
  for (const w of activeWins) {
    const ranked = [...winSlots[w]].sort((a, b) => b.k - a.k);
    let took = 0;
    for (const it of ranked) {
      if (took < winQuota[w] && okGap(it.s.t)) { chosen.push(it.s); took++; }
      else leftovers.push(it);
    }
  }
  // 补选池按分数补齐到 targetN（配额受 min-gap/槽位不足影响的残余）
  leftovers.sort((a, b) => b.k - a.k);
  for (const it of leftovers) {
    if (chosen.length >= targetN) break;
    if (okGap(it.s.t)) chosen.push(it.s);
  }
  chosen.sort((a, b) => a.t - b.t);

  // ---- 3. 按小节分组（barGrid 对齐） ----
  const measures = new Map();
  for (const s of chosen) {
    const mi = Math.floor((s.beatIdx - dbp) / meter);
    if (!measures.has(mi)) measures.set(mi, []);
    measures.get(mi).push(s);
  }

  // ---- 4. 每 measure 选键型并实例化 ----
  // v1.4.0：不再跳过重复段目标小节。旧逻辑（跳过+复现）存在链式依赖失败：
  // 当复现源段自身也是被跳过的目标段时 srcNotes 为空，目标小节永久留白
  // （即"前 10 秒正常后续全空"事故的机制）。现在所有小节正常生成，
  // 复现阶段用累积结果覆盖目标窗口，失败时保留独立生成内容，永不留白。
  let prevLane = -1;
  let prevPattern = null; // v1.8.0：measure 间键型连贯性（DDC n-gram 思想的规则版）
  const notes = [];
  const patternCounts = {};
  // v1.8.0：measure 级人声活跃度/和声 onset 密度（事件分层驱动键型）
  const measureVocal = (t0, t1) => {
    if (!vocalOnsets) return 0;
    let cnt = 0;
    for (const o of vocalOnsets) if (o.t >= t0 && o.t < t1) cnt++;
    return Math.min(1, cnt / Math.max(1, (t1 - t0) / beatSec * 0.5)); // 每 2 拍 1 个 onset ≈ 满活跃
  };
  const measureTonal = (t0, t1) => {
    if (!tonalOnsets) return 0;
    let cnt = 0;
    for (const o of tonalOnsets) if (o.t >= t0 && o.t < t1) cnt++;
    return Math.min(1, cnt / Math.max(1, (t1 - t0) / (beatSec * 4))); // 每小节 1 次和声变化 ≈ 满密度
  };
  // 键型相容性（同型延续×1.2 / 相关×1.0 / 跳变×0.8，消除 measure 间生硬切换）
  const PATTERN_RELATED = {
    flow: ['mirror', 'stair'], stair: ['flow', 'trill'],
    trill: ['stair', 'jack', 'roll'], jack: ['trill', 'chord'],
    chord: ['jack'], mirror: ['flow'], roll: ['trill', 'stair'],
  };
  const patternCompat = (name) => {
    if (!prevPattern) return 1;
    if (prevPattern === name) return 1.2;
    if ((PATTERN_RELATED[prevPattern] || []).includes(name)) return 1.0;
    return 0.8;
  };
  for (const [mi, mslots] of [...measures.entries()].sort((a, b) => a[0] - b[0])) {
    const energy = mslots.reduce((s, x) => s + x.energy, 0) / mslots.length;
    const m = {
      kickCount: mslots.reduce((s, x) => s + (x.hasKick ? 1 : 0), 0),
      snareCount: mslots.reduce((s, x) => s + (x.hasSnare ? 1 : 0), 0),
      hihatCount: mslots.reduce((s, x) => s + (x.hasHihat ? 1 : 0), 0),
    };
    let pname;
    // 用户键型偏好（音乐轴）：该 measure 起点命中 hint 范围 → 强制键型
    if (patternHints && mslots.length) {
      const midT = mslots[0].t;
      let forced = null;
      for (const ph of patternHints) {
        if (midT >= ph.start && midT < ph.end) { forced = ph.pattern; break; }
      }
      if (forced && forced !== 'hold' && forced !== 'auto' && ASSIGNERS[forced]
        && patternAvailable(forced, mslots, keyCount, beatSec)) {
        pname = forced;
      }
    }
    if (!pname) {
      const mT0 = mslots[0].t;
      const mT1 = mT0 + beatSec * meter;
      const v4ctx = (vocalOnsets || tonalOnsets)
        ? { vs: measureVocal(mT0, mT1), tonalD: measureTonal(mT0, mT1) }
        : null;
      const pool = patternPool(diff.key, energy, m, rich, v4ctx)
        .filter((p) => p.w > 0 && patternAvailable(p.v, mslots, keyCount, beatSec))
        .map((p) => ({ v: p.v, w: p.w * patternCompat(p.v) })); // v1.8.0：连贯性权重
      const usable = pool.length ? pool : [{ v: 'flow', w: 1 }];
      pname = rng.weighted(usable);
    }
    const ctx = { rng, mslots, keyCount, diff, prevLane, beatSec, rich };
    const mnotes = ASSIGNERS[pname](ctx);
    for (const n of mnotes) notes.push(n);
    if (mnotes.length) prevLane = mnotes[mnotes.length - 1].lane;
    prevPattern = pname;
    patternCounts[pname] = (patternCounts[pname] || 0) + 1;
  }

  // ---- 5. hold 转换（单侧约束 + sustain/kick/用户 holdBoost 感知） ----
  const withHolds = convertHolds(notes, diff, keyCount, audioEnd, rng, { sustainWindows, kickTimes, holdBoostRanges });

  // ---- 5.5 重复段复现（v1.3.1 默认关；音乐轴 repeatMirror 开启后：副歌再现手感相同） ----
  // v1.4.0：按 dstBar 升序处理，源段从累积 finalNotes 读取（链式复现可用）；
  // 源段无内容时跳过覆盖，目标窗口保留独立生成内容，不会留白。
  let finalNotes = withHolds;
  if (repeatMirror && repeats.length && barGrid) {
    finalNotes = [...withHolds];
    const orderedRepeats = [...repeats]
      .filter((r) => r.srcBar + r.bars <= barGrid.length && r.dstBar + r.bars <= barGrid.length)
      .sort((a, b) => a.dstBar - b.dstBar);
    for (const r of orderedRepeats) {
      const delta = barGrid[r.dstBar] - barGrid[r.srcBar];
      const winDur = r.bars * meter * beatSec;
      const srcT0 = barGrid[r.srcBar];
      const dstT0 = barGrid[r.dstBar];
      const dstT1 = dstT0 + winDur;
      // 源段 note（含 hold；从累积结果读，链式复现已复制的内容也能作源）
      const srcNotes = finalNotes.filter((n) => n.t >= srcT0 - 1e-6 && n.t < srcT0 + winDur - 1e-6);
      if (!srcNotes.length) continue; // 源段无内容：保留目标段独立生成，不留空白
      // 清掉目标窗口已有 note（被复现内容覆盖）
      finalNotes = finalNotes.filter((n) => !(n.t >= dstT0 - 1e-6 && n.t < dstT1 - 1e-6));
      // 镜像与否由 seed 决定（可复现）
      const mirror = rng.chance(0.5);
      for (const n of srcNotes) {
        finalNotes.push({
          t: +(n.t + delta).toFixed(4),
          lane: mirror ? keyCount - 1 - n.lane : n.lane,
          type: n.type,
          ...(n.d ? { d: n.d } : {}),
        });
      }
      patternCounts.repeat = (patternCounts.repeat || 0) + r.bars;
    }
    // 安全：去同时段【同轨】交叠双 hold（拷贝可能引入；v1.7.1 跨轨交叠为合法并列不再降级）
    const holds = finalNotes.filter((n) => n.type === 'hold').sort((a, b) => a.t - b.t);
    const demote = new Set();
    for (let i = 0; i < holds.length; i++) {
      if (demote.has(holds[i])) continue;
      for (let j = i + 1; j < holds.length; j++) {
        if (holds[j].t >= holds[i].t + (holds[i].d || 0)) break;
        if (holds[j].lane === holds[i].lane) demote.add(holds[j]);
      }
    }
    if (demote.size) {
      finalNotes = finalNotes.map((n) => (demote.has(n) ? { t: n.t, lane: n.lane, type: 'tap' } : n));
    }
    finalNotes.sort((a, b) => a.t - b.t);
  }

  // ---- 6. 人类可行性硬校验 ----
  const valid = validateAndFix(finalNotes, diff, keyCount, audioEnd);

  // ---- 7. 统计 ----
  const noteCount = valid.length;
  const holdCount = valid.filter((n) => n.type === 'hold').length;
  let maxSimulSeen = 1, run = 1;
  for (let i = 1; i < valid.length; i++) {
    if (Math.abs(valid[i].t - valid[i - 1].t) < 0.012) run++; else run = 1;
    maxSimulSeen = Math.max(maxSimulSeen, run);
  }
  return {
    seed,
    notes: valid,
    stats: {
      noteCount,
      holdCount,
      density: +(noteCount / Math.max(1, durationSec)).toFixed(2),
      maxSimul: maxSimulSeen,
      patternCounts,
      bpm,
      duration: +durationSec.toFixed(1),
    },
  };
}

// ============================================================
// 硬校验（防御性兜底：violation 直接删除）
// ============================================================

function validateAndFix(notes, diff, keyCount, durationSec) {
  const out = [];
  const lastTime = new Array(keyCount).fill(-10);
  const lastHoldEnd = new Array(keyCount).fill(-10);
  const sorted = notes.map((n) => ({ ...n })).sort((a, b) => a.t - b.t || a.lane - b.lane);
  const holdWindows = sorted
    .filter((n) => n.type === 'hold' && n.d)
    .map((n) => ({ start: n.t, end: n.t + n.d, lane: n.lane }));
  const half = keyCount / 2;
  const regionOf = (l) => (l < half ? 0 : 1);

  let groupStart = -1, groupLanes = [];
  const flushGroup = () => {
    for (const n of groupLanes) out.push(n);
    groupLanes = [];
  };

  for (const n of sorted) {
    const isSimul = groupStart >= 0 && Math.abs(n.t - groupStart) < 0.012;
    if (!isSimul) {
      flushGroup();
      groupStart = n.t;
    }
    if (isSimul && groupLanes.length >= diff.maxSimul) continue;

    // hold 单侧兜底：hold 窗口内同手区 tap 丢弃（保 hold）
    if (n.type !== 'hold') {
      const bad = holdWindows.some(
        (h) => n.t > h.start + 0.012 && n.t < h.end - 0.01 && regionOf(n.lane) === regionOf(h.lane)
      );
      if (bad) continue;
    }

    const lane = n.lane;
    const minGap = Math.max(HARD_MIN_GAP, Math.min(diff.sameLaneMinGap, 0.25));
    if (n.t - Math.max(lastTime[lane], lastHoldEnd[lane]) < minGap) continue;

    if (n.type === 'hold') {
      let d = n.d || 0;
      if (d < 0.18) { n.type = 'tap'; delete n.d; }
      else if (n.t + d > durationSec) {
        d = durationSec - n.t;
        if (d < 0.18) { n.type = 'tap'; delete n.d; }
        else n.d = +d.toFixed(4);
      }
    }
    groupLanes.push(n);
    lastTime[lane] = n.t;
    if (n.type === 'hold') lastHoldEnd[lane] = n.t + (n.d || 0);
  }
  flushGroup();
  return out;
}
