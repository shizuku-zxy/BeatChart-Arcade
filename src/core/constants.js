// ============ BeatChart Arcade 全局常量 ============

export const APP_NAME = 'BeatChart Arcade';
export const APP_VERSION = '1.8.1';

// 三档难度参数（生成器输入）
export const DIFFICULTIES = {
  E: {
    key: 'E',
    label: 'E · 轻松',
    color: 0x4fc98a,
    cssColor: '#4fc98a',
    // 目标密度（note/秒，含 hold 头）
    density: 0.95,
    // 允许的节拍细分等级：1=四分音符 2=八分 4=十六分
    // 每档按段落能量动态选择细分上限
    subdivLow: 1,   // 低能量段
    subdivMid: 2,   // 中能量段
    subdivHigh: 2,  // 高能量段
    holdProb: 0.06,
    holdMinDur: 0.30,
    holdMaxDur: 1.0,
    maxSimul: 1,        // 同一时刻最大同时按键数
    simulProb: 0,
    sameLaneMinGap: 0.36, // 同轨相邻 note 最小间隔（秒）
    jackMaxRun: 1,        // 纵连键型最大连击数（E 不主动出纵连）
  },
  H: {
    key: 'H',
    label: 'H · 标准',
    color: 0x6ec3ff,
    cssColor: '#6ec3ff',
    density: 2.1,
    subdivLow: 1,
    subdivMid: 2,
    subdivHigh: 2,
    holdProb: 0.14,
    holdMinDur: 0.28,
    holdMaxDur: 1.4,
    maxSimul: 2,
    simulProb: 0.09,
    sameLaneMinGap: 0.20,
    jackMaxRun: 2,       // 纵连最长 2 连
  },
  EX: {
    key: 'EX',
    label: 'EX · 专家',
    color: 0xff7a9e,
    cssColor: '#ff7a9e',
    density: 3.9,
    subdivLow: 2,
    subdivMid: 4,
    subdivHigh: 4,
    holdProb: 0.18,
    holdMinDur: 0.25,
    holdMaxDur: 1.8,
    maxSimul: 2,
    simulProb: 0.20,
    sameLaneMinGap: 0.135,
    jackMaxRun: 4,       // 纵连最长 4 连（有意纵连键型）
  },
};

export const DIFF_ORDER = ['E', 'H', 'EX'];

// 判定窗口（秒，±）
export const JUDGE_WINDOWS = {
  perfect: 0.050,
  great: 0.100,
  good: 0.150,
  // 超出 good 窗口且未按 → miss（note 过线 0.15s）
};

/** hold 提前松手宽容：尾前剩余 ≤ 此值不判 miss，按提前量给判定（v1.5.0 移动端友好） */
export const HOLD_RELEASE_GRACE = 0.35;

export const JUDGE_SCORE_WEIGHT = { perfect: 1.0, great: 0.7, good: 0.4, miss: 0 };

export const RANK_TABLE = [
  { min: 99.5, rank: 'SSS' }, { min: 98, rank: 'SS' }, { min: 95, rank: 'S' },
  { min: 90, rank: 'A' }, { min: 80, rank: 'B' }, { min: 70, rank: 'C' },
  { min: 0, rank: 'D' },
];

// 默认键位（v1.6.1：六轨已移除，仅 4 轨）
export const DEFAULT_KEYMAPS = {
  4: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
};

export const KEY_LABELS = {
  KeyD: 'D', KeyF: 'F', KeyJ: 'J', KeyK: 'K', KeyS: 'S', KeyL: 'L',
  Space: '空格', ShiftLeft: '左Shift',
};

export const KEY_COUNT = 4; // v1.6.1：固定 4 轨

export const DEFAULT_SETTINGS = {
  keyCount: 4,
  keymap: [...DEFAULT_KEYMAPS[4]],  // 必须是数组（曾因 { ...array } 对象化引发崩溃）
  scrollSpeed: 5,       // 下落速度等级（1-15，映射下落时长）
  latencyMs: 0,         // 音频输出延迟校准（毫秒）
  volume: 0.8,
  musicOffsetMs: 0,     // 谱面整体偏移微调
  clickSound: true,     // 打击音效
  renderMode: null,     // 'fall' 下落式 | 'persp' 透视式（v1.5.0：null = 自动，触屏→透视式、桌面→下落式）
};

/** 触屏设备检测（移动端/触屏适配：暂停按钮、提示文案等） */
export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
}

/** Capacitor（Android/iOS 壳）环境检测 */
export function isNativeApp() {
  return typeof window !== 'undefined' && !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

/** 解析实际渲染模式（v1.8.1b：自动 = 统一透视式，桌面/触屏一致——用户指定电脑端也用立体画面；
 * 下落式保留为手动选项；旧值 radial 归入自动） */
export function resolveRenderMode(settings) {
  const mode = settings && settings.renderMode;
  if (mode === 'fall' || mode === 'persp') return mode;
  return 'persp';
}

/** 设置归一化：容忍旧版本/损坏数据（keymap 可能是对象、缺失、长度不符），输出保证合法。
 *  v1.6.1：六轨已移除，旧数据 keyCount=6 一律收敛到 4。 */
export function normalizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const keyCount = KEY_COUNT;
  let km = merged.keymap;
  if (merged.keyCount === 6) {
    // v1.6.1：旧六轨数据——键位语义不对应（S D F J ≠ 4 轨手位），直接回默认
    km = null;
  }
  if (Array.isArray(km)) km = km.filter((c) => typeof c === 'string' && c);
  else if (km && typeof km === 'object') km = Object.values(km).filter((c) => typeof c === 'string' && c); // 兼容旧版对象形式
  else km = [];
  if (km.length < keyCount) km = [...DEFAULT_KEYMAPS[keyCount]];
  else km = km.slice(0, keyCount);
  const volNum = Number(merged.volume);
  return {
    ...merged,
    keyCount,
    keymap: km,
    scrollSpeed: Math.max(1, Math.min(15, Number(merged.scrollSpeed) || 5)),
    latencyMs: Number(merged.latencyMs) || 0,
    musicOffsetMs: Number(merged.musicOffsetMs) || 0,
    volume: Number.isFinite(volNum) ? Math.max(0, Math.min(1, volNum)) : 0.8,
    clickSound: merged.clickSound !== false,
    renderMode: merged.renderMode === 'fall' || merged.renderMode === 'persp' ? merged.renderMode : null, // 旧值 radial → 自动
  };
}

/** 按歌曲轨道数取有效键位：v1.6.1 六轨已移除，一律 4 键；非法时默认键位兜底 */
export function effectiveKeymap(settings, songKeyCount) {
  const n = KEY_COUNT;
  let km = Array.isArray(settings && settings.keymap)
    ? settings.keymap.filter((c) => typeof c === 'string' && c)
    : [];
  if (km.length < n) km = [...DEFAULT_KEYMAPS[n]];
  return km.slice(0, n);
}

export function speedToApproach(level) {
  // 速度等级 → note 从屏顶到判定线的时长（秒）。
  // v1.8.1b：上限 10 → 15（1-10 档不变，11-15 每档 -0.025s）。
  // 判定窗口固定毫秒（±50/100/150ms）与流速无关——慢快流速理论判定时间相等。
  const clamped = Math.max(1, Math.min(15, level));
  if (clamped <= 10) return 1.15 - clamped * 0.095; // 等级1=1.055s，等级10=0.2s
  return 0.2 - (clamped - 10) * 0.025;             // 等级11=0.175s … 等级15=0.075s
}

export const STORAGE_KEYS = {
  library: 'library.json',
};
