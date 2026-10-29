import React, { useRef, useState } from 'react';
import { updateSong, loadAudioBlob } from '../core/store.js';
import { generateChart, PATTERN_LABELS } from '../core/chartgen.js';
import { randomSeed } from '../core/prng.js';
import { exportChartJson, exportAnalysisCsv, exportMidi } from '../core/exporters.js';
import { importChartToSong } from '../core/importer.js';
import { decodeFile, analyzeBuffer } from '../core/audio.js';
import { DIFF_ORDER, DIFFICULTIES } from '../core/constants.js';
import { useStore } from '../core/hooks.js';

function fmtDur(sec) {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const ENERGY_COLORS = ['#31567d', '#4c8ec4', '#6ec3ff'];
const TATUM_LABELS = { 1: '四分', 2: '八分', 3: '三连', 4: '十六分', 6: '六连', 8: '卅二分' };

export default function SongScreen({ state, songId, navigate }) {
  const song = state.library.songs[songId];
  const [seedInput, setSeedInput] = useState({});
  const [toast, setToast] = useState(null);
  const [importing, setImporting] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const chartFileRef = useRef(null);

  if (!song) {
    return (
      <div className="screen">
        <div className="empty-state">歌曲不存在</div>
        <button className="btn" onClick={() => navigate({ screen: 'library' })}>返回曲库</button>
      </div>
    );
  }
  const keyCount = song.keyCount || 4;

  function flash(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }

  function pushHistory(chart) {
    const hist = [...(chart.history || []), { seed: chart.seed, notes: chart.notes, stats: chart.stats }];
    return hist.slice(-12); // 最多保留 12 版可回退
  }

  function reroll(diff) {
    const chart = song.charts[diff];
    const history = pushHistory(chart);
    const seed = randomSeed();
    const gen = generateChart(song.analysis, diff, seed, keyCount, song.hints);
    updateSong(song.id, {
      charts: { ...song.charts, [diff]: { seed: gen.seed, notes: gen.notes, stats: gen.stats, updatedAt: Date.now(), history } },
    });
    flash(`已重抽 ${diff}：新 seed ${gen.seed}（${gen.notes.length} notes${song.hints && (song.hints.energy.length || song.hints.patternHints.length) ? '，含音乐轴微调' : ''}）`);
  }

  function rollback(diff) {
    const chart = song.charts[diff];
    if (!chart.history || !chart.history.length) { flash('没有更早的版本了'); return; }
    const history = [...chart.history];
    const prev = history.pop();
    updateSong(song.id, {
      charts: { ...song.charts, [diff]: { ...chart, seed: prev.seed, notes: prev.notes, stats: prev.stats, history } },
    });
    flash(`已回退到 seed ${prev.seed}`);
  }

  function applySeed(diff) {
    const raw = parseInt(String(seedInput[diff] ?? '').trim(), 10);
    if (!Number.isFinite(raw)) { flash('请输入有效的 seed 数字'); return; }
    const seed = raw >>> 0;
    const chart = song.charts[diff];
    const history = pushHistory(chart);
    const gen = generateChart(song.analysis, diff, seed, keyCount, song.hints);
    updateSong(song.id, {
      charts: { ...song.charts, [diff]: { seed: gen.seed, notes: gen.notes, stats: gen.stats, updatedAt: Date.now(), history } },
    });
    flash(`已按 seed ${gen.seed} 生成（${gen.notes.length} notes）`);
  }

  /** v1.6.0：导入外部谱面（.osu/.mc/.sm/.ssc，或带音频的 .osz/.mcz 包——后者请从曲库页导入） */
  async function importChart() {
    const input = chartFileRef.current;
    if (!input || !input.files || !input.files.length) return;
    const file = input.files[0];
    input.value = '';
    setImporting(true);
    try {
      const { added, skipped } = await importChartToSong(song, file, () => {});
      if (added.length) flash(`已导入 ${added.length} 张谱：${added.join('、')}${skipped.length ? '；跳过：' + skipped.join('、') : ''}`);
      else flash('没有可导入的谱面' + (skipped.length ? '：' + skipped.join('；') : ''));
    } catch (e) {
      flash('导入失败：' + (e.message || e));
    }
    setImporting(false);
  }

  /** v1.8.0：升级分析到 v4（人声层/结构层/头尾静音裁剪）。保留原 seed 重生成三档，
   *  旧谱入 history 可回退；仅旧版本分析的歌显示此入口 */
  async function upgradeAnalysis() {
    if (upgrading) return;
    if (!window.confirm('重新分析这首歌（v4：人声/结构事件、头尾静音裁剪）并重生成三档？\n原 seed 保留，旧谱可回退。')) return;
    setUpgrading(true);
    setMoreOpen(false);
    try {
      flash('升级分析中（可能需要十几秒）…');
      const blob = await loadAudioBlob(song.id, song.ext);
      if (!blob) throw new Error('找不到音频文件');
      const audioBuffer = await decodeFile(blob);
      const analysis = await analyzeBuffer(audioBuffer, () => {});
      const keyCount2 = song.keyCount || 4;
      const charts = {};
      for (const dk of DIFF_ORDER) {
        const old = song.charts[dk];
        const gen = generateChart(analysis, dk, old.seed, keyCount2, song.hints);
        charts[dk] = {
          seed: old.seed,
          notes: gen.notes,
          stats: gen.stats,
          updatedAt: Date.now(),
          history: [...(old.history || []), { seed: old.seed, notes: old.notes, stats: old.stats }].slice(-12),
        };
      }
      updateSong(song.id, { analysis, charts, durationSec: +audioBuffer.duration.toFixed(2) });
      flash(`已升级到 v4 分析（${analysis.vocalOnsets.length} 个人声事件、${analysis.segments2.length} 个结构段），三档已重生成（seed 不变，可回退）`);
    } catch (e) {
      flash('升级失败：' + (e.message || e));
    }
    setUpgrading(false);
  }

  function deleteCustom(id) {
    const customs = (song.charts.custom || []).filter((c) => c.id !== id);
    updateSong(song.id, { charts: { ...song.charts, custom: customs } });
    flash('已删除该自定谱');
  }

  const a = song.analysis;
  const totalSec = Math.max(1, a.durationSec);
  const customs = song.charts.custom || [];

  return (
    <div className="screen song-screen">
      <header className="topbar">
        <button className="btn ghost" onClick={() => navigate({ screen: 'library' })}>← 返回曲库</button>
        <div className="topbar-title">{song.title}</div>
        <div className="topbar-actions">
          <button className="btn ghost" disabled={importing} onClick={() => chartFileRef.current && chartFileRef.current.click()}>{importing ? '导入中…' : '导入谱面'}</button>
          <button className="btn primary" onClick={() => navigate({ screen: 'recorder', songId })}>新建手录谱</button>
          <button className="btn ghost" onClick={() => setMoreOpen(!moreOpen)}>更多{moreOpen ? ' ▲' : ' ▼'}</button>
        </div>
      </header>

      {moreOpen && (
        <div className="more-panel glass">
          {(song.analysis.version || 3) < 4 && (
            <button className="btn ghost" disabled={upgrading} onClick={upgradeAnalysis}>
              {upgrading ? '升级中…' : '升级分析（v4 人声/结构）'}
            </button>
          )}
          <button className="btn ghost" onClick={() => { setMoreOpen(false); navigate({ screen: 'axis', songId }); }}>音乐轴{song.hints && (song.hints.energy.length || song.hints.patternHints.length || song.hints.repeatMirror) ? '（已微调）' : ''}</button>
          <button className="btn ghost" onClick={async () => { setMoreOpen(false); const r = await exportAnalysisCsv(song); if (!r.canceled) flash('分析 CSV 已导出'); }}>导出分析 CSV</button>
          <button className="btn ghost" onClick={async () => { setMoreOpen(false); for (const dk of DIFF_ORDER) { await exportChartJson(song, dk); } flash('三档 chart.json 已导出'); }}>导出三档 chart.json</button>
          <button className="btn ghost" onClick={async () => { setMoreOpen(false); for (const dk of DIFF_ORDER) { await exportMidi(song, dk); } flash('三档 MIDI 已导出'); }}>导出三档 MIDI</button>
        </div>
      )}

      <div className="song-hero glass">
        <div className="hero-stats">
          <div className="stat"><div className="stat-v">{a.bpm}</div><div className="stat-k">BPM</div></div>
          <div className="stat"><div className="stat-v">{a.offset.toFixed(2)}s</div><div className="stat-k">节拍偏移</div></div>
          <div className="stat"><div className="stat-v">{fmtDur(song.durationSec)}</div><div className="stat-k">时长</div></div>
          <div className="stat"><div className="stat-v">{a.onsetCount}</div><div className="stat-k">节拍点</div></div>
          <div className="stat"><div className="stat-v">{a.rms.dynamicRangeDb}</div><div className="stat-k">动态范围 dB</div></div>
          <div className="stat"><div className="stat-v">{a.beats.length}</div><div className="stat-k">beat 总数</div></div>
          {a.key && (
            <div className="stat" title={`置信度 ${Math.round((a.key.confidence || 0) * 100)}%`}>
              <div className="stat-v">{a.key.tonic}{a.key.mode === 'minor' ? '小调' : '大调'}</div>
              <div className="stat-k">调性</div>
            </div>
          )}
          {a.drumKicks && (
            <div className="stat" title="底鼓 / 军鼓 / 踩镲 onset 数">
              <div className="stat-v">{a.drumKicks.length}/{a.drumSnares.length}/{a.drumHihats.length}</div>
              <div className="stat-k">底/军/镲</div>
            </div>
          )}
          {a.barGrid && (
            <div className="stat" title={`拍号 ${a.meter}/4 · 小节头置信度 ${Math.round((a.downbeatConfidence || 0) * 100)}%`}>
              <div className="stat-v">{a.meter === 3 ? '3' : '4'}/{a.barGrid.length}</div>
              <div className="stat-k">拍号/小节</div>
            </div>
          )}
          {a.tatum && (
            <div className="stat" title="歌曲天然的最小节奏单元（生成密度上限）">
              <div className="stat-v">{TATUM_LABELS[a.tatum] || a.tatum}</div>
              <div className="stat-k">最小律动</div>
            </div>
          )}
        </div>
        <div className="segment-bar" title="段落能量分布（蓝越亮能量越高）">
          {a.segments.map((s, i) => (
            <div key={i} style={{ flexGrow: Math.max(0.5, s.end - s.start), background: ENERGY_COLORS[Math.round(s.energy * 2)] }} />
          ))}
        </div>
      </div>

      <div className="diff-grid">
        {DIFF_ORDER.map((diff) => {
          const D = DIFFICULTIES[diff];
          const chart = song.charts[diff];
          const best = song.scores && song.scores[diff];
          const canRollback = chart.history && chart.history.length > 0;
          return (
            <div key={diff} className="diff-card glass" style={{ borderColor: D.cssColor + '55' }}>
              <div className="diff-head" style={{ color: D.cssColor }}>
                <span className="diff-name">{D.label}</span>
                {best && <span className="badge">{best.rank} · {best.score.toLocaleString()}</span>}
              </div>
              <div className="diff-stats">
                <span>音符 {chart.notes.length}</span>
                <span>密度 {chart.stats ? chart.stats.density : '-'} /秒</span>
                <span>长按 {chart.notes.filter((n) => n.type === 'hold').length}</span>
              </div>
              {chart.stats && chart.stats.patternCounts && (
                <div className="pattern-chips" title="本谱使用的键型构成（按小节统计）">
                  {Object.entries(chart.stats.patternCounts)
                    .sort((x, y) => y[1] - x[1])
                    .map(([k, v]) => (
                      <span key={k} className="pattern-chip">{PATTERN_LABELS[k] || k}×{v}</span>
                    ))}
                </div>
              )}
              <div className="seed-row">
                <span className="muted">seed</span>
                <input
                  className="seed-input"
                  value={seedInput[diff] ?? chart.seed}
                  onChange={(e) => setSeedInput({ ...seedInput, [diff]: e.target.value.replace(/[^\d]/g, '') })}
                  placeholder={String(chart.seed)}
                />
                <button className="btn sm" onClick={() => applySeed(diff)}>应用</button>
              </div>
                  <div className="diff-actions">
                    <button className="btn primary" onClick={() => navigate({ screen: 'game', songId: song.id, diff, runId: Date.now() })}>开始游玩</button>
                    <button className="btn" onClick={() => reroll(diff)} title="重新随机生成该档 note 布局（复用分析缓存）">重抽</button>
                    <button className="btn" disabled={!canRollback} onClick={() => rollback(diff)} title="回退到上一版">回退</button>
                  </div>
                  <div className="diff-exports">
                    <button className="btn ghost sm" onClick={async () => { const r = await exportChartJson(song, diff); if (!r.canceled) flash('chart.json 已导出'); }}>导出 chart.json</button>
                    <button className="btn ghost sm" onClick={async () => { const r = await exportMidi(song, diff); if (!r.canceled) flash('MIDI 已导出'); }}>导出 MIDI</button>
                  </div>
            </div>
          );
        })}
      </div>

      <input ref={chartFileRef} type="file" accept=".osu,.mc,.sm,.ssc,.osz,.mcz,.zip" style={{ display: 'none' }} onChange={importChart} />

      {customs.length > 0 && (
        <div className="custom-section">
          <div className="section-head"><h3>导入 / 手录谱（与 E/H/EX 并列可玩）</h3></div>
          <div className="diff-grid">
            {customs.map((c) => {
              const best = song.scores && song.scores['custom:' + c.id];
              const holds = c.notes.filter((n) => n.type === 'hold').length;
              const dens = song.durationSec ? (c.notes.length / song.durationSec).toFixed(2) : '-';
              return (
                <div key={c.id} className="diff-card glass custom-card">
                  <div className="diff-head" style={{ color: '#ffd76e' }}>
                    <span className="diff-name">{c.name}</span>
                    {best && <span className="badge">{best.rank} · {best.score.toLocaleString()}</span>}
                  </div>
                  <div className="diff-stats">
                    <span>音符 {c.notes.length}</span>
                    <span>密度 {dens}/秒</span>
                    <span>长按 {holds}</span>
                    <span className="muted">{c.origin === 'manual' ? '手录' : '导入'}</span>
                  </div>
                  <div className="diff-actions">
                    <button className="btn primary" onClick={() => navigate({ screen: 'game', songId: song.id, diff: c.id, runId: Date.now() })}>开始游玩</button>
                    <button className="btn" onClick={() => navigate({ screen: 'axis', songId, chartId: c.id })}>音乐轴编辑</button>
                    <button className="btn danger" onClick={() => { if (window.confirm(`删除谱面「${c.name}」？`)) deleteCustom(c.id); }}>删除</button>
                  </div>
                  <div className="diff-exports">
                    <button className="btn ghost sm" onClick={async () => { const r = await exportChartJson(song, null, c); if (!r.canceled) flash('chart.json 已导出'); }}>导出 chart.json</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {toast && <div className="toast glass">{toast}</div>}
    </div>
  );
}
