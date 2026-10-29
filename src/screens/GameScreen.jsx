import React, { useEffect, useRef, useState } from 'react';
import { getCtx, decodeFile, SongPlayer, playClick, getAudioOutLatency } from '../core/audio.js';
import { JudgeEngine } from '../game/Engine.js';
import { GameRenderer } from '../game/Renderer.js';
import { PerspectiveRenderer } from '../game/PerspectiveRenderer.js';
import { loadAudioBlob, updateSong } from '../core/store.js';
import { DIFFICULTIES, speedToApproach, KEY_LABELS, RANK_TABLE, effectiveKeymap, resolveRenderMode, isTouchDevice } from '../core/constants.js';

function rankFor(acc) {
  for (const r of RANK_TABLE) if (acc >= r.min) return r.rank;
  return 'D';
}

export default function GameScreen({ state, songId, diff, navigate }) {
  const song = state.library.songs[songId];
  const settings = state.settings;
  const containerRef = useRef(null);
  const [phase, setPhase] = useState('loading'); // loading | playing | paused | done
  const phaseRef = useRef('loading');
  const [err, setErr] = useState(null);
  const [pauseStats, setPauseStats] = useState(null);
  const G = useRef({}).current;

  const setPhaseSafe = (p) => { phaseRef.current = p; setPhase(p); };

  useEffect(() => {
    let disposed = false;
    const container = containerRef.current;
    // v1.6.0：diff 可以是 E/H/EX 或自定谱 id（c 开头）
    const isCustom = diff && String(diff).startsWith('c');
    const customChart = isCustom ? (song.charts.custom || []).find((c) => c.id === diff) : null;
    const D = customChart || DIFFICULTIES[diff];

    async function boot() {
      try {
        const blob = await loadAudioBlob(song.id, song.ext);
        if (!blob) throw new Error('找不到音频文件，请重新导入该歌曲');
        if (disposed) return;
        const buffer = await decodeFile(blob);
        if (disposed) return;

        const player = new SongPlayer(buffer);
        player.setVolume(settings.volume);
        const engine = new JudgeEngine((customChart ? customChart.notes : song.charts[diff].notes) || [], {
          onJudge: (note, judge, isTail, offset) => {
            if (G.renderer) {
              // v1.5.0：判定反馈画在被击打轨道上方（不再画在屏幕中央），并携带早/晚偏移
              G.renderer.showJudge(judge, note && note.lane,
                offset != null && Number.isFinite(offset) ? offset * 1000 : null, isTail);
              if (note && note.lane != null && judge !== 'miss') G.renderer.laneHit(note.lane);
            }
            if (settings.clickSound !== false && judge !== 'miss') {
              try { playClick(judge === 'perfect' ? 0.4 : 0.3, judge === 'perfect' ? 2100 : 1700); } catch (e) { /* noop */ }
            }
          },
          onFinish: (stats) => {
            if (disposed) return;
            setPhaseSafe('done');
            // v1.8.1 修复「结算时冒出 GO」：stop() 会把时间锚重置为 0，渲染循环在
            // 900ms 结算延迟内继续跑 → render(0) 命中倒计时分支的 GO 帧。
            // pause() 停声且时间锚定在结束位置（>0.6s 不触发倒计时分支）。
            player.pause();
            // 保存最高分（自定谱记在 custom:id 键下）
            const scoreKey = isCustom ? 'custom:' + diff : diff;
            const prev = song.scores && song.scores[scoreKey];
            const better = !prev || stats.score > prev.score;
            if (better) {
              updateSong(song.id, {
                scores: { ...(song.scores || {}), [scoreKey]: { score: stats.score, accuracy: stats.accuracy, rank: rankFor(stats.accuracy), maxCombo: stats.maxCombo, fullCombo: stats.fullCombo, at: Date.now() } },
              });
            }
            setTimeout(() => {
              if (!disposed) {
                navigate({
                  screen: 'result',
                  result: { songId, diff, stats, isNewRecord: better, title: song.title },
                });
              }
            }, 900);
          },
        });

        const keymap = effectiveKeymap(settings, song.keyCount);
        const keyLabels = keymap.map((c) => KEY_LABELS[c] || c.replace('Key', ''));
        const renderMode = resolveRenderMode(settings);
        const RendererCls = renderMode === 'persp' ? PerspectiveRenderer : GameRenderer;
        const renderer = new RendererCls(container, {
          keyCount: song.keyCount || 4,
          approach: speedToApproach(settings.scrollSpeed),
          diffColor: D.color || 0xffd76e,
          keyLabels,
        });
        renderer.setInfo(song.title, buffer.duration);
        // v1.5.1：长键节拍刻度用的节拍网格
        if (renderer.setRhythm) {
          renderer.setRhythm(song.analysis.bpm, song.analysis.beats && song.analysis.beats[0] != null ? song.analysis.beats[0] : 0);
        }
        renderer.loadNotes(engine.notes);

        G.player = player; G.engine = engine; G.renderer = renderer;
        G.keymap = keymap;
        G.renderMode = renderMode;

        // 键盘
        G.onKeyDown = (e) => {
          if (e.code === 'Escape') {
            e.preventDefault();
            if (phaseRef.current === 'playing') doPause();
            else if (phaseRef.current === 'paused') doResume();
            return;
          }
          if (e.repeat) return;
          const lane = G.keymap.indexOf(e.code);
          if (lane < 0) return;
          e.preventDefault();
          if (phaseRef.current !== 'playing') return;
          const t = player.time - G.latencySec;
          engine.handleKeyDown(lane, t);
          renderer.laneHit(lane);
        };
        G.onKeyUp = (e) => {
          const lane = G.keymap.indexOf(e.code);
          if (lane < 0) return;
          if (phaseRef.current !== 'playing') return;
          engine.handleKeyUp(lane, player.time - G.latencySec);
        };
        window.addEventListener('keydown', G.onKeyDown);
        window.addEventListener('keyup', G.onKeyUp);

        // 触摸/鼠标：pointer 多点触控（v1.5.0：下落式与透视式均点轨道列判定，x 就近吸附）
        G.pointerLanes = new Map(); // pointerId -> lane
        G.onPointerDown = (e) => {
          if (phaseRef.current !== 'playing') return;
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          const rect = container.getBoundingClientRect();
          const lane = renderer.hitTest
            ? renderer.hitTest(e.clientX - rect.left, e.clientY - rect.top)
            : -1;
          if (lane < 0) return;
          e.preventDefault();
          // 同轨已被另一指针按住 → 忽略
          for (const l of G.pointerLanes.values()) if (l === lane) return;
          G.pointerLanes.set(e.pointerId, lane);
          engine.handleKeyDown(lane, player.time - G.latencySec);
          renderer.laneHit(lane);
        };
        G.onPointerUp = (e) => {
          const lane = G.pointerLanes.get(e.pointerId);
          if (lane == null) return;
          G.pointerLanes.delete(e.pointerId);
          if (phaseRef.current === 'playing') {
            engine.handleKeyUp(lane, player.time - G.latencySec);
          }
        };
        container.addEventListener('pointerdown', G.onPointerDown, { passive: false });
        window.addEventListener('pointerup', G.onPointerUp);
        window.addEventListener('pointercancel', G.onPointerUp);

        // 开播（2 秒倒计时）
        const ctx = getCtx();
        try { await ctx.resume(); } catch (e) { /* noop */ }
        // v1.5.0：自动补偿音频输出延迟（Android WebView 可达 100-250ms）。
        // 不补偿时视觉/判定时钟超前于听感 → 每次点按都被判"晚"（手机端"点不到"根因）。
        // resume 后读数更可靠；用户手动校准值（latencyMs/musicOffsetMs）叠加在其上。
        G.audioLatencySec = getAudioOutLatency(ctx);
        G.latencySec = G.audioLatencySec
          + (settings.latencyMs || 0) / 1000 + (settings.musicOffsetMs || 0) / 1000;
        player.play(2);
        setPhaseSafe('playing');

        // 渲染主循环：位置读取 AudioContext.currentTime（不使用 rAF 累加计时）
        const loop = () => {
          if (disposed) return;
          G.raf = requestAnimationFrame(loop);
          if (phaseRef.current !== 'playing' && phaseRef.current !== 'done') return;
          const t = player.time - G.latencySec;
          engine.update(t);
          renderer.render(t, { score: engine.score, accuracy: engine.accuracy, combo: engine.combo });
        };
        loop();
      } catch (e) {
        if (!disposed) { setErr(e.message || String(e)); setPhaseSafe('error'); }
      }
    }
    boot();

    function doPause() {
      if (!G.player) return;
      G.player.pause();
      setPhaseSafe('paused');
      if (G.engine) setPauseStats(G.engine.getStats());
    }
    function doResume() {
      if (!G.player) return;
      G.player.resume();
      setPhaseSafe('playing');
    }
    G.doPause = doPause; G.doResume = doResume;

    return () => {
      disposed = true;
      if (G.raf) cancelAnimationFrame(G.raf);
      if (G.onKeyDown) window.removeEventListener('keydown', G.onKeyDown);
      if (G.onKeyUp) window.removeEventListener('keyup', G.onKeyUp);
      if (G.onPointerDown) container.removeEventListener('pointerdown', G.onPointerDown);
      if (G.onPointerUp) {
        window.removeEventListener('pointerup', G.onPointerUp);
        window.removeEventListener('pointercancel', G.onPointerUp);
      }
      if (G.renderer) { try { G.renderer.destroy(); } catch (e) { /* noop */ } }
      if (G.player) { try { G.player.destroy(); } catch (e) { /* noop */ } }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!song) {
    return (
      <div className="screen center-screen">
        <div className="empty-state">歌曲不存在</div>
        <button className="btn" onClick={() => navigate({ screen: 'library' })}>返回曲库</button>
      </div>
    );
  }

  const D = DIFFICULTIES[diff] || { label: '自定谱' };
  const DLabel = D.label || '自定谱';
  const touchMode = isTouchDevice();

  return (
    <div className="game-screen">
      <div ref={containerRef} className="game-canvas-holder" />
      {phase === 'loading' && (
        <div className="overlay center-screen"><div className="loading-text">加载音频中…</div></div>
      )}
      {phase === 'error' && (
        <div className="overlay center-screen glass">
          <div className="error-toast">{err}</div>
          <button className="btn" onClick={() => navigate({ screen: 'song', songId })}>返回选曲</button>
        </div>
      )}
      {(phase === 'playing' || phase === 'done') && (
        <button className="btn game-pause-btn" onClick={() => G.doPause && G.doPause()} aria-label="暂停">⏸</button>
      )}
      {phase === 'paused' && (
        <div className="overlay pause-overlay glass">
          <h2>已暂停</h2>
          {pauseStats && (
            <div className="pause-stats">
              <span>分数 {pauseStats.score.toLocaleString()}</span>
              <span>准确率 {pauseStats.accuracy.toFixed(2)}%</span>
              <span>连击 {pauseStats.maxCombo}</span>
            </div>
          )}
          <div className="pause-actions">
            <button className="btn primary" onClick={() => G.doResume && G.doResume()}>继续{touchMode ? '' : '（Esc）'}</button>
            <button className="btn" onClick={() => navigate({ screen: 'game', songId, diff, runId: Date.now() })}>重试</button>
            <button className="btn danger" onClick={() => navigate({ screen: 'song', songId })}>返回选曲</button>
          </div>
          <div className="muted small">
            {touchMode
              ? `点击轨道列击打 · ${G.renderMode === 'persp' ? '透视式' : '下落式'} · 难度：${DLabel}`
              : `键位：${effectiveKeymap(settings, song.keyCount).map((c) => KEY_LABELS[c] || c.replace('Key', '')).join(' · ')}　难度：${DLabel}`}
          </div>
        </div>
      )}
      {phase === 'playing' && (
        <div className="game-hint">{touchMode ? '触摸轨道击打 · ⏸ 右上角' : 'Esc 暂停'} · {DLabel}</div>
      )}
    </div>
  );
}
