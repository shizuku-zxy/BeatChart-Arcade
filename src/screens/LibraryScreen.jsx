import React, { useEffect, useRef, useState } from 'react';
import { importSongFile, importChartPackage } from '../core/importer.js';
import { removeSong, hasFileBridge } from '../core/store.js';
import { DIFF_ORDER, DIFFICULTIES } from '../core/constants.js';
import { useStore } from '../core/hooks.js';
import { subscribeUpgrade } from '../core/upgrade.js';

const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'webm'];

function isAudioFile(f) {
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  return AUDIO_EXTS.includes(ext) || (f.type && f.type.startsWith('audio/'));
}

function fmtDur(sec) {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function ScoreBadge({ song, diff }) {
  const sc = song.scores && song.scores[diff];
  if (!sc) return <span className="badge dim">未游玩</span>;
  return <span className="badge" style={{ color: DIFFICULTIES[diff].cssColor }}>{sc.rank} · {(sc.score / 10000).toFixed(1)}w</span>;
}

export default function LibraryScreen({ state, navigate, onOpenSettings }) {
  const fileInput = useRef(null);
  const importingRef = useRef(false);
  const [importing, setImporting] = useState(null); // {file, stage, pct}
  const [error, setError] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [libFilter, setLibFilter] = useState('all'); // all | audio | pack
  const [upgradeInfo, setUpgradeInfo] = useState(null);
  useEffect(() => {
    const un = subscribeUpgrade((info) => setUpgradeInfo(info));
    return () => un();
  }, []);
  const songs = state.library.order.map((id) => state.library.songs[id]).filter(Boolean);
  // v1.7.0：曲库分类——音频导入（importSongFile 建）vs 谱面包导入（importChartPackage 建，带 origin: 'pack'）
  const filtered = libFilter === 'all'
    ? songs
    : songs.filter((s) => (libFilter === 'pack' ? s.origin === 'pack' : !s.origin));

  // 批量导入：逐个处理，全部完成后跳到第一首成功导入的歌
  async function handleFiles(files) {
    if (importingRef.current || !files.length) return;
    importingRef.current = true;
    setError(null);
    const imported = [];
    for (const file of files) {
      try {
        setImporting({ file: file.name, stage: '开始', pct: 2 });
        const song = await importSongFile(file, (p) => setImporting({ file: file.name, ...p }));
        imported.push(song);
      } catch (e) {
        setError(`导入「${file.name}」失败：${e.message}`);
      }
    }
    setImporting(null);
    importingRef.current = false;
    if (imported.length) navigate({ screen: 'song', songId: imported[0].id });
  }
  // v1.6.0：拖入 .osz/.mcz 谱面包 → 全新导入（音频+谱面）；拖入单个谱面文件 → 提示挂到已有歌
  // （音频文件仍走 handleFiles）
  const handleFilesRef = useRef(handleFiles);
  handleFilesRef.current = handleFiles;

  // 谱面包导入（.osz/.mcz/zip，带音频）→ 全新歌曲
  const packInput = useRef(null);
  async function handleChartPacks(packs) {
    for (const file of packs) {
      try {
        setImporting({ file: file.name, stage: '解包谱面包', pct: 5 });
        const { song } = await importChartPackage(file, (p) => setImporting({ file: file.name, ...p }));
        setImporting(null);
        navigate({ screen: 'song', songId: song.id });
        return;
      } catch (e) {
        setError(`导入谱面包「${file.name}」失败：${e.message}`);
      }
    }
    setImporting(null);
  }
  const handleChartPacksRef = useRef(handleChartPacks);
  handleChartPacksRef.current = handleChartPacks;

  // 整窗口拖放导入（Electron 下必须 preventDefault 阻止窗口跳转到文件）
  useEffect(() => {
    const onDragOver = (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setDragActive(true);
    };
    const onDragLeave = (e) => {
      if (!e.relatedTarget) setDragActive(false); // 离开窗口
    };
    const onDrop = async (e) => {
      e.preventDefault();
      setDragActive(false);
      if (importingRef.current) return;
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      const packs = files.filter((f) => /\.(osz|mcz|zip)$/i.test(f.name));
      const audio = files.filter((f) => !packs.includes(f) && isAudioFile(f));
      const others = files.length - audio.length - packs.length;
      setError(others > 0 ? `已忽略 ${others} 个不支持的文件（音频：MP3/WAV/OGG/FLAC；谱面包：.osz/.mcz）` : null);
      if (packs.length) await handleChartPacksRef.current(packs);
      else if (audio.length) handleFilesRef.current(audio);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return (
    <div className="screen library-screen">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">♪</span>
          <div>
            <div className="brand-name">BeatChart Arcade</div>
            <div className="brand-sub">本地自动谱面音游 · 完全离线</div>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="btn ghost" onClick={onOpenSettings}>设置</button>
        </div>
      </header>

      {upgradeInfo && upgradeInfo.running && (
        <div className="upgrade-banner glass">
          正在升级旧版分析（v4 人声/结构）… {upgradeInfo.doneCount + 1}/{upgradeInfo.totalCount}
          <span className="muted small">　保留原 seed，旧谱可在选曲页回退</span>
        </div>
      )}

      <div className="library-body">
        <section className="import-zone">
          <h2>导入</h2>
          <p className="muted">
            音频支持 MP3 / WAV / OGG / FLAC，<b>直接拖进窗口</b>或点击按钮选择。
            谱面包（.osz / .mcz）自动解包音频+谱面新建歌曲；
            或在选曲页把 <b>.osu / .mc / .sm / .ssc</b> 谱面挂到已有歌曲上。
          </p>
          <div className="import-buttons">
            <button className="btn primary big" disabled={!!importing} onClick={() => fileInput.current && fileInput.current.click()}>
              {importing ? '正在导入…' : '导入音频文件'}
            </button>
            <button className="btn big" disabled={!!importing} onClick={() => packInput.current && packInput.current.click()}>
              导入谱面包（.osz/.mcz）
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".mp3,.wav,.ogg,.flac,audio/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = '';
              if (files.length) handleFiles(files);
            }}
          />
          <input
            ref={packInput}
            type="file"
            accept=".osz,.mcz,.zip"
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = '';
              if (files.length) handleChartPacks(files);
            }}
          />
          {importing && (
            <div className="import-progress glass">
              <div className="import-file">{importing.file}</div>
              <div className="progress-track"><div className="progress-fill" style={{ width: `${importing.pct}%` }} /></div>
              <div className="import-stage">{importing.stage} · {importing.pct}%</div>
            </div>
          )}
          {error && <div className="error-toast">{error}</div>}
          {!hasFileBridge() && <div className="hint">（当前环境持久化受限，音频仅保存在本次会话中）</div>}
        </section>

        <section className="song-list">
          <div className="section-head">
            <h3>曲库 <span className="muted">（{filtered.length} 首 · 本地持久保存）</span></h3>
            <div className="seg lib-filter">
              <button className={libFilter === 'all' ? 'on' : ''} onClick={() => setLibFilter('all')}>全部</button>
              <button className={libFilter === 'audio' ? 'on' : ''} onClick={() => setLibFilter('audio')}>音频导入</button>
              <button className={libFilter === 'pack' ? 'on' : ''} onClick={() => setLibFilter('pack')}>谱面包导入</button>
            </div>
          </div>
          {filtered.length === 0 && <div className="empty-state">{libFilter === 'all' ? '曲库还是空的，拖一首歌进来试试吧' : '该分类下暂无歌曲'}</div>}
      {filtered.map((song) => (
            <div key={song.id} className="song-card glass" onClick={() => navigate({ screen: 'song', songId: song.id })}>
              <div className="song-info">
                <div className="song-title">{song.title}</div>
                <div className="song-meta">
                  <span>BPM {song.analysis.bpm}</span>
                  <span>时长 {fmtDur(song.durationSec)}</span>
                  <span>节拍点 {song.analysis.onsetCount}</span>
                  <span>动态 {song.analysis.rms.dynamicRangeDb}dB</span>
                  {song.origin === 'pack' && <span className="badge dim">谱面包</span>}
                </div>
              </div>
              <div className="song-badges">
                {DIFF_ORDER.map((d) => <ScoreBadge key={d} song={song} diff={d} />)}
              </div>
              <button
                className="btn danger sm"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (window.confirm(`确定删除「${song.title}」？谱面与成绩将一并删除。`)) {
                    await removeSong(song.id);
                  }
                }}
              >删除</button>
            </div>
          ))}
        </section>
      </div>

      {/* 导入进行中：屏蔽误点击 */}
      {importing && <div className="click-blocker" />}

      {/* 拖放遮罩 */}
      {dragActive && !importing && (
        <div className="drop-overlay">
          <div className="drop-card glass">
            <div className="drop-icon">🎵</div>
            <div className="drop-title">松开鼠标，导入音频</div>
            <div className="muted small">支持 MP3 / WAV / OGG / FLAC · 可多选</div>
          </div>
        </div>
      )}
    </div>
  );
}
