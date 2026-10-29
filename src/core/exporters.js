// ============ 导出：chart.json / 分析 CSV / MIDI 节奏轨 ============

import { APP_NAME, APP_VERSION, DIFFICULTIES } from './constants.js';
import { buildOsuChart } from './chartformats.js';
import { zipStore } from './zip.js';
import { exportBytes, loadAudioBlob } from './store.js';

/** 单档 chart.json（metadata + analysis 摘要 + notes；customChart 传入时导出自定谱） */
export function buildChartJson(song, diffKey, customChart) {
  const chart = customChart || song.charts[diffKey];
  const a = song.analysis;
  return {
    format: 'beatchart.chart',
    version: 1,
    generator: `${APP_NAME} ${APP_VERSION}`,
    metadata: {
      title: song.title,
      audioFile: song.fileName,
      durationSec: song.durationSec,
      difficulty: customChart ? customChart.id : diffKey,
      difficultyLabel: customChart ? customChart.name : DIFFICULTIES[diffKey].label,
      origin: customChart ? customChart.origin : undefined,
      seed: chart.seed,
      keyCount: customChart ? customChart.keyCount : (song.keyCount || 4),
      noteCount: chart.notes.length,
      density: chart.stats ? chart.stats.density : undefined,
      bestScore: song.scores && song.scores[customChart ? 'custom:' + customChart.id : diffKey] ? song.scores[customChart ? 'custom:' + customChart.id : diffKey].score : 0,
    },
    analysis: {
      bpm: a.bpm,
      offset: a.offset,
      onsetCount: a.onsetCount,
      beatsCount: a.beats.length,
      segments: a.segments,
      rms: a.rms,
      // v3 多乐器/节拍层级（旧分析无此字段）
      key: a.key,
      meter: a.meter,
      tatum: a.tatum,
      downbeatPhase: a.downbeatPhase,
      drumCounts: a.drumKicks ? {
        kick: a.drumKicks.length,
        snare: a.drumSnares.length,
        hihat: a.drumHihats.length,
      } : undefined,
      tonalSustains: a.tonalSustains,
    },
    notes: chart.notes.map((n) => (n.type === 'hold'
      ? { t: n.t, lane: n.lane, type: 'hold', d: n.d }
      : { t: n.t, lane: n.lane, type: 'tap' })),
  };
}

/** 分析数据 CSV（onsets / beats / 段落 / RMS 汇总） */
export function buildAnalysisCsv(song) {
  const a = song.analysis;
  const lines = [];
  lines.push('# BeatChart Arcade 分析数据导出');
  lines.push(`# 歌曲,${csv(song.title)}`);
  lines.push(`# BPM,${a.bpm}`);
  lines.push(`# offset(秒),${a.offset}`);
  lines.push(`# 时长(秒),${a.durationSec}`);
  lines.push(`# onset 总数,${a.onsetCount}`);
  lines.push(`# RMS(mean/low/high),${a.rms.mean},${a.rms.low},${a.rms.high}`);
  lines.push(`# 动态范围(dB),${a.rms.dynamicRangeDb}`);
  lines.push('');
  lines.push('type,index,time_sec,strength_or_energy,lane');
  a.onsets.forEach((o, i) => lines.push(`onset,${i},${o.t},${o.s},`));
  a.beats.forEach((t, i) => lines.push(`beat,${i},${t},,`));
  a.segments.forEach((s, i) => lines.push(`segment,${i},${s.start},${s.energy},`));
  return lines.join('\n');
}

function csv(s) {
  s = String(s);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** MIDI 节奏轨（SMF format 0，轨道映射音高 60+lane） */
export function buildMidi(song, diffKey) {
  const chart = song.charts[diffKey];
  const bpm = song.analysis.bpm;
  const beatSec = 60 / bpm;
  const PPQ = 480;
  const events = [];
  // 速度 meta
  const usPerQuarter = Math.round(60000000 / bpm);
  events.push({ tick: 0, bytes: [0x00, 0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] });
  // 音轨名 meta
  const name = `${song.title} [${diffKey}]`;
  const nameBytes = [...new TextEncoder().encode(name)];
  events.push({ tick: 0, bytes: [0x00, 0xff, 0x03, nameBytes.length, ...nameBytes] });
  const notes = chart.notes;
  const minDur = Math.max(0.09, beatSec / 8);
  for (const n of notes) {
    const onTick = Math.max(0, Math.round((n.t / beatSec) * PPQ));
    const durSec = n.type === 'hold' ? n.d : 0.11;
    const offTick = onTick + Math.max(12, Math.round((durSec / beatSec) * PPQ));
    const pitch = 60 + n.lane;
    const vel = n.type === 'hold' ? 90 : 100;
    events.push({ tick: onTick, bytes: [0x90, pitch, vel] });
    events.push({ tick: offTick, bytes: [0x80, pitch, 0] });
  }
  events.sort((a, b) => a.tick - b.tick || (a.bytes[0] === 0x80 ? 1 : 0) - (b.bytes[0] === 0x80 ? 1 : 0));
  // 组装 MTrk（含 delta time VLQ）
  const bytes = [];
  let lastTick = 0;
  let prevStatus = 0;
  for (const ev of events) {
    const delta = ev.tick - lastTick;
    lastTick = ev.tick;
    // VLQ
    let v = delta;
    const vlq = [];
    do { vlq.unshift(v & 0x7f); v >>= 7; } while (v > 0);
    for (let i = 0; i < vlq.length; i++) bytes.push(vlq[i] | (i < vlq.length - 1 ? 0x80 : 0));
    if (ev.bytes[0] === 0x90 || ev.bytes[0] === 0x80) {
      if (ev.bytes[0] === prevStatus) bytes.push(ev.bytes[1], ev.bytes[2]); // running status
      else { bytes.push(ev.bytes[0], ev.bytes[1], ev.bytes[2]); prevStatus = ev.bytes[0]; }
    } else {
      bytes.push(...ev.bytes);
      prevStatus = 0;
    }
  }
  bytes.push(0x00, 0xff, 0x2f, 0x00); // End of track

  const out = [];
  const pushStr = (s) => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };
  const pushU32 = (v) => { out.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff); };
  pushStr('MThd'); pushU32(6); pushU32(0); // format 0
  out.push(0, 1); // 1 track
  out.push((PPQ >> 8) & 0xff, PPQ & 0xff);
  pushStr('MTrk'); pushU32(bytes.length);
  bytes.forEach((b) => out.push(b));
  return new Uint8Array(out);
}

export async function exportChartJson(song, diffKey, customChart) {
  const json = buildChartJson(song, diffKey, customChart);
  const safe = safeName(song.title);
  const tag = customChart ? customChart.name.replace(/[[\]\/\\:*?"<>|]/g, '_').slice(0, 24) : diffKey;
  return exportBytes(`${safe}[${tag}].chart.json`, JSON.stringify(json, null, 2));
}
export async function exportAnalysisCsv(song) {
  return exportBytes(`${safeName(song.title)}_analysis.csv`, buildAnalysisCsv(song));
}
export async function exportMidi(song, diffKey) {
  return exportBytes(`${safeName(song.title)}[${diffKey}].mid`, buildMidi(song, diffKey));
}

/** 导出可直接再导入的 .osz 谱面包（4K chart.osu + 原音频） */
export async function exportChartPackage(song, diffKey, customChart) {
  const chart = customChart || (song.charts && song.charts[diffKey]);
  if (!chart || !Array.isArray(chart.notes)) throw new Error('找不到谱面数据，无法导出谱面包');
  const ab = await loadAudioBlob(song.id, song.ext);
  if (!ab) throw new Error('找不到音频文件，无法导出谱面包');

  const ext = String(song.ext || 'mp3')
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/[^a-z0-9]/g, '') || 'mp3';
  const audioFile = `audio.${ext}`;
  const osuText = buildOsuChart(chart, {
    title: song.title,
    bpm: song.analysis && song.analysis.bpm,
    offset: (song.analysis && song.analysis.offset) || 0,
    version: customChart ? customChart.name : `BeatChart ${diffKey}`,
    audioFile,
    keyCount: song.keyCount || 4,
  });
  const zipData = zipStore([
    { name: audioFile, data: new Uint8Array(ab) },
    { name: 'chart.osu', data: new TextEncoder().encode(osuText) },
  ]);
  const tag = customChart ? safeTag(customChart.name) : (diffKey || 'chart');
  return exportBytes(`${safeName(song.title)}[${tag}].osz`, zipData);
}

function safeTag(s) {
  return String(s == null ? '' : s)
    .replace(/[\[\]\/\\:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24) || 'chart';
}

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'chart';
}
