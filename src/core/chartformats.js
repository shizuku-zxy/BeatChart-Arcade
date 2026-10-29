// ============ 外部谱面格式解析器（v1.6.0 导入乐谱） ============
// 支持：osu!mania (.osu) / Malody Key (.mc) / StepMania (.sm .ssc)
// 统一输出：{ meta, charts: [{ diffName, keyCount, notes, noteCount }] }
// notes 元素与引擎一致：{ t 秒, lane 0..K-1, type: 'tap'|'hold', d 秒 }
//
// 时间轴规则：
//   .osu  → HitObjects 的 time 已是绝对毫秒，无需换算（TimingPoints 只提供 BPM 元数据）
//   .mc   → beat(拍) × TIME 段 BPM 积分成秒
//   .sm/.ssc → 同 .mc（#BPMS/#OFFSET），OFFSET 按社区通行解释为秒、与拍 0 的时间差

const AUDIO_EXTS = ['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus', 'aac', 'oga', 'webm'];

// ---------- 通用工具 ----------

function clampNotes(notes, keyCount) {
  // 排序 + 基本校验：轨道越界丢弃、时间负值丢弃、同轨 hold 重叠裁剪
  notes.sort((a, b) => a.t - b.t);
  const out = [];
  let laneEnd = new Array(keyCount).fill(-1); // 每轨上一 hold 结束时间
  for (const n of notes) {
    if (!Number.isFinite(n.t) || n.t < 0) continue;
    if (!Number.isInteger(n.lane) || n.lane < 0 || n.lane >= keyCount) continue;
    if (n.type === 'hold') {
      if (!Number.isFinite(n.d) || n.d < 0.05) { n.type = 'tap'; n.d = undefined; }
      else if (n.t < laneEnd[n.lane] + 0.01) {
        // 与上一 hold 重叠：裁掉重叠部分起点（或整体跳过）
        if (n.t + n.d <= laneEnd[n.lane] + 0.01) continue; // 完全被包含
        const shift = laneEnd[n.lane] - n.t;
        n = { t: laneEnd[n.lane] + 0.02, lane: n.lane, type: 'hold', d: n.d - shift - 0.02 };
        if (n.d < 0.05) continue;
      }
      laneEnd[n.lane] = n.t + n.d;
    } else {
      if (n.t < laneEnd[n.lane]) continue; // hold 存续期间同轨 tap 丢弃
    }
    out.push(n);
  }
  return out;
}

function chartStats(notes, durSec) {
  const holds = notes.filter((n) => n.type === 'hold').length;
  return {
    noteCount: notes.length,
    holdCount: holds,
    density: durSec > 1 ? +(notes.length / durSec).toFixed(2) : 0,
    patternCounts: { '导入': notes.length > 0 ? 1 : 0 },
  };
}

// ---------- .osu（osu!mania） ----------

export function parseOsu(text) {
  const lines = text.split(/\r?\n/);
  const sections = {};
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) { cur = m[1]; sections[cur] = []; continue; }
    if (cur) sections[cur].push(line);
  }
  const kv = (arr) => {
    const o = {};
    for (const l of arr || []) {
      const i = l.indexOf(':');
      if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
    return o;
  };
  const general = kv(sections.General);
  const meta = kv(sections.Metadata);
  const diff = kv(sections.Difficulty);

  const mode = parseInt(general.Mode, 10);
  if (mode !== 3) throw new Error('该 .osu 不是 mania 模式（Mode=' + mode + '），仅支持 osu!mania 键数谱');
  const keyCount = parseInt(diff.CircleSize, 10);
  if (!Number.isFinite(keyCount) || keyCount !== 4) {
    throw new Error(`该谱为 ${keyCount}K，当前仅支持导入 4K 谱面（六轨已移除）`);
  }

  // TimingPoints：取基础 BPM（首个 uninherited）
  let bpm = null;
  if (sections.TimingPoints) {
    for (const l of sections.TimingPoints) {
      const parts = l.split(',');
      const bl = Math.abs(parseFloat(parts[1]));
      const uninherited = parts.length >= 9 ? parseFloat(parts[8]) === 1 : bl > 0;
      if (uninherited && bl > 0) { bpm = Math.round(60000 / bl); break; }
    }
  }

  const notes = [];
  if (sections.HitObjects) {
    for (const l of sections.HitObjects) {
      const p = l.split(',');
      const time = parseFloat(p[2]);
      const type = parseInt(p[3], 10);
      if (!Number.isFinite(time)) continue;
      const x = parseFloat(p[0]);
      const lane = Math.min(keyCount - 1, Math.max(0, Math.floor((x * keyCount) / 512)));
      if (type & 128) {
        // hold：endTime 为第 5 字段（毫秒，绝对时间）
        const end = parseFloat(p[5]);
        if (Number.isFinite(end) && end > time) {
          notes.push({ t: time / 1000, lane, type: 'hold', d: (end - time) / 1000 });
        }
      } else {
        notes.push({ t: time / 1000, lane, type: 'tap' });
      }
    }
  }
  if (!notes.length) throw new Error('该 .osu 没有可导入的音符（HitObjects 为空）');

  const diffName = meta.Version || general.Version || 'osu 谱';
  return {
    meta: {
      title: (meta.Title || '').trim() || null,
      artist: (meta.Artist || '').trim() || null,
      audioFile: (general.AudioFilename || '').trim() || null,
      bpm,
      source: 'osu',
    },
    charts: [{
      diffName: `[osu] ${diffName}`,
      keyCount,
      notes: clampNotes(notes, keyCount),
      noteCount: notes.length,
    }],
  };
}

// ---------- 写出 .osu（osu!mania 4K，用于 .osz 谱面包交换） ----------

/**
 * 生成 osu!mania 4K 谱面文本（osu file format v14）。
 * 纯函数：不读取音频、不依赖浏览器；notes 时间单位秒，输出毫秒。
 * @param {{notes:Array<{t:number,lane:number,type:'tap'|'hold',d?:number}>}} chart
 * @param {{title:string,artist?:string,bpm:number,offset?:number,version:string,audioFile?:string,keyCount?:number}} meta
 * @returns {string}
 */
export function buildOsuChart(chart, meta) {
  const m = meta || {};
  const oneLine = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
  const title = oneLine(m.title) || 'Untitled';
  const artist = oneLine(m.artist) || 'Unknown';
  const version = oneLine(m.version) || 'BeatChart';
  const audioFile = oneLine(m.audioFile) || 'audio.mp3';
  const bpmNum = Number(m.bpm);
  const bpm = Number.isFinite(bpmNum) && bpmNum > 0 ? bpmNum : 120;
  const offsetNum = Number(m.offset);
  const offsetMs = Math.round((Number.isFinite(offsetNum) ? offsetNum : 0) * 1000);

  // 仅接受能原样被 parseOsu 读回的 4K 音符；输出前按时间排序
  const hitObjects = (Array.isArray(chart && chart.notes) ? chart.notes : [])
    .filter((n) => n && Number.isFinite(n.t) && n.t >= 0
      && Number.isInteger(n.lane) && n.lane >= 0 && n.lane < 4)
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((n) => {
      const x = Math.floor((n.lane + 0.5) * 512 / 4);
      const time = Math.round(n.t * 1000);
      if (n.type === 'hold') {
        const d = Number.isFinite(n.d) && n.d > 0 ? n.d : 0;
        const endTime = Math.max(time + 1, Math.round((n.t + d) * 1000));
        return `${x},192,${time},128,0,${endTime}:0:0:0:0`;
      }
      return `${x},192,${time},1,0,0:0:0:0:`;
    });

  return [
    'osu file format v14',
    '',
    '[General]',
    `AudioFilename: ${audioFile}`,
    'AudioLeadIn: 0',
    'PreviewTime: -1',
    'Countdown: 0',
    'SampleSet: Normal',
    'StackLeniency: 0.7',
    'Mode: 3',
    'LetterboxInBreaks: 0',
    'SpecialStyle: 0',
    'WidescreenStoryboard: 0',
    '',
    '[Editor]',
    'DistanceSpacing: 1',
    'BeatDivisor: 4',
    'GridSize: 4',
    'TimelineZoom: 1',
    '',
    '[Metadata]',
    `Title:${title}`,
    `TitleUnicode:${title}`,
    `Artist:${artist}`,
    `ArtistUnicode:${artist}`,
    'Creator:BeatChart Arcade',
    `Version:${version}`,
    'Source:',
    'Tags:BeatChart Arcade',
    'BeatmapID:0',
    'BeatmapSetID:-1',
    '',
    '[Difficulty]',
    'HPDrainRate:7',
    'CircleSize:4',
    'OverallDifficulty:8',
    'ApproachRate:5',
    'SliderMultiplier:1.4',
    'SliderTickRate:1',
    '',
    '[Events]',
    '//Background and Video events',
    '//Break Periods',
    '//Storyboard Layer 0 (Background)',
    '//Storyboard Layer 1 (Fail)',
    '//Storyboard Layer 2 (Pass)',
    '//Storyboard Layer 3 (Foreground)',
    '//Storyboard Sound Samples',
    '',
    '[TimingPoints]',
    `${offsetMs},${60000 / bpm},4,2,0,60,1,0`,
    '',
    '[HitObjects]',
    ...hitObjects,
  ].join('\n');
}

// ---------- 拍 → 秒积分器（.sm/.ssc/.mc 共用） ----------

function makeBeatToSec(bpmEvents, offsetSec) {
  // bpmEvents: [{ beat, bpm }] 升序（beat 单位：拍）
  // 返回 (beat) => 秒
  if (!bpmEvents.length) bpmEvents = [{ beat: 0, bpm: 120 }];
  const segs = [];
  for (let i = 0; i < bpmEvents.length; i++) {
    const e = bpmEvents[i];
    const next = bpmEvents[i + 1];
    if (!Number.isFinite(e.bpm) || e.bpm <= 0) continue;
    segs.push({ beat: e.beat, secPerBeat: 60 / e.bpm, end: next ? next.beat : Infinity });
  }
  if (!segs.length) segs.push({ beat: 0, secPerBeat: 0.5, end: Infinity });
  const t0 = segs[0].beat * segs[0].secPerBeat; // 起始拍的时间原点（拍通常从 0 开始）
  return (beat) => {
    let sec = -t0;
    for (const s of segs) {
      if (beat <= s.beat) break;
      const span = Math.min(beat, s.end) - s.beat;
      sec += span * s.secPerBeat;
    }
    return sec + offsetSec;
  };
}

// ---------- .sm / .ssc（StepMania） ----------

const SM_NOTE_CHARS = { '1': 'tap', '2': 'holdHead', '3': 'holdEnd', '4': 'holdHead' /* roll 当 hold */, M: null /* 地雷忽略 */ };

export function parseSm(text, fileName) {
  const data = {};
  // 提取 #TAG:value;（value 可跨行）
  const tagRe = /#([A-Za-z0-9]+):\s*([\s\S]*?);/g;
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    const tag = m[1].toUpperCase();
    if (!(tag in data)) data[tag] = m[2].trim(); // 同名 tag 取第一个
  }

  const bpmEvents = [];
  const bpmsRaw = String(data.BPMS || '').replace(/[\s]/g, '');
  for (const pair of bpmsRaw.split(',')) {
    if (!pair) continue;
    const [b, v] = pair.split('=');
    const beat = parseFloat(b), bpm = parseFloat(v);
    if (Number.isFinite(beat) && Number.isFinite(bpm) && bpm > 0) bpmEvents.push({ beat, bpm });
  }
  bpmEvents.sort((x, y) => x.beat - y.beat);
  if (!bpmEvents.length) throw new Error('该 ' + fileName + ' 缺少 #BPMS，无法换算时间');

  const offsetRaw = parseFloat(String(data.OFFSET || '0').trim());
  // StepMania 惯例：正值 = 音频晚于 0 拍 → 拍 0 在音频 offset 秒处
  const offsetSec = Number.isFinite(offsetRaw) ? offsetRaw : 0;
  const beatToSec = makeBeatToSec(bpmEvents, offsetSec);

  const meter = Number.isFinite(parseInt(data.METER, 10)) ? parseInt(data.METER, 10) : 4;
  const title = (data.TITLE || '').trim() || null;

  // 解析 #NOTES（.sm：多组；.ssc：#NOTEDATA: 分块 + #NOTES 单组）
  const charts = [];
  const notesBlocks = [];
  if (data.NOTESDATA) {
    // .ssc：按 #NOTEDATA:; 分块
    const chunks = text.split(/#NOTEDATA:\s*;/i).slice(1);
    for (const chunk of chunks) {
      const sub = {};
      let mm;
      const subRe = /#([A-Za-z0-9]+):\s*([\s\S]*?);/g;
      while ((mm = subRe.exec(chunk)) !== null) {
        if (!(mm[1].toUpperCase() in sub)) sub[mm[1].toUpperCase()] = mm[2].trim();
      }
      if (sub.NOTES) notesBlocks.push({ head: sub, body: sub.NOTES });
    }
  } else if (data.NOTES) {
    // .sm：#NOTES 内含头信息（dance-single::::难度:级别:）+ 谱体
    // 按非贪婪逐个 #NOTES 块解析
    const re = /#NOTES:\s*([\s\S]*?);\s*(?=#|$)/g;
    let mm;
    while ((mm = re.exec(text)) !== null) {
      const body = mm[1];
      // 头部：前几行是描述（类型/作者/难度/级别），其后是逗号分隔的小节矩阵
      const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let headEnd = 0;
      for (let i = 0; i < lines.length; i++) {
        if (/^[0-9]+$/.test(lines[i])) { headEnd = i; break; }
        if (lines[i].includes(',') && /^[\s0-1M2-4A-Za-z]*$/.test(lines[i].replace(/,/g, '')) === false) { headEnd = i; break; }
        // .sm 头是 5-6 行以冒号分隔的描述；谱体行只含 note 字符与逗号
        if (!/^#/.test(lines[i]) && lines[i].replace(/[0-1M2-4,]/g, '') === '') { headEnd = i; break; }
      }
      const headLines = lines.slice(0, headEnd);
      notesBlocks.push({ head: { STEPSTYPE: headLines[0] || '', DIFFICULTY: headLines[3] || '', METER: headLines[4] || '' }, body: lines.slice(headEnd).join('\n') });
    }
  }
  if (!notesBlocks.length) throw new Error('该 ' + fileName + ' 没有找到 #NOTES 谱面数据');

  for (const blk of notesBlocks) {
    const stepType = String(blk.head.STEPSTYPE || blk.head.STEPSTYPE_ || '').toLowerCase();
    const keyCount = stepType.includes('dance-single') ? 4
      : stepType.includes('kb7') ? 7
        : stepType.includes('dance-solo') ? 6
          : stepType.includes('dance-double') ? 8 : 0;
    if (keyCount !== 4) {
      throw new Error(`该谱为 ${stepType || '未知类型'}（${keyCount || '?'}K），当前仅支持 4K 谱面（六轨已移除）`);
    }
    // 解析小节矩阵：逗号分隔小节，小节内每行是 K 个 note 字符
    const notes = [];
    let measureIdx = 0;
    let holdOpen = new Array(keyCount).fill(null); // lane -> { startBeat }
    const body = String(blk.body).replace(/\/\/[^\n]*/g, ''); // 去行注释
    for (const measureRaw of body.split(',')) {
      const rows = measureRaw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length === keyCount || /^[0-1M2-4]+$/.test(l));
      if (!rows.length) { measureIdx++; continue; }
      const rowsPerBeat = rows.length / meter; // meter 拍/小节
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (row.length !== keyCount) continue;
        const beat = measureIdx * meter + (rowsPerBeat > 0 ? r / rowsPerBeat : 0);
        for (let c = 0; c < keyCount; c++) {
          const ch = row[c];
          if (ch === '0' || ch === undefined) continue;
          const kind = SM_NOTE_CHARS[ch];
          if (kind === null || kind === undefined) continue;
          if (kind === 'tap') {
            notes.push({ t: beatToSec(beat), lane: c, type: 'tap' });
          } else if (kind === 'holdHead') {
            holdOpen[c] = { startBeat: beat };
          } else if (kind === 'holdEnd' && holdOpen[c]) {
            const t0 = beatToSec(holdOpen[c].startBeat);
            const t1 = beatToSec(beat);
            if (t1 > t0 + 0.05) notes.push({ t: t0, lane: c, type: 'hold', d: t1 - t0 });
            holdOpen[c] = null;
          }
        }
      }
      measureIdx++;
    }
    if (!notes.length) continue;
    const diffName = (blk.head.DIFFICULTY || '').trim() || 'SM 谱';
    charts.push({
      diffName: `[SM] ${diffName}`,
      keyCount,
      notes: clampNotes(notes, keyCount),
      noteCount: notes.length,
    });
  }
  if (!charts.length) throw new Error('该 ' + fileName + ' 的所有谱面均无有效音符');
  return {
    meta: {
      title,
      artist: (data.ARTIST || '').trim() || null,
      audioFile: findAudioName(data.MUSIC || data.PREVIEWVIDEOFULLSCREEN || ''),
      bpm: bpmEvents.length ? Math.round(bpmEvents[0].bpm) : null,
      source: 'sm',
    },
    charts,
  };
}

function findAudioName(musicTag) {
  const name = String(musicTag || '').trim();
  if (!name) return null;
  return name;
}

// ---------- .mc（Malody Key 模式，JSON） ----------

export function parseMc(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error('.mc 不是合法 JSON：' + e.message); }
  if (!doc || !Array.isArray(doc.NOTES)) throw new Error('该 .mc 缺少 NOTES 数组（可能不是 Key 模式谱）');
  const meta = doc.META || {};
  // Malody 模式：0=Key, 1=Jubeat...（宽容处理：以 NOTE 结构判断）
  const sample = doc.NOTES.find((n) => n && n.column !== undefined);
  if (!sample) throw new Error('该 .mc 的音符不含 column 字段（非 Key 模式），无法导入');

  // TIME 段：[{ beat, bpm }]
  const bpmEvents = (Array.isArray(doc.TIME) ? doc.TIME : [])
    .map((e) => ({ beat: beatToNumber(e.beat), bpm: parseFloat(e.bpm) }))
    .filter((e) => Number.isFinite(e.beat) && Number.isFinite(e.bpm) && e.bpm > 0)
    .sort((x, y) => x.beat - y.beat);
  if (!bpmEvents.length) bpmEvents.push({ beat: 0, bpm: 120 });
  const beatToSec = makeBeatToSec(bpmEvents, 0);

  // column 0..max
  const keyCount = Math.max(...doc.NOTES.map((n) => (n && Number.isFinite(n.column) ? n.column : -1))) + 1;
  if (keyCount !== 4) {
    throw new Error(`该谱为 ${keyCount}K，当前仅支持导入 4K 谱面（六轨已移除）`);
  }

  const notes = [];
  for (const n of doc.NOTES) {
    if (!n || !Number.isFinite(n.column)) continue;
    const t = beatToSec(beatToNumber(n.beat));
    const hold = beatToNumber(n.hold);
    if (Number.isFinite(hold) && hold > 0.02) {
      const dSec = beatToSec(beatToNumber(n.beat) + hold) - t;
      if (dSec > 0.05) notes.push({ t, lane: n.column, type: 'hold', d: dSec });
      else notes.push({ t, lane: n.column, type: 'tap' });
    } else {
      notes.push({ t, lane: n.column, type: 'tap' });
    }
  }
  if (!notes.length) throw new Error('该 .mc 没有可导入的音符');

  const diffName = String(meta.version || meta.Version || 'Malody 谱');
  return {
    meta: {
      title: (meta.song || meta.Song || meta.title || '').trim() || null,
      artist: (meta.artist || meta.Artist || '').trim() || null,
      audioFile: (meta.song_id || meta.background || '').trim() || null, // .mc 的音频在包内按 song_id 索引，无文件名
      bpm: Math.round(bpmEvents[0].bpm),
      source: 'mc',
    },
    charts: [{
      diffName: `[Malody] ${diffName}`,
      keyCount,
      notes: clampNotes(notes, keyCount),
      noteCount: notes.length,
    }],
  };
}

/** Malody beat 字段：数字 或 [小节, 拍, 分母] → 总拍数（Malody Key 惯例 4 拍/小节） */
function beatToNumber(b) {
  if (Number.isFinite(b)) return b;
  if (Array.isArray(b) && b.length >= 2) {
    const bar = Number(b[0]) || 0;
    const beat = Number(b[1]) || 0;
    const frac = b.length >= 3 ? Number(b[2]) || 0 : 0;
    return bar * 4 + beat + frac;
  }
  return NaN;
}

// ---------- 入口：按内容分派 ----------

export function parseChartFile(text, fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (ext === 'osu') return parseOsu(text);
  if (ext === 'mc') return parseMc(text);
  if (ext === 'sm' || ext === 'ssc') return parseSm(text, fileName);
  // 无扩展名时嗅探
  const t = text.trimStart();
  if (t.startsWith('{') && t.includes('"NOTES"')) return parseMc(text);
  if (/^osu file format v/i.test(t)) return parseOsu(text);
  if (t.startsWith('#')) return parseSm(text, fileName);
  throw new Error('不支持的谱面格式：' + fileName + '（支持 .osu / .mc / .sm / .ssc）');
}

export { chartStats, AUDIO_EXTS };
