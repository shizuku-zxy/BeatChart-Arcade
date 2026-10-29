// ============ 谱面编辑纯函数（v1.7.0 保留段重抽；Node 可测） ============
//
// 用途：手录/导入的自定谱往往只有部分段落是精心录制的。保留段重抽 =
//   拖选一段时间段「保留」，段外用生成器按新 seed 重新生成，拼接处做冲突清理。
//
// 规则约定（与 chartgen 的 HARD_MIN_GAP 一致）：
//   - 保留优先：段内音符原样保留（hold 越过右界裁尾，裁剩 <0.18s 转短音）；
//   - 段内让位：生成音符头落在保留段内的一律丢弃；
//   - 左跨界 hold：尾裁到段起点（裁剩 <0.18s 丢弃）；
//   - 接缝清理：同轨上生成音符与保留音符头距 <0.105s、头落进保留 hold 体内、
//     或 hold 尾压到保留头 0.105s 内 → 丢弃/裁尾（保留侧永不动）。

import { DIFFICULTIES, DIFF_ORDER } from './constants.js';
import { generateChart } from './chartgen.js';

const HARD_MIN_GAP = 0.105; // 同轨头距绝对下限（秒）
const MIN_HOLD = 0.18;      // 裁剩低于此长度的 hold 视为无意义（转短音/丢弃）

/**
 * 长按期间同手区短键清理（v1.8.1b，用户规则：左手长按中左手不应有短键，右手同理）。
 * 与生成器 validateAndFix 同语义：hold 窗口 (start+0.012, end-0.01) 内同手区
 * （4 键：0/1 左手、2/3 右手）的短键丢弃；hold 头同刻的和弦（≤12ms）合法保留。
 * 用于导入谱面（osu 原谱常有此布局）与保留段重抽拼接输出。纯函数可单测。
 */
export function sanitizeHoldAdjacentTaps(notes, keyCount = 4) {
  const half = keyCount / 2;
  const regionOf = (l) => (l < half ? 0 : 1);
  const holds = (notes || []).filter((n) => n.type === 'hold' && n.d)
    .map((n) => ({ start: n.t, end: n.t + n.d, region: regionOf(n.lane) }));
  if (!holds.length) return notes || [];
  const out = [];
  let dropped = 0;
  for (const n of notes) {
    if (n.type !== 'hold') {
      const bad = holds.some((h) => n.t > h.start + 0.012 && n.t < h.end - 0.01
        && regionOf(n.lane) === h.region);
      if (bad) { dropped++; continue; }
    }
    out.push(n);
  }
  return dropped ? out : notes; // 无违规时原样返回（保持引用稳定）
}

function cleanNote(n) {
  if (n.type === 'hold') {
    return { t: +n.t.toFixed(3), lane: n.lane, type: 'hold', d: +Math.max(0.05, n.d).toFixed(3) };
  }
  return { t: +n.t.toFixed(3), lane: n.lane, type: 'tap' };
}

/** 按谱面密度（notes/秒）选最接近的生成档位（保留段重抽时决定段外密度） */
export function pickDiffForDensity(density) {
  let best = 'H';
  let bestD = Infinity;
  for (const dk of DIFF_ORDER) {
    const d = Math.abs(DIFFICULTIES[dk].density - density);
    if (d < bestD) { bestD = d; best = dk; }
  }
  return best;
}

/**
 * 保留段拼接：base 的 [keepStart, keepEnd] 段保留，其余用 genNotes 填充，
 * 接缝做同轨冲突清理。返回清洗后的新 note 数组（按时间排序）。
 * v1.8.1b：输出术尾过 sanitizeHoldAdjacentTaps（长按期间同手区短键清理）。
 */
export function mergeKeepSegment(baseNotes, genNotes, keepStart, keepEnd, keyCount = 4) {
  // ---- 1. 保留段 ----
  const kept = [];
  for (const n of baseNotes || []) {
    if (n.t < keepStart - 1e-4 || n.t > keepEnd + 1e-4) continue;
    if (n.type === 'hold') {
      const d = Math.min(n.d, keepEnd - n.t);
      kept.push(d >= MIN_HOLD
        ? { t: n.t, lane: n.lane, type: 'hold', d }
        : { t: n.t, lane: n.lane, type: 'tap' });
    } else {
      kept.push({ t: n.t, lane: n.lane, type: 'tap' });
    }
  }

  // ---- 2. 段外（来自生成谱） ----
  const outside = [];
  for (const n of genNotes || []) {
    if (n.t >= keepStart - 1e-4 && n.t <= keepEnd + 1e-4) continue; // 段内让位
    if (n.t > keepEnd + 1e-4) { outside.push(cleanNote(n)); continue; }
    // n.t < keepStart：看尾部是否跨进保留段
    const endT = n.t + (n.type === 'hold' ? n.d : 0);
    if (endT <= keepStart + 1e-4) { outside.push(cleanNote(n)); continue; }
    if (n.type === 'hold') {
      const d = keepStart - n.t;
      if (d >= MIN_HOLD) outside.push({ t: n.t, lane: n.lane, type: 'hold', d });
    }
    // 左跨界短音、裁剩过短的 hold：丢弃
  }

  // ---- 3. 接缝清理（保留侧优先） ----
  const merged = [...kept, ...outside].sort((x, y) => x.t - y.t);
  const keptSet = new Set(kept); // 保留条目为本函数新建对象，与 outside 无共享引用
  const result = [];
  for (const n of merged) {
    if (keptSet.has(n)) { result.push(n); continue; }
    let drop = false;
    for (const k of kept) {
      if (k.lane !== n.lane) continue;
      if (Math.abs(n.t - k.t) < HARD_MIN_GAP) { drop = true; break; }                    // 头距过近
      if (n.type === 'hold' && n.t < k.t) {                                              // 生成 hold 尾压保留头
        const endLimit = k.t - HARD_MIN_GAP;
        if (n.t + n.d > endLimit) {
          const d2 = endLimit - n.t;
          if (d2 < MIN_HOLD) { drop = true; break; }
          n.d = +d2.toFixed(3);
        }
      }
      if (k.type === 'hold' && n.t > k.t + 0.05 && n.t < k.t + k.d - 0.05) { drop = true; break; } // 头进保留 hold 体内
      if (k.type === 'hold' && n.t > k.t + k.d && n.t - (k.t + k.d) < HARD_MIN_GAP) { drop = true; break; } // 头紧贴保留 hold 尾后
    }
    if (!drop) result.push(n);
  }
  // v1.8.1b：长按期间同手区短键清理（底稿可能来自导入谱，带违规布局）
  return sanitizeHoldAdjacentTaps(result.map(cleanNote), keyCount);
}

/**
 * 保留段重抽一步到位：按 base 密度自动选档 → generateChart(新 seed) →
 * mergeKeepSegment 拼接。返回 { diffKey, seed, notes }。
 */
export function regenOutsideSegment(baseNotes, analysis, keyCount, hints, keepStart, keepEnd, seed) {
  const dur = Math.max(1, (analysis && analysis.durationSec) || 1);
  const density = (baseNotes || []).length / dur;
  const diffKey = pickDiffForDensity(density);
  const gen = generateChart(analysis, diffKey, seed, keyCount, hints);
  const notes = mergeKeepSegment(baseNotes, gen.notes, keepStart, keepEnd, keyCount);
  return { diffKey, seed: gen.seed, notes };
}
