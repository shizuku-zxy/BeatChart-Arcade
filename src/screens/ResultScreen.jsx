import React from 'react';
import { DIFFICULTIES } from '../core/constants.js';
import { useStore } from '../core/hooks.js';

const JUDGE_ROWS = [
  { k: 'perfect', label: 'PERFECT', color: '#6ef7d8' },
  { k: 'great', label: 'GREAT', color: '#6ec3ff' },
  { k: 'good', label: 'GOOD', color: '#ffd76e' },
  { k: 'miss', label: 'MISS', color: '#ff6e7a' },
];

const RANK_COLORS = { SSS: '#ffe9a3', SS: '#a3ffdc', S: '#6ef7d8', A: '#6ec3ff', B: '#9db8ff', C: '#ffd76e', D: '#ff8a94' };

export default function ResultScreen({ state, result, navigate }) {
  const store = useStore();
  const song = store.library.songs[result.songId];
  // v1.6.0：自定谱（diff 为 c 开头 id）从 song.charts.custom 取展示名
  const isCustom = result.diff && String(result.diff).startsWith('c');
  const customChart = isCustom && song ? (song.charts.custom || []).find((c) => c.id === result.diff) : null;
  const D = customChart ? { label: customChart.name, cssColor: '#ffd76e' } : DIFFICULTIES[result.diff] || { label: '自定谱', cssColor: '#ffd76e' };
  const { stats } = result;
  const best = song && song.scores && song.scores[isCustom ? 'custom:' + result.diff : result.diff];

  return (
    <div className="screen result-screen">
      <div className="result-card glass">
        <div className="result-song">{result.title}</div>
        <div className="result-diff" style={{ color: D.cssColor }}>{D.label}</div>

        <div className="result-rank" style={{ color: RANK_COLORS[best && best.rank] || '#ffffff' }}>
          {best ? best.rank : '—'}
        </div>
        {stats.fullCombo && <div className="fc-badge">FULL COMBO</div>}
        {result.isNewRecord && <div className="new-record">★ 新纪录</div>}

        <div className="result-score">{stats.score.toLocaleString()}</div>
        <div className="result-acc">准确率 {stats.accuracy.toFixed(2)}%</div>

        <div className="judge-table">
          {JUDGE_ROWS.map((j) => (
            <div className="judge-row" key={j.k}>
              <span style={{ color: j.color }}>{j.label}</span>
              <span>{stats.counts[j.k] ?? 0}</span>
            </div>
          ))}
          <div className="judge-row combo-row">
            <span>MAX COMBO</span>
            <span>{stats.maxCombo} / {stats.totalJudges}</span>
          </div>
        </div>

        <div className="result-actions">
          <button className="btn primary" onClick={() => navigate({ screen: 'game', songId: result.songId, diff: result.diff, runId: Date.now() })}>再来一次</button>
          <button className="btn" onClick={() => navigate({ screen: 'song', songId: result.songId })}>返回选曲 / 重抽谱面</button>
          <button className="btn ghost" onClick={() => navigate({ screen: 'library' })}>返回曲库</button>
        </div>
      </div>
    </div>
  );
}
