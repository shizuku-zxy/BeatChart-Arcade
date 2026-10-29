// ============ 手动录入谱面页（v1.7.0 全面重做） ============
// 录入时钟 = 游玩判定时钟（AudioContext + 音频输出延迟补偿 + 手动校准），
// 因此"录的谱自己玩必然跟手"，无需额外校准。
//
// v1.7.0 新增：
//   - 起点选择：空白谱 / 深拷贝 E/H/EX/已有自定谱为底稿（原谱不动，保存生成新谱面）
//   - 录制模式与编辑模式随时切换（编辑交互与音乐轴完全一致：点选/新增/删改）
//   - 慢放三档 0.5x/0.75x/1x（音调不变；慢放时录入时刻即音乐时间轴时刻）
//   - 底部时间轴滑块（拖动=回退定位，拖动时自动暂停；已录音符密度直方图）
//   - 渲染窗口=当前音乐时间之后：已过线的已录 note 隐藏，只有回退时间轴才重现
//   - 回退点之后音符保留标灰，重录同轨同时刻自动替换；一键清尾 / 从此处重录并存
//   - Ctrl+Z 撤销（覆盖录入/替换/删除/编辑/清尾）；手动保存 + 未保存退出询问

import React, { useEffect, useRef, useState } from 'react';
import { getCtx, decodeFile, SongPlayer, getAudioOutLatency } from '../core/audio.js';
import { GameRenderer } from '../game/Renderer.js';
import { PerspectiveRenderer } from '../game/PerspectiveRenderer.js';
import { loadAudioBlob, updateSong } from '../core/store.js';
import { effectiveKeymap, KEY_LABELS, resolveRenderMode, isTouchDevice } from '../core/constants.js';

const HOLD_MIN = 0.18;      // 按住超过此秒数录成 hold
const SNAP_SUBDIV = 4;      // 吸附网格：十六分音符
const REPLACE_TOL = 0.15;   // 重录同轨同时刻替换容差（秒）
const REC_WINDOW = 0.02;    // 已过线隐藏裕量（秒）
const SPEEDS = [0.5, 0.75, 1];

const ENERGY_COLORS = ['#31567d', '#4c8ec4', '#6ec3ff'];
const LANE_COLORS = ['#6ec3ff', '#6ef7d8', '#ffd76e', '#ff7a9e', '#c3a3ff', '#7af0b0'];
const GRAY_CSS = '#5a6a80';
const EDIT_ENERGY_H = 18;
const EDIT_LANES_Y = 32;
const EDIT_LANE_H = 24;

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
  const editorRef = useRef(null);
  const G = useRef({}).current;
  const [phase, setPhase] = useState('loading'); // start | loading | ready | recording | paused | edit | done | error
  const phaseRef = useRef('start');
  const [count, setCount] = useState(0);
  const [holdCount, setHoldCount] = useState(0);
  const [snap, setSnap] = useState(true);
  const snapRef = useRef(true);
  const [rate, setRate] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [selIdx, setSelIdx] = useState(null);
  const selRef = useRef(null);
  const [err, setErr] = useState(null);
  const [report, setReport] = useState(null);
  const [toast, setToast] = useState(null);

  const setPhaseSafe = (p) => { phaseRef.current = p; setPhase(p); };
  const setSelIdxSafe = (i) => { selRef.current = i; setSelIdx(i); };

  function flash(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  }

  useEffect(() => { snapRef.current = snap; }, [snap]);

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

    // ---- 撤销（录入/替换/删除/编辑/清尾全可回退） ----
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
      else if (e.type === 'edit') {
        const i = G.notes.indexOf(e.after);
        if (i >= 0) G.notes[i] = e.before;
      } else if (e.type === 'clearTail') {
        G.notes = [...G.notes, ...e.removed].sort((x, y) => x.t - y.t);
      }
      if (selRef.current != null && selRef.current >= G.notes.length) setSelIdxSafe(null);
      G.rewindT = e.type === 'clearTail' ? null : G.rewindT;
      afterChange();
    }
    G.undo = undo;

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
        if (renderer.setRhythm) {
          renderer.setRhythm(song.analysis.bpm, song.analysis.beats && song.analysis.beats[0] != null ? song.analysis.beats[0] : 0);
        }

        G.player = player;
        G.renderer = renderer;
        G.keymap = keymap;
        G.buffer = buffer;
        G.notes = [];
        G.pressed = new Array(keyCount).fill(null);       // lane -> { t0 }
        G.previewByLane = new Array(keyCount).fill(null); // lane -> 预览 hold note 对象（原地改 d）
        G.pointerLanes = new Map();
        G.undoStack = [];
        G.rewindT = null;      // 回退点：之后的音符标灰（保留待重录）
        G.lastList = null;     // 上次 loadNotes 的可见列表（变更检测）
        G.listDirty = true;
        G.scrubbing = false;
        G.scrubT = null;
        G.dirty = false;
        G.savedId = null;
        G.baseLabel = null;
        G.latencySec = getAudioOutLatency(getCtx())
          + (settings.latencyMs || 0) / 1000 + (settings.musicOffsetMs || 0) / 1000;
        renderer.loadNotes([]);

        function nowT() {
          return (G.latencySec == null ? G.player.time : G.player.time - G.latencySec);
        }
        G.nowT = nowT;

        // ---- 可见列表：渲染窗口 = 当前音乐时间之后（已过线隐藏，回退重现） ----
        function buildVisible(curT) {
          const winHi = curT + (G.renderer.leadTime || G.renderer.approach * 12) + 0.6; // 透视式可见窗口（v1.8.1f=12K，与渲染器同步）
          const list = [];
          for (const n of G.notes) {
            if (n.t > winHi) break;
            if (n.t < curT - REC_WINDOW) continue;
            n.gray = G.rewindT != null && !n.confirmed && n.t >= G.rewindT - 1e-4;
            list.push(n);
          }
          for (let l = 0; l < keyCount; l++) if (G.previewByLane[l]) list.push(G.previewByLane[l]);
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
            if (phaseRef.current === 'edit') { setPhaseSafe('paused'); return; }
            togglePlay();
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

        // 触摸（多点；与游玩同一 hitTest）
        G.onPointerDown = (e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          const rect = container.getBoundingClientRect();
          const lane = renderer.hitTest
            ? renderer.hitTest(e.clientX - rect.left, e.clientY - rect.top)
            : -1;
          if (lane < 0) return;
          e.preventDefault();
          for (const l of G.pointerLanes.values()) if (l === lane) return;
          G.pointerLanes.set(e.pointerId, lane);
          if (phaseRef.current !== 'recording') return;
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
        function pausePlayback() {
          releaseAllPressed();
          if (G.player.playing && !G.player.paused) G.player.pause();
          if (phaseRef.current === 'recording') setPhaseSafe('paused');
        }
        G.pausePlayback = pausePlayback;
        function resumeRecording() {
          // 带 0.6s 缓冲倒计时从暂停锚点严格续播（v1.7.1 修复：旧代码 fromT 误用
          // nowT()=time-latencySec，音乐往回跳 latency 秒重复一小段，与玩家听到的位置脱节）
          G.player.play(0.6, Math.max(0, G.player.time));
          setPhaseSafe('recording');
        }
        G.resumeRecording = resumeRecording;
        function togglePlay() {
          if (!G.player) return;
          if (phaseRef.current === 'recording') pausePlayback();
          else if (phaseRef.current === 'paused') resumeRecording();
        }

        // ---- 底部时间轴滑块（拖动=回退定位，拖动时自动暂停） ----
        // 画布随 phase 就绪后懒挂载（start/loading 阶段节点尚不存在）
        function ensureTimelineCanvas() {
          const tcv = timelineRef.current;
          if (!tcv || G.timelineCanvas === tcv) return G.timelineCanvas;
          if (G.timelineCanvas && G.onTLDown) {
            G.timelineCanvas.removeEventListener('pointerdown', G.onTLDown);
            G.timelineCanvas.removeEventListener('pointermove', G.onTLMove);
            G.timelineCanvas.removeEventListener('pointerup', G.onTLUp);
            G.timelineCanvas.removeEventListener('pointercancel', G.onTLUp);
          }
          G.timelineCanvas = tcv;
          tcv.addEventListener('pointerdown', G.onTLDown);
          tcv.addEventListener('pointermove', G.onTLMove);
          tcv.addEventListener('pointerup', G.onTLUp);
          tcv.addEventListener('pointercancel', G.onTLUp);
          return tcv;
        }
        function timelinePos(e) {
          const rect = G.timelineCanvas.getBoundingClientRect();
          return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * G.buffer.duration;
        }
        G.onTLDown = (e) => {
          e.preventDefault();
          if (phaseRef.current === 'recording') pausePlayback();
          G.scrubbing = true;
          G.scrubT = timelinePos(e);
          const tcv = G.timelineCanvas;
          tcv.setPointerCapture && tcv.setPointerCapture(e.pointerId);
        };
        G.onTLMove = (e) => { if (G.scrubbing) G.scrubT = timelinePos(e); };
        G.onTLUp = () => {
          if (!G.scrubbing) return;
          G.scrubbing = false;
          doSeek(G.scrubT != null ? G.scrubT : 0);
          G.scrubT = null;
        };

        function doSeek(t) {
          const before = nowT();
          G.player.seek(Math.max(0, Math.min(G.buffer.duration - 0.05, t)));
          // 向回拖 = 回退：之后的已录音符保留标灰
          if (t < before - 0.25) G.rewindT = (G.rewindT == null) ? t : Math.min(G.rewindT, t);
          G.listDirty = true;
          if (phaseRef.current === 'recording') setPhaseSafe('paused');
        }
        G.doSeek = doSeek;

        // ---- 编辑模式时间轴（交互与音乐轴完全一致）——画布懒挂载 ----
        G.onEditDown = (e) => {
          const ecv = G.editCanvas;
          const rect = ecv.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const t = (x / rect.width) * G.buffer.duration;
          const lane = Math.floor((y - EDIT_LANES_Y) / EDIT_LANE_H);
          if (lane < 0 || lane >= keyCount) { setSelIdxSafe(null); return; }
          const tTol = Math.max(0.04, (8 / rect.width) * G.buffer.duration);
          let hitIdx = -1;
          let hitD = Infinity;
          G.notes.forEach((n, i) => {
            if (n.lane !== lane) return;
            const within = n.type === 'hold'
              ? (t >= n.t - tTol && t <= n.t + n.d + tTol)
              : Math.abs(n.t - t) <= tTol;
            if (!within) return;
            const d = Math.abs(n.t - t);
            if (d < hitD) { hitD = d; hitIdx = i; }
          });
          if (hitIdx >= 0) { setSelIdxSafe(hitIdx); return; }
          // 空白 → 新增 tap（吸附），与音乐轴一致
          const nt = +snapT(t).toFixed(3);
          const note = { t: nt, lane, type: 'tap', confirmed: true };
          insertNoteSorted(note);
          pushUndo({ type: 'add', note });
          setSelIdxSafe(G.notes.indexOf(note));
          afterChange();
        };
        function ensureEditCanvas() {
          const ecv = editorRef.current;
          if (!ecv || G.editCanvas === ecv) return G.editCanvas;
          if (G.editCanvas && G.onEditDown) G.editCanvas.removeEventListener('pointerdown', G.onEditDown);
          G.editCanvas = ecv;
          ecv.addEventListener('pointerdown', G.onEditDown);
          return ecv;
        }

        // ---- 渲染主循环（音频时钟） ----
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
          const { W, H } = fitCanvas(tcv, tg, tcv.parentElement.clientWidth - 24, 44);
          const dur = G.buffer.duration;
          tg.clearRect(0, 0, W, H);
          tg.fillStyle = 'rgba(20,32,52,0.5)';
          tg.fillRect(0, 10, W, H - 22);
          // 回退区（之后的音符标灰）
          if (G.rewindT != null) {
            tg.fillStyle = 'rgba(255,215,110,0.10)';
            tg.fillRect((G.rewindT / dur) * W, 10, W - (G.rewindT / dur) * W, H - 22);
          }
          // 已录音符密度直方图（确认=蓝，回退区=灰）
          const buckets = Math.max(24, Math.floor(W / 3));
          const bins = new Array(buckets).fill(0);
          for (const n of G.notes) {
            const b = Math.min(buckets - 1, Math.floor((n.t / dur) * buckets));
            bins[b] += n.type === 'hold' ? 2 : 1;
          }
          const maxB = Math.max(1, ...bins);
          for (let i = 0; i < buckets; i++) {
            if (!bins[i]) continue;
            const bt = ((i + 0.5) / buckets) * dur;
            const inGray = G.rewindT != null && bt >= G.rewindT;
            tg.fillStyle = inGray ? 'rgba(90,106,128,0.85)' : 'rgba(110,195,255,0.75)';
            const bh = Math.max(3, (bins[i] / maxB) * (H - 30));
            tg.fillRect((i / buckets) * W, H - 14 - bh, W / buckets - 1, bh);
          }
          // 时间刻度
          tg.fillStyle = '#5f7f9f';
          tg.font = '9px Consolas, monospace';
          const stepT = dur > 240 ? 30 : dur > 120 ? 15 : dur > 60 ? 10 : 5;
          for (let t = 0; t <= dur; t += stepT) {
            const x = (t / dur) * W;
            tg.fillStyle = 'rgba(110,195,255,0.3)';
            tg.fillRect(x, H - 11, 1, 6);
            tg.fillStyle = '#5f7f9f';
            tg.fillText(fmtT(t), x + 2, H - 2);
          }
          // 播放头
          const px = (Math.max(0, Math.min(dur, curT)) / dur) * W;
          tg.fillStyle = '#6ec3ff';
          tg.fillRect(px - 1, 6, 2.5, H - 12);
          tg.beginPath();
          tg.moveTo(px - 5, 6); tg.lineTo(px + 5, 6); tg.lineTo(px, 13);
          tg.closePath(); tg.fill();
        }

        function drawEditor(curT) {
          const ecv = ensureEditCanvas();
          if (!ecv) return;
          const eg = ecv.getContext('2d');
          const wrap = ecv.parentElement;
          const laneAreaH = keyCount * EDIT_LANE_H + 8;
          const { W, H } = fitCanvas(ecv, eg, wrap.clientWidth - 28, EDIT_LANES_Y + laneAreaH + 22);
          const dur = G.buffer.duration;
          const t2x = (t) => (t / dur) * W;
          eg.clearRect(0, 0, W, H);
          // 段落能量条
          eg.fillStyle = 'rgba(20,32,52,0.4)';
          eg.fillRect(0, 6, W, EDIT_ENERGY_H);
          if (a && a.segments) {
            for (const s of a.segments) {
              eg.fillStyle = ENERGY_COLORS[Math.round(s.energy * 2)];
              eg.fillRect(t2x(s.start), 6, Math.max(1, t2x(s.end) - t2x(s.start)), EDIT_ENERGY_H);
            }
          }
          // 小节线
          if (a && a.barGrid) {
            eg.strokeStyle = 'rgba(110,195,255,0.16)';
            for (const bt of a.barGrid) {
              eg.beginPath(); eg.moveTo(t2x(bt), 6); eg.lineTo(t2x(bt), H - 16); eg.stroke();
            }
          }
          // 轨道行
          const laneT0 = EDIT_LANES_Y;
          for (let l = 0; l < keyCount; l++) {
            const y = laneT0 + l * EDIT_LANE_H;
            eg.fillStyle = l % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)';
            eg.fillRect(0, y, W, EDIT_LANE_H - 2);
            eg.fillStyle = 'rgba(126,164,200,0.55)';
            eg.font = '10px Consolas, monospace';
            eg.fillText(String(l), 4, y + 14);
          }
          // 音符
          const sel = selRef.current;
          G.notes.forEach((n, i) => {
            const x = t2x(n.t);
            const y = laneT0 + n.lane * EDIT_LANE_H;
            const isSel = sel === i;
            const col = isSel ? '#ffd76e' : (n.gray ? GRAY_CSS : (LANE_COLORS[n.lane % LANE_COLORS.length] || '#6ec3ff'));
            if (n.type === 'hold') {
              const w = Math.max(3, t2x(n.d));
              eg.fillStyle = col;
              eg.globalAlpha = isSel ? 1 : 0.55;
              eg.fillRect(x, y + 6, w, EDIT_LANE_H - 12);
              eg.globalAlpha = 1;
            }
            eg.fillStyle = col;
            eg.fillRect(x - 2.5, y + 2, 5, EDIT_LANE_H - 8);
            if (isSel) {
              eg.strokeStyle = '#fff';
              eg.lineWidth = 1;
              eg.strokeRect(x - 4.5, y + 0.5, 9, EDIT_LANE_H - 5);
            }
          });
          // 播放头
          const px = t2x(Math.max(0, Math.min(dur, curT)));
          eg.fillStyle = '#6ec3ff';
          eg.fillRect(px - 1, 4, 2, H - 18);
          // 时间标签
          eg.fillStyle = '#5f7f9f';
          eg.font = '9px Consolas, monospace';
          const stepT = dur > 240 ? 30 : dur > 120 ? 15 : dur > 60 ? 10 : 5;
          for (let t = 0; t <= dur; t += stepT) eg.fillText(fmtT(t), t2x(t) + 2, H - 4);
        }

        const loop = () => {
          if (disposed) return;
          G.raf = requestAnimationFrame(loop);
          if (!G.renderer || !G.player) return;
          const scrubbing = G.scrubbing && G.scrubT != null;
          const t = scrubbing ? G.scrubT : nowT();
          // 曲尾自动暂停
          if (!scrubbing && phaseRef.current === 'recording' && t > G.buffer.duration + 0.3) {
            releaseAllPressed();
            G.player.pause();
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
          G.renderer.render(t, { score: 0, accuracy: 100, combo: 0 });
          syncVisible(t);
          if (timelineRef.current) drawTimeline(t);
          if (phaseRef.current === 'edit') drawEditor(t);
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
      const tcv = G.timelineCanvas;
      if (tcv && G.onTLDown) {
        tcv.removeEventListener('pointerdown', G.onTLDown);
        tcv.removeEventListener('pointermove', G.onTLMove);
        tcv.removeEventListener('pointerup', G.onTLUp);
        tcv.removeEventListener('pointercancel', G.onTLUp);
      }
      const ecv = G.editCanvas;
      if (ecv && G.onEditDown) ecv.removeEventListener('pointerdown', G.onEditDown);
      if (G.renderer) { try { G.renderer.destroy(); } catch (e) { /* noop */ } }
      if (G.player) { try { G.player.destroy(); } catch (e) { /* noop */ } }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 起点（phase=start 之后调用；boot 已完成，选完进入 ready） ----
  function chooseBase(label, notes) {
    if (!G.player) return;
    G.baseLabel = label;
    G.notes = notes;
    G.undoStack = [];
    G.rewindT = null;
    G.listDirty = true;
    G.lastList = null;
    if (G.renderer) G.renderer.loadNotes([]);
    setSelIdxSafe(null);
    refreshCounts2(notes);
    G.dirty = false; setDirty(false);
    setPhaseSafe('ready');
  }
  function refreshCounts2(notes) {
    setCount(notes.length);
    setHoldCount(notes.filter((x) => x.type === 'hold').length);
  }

  async function startRecording() {
    if (!G.player) return;
    const ctx = getCtx();
    try { await ctx.resume(); } catch (e) { /* noop */ }
    G.player.play(2);
    setPhaseSafe('recording');
  }

  function enterEdit() {
    if (!G.player) return;
    G.pausePlayback && G.pausePlayback();
    setSelIdxSafe(null);
    setPhaseSafe('edit');
  }
  function exitEdit() { setPhaseSafe('paused'); }

  function restartFromHere() {
    if (!G.player) return;
    G.pausePlayback && G.pausePlayback();
    const t = Math.max(0, G.nowT());
    const removed = G.notes.filter((n) => n.t >= t - 0.05);
    if (removed.length) {
      G.notes = G.notes.filter((n) => n.t < t - 0.05);
      G.undoStack.push({ type: 'clearTail', removed });
    }
    G.rewindT = null;
    G.player.seek(t);
    G.listDirty = true;
    refreshCounts2(G.notes);
    markDirty2();
    setPhaseSafe('paused');
    flash(removed.length
      ? `已清除 ${fmtT(t)} 之后的 ${removed.length} 个音符，按「继续」从此处重录`
      : '当前位置之后没有音符，按「继续」从此处录入');
  }
  function markDirty2() { G.dirty = true; setDirty(true); }

  function clearTail() {
    if (!G.player) return;
    const t = Math.max(0, G.nowT());
    const removed = G.notes.filter((n) => n.t >= t - 0.05);
    if (!removed.length) { flash('当前位置之后没有音符'); return; }
    G.notes = G.notes.filter((n) => n.t < t - 0.05);
    G.undoStack.push({ type: 'clearTail', removed });
    // 若回退区整体位于清除点之后，一并解除标灰
    if (G.rewindT != null && G.rewindT >= t - 0.05) G.rewindT = null;
    G.listDirty = true;
    refreshCounts2(G.notes);
    markDirty2();
    flash(`已清除 ${fmtT(t)} 之后的 ${removed.length} 个音符（Ctrl+Z 可撤销）`);
  }

  // ---- 编辑操作（与音乐轴编辑完全一致的语义） ----
  function editApply(fn) {
    const sel = selRef.current;
    if (sel == null || !G.notes[sel]) return;
    const before = G.notes[sel];
    const after = fn({ ...before });
    G.notes[sel] = after;
    G.notes.sort((x, y) => x.t - y.t);
    setSelIdxSafe(G.notes.indexOf(after));
    G.listDirty = true;
    refreshCounts2(G.notes);
    markDirty2();
    G.undoStack.push({ type: 'edit', before, after });
  }
  function editDelete() {
    const sel = selRef.current;
    if (sel == null || !G.notes[sel]) return;
    const note = G.notes[sel];
    G.notes.splice(sel, 1);
    setSelIdxSafe(null);
    G.listDirty = true;
    refreshCounts2(G.notes);
    markDirty2();
    G.undoStack.push({ type: 'delete', note });
  }
  const selNote = selIdx != null ? (G.notes ? G.notes[selIdx] : null) : null;

  function saveChart() {
    if (!G.notes || !G.notes.length) { flash('还没有录入任何音符'); return; }
    G.pausePlayback && G.pausePlayback(); // 播放中保存：先暂停，避免返回继续编辑时音频/状态脱节
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
    if (G.savedId && customs.some((c) => c.id === G.savedId)) {
      const i = customs.findIndex((c) => c.id === G.savedId);
      customs[i] = { ...customs[i], notes: clean, stats, updatedAt: Date.now() };
    } else {
      const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      G.savedId = id;
      customs.push({
        id,
        name: G.baseLabel && G.baseLabel !== 'blank'
          ? `手录 · 基于${G.baseLabel} · ${new Date().toLocaleDateString('zh-CN')}`
          : `手录 · ${new Date().toLocaleDateString('zh-CN')}`,
        origin: 'manual',
        keyCount: song.keyCount || 4,
        notes: clean,
        stats,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    updateSong(song.id, { charts: { ...song.charts, custom: customs } });
    G.dirty = false; setDirty(false);
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

  return (
    <div className="game-screen">
      <div ref={containerRef} className="game-canvas-holder" />

      {phase === 'start' && (
        <div className="overlay center-screen">
          <div className="rec-start glass">
            <h2>新建手录谱</h2>
            <div className="muted small">选一个起点。底稿会被深拷贝，原谱不受影响；保存时生成新谱面。</div>
            <div className="rec-start-grid">
              <button className="btn primary" onClick={() => chooseBase('blank', [])}>空白谱</button>
              {stdBases.map(({ dk, chart }) => (
                <button key={dk} className="btn" onClick={() => chooseBase(dk, copyNotes(chart.notes))}>
                  {dk} 谱底稿（{chart.notes.length} notes）
                </button>
              ))}
              {customs.map((c) => (
                <button key={c.id} className="btn" onClick={() => chooseBase(`「${c.name}」`, copyNotes(c.notes))}>
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

      {(phase === 'ready' || phase === 'recording' || phase === 'paused' || phase === 'edit') && (
        <>
          <div className="rec-toolbar glass">
            <button className="btn ghost sm" onClick={requestExit}>退出</button>
            {phase === 'ready' && <button className="btn primary sm" onClick={startRecording}>开始录制（2s 倒计时）</button>}
            {(phase === 'recording' || phase === 'paused') && (
              <button className="btn sm" onClick={() => (phase === 'recording' ? G.pausePlayback() : G.resumeRecording())}>
                {phase === 'recording' ? '暂停' : '继续'}
              </button>
            )}
            <span className="muted small">慢放</span>
            <div className="seg">
              {SPEEDS.map((r) => (
                <button key={r} className={rate === r ? 'on' : ''} onClick={() => { setRate(r); if (G.player) G.player.setRate(r); }}>
                  {r}x
                </button>
              ))}
            </div>
            {phase !== 'edit' ? (
              <>
                <label className="rec-snap">
                  <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
                  吸附十六分
                </label>
                <button className="btn sm" onClick={restartFromHere} title="暂停并清除当前位置之后的音符，倒计时后从此处重录">从此处重录</button>
                <button className="btn sm" onClick={clearTail} title="只清除当前位置之后的音符，不打断录制">清除后续</button>
                <button className="btn sm" onClick={enterEdit}>编辑模式</button>
              </>
            ) : (
              <button className="btn primary sm" onClick={exitEdit}>回到录制</button>
            )}
            <button className="btn sm" onClick={() => G.undo && G.undo()} disabled={!count}>撤销</button>
            <span className="badge dim">{count} notes · {holdCount} hold{G.rewindT != null ? ' · 回退区标灰' : ''}</span>
            <button className="btn primary sm" onClick={saveChart} disabled={!count}>保存谱面{dirty ? ' *' : ''}</button>
          </div>

          <div className="rec-timeline glass" title="拖动定位（回退后音符标灰，重录同刻自动替换）">
            <canvas ref={timelineRef} />
          </div>

          {phase === 'edit' && (
            <div className="rec-editor glass">
              <div className="rec-editor-head">
                <span className="muted small">谱面编辑：点选音符 · 点空白轨道新增（吸附十六分）· 下方面板修改（与音乐轴一致）</span>
                <label className="rec-snap">
                  <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
                  新增吸附
                </label>
              </div>
              <div className="rec-editor-canvas">
                <canvas ref={editorRef} />
              </div>
              {selNote ? (
                <div className="rec-editor-panel">
                  <span className="muted small">选中 #{selIdx + 1} · {fmtT(selNote.t)} · 轨 {selNote.lane} · {selNote.type === 'hold' ? `长按 ${selNote.d.toFixed(2)}s` : '短音'}</span>
                  <button className="btn sm danger" onClick={editDelete}>删除</button>
                  <button className="btn sm" onClick={() => editApply((n) => ({ ...n, t: Math.max(0, +(n.t - 0.05).toFixed(3)) }))}>◀ 0.05s</button>
                  <button className="btn sm" onClick={() => editApply((n) => ({ ...n, t: Math.max(0, +(n.t + 0.05).toFixed(3)) }))}>0.05s ▶</button>
                  <button className="btn sm" onClick={() => editApply((n) => ({ ...n, lane: Math.max(0, Math.min(G.keyCount - 1, n.lane - 1)) }))}>轨◀</button>
                  <button className="btn sm" onClick={() => editApply((n) => ({ ...n, lane: Math.max(0, Math.min(G.keyCount - 1, n.lane + 1)) }))}>轨▶</button>
                  <button className="btn sm" onClick={() => editApply((n) => (n.type === 'hold' ? { ...n, d: Math.max(0.05, +(n.d - 0.1).toFixed(3)) } : { ...n, type: 'hold', d: 0.3 }))}>长−0.1</button>
                  <button className="btn sm" onClick={() => editApply((n) => (n.type === 'hold' ? { ...n, d: +(n.d + 0.1).toFixed(3) } : { ...n, type: 'hold', d: 0.3 }))}>长+0.1</button>
                  <button className="btn sm" onClick={() => editApply((n) => (n.type === 'hold' ? { ...n, type: 'tap', d: undefined } : { ...n, type: 'hold', d: 0.5 }))}>{selNote.type === 'hold' ? '转短音' : '转长按'}</button>
                  <button className="btn ghost sm" onClick={() => setSelIdxSafe(null)}>取消选中</button>
                </div>
              ) : (
                <div className="muted small rec-editor-tip">未选中音符。点时间轴上的音符选中，或点空白轨道新增。</div>
              )}
            </div>
          )}

          {phase === 'recording' && (
            <div className="game-hint">
              {touchMode
                ? '触摸轨道录入 · 按住录长键 · 回退请拖底部时间轴'
                : `按 ${effectiveKeymap(settings, song.keyCount).map((c) => KEY_LABELS[c] || c.replace('Key', '')).join(' ')} 录入 · 按住录长键 · Ctrl+Z 撤销 · Esc 暂停`}
            </div>
          )}
          {phase === 'paused' && (
            <div className="game-hint">已暂停 · 拖底部时间轴回退（之后音符标灰）· 「继续」带缓冲倒计时</div>
          )}
          {phase === 'edit' && (
            <div className="game-hint">编辑模式（已暂停）· Esc 回到录制</div>
          )}
        </>
      )}

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
            <button className="btn" onClick={() => navigate({ screen: 'song', songId })}>前往选曲试玩</button>
            <button className="btn" onClick={() => navigate({ screen: 'axis', songId, chartId: G.savedId })}>在音乐轴上编辑</button>
          </div>
        </div>
      )}

      {toast && <div className="toast glass">{toast}</div>}
    </div>
  );
}
