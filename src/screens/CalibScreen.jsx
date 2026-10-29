// ============ 触屏与延迟校准页：真机排查"UI 与判定不对齐" ============
// 三块能力：
//   1. 音频管线信息：采样率 / baseLatency / outputLatency / 自动补偿合计
//   2. 触屏节拍校准：节拍器点击 + 跟拍点按 → 测量平均偏差 → 一键应用延迟补偿
//   3. 触点几何检测：复刻游戏内轨道几何，实时画触点/命中轨道/坐标日志，
//      直接验证"点到的位置 ↔ 判定的轨道"是否对齐（真机肉眼可查）

import React, { useEffect, useRef, useState } from 'react';
import { getCtx, scheduleClick, getAudioOutLatency } from '../core/audio.js';
import { setSettings } from '../core/store.js';
import { effectiveKeymap, resolveRenderMode } from '../core/constants.js';

const JUDGE_WINDOWS_MS = { perfect: 50, great: 100, good: 150 };

export default function CalibScreen({ state, navigate }) {
  const s = state.settings;
  const keyCount = s.keyCount === 6 ? 6 : 4;
  const canvasRef = useRef(null);
  const geoRef = useRef(null);
  const tapsRef = useRef([]);      // 触点日志 {x,y,lane,hit}
  const [taps, setTaps] = useState([]);
  const [audioInfo, setAudioInfo] = useState(null);
  const [calib, setCalib] = useState({ phase: 'idle', hits: [] }); // idle | running | done
  const calibRef = useRef({ clicks: [], hits: [] });

  // ---- 音频管线信息 ----
  useEffect(() => {
    const ctx = getCtx();
    ctx.resume().catch(() => {});
    const read = () => setAudioInfo({
      sampleRate: ctx.sampleRate,
      baseLatency: Number(ctx.baseLatency) || 0,
      outputLatency: Number(ctx.outputLatency) || 0,
      autoMs: Math.round(getAudioOutLatency(ctx) * 1000),
    });
    read();
    const t = setTimeout(read, 600); // resume 后读数更可靠，再读一次
    return () => clearTimeout(t);
  }, []);

  // ---- 触点几何检测画布（按实际渲染模式复刻：下落式 / 透视式） ----
  const renderMode = resolveRenderMode(s);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');

    function layout() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = canvas.clientWidth || 600;
      const H = Math.max(220, Math.min(300, Math.round(W * 0.42)));
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 与 GameRenderer/PerspectiveRenderer._layout 相同的几何
      const laneW = Math.min(130, Math.max(70, W / (keyCount + 2.2)));
      const fieldW = laneW * keyCount;
      const fieldX = (W - fieldW) / 2;
      const judgeY = H * 0.84;
      const geo = { W, H, laneW, fieldW, fieldX, judgeY };
      if (renderMode === 'persp') {
        geo.vpX = W * 0.5;
        geo.vpY = -H * 0.25; // 与 PerspectiveRenderer v1.6.1 一致（消失点 -0.25H）
        geo.sAt = (y) => {
          if (y >= judgeY) return 1;
          if (y <= 0) return (0 - geo.vpY) / (judgeY - geo.vpY);
          return (y - geo.vpY) / (judgeY - geo.vpY);
        };
        geo.edgeAt = (xBot, y) => geo.vpX + (xBot - geo.vpX) * geo.sAt(y);
      }
      geoRef.current = geo;
      draw();
    }

    function hitTest(x, y) {
      const g = geoRef.current;
      if (!g || y < 0 || y > g.H) return -1;
      if (renderMode === 'persp') {
        // v1.5.2：与游戏内透视 hitTest 完全一致（按触点高度的透视几何吸附）
        const s = g.sAt(y);
        const lo = g.edgeAt(g.fieldX, y) - g.laneW * s * 0.5;
        const hi = g.edgeAt(g.fieldX + g.fieldW, y) + g.laneW * s * 0.5;
        if (x < lo || x > hi) return -1;
        let best = -1, bestD = Infinity;
        for (let l = 0; l < keyCount; l++) {
          const cx = g.edgeAt(g.fieldX + (l + 0.5) * g.laneW, y);
          const d = Math.abs(x - cx);
          if (d < bestD) { bestD = d; best = l; }
        }
        return best;
      }
      const lo = g.fieldX - g.laneW * 0.5;
      const hi = g.fieldX + g.fieldW + g.laneW * 0.5;
      if (x < lo || x > hi) return -1;
      const l = Math.floor((x - g.fieldX + g.laneW * 0.5) / g.laneW);
      return Math.max(0, Math.min(keyCount - 1, l));
    }

    function draw() {
      const g = geoRef.current;
      if (!g) return;
      const { W, H, laneW, fieldW, fieldX, judgeY, vpX, vpY } = g;
      const edgeAtTop = renderMode === 'persp'
        ? (xBot) => vpX + (xBot - vpX) * ((0 - vpY) / (judgeY - vpY))
        : (xBot) => xBot;
      ctx2d.clearRect(0, 0, W, H);
      // 轨道底色（透视式为梯形）
      for (let l = 0; l < keyCount; l++) {
        const xL = fieldX + l * laneW;
        const xR = xL + laneW;
        ctx2d.fillStyle = l % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)';
        if (renderMode === 'persp') {
          ctx2d.beginPath();
          ctx2d.moveTo(edgeAtTop(xL), 0);
          ctx2d.lineTo(edgeAtTop(xR), 0);
          ctx2d.lineTo(xR, judgeY);
          ctx2d.lineTo(xL, judgeY);
          ctx2d.closePath();
          ctx2d.fill();
        } else {
          ctx2d.fillRect(xL, 0, laneW, judgeY);
        }
      }
      // 边框（透视式：向消失点汇聚）
      ctx2d.strokeStyle = 'rgba(110,195,255,0.4)';
      ctx2d.beginPath();
      ctx2d.moveTo(edgeAtTop(fieldX), 0); ctx2d.lineTo(fieldX, judgeY);
      ctx2d.moveTo(edgeAtTop(fieldX + fieldW), 0); ctx2d.lineTo(fieldX + fieldW, judgeY);
      ctx2d.stroke();
      if (renderMode === 'persp') {
        ctx2d.strokeStyle = 'rgba(255,255,255,0.08)';
        for (let l = 1; l < keyCount; l++) {
          ctx2d.beginPath();
          ctx2d.moveTo(edgeAtTop(fieldX + l * laneW), 0);
          ctx2d.lineTo(fieldX + l * laneW, judgeY);
          ctx2d.stroke();
        }
      }
      // 判定线 + 每轨中心标记（中心标记沿轨道透视位置，高度 judgeY-40 处更直观）
      ctx2d.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx2d.lineWidth = 3;
      ctx2d.beginPath();
      ctx2d.moveTo(fieldX - 12, judgeY); ctx2d.lineTo(fieldX + fieldW + 12, judgeY);
      ctx2d.stroke();
      ctx2d.lineWidth = 1;
      ctx2d.fillStyle = '#fff';
      for (let l = 0; l < keyCount; l++) {
        const cx = fieldX + (l + 0.5) * laneW;
        ctx2d.beginPath();
        ctx2d.moveTo(cx, judgeY - 8); ctx2d.lineTo(cx + 6, judgeY);
        ctx2d.lineTo(cx, judgeY + 8); ctx2d.lineTo(cx - 6, judgeY);
        ctx2d.closePath(); ctx2d.fill();
      }
      // 键位标签
      const km = effectiveKeymap(s, keyCount);
      ctx2d.fillStyle = 'rgba(143,184,221,0.9)';
      ctx2d.font = '700 13px Consolas, monospace';
      ctx2d.textAlign = 'center';
      for (let l = 0; l < keyCount; l++) {
        ctx2d.fillText(km[l].replace('Key', ''), fieldX + (l + 0.5) * laneW, judgeY + 22);
      }
      // 触点（新的亮、旧的淡）+ 命中轨道高亮（透视式沿梯形）
      const list = tapsRef.current.slice(-12);
      list.forEach((tp, i) => {
        const age = list.length - 1 - i;
        const a = Math.max(0.25, 1 - age * 0.09);
        if (tp.lane >= 0) {
          ctx2d.strokeStyle = `rgba(110,195,255,${a})`;
          ctx2d.lineWidth = 2;
          const xL = fieldX + tp.lane * laneW;
          const xR = xL + laneW;
          if (renderMode === 'persp') {
            ctx2d.beginPath();
            ctx2d.moveTo(edgeAtTop(xL), 0);
            ctx2d.lineTo(edgeAtTop(xR), 0);
            ctx2d.lineTo(xR, judgeY);
            ctx2d.lineTo(xL, judgeY);
            ctx2d.closePath();
            ctx2d.stroke();
          } else {
            ctx2d.strokeRect(xL + 2, 2, laneW - 4, judgeY - 4);
          }
        }
        ctx2d.fillStyle = tp.lane >= 0 ? `rgba(110,229,216,${a})` : `rgba(255,110,122,${a})`;
        ctx2d.beginPath();
        ctx2d.arc(tp.x, tp.y, 8, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.fillStyle = `rgba(255,255,255,${a})`;
        ctx2d.font = '11px Consolas, monospace';
        ctx2d.textAlign = 'left';
        ctx2d.fillText(`${tp.lane >= 0 ? '轨' + tp.lane : '未命中'}`, tp.x + 12, tp.y - 10);
      });
    }

    function onPointer(e) {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const lane = hitTest(x, y);
      tapsRef.current.push({ x, y, lane, hit: lane >= 0 });
      if (tapsRef.current.length > 40) tapsRef.current.shift();
      setTaps([...tapsRef.current.slice(-8)]);
      draw();
    }

    layout();
    canvas.addEventListener('pointerdown', onPointer);
    window.addEventListener('resize', layout);
    return () => {
      canvas.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('resize', layout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyCount, renderMode]);

  // ---- 触屏节拍校准 ----
  async function startCalib() {
    const ctx = getCtx();
    try { await ctx.resume(); } catch (e) { /* noop */ }
    calibRef.current = { clicks: [], hits: [] };
    setCalib({ phase: 'running', hits: [] });
    const beat = 0.6;
    const n = 12;
    const clicks = [];
    for (let i = 1; i <= n; i++) clicks.push(scheduleClick(ctx.currentTime + 0.8 + i * beat, 0.75));
    calibRef.current.clicks = clicks;
    setTimeout(() => {
      const hs = calibRef.current.hits;
      if (hs.length >= 4) {
        setCalib({ phase: 'done', hits: [...hs] });
      } else {
        setCalib({ phase: 'idle', hits: [] });
      }
    }, 0.8 + n * beat + 1.0);
  }

  function onCalibTap(e) {
    e.preventDefault();
    if (calib.phase !== 'running') return;
    const ctx = getCtx();
    const t = ctx.currentTime;
    const clicks = calibRef.current.clicks;
    if (!clicks.length) return;
    let nearest = clicks[0];
    for (const c of clicks) if (Math.abs(c - t) < Math.abs(nearest - t)) nearest = c;
    const diff = t - nearest;
    if (Math.abs(diff) > 0.35) return; // 误触
    calibRef.current.hits.push(diff);
    setCalib({ phase: 'running', hits: [...calibRef.current.hits] });
  }

  const avgMs = calib.hits.length
    ? Math.round((calib.hits.reduce((a, b) => a + b, 0) / calib.hits.length) * 1000)
    : null;
  const sdMs = calib.hits.length > 1
    ? Math.round(Math.sqrt(calib.hits.reduce((a, b) => a + (b * 1000 - avgMs) ** 2, 0) / calib.hits.length))
    : null;

  return (
    <div className="screen">
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark">🎯</div>
          <div>
            <div className="brand-name">触屏与延迟校准</div>
            <div className="brand-sub">排查"点不到 / UI 与判定不对齐"</div>
          </div>
        </div>
        <button className="btn" onClick={() => navigate({ screen: 'library' })}>返回曲库</button>
      </div>

      <div className="library-body calib-body">
        <section className="glass calib-section">
          <h3>① 音频管线（自动补偿）</h3>
          {audioInfo ? (
            <div className="calib-info">
              <div>采样率：<b>{audioInfo.sampleRate} Hz</b></div>
              <div>baseLatency：<b>{(audioInfo.baseLatency * 1000).toFixed(1)} ms</b>（处理固有延迟）</div>
              <div>outputLatency：<b>{(audioInfo.outputLatency * 1000).toFixed(1)} ms</b>（到扬声器延迟）</div>
              <div className="calib-sum">游戏内已自动补偿合计 <b>{audioInfo.autoMs} ms</b>（v1.5.0 起，无需手动设置）</div>
              {audioInfo.outputLatency === 0 && (
                <div className="muted small">⚠ 本环境 outputLatency 读数为 0——若游玩仍总觉得"晚"，请用下方节拍校准补手动补偿。</div>
              )}
            </div>
          ) : <div className="muted">读取中…</div>}
        </section>

        <section className="glass calib-section">
          <h3>② 触点几何检测（验证点到=判到）</h3>
          <div className="muted small">在下方面板任意位置点按：触点应精确出现在手指处，并高亮将判定的轨道；判定线中点=每轨中心菱形。</div>
          <canvas ref={canvasRef} className="calib-canvas" />
          <div className="muted small tap-log">
            {taps.length
              ? taps.slice().reverse().map((tp, i) => (
                <span key={i}>[{tp.x.toFixed(0)},{tp.y.toFixed(0)}]→{tp.lane >= 0 ? `轨${tp.lane}` : '未命中'}　</span>
              ))
              : '（尚未点按）'}
          </div>
        </section>

        <section className="glass calib-section">
          <h3>③ 触屏节拍校准（手动微调）</h3>
          <div className="muted small">开始后跟随"嗒、嗒、嗒"节拍，在大按钮上同步点按 8 次以上。测得平均偏差将叠加到延迟补偿上。</div>
          <div className="calib-pad glass" onPointerDown={onCalibTap}>
            {calib.phase === 'running'
              ? <div><div className="calib-pulse" /><div>已点按 {calib.hits.length} 次…（跟着节拍点这里）</div></div>
              : <div>点这里跟拍</div>}
          </div>
          {calib.phase === 'done' && (
            <div className="calib-done">
              完成：{calib.hits.length} 次 · 平均 {avgMs > 0 ? '晚' : '早'} {Math.abs(avgMs)} ms · 波动 ±{sdMs} ms
              <button
                className="btn primary sm"
                onClick={() => setSettings({ latencyMs: Math.max(-150, Math.min(300, avgMs)) })}
              >
                应用补偿 {Math.max(-150, Math.min(300, avgMs))} ms
              </button>
            </div>
          )}
          {calib.phase === 'idle' && <button className="btn" onClick={startCalib}>开始校准</button>}
          <div className="muted small">当前手动补偿：{s.latencyMs} ms（正值=你觉得打得偏晚时增加）。判定窗口参考：PERFECT ±{JUDGE_WINDOWS_MS.perfect} / GREAT ±{JUDGE_WINDOWS_MS.great} / GOOD ±{JUDGE_WINDOWS_MS.good} ms。</div>
        </section>
      </div>
    </div>
  );
}
