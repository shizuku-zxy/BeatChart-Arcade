// ============ 旧歌库自动升级队列（v1.8.1） ============
// 应用启动 3 秒后自动后台扫描 version<4 的歌，串行逐首重跑 v4 分析并重生成
// 三档（seed 保留、旧谱入 history 可回退）。每首间隔 1 秒不抢占 UI/音频。
// 失败的歌记入 failed 集合（本次会话不再重试，下次启动再试）。
// 曲库页顶部显示进度。

import { getState, updateSong, loadAudioBlob } from './store.js';
import { decodeFile, analyzeBuffer } from './audio.js';
import { generateChart } from './chartgen.js';
import { DIFF_ORDER } from './constants.js';

const STATE = {
  running: false,
  queue: [],        // 待升级 songId 列表
  failed: new Set(),
  doneCount: 0,
  totalCount: 0,
  currentId: null,
  listeners: new Set(),
};

function notify() {
  const info = {
    running: STATE.running,
    pending: STATE.queue.length,
    doneCount: STATE.doneCount,
    totalCount: STATE.totalCount,
    currentId: STATE.currentId,
    failed: [...STATE.failed],
  };
  for (const fn of STATE.listeners) {
    try { fn(info); } catch (e) { /* noop */ }
  }
}

export function subscribeUpgrade(fn) {
  STATE.listeners.add(fn);
  return () => STATE.listeners.delete(fn);
}

export function getUpgradeInfo() {
  return {
    running: STATE.running,
    pending: STATE.queue.length,
    doneCount: STATE.doneCount,
    totalCount: STATE.totalCount,
    currentId: STATE.currentId,
    failed: [...STATE.failed],
  };
}

async function upgradeOne(song) {
  const blob = await loadAudioBlob(song.id, song.ext);
  if (!blob) throw new Error('找不到音频文件');
  const audioBuffer = await decodeFile(blob);
  const analysis = await analyzeBuffer(audioBuffer, () => {});
  const keyCount = song.keyCount || 4;
  const charts = {};
  for (const dk of DIFF_ORDER) {
    const old = song.charts[dk];
    const gen = generateChart(analysis, dk, old.seed, keyCount, song.hints);
    charts[dk] = {
      seed: old.seed,
      notes: gen.notes,
      stats: gen.stats,
      updatedAt: Date.now(),
      history: [...(old.history || []), { seed: old.seed, notes: old.notes, stats: old.stats }].slice(-12),
    };
  }
  updateSong(song.id, { analysis, charts, durationSec: +audioBuffer.duration.toFixed(2) });
}

async function runQueue() {
  STATE.running = true;
  notify();
  while (STATE.queue.length) {
    const id = STATE.queue.shift();
    const song = getState().library.songs[id];
    STATE.currentId = id;
    notify();
    if (song && (song.analysis.version || 3) < 4) {
      try {
        await upgradeOne(song);
        STATE.doneCount++;
      } catch (e) {
        STATE.failed.add(id);
      }
    } else {
      STATE.doneCount++; // 已是新版本（并发手动升级过）——计完成不重跑
    }
    STATE.currentId = null;
    notify();
    if (STATE.queue.length) await new Promise((r) => setTimeout(r, 1000));
  }
  STATE.running = false;
  notify();
}

/** 启动后调用：扫描并启动升级队列 */
export function startLibraryUpgrade(delayMs = 3000) {
  setTimeout(() => {
    if (STATE.running) return;
    const state = getState();
    const songs = (state && state.library && state.library.songs) || {};
    const stale = Object.values(songs)
      .filter((s) => s && s.analysis && (s.analysis.version || 3) < 4 && !STATE.failed.has(s.id))
      .map((s) => s.id);
    if (!stale.length) return;
    STATE.queue = stale;
    STATE.doneCount = 0;
    STATE.totalCount = stale.length;
    runQueue();
  }, delayMs);
}
