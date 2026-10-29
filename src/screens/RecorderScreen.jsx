// ============ 手动录入谱面页（v1.8.2 简化版） ============
// 设计原则（按用户反馈）：
//   - 只在录制 / 暂停两态：暂停即编辑，不再有独立「编辑模式」；
//   - 暂停后底部自动出现时间轴：拖动定位、点音符或时间轴标记删除；
//   - 底谱默认「仅参考」（灰色、不写入保存结果），也可选「一并录入」；
//   - 顶栏只保留暂停按钮；慢放/吸附/撤销/重录/清尾统一收进暂停菜单的「设置」；
//   - 底谱参考音符不参与保存，保存的谱面可以导出为 .osz 谱面包（与导入格式一致）。
//
// 录入时钟 = 游玩判定时钟（AudioContext + 音频输出延迟补偿 + 手动校准）。

import React, { useEffect, useRef, useState } from 'react';
import { getCtx, decodeFile, SongPlayer, getAudioOutLatency } from '../core/audio.js';
import { GameRenderer } from '../game/Renderer.js';
import { PerspectiveRenderer } from '../game/PerspectiveRenderer.js';
import { loadAudioBlob, updateSong } from '../core/store.js';
import { effectiveKeymap, KEY_LABELS, resolveRenderMode, isTouchDevice } from '../core/constants.js';
import { exportChartPackage } from '../core/exporters.js';

const HOLD_MIN = 0.18;      // 按住超过此秒数录成 hold
const SNAP_SUBDIV = 4;      // 吸附网格：十六分音符
const REPLACE_TOL = 0.15;   // 重录同轨同时刻替换容差（秒）
const REC_WINDOW = 0.02;    // 已过线隐藏裕量（秒）
const SPEEDS = [0.5, 0.75, 1];
const TL_H = 60;            // 底部时间轴画布高度（CSS px）

const LANE_COLORS = ['#6ec3ff', '#6ef7d8', '#ffd76e', '#ff7a9e', '#c3a3ff', '#7af0b0'];
const GRAY_CSS = '#5a6a80';

function fmtT(sec) {
  const m = Math.floor(Math.max(0, sec) / 60), s = Math.max(0, sec) % 60;
  return `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

/** 深拷贝谱面 note（剥离 state/gray 等运行时字段，原谱不动） */
function copyNotes(arr) {
  return (arr || []).map((n) => (n.type === 'hold'
    ? { t: n.t, lane: n.lane, type: 'hold', d: n.d }
    : { t: n.t, lane: n.lane, type: 'tap' }));
}

export default function RecorderScreen({ state, songId, navigate }) {
  const song = state.library.songs[songId];
  const settings = state.settings;
  const containerRef = useRef(null);
  const timelineRef = useRef(null);
  const G = useRef({}).current;

  const [phase, setPhase] = useState('loading'); // loading | start | ready | recording | paused | done | error
  const phaseRef = useRef('loading');
  const [count, setCount] = useState(0);
  const [holdCount, setHoldCount] = useState(0);
  const [snap, setSnap] = useState(true);
  const snapRef = useRef(true);
  const [rate, setRateState] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [baseMode, setBaseModeState] = useState('ref'); // ref | merge
  const baseModeRef = useRef('ref');
  const [baseInfo, setBaseInfo] = useState(null); // { label, mode, notes }
  const [recSettingsOpen, setRecSettingsOpen] = useState(false);
  const recSettingsRef = useRef(false);
  const [err, setErr] = useState(null);
  const [report, setReport] = useState(null);
  const [toast, setToast] = useState(null);

  const setPhaseSafe = (p) => { phaseRef.current = p; setPhase(p); };
  const setBaseMode = (m) => { baseModeRef.current = m; setBaseModeState(m); };
  const setRecSettings = (v) => { recSettingsRef.current = v; setRecSettingsOpen(v); };

  function flash(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  }

  useEffect(() => { snapRef.current = snap; }, [snap]);
  useEffect(() => { recSettingsRef.current = recSettingsOpen; }, [recSettingsOpen]);

  useEffect(() => {
    let disposed = false;
    const container = containerRef.current;
    const keyCount = song ? (song.keyCount || 4) : 4;
    const a = song ? song.analysis : null;
    const beat = a && a.bpm ? 60 / a.bpm : 0.5;
    const b0 = (a && a.beats && a.beats.length) ? a.beats[0] : 0;
    const step = beat / SNAP_SUBDIV;

    function snapT(t) {
      if (!snapRef.current) return Math.max(0, t);
      if (!a || !a.bpm || !a.beats || !a.beats.length) return Math.max(0, t);
      const k = Math.round((t - b0) / step);
      return Math.max(0, b0 + k * step);
    }
    G.snapT = snapT;
    G.a = a; G.b0 = b0; G.step = step; G.keyCount = keyCount;

    function refreshCounts() {
      setCount(G.notes.length);
      setHoldCount(G.notes.filter((x) => x.type === 'hold').length);
    }
    function markDirty() { G.dirty = true; setDirty(true); }
    function afterChange() { refreshCounts(); markDirty(); G.listDirty = true; }

    // ---- 撤销（录入/替换/删除/清尾都可回退） ----
    function pushUndo(entry) {
      G.undoStack.push(entry);
      if (G.undoStack.length > 300) G.undoStack.shift();
    }
    function insertNoteSorted(n) { G.notes.push(n); G.notes.sort((x, y) => x.t - y.t); }
    function removeNoteRef(n) {
      const i = G.notes.indexOf(n);
      if (i >= 0) G.notes.splice(i, 1);
    }
    function undo() {
      const e = G.undoStack.pop();
      if (!e) return;
      if (e.type === 'add') removeNoteRef(e.note);
      else if (e.type === 'replace') { removeNoteRef(e.newNote); insertNoteSorted(e.oldNote); }
      else if (e.type === 'delete') insertNoteSorted(e.note);
      else if (e.type === 'clearTail') G.notes = [...G.notes, ...e.removed].sort((x, y) => x.t - y.t);
      G.listDirty = true;
      afterChange();
    }
    G.undo = undo;

    function deleteNote(note) {
      const idx = G.notes.indexOf(note);
      if (idx < 0) return false;
      G.notes.splice(idx, 1);
      pushUndo({ type: 'delete', note });
      G.listDirty = true;
      afterChange();
      return true;
    }
    G.deleteNote = deleteNote;

    /** 录入音符：同轨同时刻（±REPLACE_TOL）已有 → 替换（回退重录核心） */
    function addRecordedNote(t, lane, type, d) {
      let replaced = null;
      let bestD = Infinity;
      for (const n of G.notes) {
        if (n.lane !== lane) continue;
        const dt = Math.abs(n.t - t);
        if (dt <= REPLACE_TOL && dt < bestD) { bestD = dt; replaced = n; }
      }
      const note = type === 'hold' ? { t, lane, type, d, confirmed: true } : { t, lane, type, confirmed: true };
      if (replaced) {
        removeNoteRef(replaced);
        insertNoteSorted(note);
        pushUndo({ type: 'replace', oldNote: replaced, newNote: note });
      } else {
        insertNoteSorted(note);
        pushUndo({ type: 'add', note });
      }
      afterChange();
    }

    async function boot() {
      try {
        const blob = await loadAudioBlob(song.id, song.ext);
        if (!blob) throw new Error('找不到音频文件，请重新导入该歌曲');
        if (disposed) return;
        const buffer = await decodeFile(blob);
        if (disposed) return;

        const player = new SongPlayer(buffer);
        player.setVolume(settings.volume);
        const keymap = effectiveKeymap(settings, keyCount);
        const keyLabels = keymap.map((c) => KEY_LABELS[c] || c.replace('Key', ''));
        const renderMode = resolveRenderMode(settings);
        const RendererCls = renderMode === 'persp' ? PerspectiveRenderer : GameRenderer;
        const renderer = new RendererCls(container, {
          keyCount, approach: 0.7, diffColor: 0xffd76e, keyLabels,
        });
        renderer.setInfo('录制 · ' + song.title, buffer.duration);
        if (renderer.setCleanHud) renderer.setCleanHud(true);
        if (renderer.setRhythm) {
          renderer.setRhythm(song.analysis.bpm, song.analysis.beats && song.analysis.beats[0] != null ? song.analysis.beats[0] : 0);
        }

        G.player = player;
        G.renderer = renderer;
        G.keymap = keymap;
        G.buffer = buffer;
        G.notes = [];
        G.baseNotes = [];
        G.baseLabel = null;
        G.baseMode = 'blank';
        G.pressed = new Array(keyCount).fill(null);       // lane -> { t0 }
        G.previewByLane = new Array(keyCount).fill(null); // lane -> 预览 hold note 对象（原地改 d）
        G.pointerLanes = new Map();
        G.undoStack = [];
        G.rewindT = null;      // 回退点：之后的音符标灰（保留待重录）
        G.lastList = null;     // 上次 loadNotes 的可见列表（变更检测）
        G.listDirty = true;
        G.scrubbing = false;
        G.scrubT = null;
        G.pausedReady = false;
        G.dirty = false;
        G.savedId = null;
        G.latencySec = getAudioOutLatency(getCtx())
          + (settings.latencyMs || 0) / 1000 + (settings.musicOffsetMs || 0) / 1000;
        renderer.loadNotes([]);

        function nowT() {
          return (G.latencySec == null ? G.player.time : G.player.time - G.latencySec);
        }
        G.nowT = nowT;

        // ---- 可见列表：录制时 = 当前音乐时间之后；暂停时 = 全部音符（避免拖动时反复重建） ----
        function buildVisible(curT) {
          const lead = G.renderer.leadTime || G.renderer.approach * 12;
          const winHi = curT + lead + 0.6;
          const list = [];
          for (const n of G.notes) {
            if (n.t > winHi) break;
            if (n.t < curT - REC_WINDOW) continue;
            n.gray = G.rewindT != null && !n.confirmed && n.t >= G.rewindT - 1e-4;
            list.push(n);
          }
          for (const n of G.baseNotes) {
            if (n.t > winHi) break;
            if (n.t < curT - REC_WINDOW) continue;
            n.gray = true;
            list.push(n);
          }
          for (let l = 0; l < keyCount; l++) if (G.previewByLane[l]) list.push(G.previewByLane[l]);
          return list;
        }
        function allNotesForPause() {
          const list = [...G.notes, ...G.baseNotes];
          list.sort((x, y) => x.t - y.t);
          for (const n of G.baseNotes) n.gray = true;
          return list;
        }
        function syncVisible(curT) {
          const list = buildVisible(curT);
          const last = G.lastList;
          let changed = G.listDirty || !last || last.length !== list.length;
          if (!changed) {
            for (let i = 0; i < list.length; i++) if (list[i] !== last[i]) { changed = true; break; }
          }
          if (changed) { G.renderer.loadNotes(list); G.lastList = list; G.listDirty = false; }
        }

        // ---- 键盘 / 触摸录入 ----
        function releaseLane(lane) {
          const p = G.pressed[lane];
          if (!p) return;
          G.pressed[lane] = null;
          const pv = G.previewByLane[lane];
          G.previewByLane[lane] = null;
          if (pv) G.listDirty = true;
          if (phaseRef.current !== 'recording') return;
          const t1 = nowT();
          if (t1 - p.t0 >= HOLD_MIN) {
            const st = +snapT(p.t0).toFixed(3);
            const en = +snapT(t1).toFixed(3);
            addRecordedNote(st, lane, 'hold', Math.max(HOLD_MIN, en - st));
          } else {
            addRecordedNote(+snapT(p.t0).toFixed(3), lane, 'tap');
          }
        }
        function releaseAllPressed() {
          for (let l = 0; l < keyCount; l++) if (G.pressed[l]) releaseLane(l);
          for (const id of [...G.pointerLanes.keys()]) G.pointerLanes.delete(id);
        }

        G.onKeyDown = (e) => {
          if (e.code === 'Escape') {
            e.preventDefault();
            if (recSettingsRef.current) { setRecSettings(false); return; }
            if (phaseRef.current === 'recording') pausePlayback();
            else if (phaseRef.current === 'paused') resumeRecording();
            return;
          }
          if (e.ctrlKey || e.metaKey) {
            if (e.code === 'KeyZ') { e.preventDefault(); undo(); }
            return;
          }
          if (e.repeat) return;
          const lane = G.keymap.indexOf(e.code);
          if (lane < 0) return;
          e.preventDefault();
          if (phaseRef.current !== 'recording') return;
          G.pressed[lane] = { t0: nowT() };
          const pv = { t: +snapT(G.pressed[lane].t0).toFixed(3), lane, type: 'hold', d: 0.05, confirmed: true };
          G.previewByLane[lane] = pv;
          G.listDirty = true;
          if (G.renderer.laneHit) G.renderer.laneHit(lane);
        };
        G.onKeyUp = (e) => {
          const lane = G.keymap.indexOf(e.code);
          if (lane < 0) return;
          releaseLane(lane);
        };
        window.addEventListener('keydown', G.onKeyDown);
        window.addEventListener('keyup', G.onKeyUp);

        // ---- 触摸/鼠标 ----
        G.onPointerDown = (e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          if (recSettingsRef.current) return;
          const rect = container.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;

          // 暂停 = 编辑：点音符删除（底谱参考音符不可删）
          if (phaseRef.current === 'paused') {
            e.preventDefault();
            const note = G.renderer && G.renderer.hitNote ? G.renderer.hitNote(x, y) : null;
            if (!note) return;
            if (G.notes.indexOf(note) >= 0) {
              if (deleteNote(note)) flash('已删除音符（Ctrl+Z 撤销）');
            } else {
              flash('底谱参考音符不可删除；需要编辑请选择「一并录入」');
            }
            return;
          }
          if (phaseRef.current !== 'recording') return;

          const lane = renderer.hitTest ? renderer.hitTest(x, y) : -1;
          if (lane < 0) return;
          e.preventDefault();
          for (const l of G.pointerLanes.values()) if (l === lane) return;
          G.pointerLanes.set(e.pointerId, lane);
          G.pressed[lane] = { t0: nowT() };
          const pv = { t: +snapT(G.pressed[lane].t0).toFixed(3), lane, type: 'hold', d: 0.05, confirmed: true };
          G.previewByLane[lane] = pv;
          G.listDirty = true;
          if (G.renderer.laneHit) G.renderer.laneHit(lane);
        };
        G.onPointerUp = (e) => {
          const lane = G.pointerLanes.get(e.pointerId);
          if (lane == null) return;
          G.pointerLanes.delete(e.pointerId);
          releaseLane(lane);
        };
        container.addEventListener('pointerdown', G.onPointerDown, { passive: false });
        window.addEventListener('pointerup', G.onPointerUp);
        window.addEventListener('pointercancel', G.onPointerUp);

        // ---- 播放控制 ----
        function cleanupScrubListeners() {
          window.removeEventListener('pointermove', G.onTLMove);
          window.removeEventListener('pointerup', G.onTLUp);
          window.removeEventListener('pointercancel', G.onTLUp);
          const tcv = G.timelineCanvas;
          if (tcv && G.tlPointerId != null) {
            try { tcv.releasePointerCapture(G.tlPointerId); } catch (e) { /* noop */ }
          }
          G.tlPointerId = null;
          G.tlNote = null;
          G.scrubbing = false;
        }
        G.cleanupScrubListeners = cleanupScrubListeners;

        function pausePlayback() {
          releaseAllPressed();
          if (G.player.playing && !G.player.paused) G.player.pause();
          if (phaseRef.current === 'recording') {
            G.pausedReady = false;
            G.listDirty = true;
            setPhaseSafe('paused');
          }
        }
        G.pausePlayback = pausePlayback;

        function resumeRecording() {
          if (!G.player) return;
          cleanupScrubListeners();
          setRecSettings(false);
          G.pausedReady = false;
          G.listDirty = true;
          G.lastList = null;
          G.player.play(0.6, Math.max(0, G.player.time));
          setPhaseSafe('recording');
        }
        G.resumeRecording = resumeRecording;

        // ---- 暂停编辑：底部时间轴（拖动定位 / 点标记删除） ----
        function ensureTimelineCanvas() {
          const tcv = timelineRef.current;
          if (!tcv || G.timelineCanvas === tcv) return G.timelineCanvas;
          if (G.timelineCanvas && G.onTLDown) {
            G.timelineCanvas.removeEventListener('pointerdown', G.onTLDown);
          }
          G.timelineCanvas = tcv;
          tcv.addEventListener('pointerdown', G.onTLDown, { passive: false });
          return tcv;
        }

        function timelineX(e) {
          const tcv = G.timelineCanvas;
          if (!tcv) return 0;
          const rect = tcv.getBoundingClientRect();
          return Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        }
        function noteAtTimelineX(x, rect) {
          const dur = G.buffer.duration || 1;
          let best = null, bestD = Infinity;
          const threshold = Math.max(8, rect.width * 0.008);
          for (const n of G.notes) {
            const nx = (n.t / dur) * rect.width;
            const d = Math.abs(nx - x);
            if (d <= threshold && d < bestD) { bestD = d; best = n; }
          }
          return best;
        }
        G.onTLDown = (e) => {
          if (phaseRef.current !== 'paused') return;
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          const tcv = G.timelineCanvas;
          if (!tcv) return;
          const rect = tcv.getBoundingClientRect();
          const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
          G.tlPointerId = e.pointerId;
          G.tlStartX = x;
          G.tlMoved = false;
          G.tlNote = noteAtTimelineX(x, rect);
          G.scrubbing = true;
          G.scrubT = G.tlNote ? G.tlNote.t : (x / Math.max(1, rect.width)) * (G.buffer.duration || 0);
          try { tcv.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
          window.addEventListener('pointermove', G.onTLMove, { passive: false });
          window.addEventListener('pointerup', G.onTLUp);
          window.addEventListener('pointercancel', G.onTLUp);
        };
        G.onTLMove = (e) => {
          if (!G.scrubbing || e.pointerId !== G.tlPointerId) return;
          const tcv = G.timelineCanvas;
          if (!tcv) return;
          const rect = tcv.getBoundingClientRect();
          const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
          if (Math.abs(x - G.tlStartX) > 4) G.tlMoved = true;
          if (G.tlMoved) {
            e.preventDefault();
            G.scrubT = (x / Math.max(1, rect.width)) * (G.buffer.duration || 0);
          }
        };
        G.onTLUp = (e) => {
          if (!G.scrubbing) return;
          if (e && G.tlPointerId != null && e.pointerId !== G.tlPointerId) return;
          const wasMoved = G.tlMoved;
          const note = G.tlNote;
          const target = G.scrubT;
          cleanupScrubListeners();
          if (!wasMoved && note) {
            if (deleteNote(note)) {
              flash('已删除音符（Ctrl+Z 撤销）');
              doSeek(note.t);
            }
          } else if (target != null) {
            doSeek(target);
          }
          G.listDirty = true;
        };

        function doSeek(t) {
          if (!G.player) return;
          const dur = G.buffer.duration || 0;
          const target = Math.max(0, Math.min(Math.max(0, dur - 0.05), t));
          const before = G.player.time;
          G.player.seek(target);
          if (target < before - 0.25) G.rewindT = (G.rewindT == null) ? target : Math.min(G.rewindT, target);
          G.listDirty = true;
          G.lastList = null;
          G.scrubT = target;
        }
        G.doSeek = doSeek;

        // ---- 渲染主循环（音频时钟；拍照/暂停时读同一时钟） ----
        function fitCanvas(cv, ctx, cssW, cssH) {
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          const w = Math.max(10, Math.floor(cssW)), h = Math.max(10, Math.floor(cssH));
          if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) {
            cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr);
          }
          cv.style.width = w + 'px'; cv.style.height = h + 'px';
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          return { W: w, H: h };
        }

        function drawTimeline(curT) {
          const tcv = ensureTimelineCanvas();
          if (!tcv) return;
          const tg = tcv.getContext('2d');
          const { W, H } = fitCanvas(tcv, tg, Math.max(120, (tcv.parentElement ? tcv.parentElement.clientWidth : 600) - 18), TL_H);
          const dur = Math.max(0.01, G.buffer.duration || 0);
          tg.clearRect(0, 0, W, H);
          tg.fillStyle = 'rgba(20,32,52,0.62)';
          tg.fillRect(0, 0, W, H);
          // 回退区（重录时之后音符标灰）
          if (G.rewindT != null) {
            tg.fillStyle = 'rgba(255,215,110,0.08)';
            tg.fillRect((G.rewindT / dur) * W, 0, W - (G.rewindT / dur) * W, H);
          }
          // 音符标记：暂停时点标记可直接删除
          const markerY = 12;
          for (const n of G.notes) {
            const x = (n.t / dur) * W;
            if (x < -2 || x > W + 2) continue;
            tg.fillStyle = n.gray ? GRAY_CSS : (LANE_COLORS[n.lane % LANE_COLORS.length] || '#6ec3ff');
            tg.globalAlpha = n.gray ? 0.45 : 0.95;
            tg.fillRect(x - 1.2, 3, 2.4, 12);
            if (n.type === 'hold') {
              tg.globalAlpha *= 0.5;
              tg.fillRect(x, markerY, Math.max(1.5, (n.d / dur) * W), 2);
            }
            tg.globalAlpha = 1;
          }
          // 密度直方图
          const buckets = Math.max(32, Math.floor(W / 4));
          const bins = new Array(buckets).fill(0);
          for (const n of G.notes) {
            const b = Math.min(buckets - 1, Math.floor((n.t / dur) * buckets));
            bins[b] += n.type === 'hold' ? 2 : 1;
          }
          const maxB = Math.max(1, ...bins);
          for (let i = 0; i < buckets; i++) {
            if (!bins[i]) continue;
            tg.fillStyle = 'rgba(110,195,255,0.5)';
            const bh = Math.max(2, (bins[i] / maxB) * (H - 32));
            tg.fillRect((i / buckets) * W, H - 12 - bh, Math.max(1, W / buckets - 1), bh);
          }
          // 时间刻度
          const stepT = dur > 240 ? 30 : dur > 120 ? 15 : dur > 60 ? 10 : 5;
          tg.font = '9px Consolas, monospace';
          for (let t = 0; t <= dur; t += stepT) {
            const x = (t / dur) * W;
            tg.fillStyle = 'rgba(110,195,255,0.28)';
            tg.fillRect(x, H - 10, 1, 5);
            tg.fillStyle = '#5f7f9f';
            tg.fillText(fmtT(t), x + 2, H - 1);
          }
          // 播放头 + 当前时间
          const px = (Math.max(0, Math.min(dur, curT)) / dur) * W;
          tg.fillStyle = '#6ec3ff';
          tg.fillRect(px - 1, 0, 2.2, H - 9);
          tg.beginPath();
          tg.arc(px, 5.5, 4.5, 0, Math.PI * 2);
          tg.fill();
          tg.fillStyle = '#cfe6ff';
          tg.font = '10px Consolas, monospace';
          const label = `${fmtT(curT)} / ${fmtT(dur)}`;
          const tw = tg.measureText(label).width;
          tg.fillStyle = 'rgba(10,18,30,0.72)';
          tg.fillRect(W - tw - 10, H - 23, tw + 8, 14);
          tg.fillStyle = '#cfe6ff';
          tg.fillText(label, W - tw - 6, H - 12);
        }

        const loop = () => {
          if (disposed) return;
          G.raf = requestAnimationFrame(loop);
          if (!G.renderer || !G.player) return;
          const scrubbing = G.scrubbing && G.scrubT != null;
          const paused = phaseRef.current === 'paused';
          const t = scrubbing ? G.scrubT : (paused ? G.player.time : nowT());
          // 曲尾自动暂停
          if (!scrubbing && phaseRef.current === 'recording' && t > G.buffer.duration + 0.3) {
            releaseAllPressed();
            G.player.pause();
            G.pausedReady = false;
            setPhaseSafe('paused');
            flash('已到曲尾，可回退补录或保存');
          }
          // 按住中的 hold 预览：原地改 d（不重建精灵）
          if (phaseRef.current === 'recording') {
            for (let l = 0; l < keyCount; l++) {
              const p = G.pressed[l];
              const pv = G.previewByLane[l];
              if (p && pv) pv.d = Math.max(0.05, t - p.t0);
            }
          }
          // 暂停时一次载入全部音符，拖动时间轴不反复重建精灵（也避免闪烁）
          if (paused) {
            if (!G.pausedReady || G.listDirty) {
              G.renderer.loadNotes(allNotesForPause());
              G.pausedReady = true;
              G.listDirty = false;
            }
          } else {
            syncVisible(t);
          }
          G.renderer.render(t, { score: 0, accuracy: 100, combo: 0 });
          if (timelineRef.current) drawTimeline(t);
        };
        loop();
        setPhaseSafe('start');
      } catch (e) {
        if (!disposed) { setErr(e.message || String(e)); setPhaseSafe('error'); }
      }
    }
    boot();

    return () => {
      disposed = true;
      if (G.raf) cancelAnimationFrame(G.raf);
      if (G.onKeyDown) window.removeEventListener('keydown', G.onKeyDown);
      if (G.onKeyUp) window.removeEventListener('keyup', G.onKeyUp);
      if (G.onPointerDown && container) container.removeEventListener('pointerdown', G.onPointerDown);
      if (G.onPointerUp) {
        window.removeEventListener('pointerup', G.onPointerUp);
        window.removeEventListener('pointercancel', G.onPointerUp);
      }
      if (G.cleanupScrubListeners) G.cleanupScrubListeners();
      const tcv = G.timelineCanvas;
      if (tcv && G.onTLDown) tcv.removeEventListener('pointerdown', G.onTLDown);
      if (G.renderer) { try { G.renderer.destroy(); } catch (e) { /* noop */ } }
      if (G.player) { try { G.player.destroy(); } catch (e) { /* noop */ } }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 起点选择 ----
  function chooseBase(label, notes) {
    if (!G.player) return;
    const mode = label === 'blank' ? 'blank' : baseModeRef.current;
    G.baseLabel = label === 'blank' ? null : label;
    G.baseMode = mode;
    if (mode === 'ref') {
      G.baseNotes = copyNotes(notes).map((n) => ({ ...n, gray: true, ref: true }));
      G.notes = [];
    } else {
      G.baseNotes = [];
      G.notes = mode === 'merge' ? copyNotes(notes) : [];
    }
    G.undoStack = [];
    G.rewindT = null;
    G.listDirty = true;
    G.lastList = null;
    G.pausedReady = false;
    if (G.renderer) G.renderer.loadNotes([]);
    setBaseInfo({ label: label === 'blank' ? '空白谱' : label, mode, notes: notes.length });
    setCount(G.notes.length);
    setHoldCount(G.notes.filter((n) => n.type === 'hold').length);
    G.dirty = false; setDirty(false);
    setRecSettings(false);
    setPhaseSafe('ready');
  }

  function changeRate(r) {
    setRateState(r);
    if (G.player) G.player.setRate(r);
  }

  function startRecording() {
    if (!G.player) return;
    const ctx = getCtx();
    try { ctx.resume(); } catch (e) { /* noop */ }
    G.pausedReady = false;
    G.listDirty = true;
    G.player.play(2);
    setPhaseSafe('recording');
  }

  function restartFromHere() {
    if (!G.player) return;
    G.pausePlayback && G.pausePlayback();
    const t = Math.max(0, G.player.time);
    const removed = G.notes.filter((n) => n.t >= t - 0.05);
    if (removed.length) {
      G.notes = G.notes.filter((n) => n.t < t - 0.05);
      G.undoStack.push({ type: 'clearTail', removed });
    }
    G.rewindT = null;
    G.player.seek(t);
    G.listDirty = true;
    setCount(G.notes.length);
    setHoldCount(G.notes.filter((n) => n.type === 'hold').length);
    G.dirty = true; setDirty(true);
    setRecSettings(false);
    flash(removed.length
      ? `已清除 ${fmtT(t)} 之后的 ${removed.length} 个音符，按「继续」从此处重录`
      : '当前位置之后没有音符，按「继续」从此处录入');
  }

  function clearTail() {
    if (!G.player) return;
    const t = Math.max(0, G.player.time);
    const removed = G.notes.filter((n) => n.t >= t - 0.05);
    if (!removed.length) { flash('当前位置之后没有音符'); return; }
    G.notes = G.notes.filter((n) => n.t < t - 0.05);
    G.undoStack.push({ type: 'clearTail', removed });
    if (G.rewindT != null && G.rewindT >= t - 0.05) G.rewindT = null;
    G.listDirty = true;
    setCount(G.notes.length);
    setHoldCount(G.notes.filter((n) => n.type === 'hold').length);
    G.dirty = true; setDirty(true);
    setRecSettings(false);
    flash(`已清除 ${fmtT(t)} 之后的 ${removed.length} 个音符（Ctrl+Z 可撤销）`);
  }

  function saveChart() {
    if (!G.notes || !G.notes.length) { flash('还没有录入任何音符'); return; }
    if (G.player && !G.player.paused) {
      G.pausePlayback && G.pausePlayback(); // 播放中保存：先暂停，避免返回继续编辑时音频/状态脱节
    }
    const clean = G.notes.map((n) => (n.type === 'hold'
      ? { t: +n.t.toFixed(3), lane: n.lane, type: 'hold', d: +n.d.toFixed(3) }
      : { t: +n.t.toFixed(3), lane: n.lane, type: 'tap' })).sort((x, y) => x.t - y.t);
    const rep = buildReport(clean);
    setReport(rep);
    const customs = [...(song.charts.custom || [])];
    const stats = {
      noteCount: clean.length,
      holdCount: clean.filter((n) => n.type === 'hold').length,
      density: rep ? +rep.density : 0,
      patternCounts: {},
    };
    const date = new Date().toLocaleDateString('zh-CN');
    const baseTag = G.baseLabel
      ? (G.baseMode === 'merge' ? `基于${G.baseLabel}` : `参考${G.baseLabel}`)
      : '';
    const fallbackName = baseTag ? `手录 · ${baseTag} · ${date}` : `手录 · ${date}`;
    const baseMeta = { baseLabel: G.baseLabel || null, baseMode: G.baseMode || 'blank' };
    if (G.savedId && customs.some((c) => c.id === G.savedId)) {
      const i = customs.findIndex((c) => c.id === G.savedId);
      customs[i] = { ...customs[i], notes: clean, stats, updatedAt: Date.now(), ...baseMeta };
    } else {
      const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      G.savedId = id;
      customs.push({
        id,
        name: fallbackName,
        origin: 'manual',
        keyCount: song.keyCount || 4,
        notes: clean,
        stats,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...baseMeta,
      });
    }
    updateSong(song.id, { charts: { ...song.charts, custom: customs } });
    G.dirty = false; setDirty(false);
    G.listDirty = true;
    setPhaseSafe('done');
  }

  function buildReport(notes) {
    if (!notes || !notes.length || !G.a || !G.a.bpm) return null;
    const a = G.a;
    const step = (60 / a.bpm) / SNAP_SUBDIV;
    const b0 = a.beats && a.beats.length ? a.beats[0] : 0;
    const devs = notes.map((n) => {
      const k = Math.round((n.t - b0) / step);
      return Math.abs(n.t - (b0 + k * step)) * 1000;
    });
    devs.sort((x, y) => x - y);
    const med = devs[Math.floor(devs.length / 2)];
    const p90 = devs[Math.floor(devs.length * 0.9)];
    const offGrid = devs.filter((d) => d > 45).length;
    const dur = song.durationSec || 1;
    const gaps = [];
    const ts = notes.map((n) => n.t);
    for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > 8) gaps.push(ts[i - 1]);
    return { median: Math.round(med), p90: Math.round(p90), offGrid, density: (notes.length / dur).toFixed(2), gaps, dur };
  }

  async function exportSavedChart() {
    const custom = G.savedId ? (song.charts.custom || []).find((c) => c.id === G.savedId) : null;
    if (!custom) { flash('尚未保存谱面'); return; }
    try {
      const r = await exportChartPackage(song, null, custom);
      if (!r.canceled) flash('谱面包 (.osz) 已导出');
    } catch (e) {
      flash('导出失败：' + (e.message || e));
    }
  }

  function requestExit() {
    if (G.dirty) {
      if (!window.confirm('有未保存的修改，退出将丢失。确定退出？')) return;
    }
    navigate({ screen: 'song', songId });
  }

  if (!song) {
    return (
      <div className="screen center-screen">
        <div className="empty-state">歌曲不存在</div>
        <button className="btn" onClick={() => navigate({ screen: 'library' })}>返回曲库</button>
      </div>
    );
  }

  const touchMode = isTouchDevice();
  const customs = song.charts.custom || [];
  const stdBases = ['E', 'H', 'EX'].map((dk) => ({ dk, chart: song.charts[dk] })).filter((x) => x.chart);
  const keymap = effectiveKeymap(settings, song.keyCount);
  const keyLabelsText = keymap.map((c) => KEY_LABELS[c] || c.replace('Key', '')).join(' ');
  const savedCustom = G.savedId ? (song.charts.custom || []).find((c) => c.id === G.savedId) : null;

  return (
    <div className="game-screen">
      <div ref={containerRef} className="game-canvas-holder" />

      {/* ---------- 起点选择 ---------- */}
      {phase === 'start' && (
        <div className="overlay center-screen">
          <div className="rec-start glass">
            <h2>新建手录谱</h2>
            <div className="muted small">选一个起点。底谱会被深拷贝，原谱不受影响；保存时生成新的自定谱。</div>
            <div className="rec-mode-row">
              <span className="muted">底谱用法</span>
              <div className="seg">
                <button className={baseMode === 'ref' ? 'on' : ''} onClick={() => setBaseMode('ref')}>仅参考（默认）</button>
                <button className={baseMode === 'merge' ? 'on' : ''} onClick={() => setBaseMode('merge')}>一并录入</button>
              </div>
            </div>
            <div className="muted small rec-mode-hint">
              {baseMode === 'ref'
                ? '底谱只以灰色显示，帮你对齐节奏；保存的谱面里不会包含底谱音符。'
                : '底谱音符会作为已录入音符一并保存，可在暂停后用删除功能移除。'}
            </div>
            <div className="rec-start-grid">
              <button className="btn primary" onClick={() => chooseBase('blank', [])}>空白谱</button>
              {stdBases.map(({ dk, chart }) => (
                <button key={dk} className="btn" onClick={() => chooseBase(dk, chart.notes)}>
                  {dk} 谱底稿（{chart.notes.length} notes）
                </button>
              ))}
              {customs.map((c) => (
                <button key={c.id} className="btn" onClick={() => chooseBase(`「${c.name}」`, c.notes)}>
                  {c.name}（{c.notes.length} notes）
                </button>
              ))}
            </div>
            <button className="btn ghost sm" onClick={() => navigate({ screen: 'song', songId })}>返回</button>
          </div>
        </div>
      )}

      {phase === 'loading' && <div className="overlay center-screen"><div className="loading-text">加载音频中…</div></div>}
      {phase === 'error' && (
        <div className="overlay center-screen glass"><div className="error-toast">{err}</div>
          <button className="btn" onClick={() => navigate({ screen: 'song', songId })}>返回选曲</button></div>
      )}

      {/* ---------- 准备录制 ---------- */}
      {phase === 'ready' && (
        <div className="overlay center-screen">
          <div className="rec-ready glass">
            <h2>准备录制</h2>
            <div className="muted small">
              底谱：{baseInfo ? baseInfo.label : '空白谱'}
              {baseInfo && baseInfo.mode === 'ref' ? ` · 仅参考 ${baseInfo.notes} 个音符（不保存）` : ''}
              {baseInfo && baseInfo.mode === 'merge' ? ` · 一并录入 ${baseInfo.notes} 个音符` : ''}
            </div>
            <div className="rec-ready-stats">
              <span>已录入 {count} notes</span>
              <span>长按 {holdCount}</span>
              <span>慢放 {rate}x</span>
            </div>
            <div className="rec-ready-actions">
              <button className="btn primary" onClick={startRecording}>开始录制（2 秒倒计时）</button>
              <button className="btn ghost" onClick={requestExit}>退出</button>
            </div>
            <div className="muted small">播放开始后按{keyLabelsText ? ` ${keyLabelsText} ` : '轨道键'}录入；按住录长键。</div>
          </div>
        </div>
      )}

      {/* ---------- 录制中：只留一个暂停按钮 ---------- */}
      {phase === 'recording' && (
        <button className="btn rec-pause-btn" onClick={() => G.pausePlayback && G.pausePlayback()} title="暂停（Esc）">暂停</button>
      )}
      {phase === 'recording' && (
        <div className="game-hint">
          {touchMode
            ? '触摸轨道录入 · 按住录长键 · 右上角暂停'
            : `按 ${keyLabelsText} 录入 · 按住录长键 · Esc 暂停 · Ctrl+Z 撤销`}
        </div>
      )}

      {/* ---------- 暂停 = 编辑：小面板 + 自动出现的时间轴 ---------- */}
      {phase === 'paused' && (
        <>
          <div className="rec-pause-panel glass">
            <div className="rec-pause-head">
              <b>已暂停</b>
              <span className="muted small">{count} notes · {holdCount} hold{dirty ? ' · 未保存' : ''}</span>
            </div>
            <div className="rec-pause-actions">
              <button className="btn primary" onClick={() => G.resumeRecording && G.resumeRecording()}>继续录制</button>
              <button className="btn" onClick={saveChart} disabled={!count}>保存谱面{dirty ? ' *' : ''}</button>
              <button className="btn" onClick={() => setRecSettings(true)}>设置</button>
              <button className="btn ghost" onClick={requestExit}>退出</button>
            </div>
            <div className="muted small rec-pause-tip">
              拖动底部时间轴定位；点音符或时间轴标记删除（Ctrl+Z 撤销）。
              底谱参考音符为灰色，不可删除。
            </div>
          </div>
          <div className="rec-timeline-wrap">
            <div className="rec-timeline glass" title="拖动定位；点击音符标记删除">
              <canvas ref={timelineRef} />
            </div>
          </div>
        </>
      )}

      {/* ---------- 录制设置（暂停时打开） ---------- */}
      {recSettingsOpen && phase === 'paused' && (
        <div className="modal-overlay" onClick={() => setRecSettings(false)}>
          <div className="modal glass rec-settings" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>录制设置</h2>
              <button className="btn ghost sm" onClick={() => setRecSettings(false)}>关闭</button>
            </div>
            <div className="rec-settings-grid">
              <section>
                <h3>慢放</h3>
                <div className="seg">
                  {SPEEDS.map((r) => (
                    <button key={r} className={rate === r ? 'on' : ''} onClick={() => changeRate(r)}>{r}x</button>
                  ))}
                </div>
                <div className="muted small">只影响播放速度，不改变谱面时间轴；恢复录制后继续生效。</div>
              </section>
              <section>
                <h3>录入辅助</h3>
                <label className="rec-snap">
                  <input type="checkbox" checked={snap} onChange={(e) => { setSnap(e.target.checked); snapRef.current = e.target.checked; }} />
                  吸附到十六分音符网格
                </label>
              </section>
              <section>
                <h3>编辑工具</h3>
                <div className="rec-tool-row">
                  <button className="btn sm" onClick={() => G.undo && G.undo()}>撤销</button>
                  <button className="btn sm" onClick={restartFromHere} title="暂停并清除当前位置之后的音符，倒计时后从此处重录">从此处重录</button>
                  <button className="btn sm" onClick={clearTail} title="只清除当前位置之后的音符，不打断录制">清除后续</button>
                </div>
                <div className="muted small">「从此处重录」会清除当前时间之后的音符并定位；「清除后续」保留当前位置。</div>
              </section>
            </div>
          </div>
        </div>
      )}

      {/* ---------- 保存结果 ---------- */}
      {phase === 'done' && report && (
        <div className="overlay center-screen glass rec-report">
          <h2>已保存</h2>
          <div className="rec-report-stats">
            <span>音符 {count}</span><span>长按 {holdCount}</span><span>密度 {report.density}/秒</span>
          </div>
          <div className="rec-report-dev">
            <div>网格偏差：中位 ±{report.median}ms · 90分位 ±{report.p90}ms</div>
            <div>离格较远（&gt;45ms）：{report.offGrid} 个{snap ? '（录制时已自动吸附到网格）' : ''}</div>
            {report.gaps.length > 0 && (
              <div>超过 8 秒的空段 {report.gaps.length} 处（{report.gaps.slice(0, 5).map((t) => t.toFixed(0) + 's').join('、')}…）——如非本意可回去补录</div>
            )}
          </div>
          <div className="pause-actions">
            <button className="btn primary" onClick={() => setPhaseSafe('paused')}>返回继续编辑</button>
            <button className="btn" onClick={exportSavedChart} disabled={!savedCustom}>导出谱面包 (.osz)</button>
            <button className="btn" onClick={() => navigate({ screen: 'song', songId })}>前往选曲试玩</button>
          </div>
        </div>
      )}

      {toast && <div className="toast glass">{toast}</div>}
    </div>
  );
}
