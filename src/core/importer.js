// ============ 导入流水线：解码 → Worker 分析 → 自动生成三档 → 持久化 ============
// v1.6.0 增补：外部谱面导入（.osu/.mc/.sm/.ssc + .osz/.mcz 包）

import { decodeFile, analyzeBuffer } from './audio.js';
import { generateChart } from './chartgen.js';
import { randomSeed } from './prng.js';
import { upsertSong, saveAudioBlob, updateSong } from './store.js';
import { DIFF_ORDER } from './constants.js';
import { parseChartFile, chartStats, AUDIO_EXTS } from './chartformats.js';
import { unzipFiles, bytesToText } from './zip.js';
import { sanitizeHoldAdjacentTaps } from './chartedit.js';

const CHART_EXTS = ['osu', 'mc', 'sm', 'ssc'];

/** 读取谱面 File → { charts, meta }（自动解包 .osz/.mcz/zip） */
export async function readChartFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (['osz', 'mcz', 'zip'].includes(ext)) {
    const entries = await unzipFiles(await file.arrayBuffer(), [...CHART_EXTS, ...AUDIO_EXTS]);
    const chartEntries = entries.filter((e) => CHART_EXTS.includes((e.name.split('.').pop() || '').toLowerCase()));
    if (!chartEntries.length) throw new Error('谱面包内没有谱面文件（.osu/.mc/.sm/.ssc）');
    let meta = null;
    const charts = [];
    const errors = [];
    for (const e of chartEntries) {
      try {
        const parsed = parseChartFile(bytesToText(e.data), e.name.split('/').pop());
        if (!meta) meta = parsed.meta;
        charts.push(...parsed.charts);
      } catch (err) { errors.push(`${e.name}：${err.message}`); }
    }
    if (!charts.length) throw new Error('谱面包内所有谱面解析失败：\n' + errors.join('\n'));
    const audioEntry = entries.find((e) => AUDIO_EXTS.includes((e.name.split('.').pop() || '').toLowerCase()));
    const metaFull = {
      ...meta,
      packAudio: audioEntry ? { name: audioEntry.name.split('/').pop(), data: audioEntry.data } : null,
      packErrors: errors,
    };
    return { charts, meta: metaFull };
  }
  const text = await file.text();
  const parsed = parseChartFile(text, file.name);
  return { charts: parsed.charts, meta: parsed.meta };
}

function makeCustomId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/** 场景 A：给库内已有歌曲添加外部谱面 */
export async function importChartToSong(song, file, onProgress) {
  const onP = onProgress || (() => {});
  onP({ stage: '解析谱面', pct: 10 });
  const { charts } = await readChartFile(file);
  const keyCount = song.keyCount || 4;
  const dur = song.durationSec || 0;
  const added = [];
  const skipped = [];
  const customs = [...(song.charts.custom || [])];
  for (const c of charts) {
    if (c.keyCount !== keyCount) { skipped.push(`${c.diffName}（${c.keyCount}K，本歌为 ${keyCount}K）`); continue; }
    // v1.8.1b：长按期间同手区短键清理（osu 原谱常有左手长键+左手短键布局，
    // 与生成器规则对齐：长按中另一手自由，同手区短键删除）
    const notes = sanitizeHoldAdjacentTaps(c.notes.filter((n) => n.t < dur - 0.05), keyCount);
    const dropped = c.notes.length - notes.length;
    if (notes.length < 5) { skipped.push(`${c.diffName}（有效音符过少${dropped ? `，${dropped} 个超出歌曲时长被裁` : ''}）`); continue; }
    customs.push({
      id: makeCustomId(),
      name: c.diffName + (dropped ? ` ·裁${dropped}` : ''),
      origin: 'import',
      keyCount,
      notes,
      stats: chartStats(notes, dur),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    added.push(c.diffName);
  }
  updateSong(song.id, { charts: { ...song.charts, custom: customs } });
  onP({ stage: '完成', pct: 100 });
  return { added, skipped };
}

/** 场景 B：从带音频的谱面包（.osz/.mcz）新建歌曲并导入谱面 */
export async function importChartPackage(file, onProgress) {
  const onP = onProgress || (() => {});
  onP({ stage: '解包谱面包', pct: 5 });
  const { charts, meta } = await readChartFile(file);
  if (!meta.packAudio) {
    throw new Error('谱面包内没有音频文件。请先在曲库导入音频，再到选曲页用「导入谱面」把谱面挂到歌曲上');
  }
  onP({ stage: '解码音频', pct: 20 });
  const audioFile = meta.packAudio;
  const arrayBuffer = audioFile.data.buffer.slice(audioFile.data.byteOffset, audioFile.data.byteOffset + audioFile.data.byteLength);
  const audioBuffer = await decodeFile(arrayBuffer);
  if (!audioBuffer || audioBuffer.duration < 8) throw new Error('包内音频过短（<8 秒）');

  onP({ stage: '音频分析', pct: 30 });
  const analysis = await analyzeBuffer(audioBuffer, (p) => {
    onP({ stage: '音频分析', pct: 30 + p.pct * 0.5 });
  });

  onP({ stage: '入库谱面', pct: 85 });
  const id = 'song-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const ext = (audioFile.name.split('.').pop() || 'mp3').toLowerCase();
  const title = meta.title || file.name.replace(/\.[^.]+$/, '') || '导入谱面包';
  const keyCount = charts[0].keyCount;
  await saveAudioBlob(id, ext, arrayBuffer);

  const chartMap = {};
  for (const dk of DIFF_ORDER) {
    const seed = randomSeed();
    const gen = generateChart(analysis, dk, seed, keyCount);
    chartMap[dk] = { seed: gen.seed, notes: gen.notes, stats: gen.stats, updatedAt: Date.now(), history: [] };
  }
  const dur = audioBuffer.duration;
  const customs = charts
    .filter((c) => c.keyCount === keyCount)
    .map((c) => ({
      id: makeCustomId(),
      name: c.diffName,
      origin: 'import',
      keyCount,
      // v1.8.1b：同手区短键清理（与单谱导入同规则）
      notes: sanitizeHoldAdjacentTaps(c.notes.filter((n) => n.t < dur - 0.05), keyCount),
      stats: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }))
    .filter((c) => c.notes.length >= 5);
  for (const c of customs) c.stats = chartStats(c.notes, dur);

  const song = {
    id,
    title,
    fileName: audioFile.name,
    audioFile: `${id}.${ext}`,
    ext,
    durationSec: +dur.toFixed(2),
    addedAt: Date.now(),
    keyCount,
    origin: 'pack', // v1.7.0：曲库分类标记（谱面包导入）
    analysis,
    charts: { ...chartMap, custom: customs },
    scores: {},
  };
  upsertSong(song);
  onP({ stage: '完成', pct: 100 });
  return { song, added: customs.map((c) => c.name), skipped: charts.filter((c) => c.keyCount !== keyCount).map((c) => c.diffName) };
}

export async function importSongFile(file, onProgress) {
  const onP = onProgress || (() => {});

  onP({ stage: '读取文件', pct: 4 });
  const arrayBuffer = await file.arrayBuffer();

  onP({ stage: '解码音频', pct: 10 });
  const audioBuffer = await decodeFile(arrayBuffer);
  if (!audioBuffer || audioBuffer.duration < 8) {
    throw new Error('音频过短（<8 秒），无法生成谱面');
  }

  const analysis = await analyzeBuffer(audioBuffer, (p) => {
    const map = {
      mixdown: '混音', resample: '降采样', stft: '频谱变换', onset: '节拍点检测',
      drums: '鼓点分轨', bpm: 'BPM 分析', downbeat: '小节线与律动',
      tonal: '调性与旋律', segments: '段落能量', done: '完成',
    };
    onP({ stage: map[p.stage] || '分析中', pct: 15 + p.pct * 0.7 });
  });

  onP({ stage: '生成三档谱面', pct: 90 });
  const id = 'song-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const ext = (file.name.split('.').pop() || 'mp3').toLowerCase();
  const title = file.name.replace(/\.[^.]+$/, '') || '未命名曲目';
  const keyCount = 4; // v1.6.1：固定 4 轨（六轨已移除）

  await saveAudioBlob(id, ext, arrayBuffer);

  const charts = {};
  for (const dk of DIFF_ORDER) {
    const seed = randomSeed();
    const gen = generateChart(analysis, dk, seed, keyCount);
    charts[dk] = { seed: gen.seed, notes: gen.notes, stats: gen.stats, updatedAt: Date.now(), history: [] };
  }

  const song = {
    id,
    title,
    fileName: file.name,
    audioFile: `${id}.${ext}`,
    ext,
    durationSec: +audioBuffer.duration.toFixed(2),
    addedAt: Date.now(),
    keyCount,
    analysis,
    charts,
    scores: {},
  };
  upsertSong(song);

  onP({ stage: '完成', pct: 100 });
  return song;
}
