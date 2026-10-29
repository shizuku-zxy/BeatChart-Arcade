// ============ 全局状态 + 本地持久化 ============
// 优先级：Electron IPC 文件存储（桌面）→ IndexedDB（Android/iOS/浏览器）→ localStorage 兜底

import { normalizeSettings } from './constants.js';
import { idbGet, idbSet, idbPutBlob, idbGetBlob, idbDeleteBlob, idbAvailable } from './idb.js';

const bridge = (typeof window !== 'undefined' && window.beatchart && window.beatchart.isElectron)
  ? window.beatchart
  : null;

const LIB_KEY = 'library.json';

let useIDB = false; // initStore 探测后置位

async function rawGet(key) {
  if (bridge) return bridge.storageGet(key);
  if (useIDB) return idbGet(key);
  try { return localStorage.getItem('bc.' + key); } catch (e) { return null; }
}
async function rawSet(key, val) {
  if (bridge) return bridge.storageSet(key, val);
  if (useIDB) return idbSet(key, val);
  try { localStorage.setItem('bc.' + key, val); return true; } catch (e) { return false; }
}

// ---------- 极简发布订阅 store ----------
let state = {
  loaded: false,
  library: { songs: {}, order: [] },
  settings: normalizeSettings(null),
};
let version = 0;
const listeners = new Set();

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getState() { return state; }
export function getVersion() { return version; }
function emit() { version++; listeners.forEach((fn) => { try { fn(); } catch (e) { /* noop */ } }); }

let persistTimer = null;
function schedulePersist() {
  if (!state.loaded) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistTimer = null; doPersist(); }, 350);
}
async function doPersist() {
  try {
    await rawSet(LIB_KEY, JSON.stringify({ library: state.library, settings: state.settings }));
  } catch (e) {
    console.error('持久化失败', e);
  }
}

export async function initStore() {
  if (!bridge) {
    useIDB = await idbAvailable(); // 一次性探测，失败退回 localStorage
  }
  const raw = await rawGet(LIB_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.library) state.library = parsed.library;
      if (parsed.settings) state.settings = normalizeSettings(parsed.settings); // 容忍旧版对象化 keymap
    } catch (e) { console.error('库数据损坏，重建', e); }
  }
  state.loaded = true;
  emit();
  // 自愈：旧版/损坏数据归一化后立即回写，避免下次启动再次处理
  if (raw) {
    const healed = JSON.stringify({ library: state.library, settings: state.settings });
    if (healed !== raw) await rawSet(LIB_KEY, healed);
  }
}

export function setSettings(patch) {
  state = { ...state, settings: normalizeSettings({ ...state.settings, ...patch }) };
  emit();
  schedulePersist();
}

// ---------- 歌曲库操作 ----------
export function upsertSong(song) {
  const songs = { ...state.library.songs, [song.id]: song };
  const order = state.library.order.includes(song.id) ? state.library.order : [...state.library.order, song.id];
  state = { ...state, library: { songs, order } };
  emit();
  schedulePersist();
}

export function updateSong(id, patch) {
  if (!state.library.songs[id]) return;
  const songs = { ...state.library.songs, [id]: { ...state.library.songs[id], ...patch } };
  state = { ...state, library: { ...state.library, songs } };
  emit();
  schedulePersist();
}

export async function removeSong(id) {
  const song = state.library.songs[id];
  if (!song) return;
  const songs = { ...state.library.songs };
  delete songs[id];
  const order = state.library.order.filter((x) => x !== id);
  state = { ...state, library: { songs, order } };
  emit();
  schedulePersist();
  audioCache.delete(id);
  if (bridge && song.audioFile) {
    try { await bridge.audioDelete(song.audioFile); } catch (e) { /* noop */ }
  } else if (useIDB) {
    try { await idbDeleteBlob(id); } catch (e) { /* noop */ }
  }
}

export function getSong(id) { return state.library.songs[id]; }

// 音频文件存取（桌面：Electron userData；移动/浏览器：IndexedDB）
const audioCache = new Map(); // id -> ArrayBuffer（会话缓存）

export async function saveAudioBlob(id, ext, arrayBuffer) {
  audioCache.set(id, arrayBuffer);
  if (bridge) {
    const ok = await bridge.audioSave(id, ext, new Uint8Array(arrayBuffer));
    if (!ok) throw new Error('音频文件保存失败');
    return;
  }
  if (useIDB) {
    const ok = await idbPutBlob(id, arrayBuffer);
    if (!ok) throw new Error('音频保存失败（IndexedDB 不可写）');
  }
}

export async function loadAudioBlob(id, ext) {
  if (audioCache.has(id)) return audioCache.get(id);
  if (bridge) {
    const buf = await bridge.audioRead(id, ext);
    if (buf) { audioCache.set(id, buf); return buf; }
    return null;
  }
  if (useIDB) {
    const buf = await idbGetBlob(id);
    if (buf) { audioCache.set(id, buf); return buf; }
  }
  return null;
}

// ---------- 导出（保存对话框） ----------
export async function exportBytes(defaultName, uint8OrString) {
  const data = typeof uint8OrString === 'string'
    ? new TextEncoder().encode(uint8OrString)
    : uint8OrString;
  if (bridge) {
    const res = await bridge.exportSave(defaultName, data);
    return res; // { canceled, path }
  }
  // 浏览器兜底：下载
  const blob = new Blob([data]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { canceled: false, path: defaultName };
}

export function hasFileBridge() { return !!bridge || useIDB; }
