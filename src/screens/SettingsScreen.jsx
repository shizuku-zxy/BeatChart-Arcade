import React, { useEffect, useRef, useState } from 'react';
import { getCtx, scheduleClick } from '../core/audio.js';
import { setSettings } from '../core/store.js';
import { KEY_LABELS } from '../core/constants.js';

function CalibrationWidget({ latencyMs, onApply }) {
  const [state, setState] = useState('idle'); // idle | running | done
  const [hits, setHits] = useState([]);
  const hitsRef = useRef([]);
  const clicksRef = useRef([]);

  useEffect(() => {
    function onKey(e) {
      if (e.code !== 'Space') return;
      e.preventDefault();
      if (state !== 'running') return;
      const ctx = getCtx();
      const t = ctx.currentTime;
      const clicks = clicksRef.current;
      if (!clicks.length) return;
      let nearest = clicks[0];
      for (const c of clicks) if (Math.abs(c - t) < Math.abs(nearest - t)) nearest = c;
      const diff = t - nearest;
      if (Math.abs(diff) > 0.35) return; // 明显误触
      hitsRef.current.push(diff);
      setHits([...hitsRef.current]);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state]);

  async function start() {
    hitsRef.current = []; setHits([]);
    const ctx = getCtx();
    try { await ctx.resume(); } catch (e) { /* noop */ }
    const beat = 0.6; // 100 BPM
    const n = 12;
    const clicks = [];
    for (let i = 1; i <= n; i++) clicks.push(scheduleClick(ctx.currentTime + 0.8 + i * beat, 0.7));
    clicksRef.current = clicks;
    setState('running');
    setTimeout(() => {
      const hs = hitsRef.current;
      if (hs.length >= 4) {
        const avg = hs.reduce((s, x) => s + x, 0) / hs.length;
        onApply(Math.round(avg * 1000));
        setState('done');
      } else {
        setState('idle');
      }
    }, 0.8 + n * beat + 1.2);
  }

  return (
    <div className="calib glass">
      <div className="calib-head">延迟校准</div>
      <div className="muted small">点击开始后，跟随「嗒、嗒、嗒」的节拍按 <b>空格</b>（{12} 次）。系统将测量你的输入偏差并自动补偿。</div>
      {state === 'running' && (
        <>
          <div className="calib-pulse" />
          <div className="muted">已命中 {hits.length} 次…</div>
        </>
      )}
      {state === 'done' && <div className="calib-done">校准完成！已应用补偿 {latencyMs} ms</div>}
      <button className="btn" onClick={start} disabled={state === 'running'}>
        {state === 'running' ? '校准中…' : '开始校准'}
      </button>
    </div>
  );
}

function KeyBindButton({ code, index, onSet }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    function onKey(e) {
      e.preventDefault();
      onSet(index, e.code);
      setListening(false);
    }
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [listening, index, onSet]);
  return (
    <button
      className={`keycap ${listening ? 'listening' : ''}`}
      onClick={() => setListening(true)}
    >
      {listening ? '按任意键' : (KEY_LABELS[code] || code.replace('Key', ''))}
    </button>
  );
}

export default function SettingsScreen({ state, onClose, onOpenCalib }) {
  const s = state.settings;

  function setKeymap(index, code) {
    const km = [...s.keymap];
    km[index] = code;
    setSettings({ keymap: km });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal glass" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>设置</h2>
          <button className="btn ghost sm" onClick={onClose}>关闭</button>
        </div>

        <div className="settings-grid">
          <section>
            <h3>轨道与键位</h3>
            <div className="row">
              <span className="muted">轨道数</span>
              <span className="badge">固定 4 轨（D F J K）</span>
            </div>
            <div className="row wrap">
              <span className="muted">键位</span>
              {s.keymap.map((c, i) => <KeyBindButton key={i} code={c} index={i} onSet={setKeymap} />)}
            </div>
            <div className="muted small">v1.6.1 起固定 4 轨；导入 6K 谱面会被拒绝，6 轨旧设置自动收敛为 4 轨。</div>
          </section>

          <section>
            <h3>游玩</h3>
            <div className="row">
              <span className="muted">画面模式</span>
              <div className="seg">
                <button className={s.renderMode === 'fall' ? 'on' : ''} onClick={() => setSettings({ renderMode: 'fall' })}>下落式</button>
                <button className={s.renderMode === 'persp' ? 'on' : ''} onClick={() => setSettings({ renderMode: 'persp' })}>透视式</button>
                <button className={s.renderMode !== 'fall' && s.renderMode !== 'persp' ? 'on' : ''} onClick={() => setSettings({ renderMode: null })}>自动</button>
              </div>
            </div>
            <div className="muted small">自动 = 透视式（v1.8.1 起桌面/触屏统一；下落式可手动选）。透视式：音符从屏幕外远端的消失点向各自的轨道落点飞来、逐渐放大（落点仍是同一条判定线）；下落式：竖直下落。两者触摸/键位判定完全相同。</div>
            {onOpenCalib && (
              <div className="row">
                <button className="btn" onClick={onOpenCalib}>🎯 触屏与延迟校准</button>
              </div>
            )}
            <div className="row">
              <span className="muted">下落速度 <b>{s.scrollSpeed}</b></span>
              <input type="range" min="1" max="15" step="1" value={s.scrollSpeed}
                onChange={(e) => setSettings({ scrollSpeed: +e.target.value })} />
              <span className="muted small">1-15 档（判定窗口固定毫秒，与流速无关）</span>
            </div>
            <div className="row">
              <span className="muted">音乐音量 <b>{Math.round(s.volume * 100)}%</b></span>
              <input type="range" min="0" max="1" step="0.05" value={s.volume}
                onChange={(e) => setSettings({ volume: +e.target.value })} />
            </div>
            <div className="row">
              <span className="muted">打击音效</span>
              <div className="seg">
                <button className={s.clickSound !== false ? 'on' : ''} onClick={() => setSettings({ clickSound: true })}>开</button>
                <button className={s.clickSound === false ? 'on' : ''} onClick={() => setSettings({ clickSound: false })}>关</button>
              </div>
            </div>
          </section>

          <section>
            <h3>时序</h3>
            <div className="row">
              <span className="muted">延迟补偿 <b>{s.latencyMs} ms</b></span>
              <input type="range" min="-150" max="300" step="5" value={s.latencyMs}
                onChange={(e) => setSettings({ latencyMs: +e.target.value })} />
            </div>
            <div className="row">
              <span className="muted">谱面偏移 <b>{s.musicOffsetMs} ms</b></span>
              <input type="range" min="-200" max="200" step="5" value={s.musicOffsetMs}
                onChange={(e) => setSettings({ musicOffsetMs: +e.target.value })} />
            </div>
            <div className="muted small">v1.5.0 起自动补偿音频输出延迟（Android 可达 100-250ms，见校准页）；此滑杆为手动微调，正值 = 你整体打得偏晚时增加。</div>
          </section>

          <CalibrationWidget latencyMs={s.latencyMs} onApply={(ms) => setSettings({ latencyMs: ms })} />
        </div>
      </div>
    </div>
  );
}
