import React, { useEffect, useRef, useState } from 'react';
import { updateSong } from '../core/store.js';
import { generateChart, PATTERN_LABELS } from '../core/chartgen.js';
import { regenOutsideSegment } from '../core/chartedit.js';
import { randomSeed } from '../core/prng.js';
import { DIFF_ORDER } from '../core/constants.js';
import { useStore } from '../core/hooks.js';

// 音乐轴：把整首歌的分析结果按时间直观摆开 + 用户微调
// 行1 段落能量（自动检测 + 用户覆盖）  行2 鼓点分轨（kick/snare/hihat）
// 行3 小节线/重复段                    行4 EX 谱 note 分布（或自定谱轨道视图）
// 交互：点能量条切换档位；拖选时间范围设键型偏好；
//       chartId 传入时为自定谱编辑模式（点选/新增/删改 note）

const ENERGY_COLORS = ['#31567d', '#4c8ec4', '#6ec3ff'];
const PATTERNS = ['trill', 'stair', 'jack', 'chord', 'mirror', 'hold', 'auto'];
const HINT_COLORS = {
  trill: '#6ef7d8', stair: '#9db8ff', jack: '#ffd76e',
  chord: '#ff7a9e', mirror: '#c3a3ff', hold: '#7af0b0', auto: 'rgba(110,195,255,0.12)',
};
const LANE_COLORS = ['#6ec3ff', '#6ef7d8', '#ffd76e', '#ff7a9e', '#c3a3ff', '#7af0b0'];

function fmtT(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

export default function MusicAxisScreen({ state, songId, chartId, navigate }) {
  const song = state.library.songs[songId];
  const store = useStore();
  const canvasRef = useRef(null);
  const customChart = chartId ? (song.charts.custom || []).find((c) => c.id === chartId) : null;
  const [editNotes, setEditNotes] = useState(() => (customChart ? customChart.notes.map((n) => ({ ...n })) : []));
  const [selected, setSelected] = useState(null); // 编辑模式选中 note 的索引
  const [editSnap, setEditSnap] = useState(true);
  const [hints, setHints] = useState(() => ({
    energy: (song.hints && song.hints.energy) || [],
    patternHints: (song.hints && song.hints.patternHints) || [],
    repeatMirror: !!(song.hints && song.hints.repeatMirror),
  }));
  const [mode, setMode] = useState(customChart ? 'edit' : 'energy'); // energy | pattern | edit
  const [drag, setDrag] = useState(null); // {x0, x1} 拖选预览（pattern 模式 / 编辑模式保留段选择）
  const [keepMode, setKeepMode] = useState(false);  // 编辑模式子模式：保留段选择（v1.7.0）
  const [keepSel, setKeepSel] = useState(null);     // {start,end} 已选保留段
  const [toast, setToast] = useState(null);
  const dirtyRef = useRef(false);
  const editDirtyRef = useRef(false);
  const hintsRef = useRef(hints);
  hintsRef.current = hints;
  const notesRef = useRef(editNotes);
  notesRef.current = editNotes;

  function flash(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }

  const a = song.analysis;
  const dur = a.durationSec;
  const keyCount = song.keyCount || 4;
  const t2x = (t, W) => (t / dur) * W;
  const x2t = (x, W) => Math.max(0, Math.min(dur, (x / W) * dur));
  const EDIT_LANES_Y = 246;  // 编辑轨道视图起始 y（与 EX 热图同行位置）
  const EDIT_LANE_H = 22;

  /** 吸附到十六分网格 */
  function snapT(t) {
    if (!editSnap || !a.bpm) return t;
    const beat = 60 / a.bpm;
    const b0 = a.beats && a.beats.length ? a.beats[0] : 0;
    const step = beat / 4;
    return Math.max(0, b0 + Math.round((t - b0) / step) * step);
  }

  // ---------- 绘制 ----------
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const parent = cv.parentElement;
    const draw = () => {
      const W = parent.clientWidth;
      const H = customChart ? Math.max(360, EDIT_LANES_Y + keyCount * EDIT_LANE_H + 30) : 360;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = W * dpr; cv.height = H * dpr;
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);

      const rows = customChart
        ? [
          { y: 8, h: 64, label: '段落能量（自动检测）' },
          { y: 84, h: 84, label: '鼓点分轨 ●kick ●snare ●hihat（强弱=亮度）' },
          { y: 180, h: 56, label: '小节线（对齐参考）' },
          { y: 246, h: keyCount * EDIT_LANE_H + 14, label: '自定谱轨道视图（点选编辑 · 点空白新增）' },
        ]
        : [
          { y: 8, h: 64, label: '段落能量（点击切换 低/中/高/自动）' },
          { y: 84, h: 84, label: '鼓点分轨 ●kick ●snare ●hihat（强弱=亮度）' },
          { y: 180, h: 56, label: '小节线与重复段（检测到的副歌再现）' },
          { y: 246, h: 60, label: 'EX 谱 note 分布（密度热图）' },
          { y: 314, h: 38, label: '用户键型偏好（拖选范围设定）' },
        ];

      // 底色 + 行标签
      g.font = '11px "Microsoft YaHei", sans-serif';
      rows.forEach((r) => {
        g.fillStyle = 'rgba(20,32,52,0.4)';
        g.fillRect(0, r.y, W, r.h);
        g.fillStyle = '#7ea4c8';
        g.fillText(r.label, 8, r.y + 14);
      });

      // 行1：段落能量（自动 + 用户覆盖高亮描边）
      const r1 = rows[0];
      const drawSeg = (start, end, level, isUser) => {
        const x0 = t2x(start, W), x1 = Math.max(x0 + 2, t2x(end, W));
        g.fillStyle = ENERGY_COLORS[Math.round(level * 2)];
        g.fillRect(x0, r1.y + 20, x1 - x0 - 1, r1.h - 26);
        if (isUser) {
          g.strokeStyle = '#ffd76e';
          g.lineWidth = 2;
          g.strokeRect(x0 + 1, r1.y + 21, x1 - x0 - 3, r1.h - 28);
        }
      };
      for (const s of a.segments) drawSeg(s.start, s.end, s.energy, false);
      for (const s of hints.energy) drawSeg(s.start, s.end, s.level, true);

      // 行2：鼓点分轨（三行小轨）
      const r2 = rows[1];
      const lanes = [
        { arr: a.drumKicks || [], color: '#6ec3ff', y: r2.y + 26 },
        { arr: a.drumSnares || [], color: '#ffd76e', y: r2.y + 48 },
        { arr: a.drumHihats || [], color: '#ff9ecf', y: r2.y + 70 },
      ];
      for (const L of lanes) {
        g.strokeStyle = 'rgba(110,195,255,0.15)';
        g.beginPath(); g.moveTo(0, L.y); g.lineTo(W, L.y); g.stroke();
        for (const o of L.arr) {
          const x = t2x(o.t, W);
          g.globalAlpha = 0.35 + 0.65 * (o.s || 0.5);
          g.fillStyle = L.color;
          g.fillRect(x - 1, L.y - 6, 2.5, 12);
        }
        g.globalAlpha = 1;
      }

      // 行3：小节线 + 重复段
      const r3 = rows[2];
      if (a.barGrid) {
        g.strokeStyle = 'rgba(110,195,255,0.22)';
        for (const bt of a.barGrid) {
          const x = t2x(bt, W);
          g.beginPath(); g.moveTo(x, r3.y + 18); g.lineTo(x, r3.y + r3.h - 8); g.stroke();
        }
      }
      if (!customChart && a.repeats && a.repeats.length) {
        for (const rp of a.repeats) {
          const x0 = t2x(rp.srcStart, W), x1 = t2x(rp.srcEnd, W);
          const dx0 = t2x(rp.dstStart, W), dx1 = t2x(rp.dstEnd, W);
          g.fillStyle = 'rgba(110,195,255,0.16)';
          g.strokeStyle = 'rgba(110,195,255,0.5)';
          [[x0, x1], [dx0, dx1]].forEach(([xa, xb]) => {
            g.fillRect(xa, r3.y + 22, xb - xa - 1, r3.h - 34);
            g.strokeRect(xa + 0.5, r3.y + 22.5, xb - xa - 2, r3.h - 35);
          });
          // 连接线：源段 → 目标段
          g.strokeStyle = 'rgba(110,195,255,0.35)';
          g.setLineDash([4, 3]);
          g.beginPath(); g.moveTo((x0 + x1) / 2, r3.y + 22); g.lineTo((dx0 + dx1) / 2, r3.y + 22); g.stroke();
          g.setLineDash([]);
        }
        g.fillStyle = '#9db8d8';
        g.fillText(`重复段 ×${a.repeats.length}（可开启“复现”让再现段用同一手感）`, W - 300, r3.y + 16);
      }

      // 行4：EX 热图（普通模式） / 自定谱轨道视图（编辑模式）
      const r4 = rows[3];
      if (customChart) {
        // 每轨一行：tap=方块、hold=横条；选中项金色高亮
        const laneT0 = EDIT_LANES_Y + 14;
        for (let l = 0; l < keyCount; l++) {
          const y = laneT0 + l * EDIT_LANE_H;
          g.fillStyle = l % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.045)';
          g.fillRect(0, y, W, EDIT_LANE_H - 2);
          g.fillStyle = 'rgba(126,164,200,0.55)';
          g.font = '10px Consolas, monospace';
          g.fillText(String(l), 4, y + 13);
        }
        notesRef.current.forEach((n, i) => {
          const x = t2x(n.t, W);
          const y = laneT0 + n.lane * EDIT_LANE_H;
          const isSel = selected === i;
          if (n.type === 'hold') {
            const w = Math.max(3, t2x(n.d, W));
            g.fillStyle = isSel ? '#ffd76e' : (LANE_COLORS[n.lane % LANE_COLORS.length] || '#6ec3ff');
            g.globalAlpha = isSel ? 1 : 0.55;
            g.fillRect(x, y + 6, w, EDIT_LANE_H - 12);
            g.globalAlpha = 1;
          }
          g.fillStyle = isSel ? '#ffd76e' : (LANE_COLORS[n.lane % LANE_COLORS.length] || '#6ec3ff');
          g.fillRect(x - 2.5, y + 2, 5, EDIT_LANE_H - 8);
          if (isSel) {
            g.strokeStyle = '#fff';
            g.lineWidth = 1;
            g.strokeRect(x - 4.5, y + 0.5, 9, EDIT_LANE_H - 5);
          }
        });
      } else {
        const chart = song.charts.EX;
        if (chart) {
          const N = Math.max(120, Math.floor(W));
          const bins = new Float32Array(N);
          for (const n of chart.notes) {
            const i = Math.min(N - 1, Math.floor(t2x(n.t, W)));
            bins[i] += 1;
          }
          const maxB = Math.max(1, ...bins);
          for (let i = 0; i < N; i++) {
            if (!bins[i]) continue;
            const alpha = 0.15 + 0.85 * (bins[i] / maxB);
            g.fillStyle = `rgba(255,122,158,${alpha.toFixed(3)})`;
            g.fillRect((i * W) / N, r4.y + 18, W / N + 1, r4.h - 26);
          }
          g.strokeStyle = 'rgba(255,122,158,0.5)';
          for (const n of chart.notes) {
            if (n.type !== 'hold') continue;
            const x = t2x(n.t, W);
            g.beginPath(); g.moveTo(x, r4.y + 18); g.lineTo(x, r4.y + r4.h - 8); g.stroke();
          }
        }
      }

      // 行5：用户键型偏好色块
      const r5 = rows[4];
      for (const ph of hints.patternHints) {
        const x0 = t2x(ph.start, W), x1 = Math.max(x0 + 2, t2x(ph.end, W));
        g.fillStyle = HINT_COLORS[ph.pattern] || 'rgba(110,195,255,0.2)';
        g.globalAlpha = ph.pattern === 'auto' ? 0.5 : 0.75;
        g.fillRect(x0, r5.y + 16, x1 - x0 - 1, r5.h - 24);
        g.globalAlpha = 1;
        if (x1 - x0 > 34) {
          g.fillStyle = '#07121f';
          g.font = 'bold 11px "Microsoft YaHei", sans-serif';
          g.fillText(PATTERN_LABELS[ph.pattern] || ph.pattern, x0 + 6, r5.y + 31);
        }
      }

      // 拖选预览（v1.7.0 修复：反向拖选（从右往左）也要画框——旧版只画 x1>x0 的正向拖选）
      if (drag) {
        const dx0 = Math.min(drag.x0, drag.x1);
        const dx1 = Math.max(drag.x0, drag.x1);
        if (dx1 > dx0) {
          g.fillStyle = 'rgba(110,195,255,0.18)';
          g.fillRect(dx0, 0, dx1 - dx0, H);
          g.strokeStyle = '#6ec3ff';
          g.strokeRect(dx0 + 0.5, 0.5, dx1 - dx0 - 1, H - 1);
        }
      }

      // 保留段高亮（编辑模式 · 保留段重抽）
      if (customChart && keepSel) {
        const kx0 = t2x(keepSel.start, W);
        const kx1 = Math.max(kx0 + 2, t2x(keepSel.end, W));
        g.fillStyle = 'rgba(255,215,110,0.14)';
        g.fillRect(kx0, 0, kx1 - kx0, H);
        g.strokeStyle = '#ffd76e';
        g.lineWidth = 1.5;
        g.strokeRect(kx0 + 0.75, 0.75, kx1 - kx0 - 1.5, H - 1.5);
      }

      // 时间刻度（每 15s 或按长度自适应）
      g.fillStyle = '#5f7f9f';
      g.font = '10px Consolas, monospace';
      const step = dur > 240 ? 30 : dur > 120 ? 15 : dur > 60 ? 10 : 5;
      for (let t = 0; t <= dur; t += step) {
        const x = t2x(t, W);
        g.fillStyle = 'rgba(110,195,255,0.25)';
        g.fillRect(x, H - 8, 1, 8);
        g.fillStyle = '#5f7f9f';
        g.fillText(fmtT(t), x + 3, H - 10);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [hints, drag, song, customChart, editNotes, selected, keyCount, keepSel]);

  // ---------- 交互 ----------
  const pointer = useRef(null);

  function canvasPos(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, W: rect.width };
  }

  function onPointerDown(e) {
    const p = canvasPos(e);
    pointer.current = p;
    if (mode === 'pattern' || (mode === 'edit' && keepMode)) setDrag({ x0: p.x, x1: p.x });
    if (mode === 'edit' && !keepMode) editClick(p);
  }

  /** 编辑模式点击：命中 note → 选中；命中轨道空白 → 新增 tap */
  function editClick(p) {
    const t = x2t(p.x, p.W);
    const laneT0 = EDIT_LANES_Y + 14;
    const lane = Math.floor((p.y - laneT0) / EDIT_LANE_H);
    if (lane < 0 || lane >= keyCount) { setSelected(null); return; }
    // 命中检测：时间半径与像素宽度挂钩（8px 容差）
    const tTol = Math.max(0.04, (8 / p.W) * dur);
    let hitIdx = -1;
    let hitD = Infinity;
    notesRef.current.forEach((n, i) => {
      if (n.lane !== lane) return;
      // hold 身体也可选中
      const within = n.type === 'hold' ? (t >= n.t - tTol && t <= n.t + n.d + tTol) : Math.abs(n.t - t) <= tTol;
      if (!within) return;
      const d = Math.abs(n.t - t);
      if (d < hitD) { hitD = d; hitIdx = i; }
    });
    if (hitIdx >= 0) { setSelected(hitIdx); return; }
    // 空白 → 新增 tap（吸附）
    const nt = snapT(t);
    const notes = [...notesRef.current, { t: +nt.toFixed(3), lane, type: 'tap' }].sort((x, y) => x.t - y.t);
    setEditNotes(notes);
    setSelected(notes.findIndex((n) => n.t === +nt.toFixed(3) && n.lane === lane));
    editDirtyRef.current = true;
  }

  // ---------- 编辑操作（选中 note 的增删改） ----------
  function editUpdate(fn) {
    if (selected == null || !editNotes[selected]) return;
    const notes = editNotes.map((n, i) => (i === selected ? fn({ ...n }) : n));
    setEditNotes(notes);
    editDirtyRef.current = true;
  }

  function editDelete() {
    if (selected == null) return;
    setEditNotes(editNotes.filter((_, i) => i !== selected));
    setSelected(null);
    editDirtyRef.current = true;
  }

  function editShiftTime(dt) { editUpdate((n) => ({ ...n, t: Math.max(0, +(n.t + dt).toFixed(3)) })); }
  function editShiftLane(dl) { editUpdate((n) => ({ ...n, lane: Math.max(0, Math.min(keyCount - 1, n.lane + dl)) })); }
  function editHoldD(dd) { editUpdate((n) => (n.type === 'hold' ? { ...n, d: Math.max(0.05, +(n.d + dd).toFixed(3)) } : { ...n, type: 'hold', d: 0.3 })); }
  function editToggleType() { editUpdate((n) => (n.type === 'hold' ? { ...n, type: 'tap', d: undefined } : { ...n, type: 'hold', d: 0.5 })); }

  function saveEdit() {
    if (!customChart) return;
    const notes = editNotes.map((n) => (n.type === 'hold'
      ? { t: +n.t.toFixed(3), lane: n.lane, type: 'hold', d: +n.d.toFixed(3) }
      : { t: +n.t.toFixed(3), lane: n.lane, type: 'tap' })).sort((x, y) => x.t - y.t);
    const customs = (song.charts.custom || []).map((c) => (c.id === customChart.id
      ? {
        ...c,
        notes,
        stats: {
          noteCount: notes.length,
          holdCount: notes.filter((n) => n.type === 'hold').length,
          density: dur > 1 ? +(notes.length / dur).toFixed(2) : 0,
          patternCounts: {},
        },
        updatedAt: Date.now(),
      }
      : c));
    updateSong(song.id, { charts: { ...song.charts, custom: customs } });
    editDirtyRef.current = false;
    flash(`已保存「${customChart.name}」（${notes.length} notes）`);
  }

  function onPointerMove(e) {
    if (!pointer.current) return;
    if (mode !== 'pattern' && !(mode === 'edit' && keepMode)) return;
    const p = canvasPos(e);
    setDrag((d) => (d ? { ...d, x1: p.x } : d));
  }

  function onPointerUp(e) {
    const p = canvasPos(e);
    const startP = pointer.current;
    pointer.current = null;
    if (!startP) return;
    if (mode === 'edit') return; // 编辑模式单击已处理

    if (mode === 'energy') {
      // 点击段落能量条：命中已有 hint → 循环档位；否则在自动段落上新建 hint
      const t = x2t(p.x, p.W);
      const hit = hints.energy.findIndex((s) => t >= s.start && t <= s.end);
      if (hit >= 0) {
        const cur = hints.energy[hit];
        const nextLevel = cur.level >= 1 ? null : cur.level + 0.5;
        const energy = [...hints.energy];
        if (nextLevel == null) energy.splice(hit, 1); // 回到自动
        else energy[hit] = { ...cur, level: nextLevel };
        setHints({ ...hints, energy });
        dirtyRef.current = true;
      } else {
        // 找到点击处的自动段落 → 以该段落为范围建 hint（0.5 起）
        const seg = a.segments.find((s) => t >= s.start && t <= s.end);
        if (seg) {
          setHints({ ...hints, energy: [...hints.energy, { start: seg.start, end: seg.end, level: 1 }] });
          dirtyRef.current = true;
          flash(`已把 ${fmtT(seg.start)} 段设为高能量（再点两下可调低/恢复自动）`);
        }
      }
      return;
    }

    if (mode === 'edit' && keepMode) {
      // 保留段重抽：拖选完成 → 记录保留范围（段外重抽由按钮触发）
      const d = drag;
      setDrag(null);
      if (!d || Math.abs(d.x1 - d.x0) < 6) return;
      const t0 = x2t(Math.min(d.x0, d.x1), p.W);
      const t1 = x2t(Math.max(d.x0, d.x1), p.W);
      if (t1 - t0 < 0.5) { flash('保留段太短（至少 0.5 秒）'); return; }
      setKeepSel({ start: +t0.toFixed(2), end: +t1.toFixed(2) });
      return;
    }

    // pattern 模式：拖选完成 → 弹键型选择（由 patternPicker 状态驱动）
    const d = drag;
    setDrag(null);
    if (!d || Math.abs(d.x1 - d.x0) < 6) return;
    const t0 = x2t(Math.min(d.x0, d.x1), p.W);
    const t1 = x2t(Math.max(d.x0, d.x1), p.W);
    setPickRange({ start: t0, end: t1 });
  }

  const [pickRange, setPickRange] = useState(null); // {start,end} 待选键型的范围

  function applyPick(pattern) {
    if (!pickRange) return;
    // 与既有 hint 合并/覆盖重叠区
    let ph = hints.patternHints.filter(
      (h) => !(pickRange.start < h.end && h.start < pickRange.end)
    );
    if (pattern !== 'auto') {
      ph = [...ph, { start: +pickRange.start.toFixed(2), end: +pickRange.end.toFixed(2), pattern }];
    }
    setHints({ ...hints, patternHints: ph });
    dirtyRef.current = true;
    setPickRange(null);
    flash(pattern === 'auto' ? '已清除该范围的偏好' : `已设为「${PATTERN_LABELS[pattern]}」，重抽后生效`);
  }

  function save() {
    updateSong(song.id, { hints });
    dirtyRef.current = false;
    flash('已保存，点“重新生成三档”后生效');
  }

  /** v1.7.0 保留段重抽：保留段内音符原样保留，段外按新 seed 重新生成（密度自动匹配档位），拼接处冲突清理 */
  function applyKeepRegen() {
    if (!keepSel || !customChart) return;
    const keptCount = editNotes.filter((n) => n.t >= keepSel.start && n.t <= keepSel.end).length;
    const sec = Math.round(keepSel.end - keepSel.start);
    if (!window.confirm(
      `保留 ${fmtT(keepSel.start)}–${fmtT(keepSel.end)}（约 ${sec}s）内的 ${keptCount} 个音符，`
      + `段外按新 seed 重新生成（密度自动匹配 E/H/EX 档位，拼接处自动清理冲突）。确定？`
    )) return;
    const r = regenOutsideSegment(editNotes, a, keyCount, hints, keepSel.start, keepSel.end, randomSeed());
    setEditNotes(r.notes);
    editDirtyRef.current = true;
    setKeepSel(null);
    setKeepMode(false);
    setSelected(null);
    flash(`已保留段内 ${keptCount} 个音符，段外按 ${r.diffKey} 档密度重抽（新 seed ${r.seed}，共 ${r.notes.length} notes），记得保存谱面`);
  }

  function regenAll() {
    const keyCount = song.keyCount || 4;
    const charts = {};
    for (const dk of DIFF_ORDER) {
      const old = song.charts[dk];
      const gen = generateChart(a, dk, old.seed, keyCount, hints);
      charts[dk] = {
        seed: old.seed,
        notes: gen.notes,
        stats: gen.stats,
        updatedAt: Date.now(),
        history: [...(old.history || []), { seed: old.seed, notes: old.notes, stats: old.stats }].slice(-12),
      };
    }
    updateSong(song.id, { hints, charts });
    dirtyRef.current = false;
    flash('三档已按微调重新生成（seed 不变，选曲页可回退）');
  }

  if (!song) {
    return (
      <div className="screen center-screen">
        <div className="empty-state">歌曲不存在</div>
        <button className="btn" onClick={() => navigate({ screen: 'library' })}>返回曲库</button>
      </div>
    );
  }

  const sel = selected != null ? editNotes[selected] : null;

  return (
    <div className="screen axis-screen">
      <header className="topbar">
        <button className="btn ghost" onClick={() => navigate({ screen: 'song', songId })}>← 返回选曲</button>
        <div className="topbar-title">🎛 {customChart ? `编辑 · ${customChart.name}` : `音乐轴 · ${song.title}`}</div>
        <div className="topbar-actions">
          {customChart ? (
            <>
              <button className="btn ghost" onClick={() => navigate({ screen: 'game', songId, diff: customChart.id, runId: Date.now() })}>▶ 试玩</button>
              <button className="btn primary" disabled={!editDirtyRef.current} onClick={saveEdit}>💾 保存谱面</button>
            </>
          ) : (
            <>
              <button className="btn ghost" disabled={!dirtyRef.current} onClick={save}>💾 保存微调</button>
              <button className="btn primary" onClick={regenAll}>⚡ 重新生成三档</button>
            </>
          )}
        </div>
      </header>

      <div className="axis-body">
        <div className="axis-toolbar glass">
          {customChart ? (
            <>
              <span className="muted">谱面编辑：</span>
              <span className="muted small">{keepMode ? '拖选要保留的段落' : '点选音符编辑 · 点空白轨道新增 · 下方面板操作'}</span>
              <span className="muted small">│</span>
              <span className="muted small">子模式：</span>
              <div className="seg">
                <button className={!keepMode ? 'on' : ''} onClick={() => { setKeepMode(false); setDrag(null); }}>编辑音符</button>
                <button className={keepMode ? 'on' : ''} onClick={() => { setKeepMode(true); setDrag(null); setSelected(null); }}>保留段重抽</button>
              </div>
              {keepMode && (
                keepSel ? (
                  <>
                    <span className="badge">保留 {fmtT(keepSel.start)}–{fmtT(keepSel.end)} · 段内 {editNotes.filter((n) => n.t >= keepSel.start && n.t <= keepSel.end).length} notes</span>
                    <button className="btn primary sm" onClick={applyKeepRegen}>重抽段外</button>
                    <button className="btn ghost sm" onClick={() => setKeepSel(null)}>清除选择</button>
                  </>
                ) : (
                  <span className="muted small">在时间轴上拖选要保留的段落，段外按新 seed 重新生成（密度自动匹配档位）</span>
                )
              )}
              <span className="muted small">│</span>
              <label className="rec-snap">
                <input type="checkbox" checked={editSnap} onChange={(e) => setEditSnap(e.target.checked)} />
                新增吸附十六分
              </label>
              <span className="badge dim">{editNotes.length} notes</span>
            </>
          ) : (
            <>
              <span className="muted">编辑模式：</span>
              <div className="seg">
                <button className={mode === 'energy' ? 'on' : ''} onClick={() => setMode('energy')}>段落能量</button>
                <button className={mode === 'pattern' ? 'on' : ''} onClick={() => setMode('pattern')}>键型偏好（拖选）</button>
              </div>
              <span className="muted small">│</span>
              <span className="muted small">重复段复现：</span>
              <div className="seg">
                <button className={!hints.repeatMirror ? 'on' : ''} onClick={() => { setHints({ ...hints, repeatMirror: false }); dirtyRef.current = true; }}>关（默认）</button>
                <button className={hints.repeatMirror ? 'on' : ''} onClick={() => { setHints({ ...hints, repeatMirror: true }); dirtyRef.current = true; }}>开（再现段同手感）</button>
              </div>
              <span className="muted small">│</span>
              <span className="muted small">
                BPM {a.bpm} · {a.meter === 3 ? '3' : '4'}/4 · 调性 {a.key ? `${a.key.tonic}${a.key.mode === 'minor' ? '小' : '大'}` : '—'}
                · tatum {a.tatum || '—'}
              </span>
            </>
          )}
        </div>

        <div className="axis-canvas-wrap glass">
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => { pointer.current = null; setDrag(null); }}
          />
        </div>

        <div className="axis-legend muted small">
          {customChart
            ? (keepMode
              ? '保留段重抽：拖选时间段 → 点「重抽段外」。段内音符原样保留，段外按新 seed 重新生成，拼接处自动清理同轨冲突。'
              : '图例：每行=一条轨道，方块=短音，长条=长按；金色=选中，灰色=回退区保留待重录。点选音符后用下方面板修改。')
            : '图例：能量 蓝=低/中/高（金框=手动）；鼓点亮度=强度；重复段虚线连接源→再现；note 热图=当前 EX 谱（粉=密度，竖线=hold）。'}
          {!customChart && (mode === 'energy' ? '点击能量条上的段落可循环调整。' : '在时间轴上按住拖动选择范围，松开后选键型。')}
        </div>

        {customChart && sel && (
          <div className="axis-toolbar glass edit-panel">
            <span className="muted small">选中 #{selected + 1} · {fmtT(sel.t)} · 轨 {sel.lane} · {sel.type === 'hold' ? `长按 ${sel.d.toFixed(2)}s` : '短音'}</span>
            <button className="btn sm danger" onClick={editDelete}>🗑 删除</button>
            <button className="btn sm" onClick={() => editShiftTime(-0.05)}>◀ 0.05s</button>
            <button className="btn sm" onClick={() => editShiftTime(0.05)}>0.05s ▶</button>
            <button className="btn sm" onClick={() => editShiftLane(-1)}>轨◀</button>
            <button className="btn sm" onClick={() => editShiftLane(1)}>轨▶</button>
            <button className="btn sm" onClick={() => editHoldD(-0.1)}>长−0.1</button>
            <button className="btn sm" onClick={() => editHoldD(0.1)}>长+0.1</button>
            <button className="btn sm" onClick={editToggleType}>{sel.type === 'hold' ? '转短音' : '转长按'}</button>
            <button className="btn ghost sm" onClick={() => setSelected(null)}>取消选中</button>
          </div>
        )}
      </div>

      {pickRange && (
        <div className="modal-overlay" onClick={() => setPickRange(null)}>
          <div className="modal glass pick-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>该范围用什么键型？</h2>
              <span className="muted small">{fmtT(pickRange.start)} → {fmtT(pickRange.end)}（{Math.round(pickRange.end - pickRange.start)}s）</span>
            </div>
            <div className="pick-grid">
              {PATTERNS.map((p) => (
                <button key={p} className="pick-btn" style={{ borderColor: HINT_COLORS[p] }} onClick={() => applyPick(p)}>
                  <span className="pick-dot" style={{ background: HINT_COLORS[p] }} />
                  {p === 'auto' ? '恢复自动' : PATTERN_LABELS[p]}
                </button>
              ))}
            </div>
            <div className="muted small">E 档可能不支持部分键型（如多压），不受影响的档位仍会应用。</div>
          </div>
        </div>
      )}

      {toast && <div className="toast glass">{toast}</div>}
    </div>
  );
}
