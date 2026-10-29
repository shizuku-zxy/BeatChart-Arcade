// ============ IndexedDB 存储层（无 Electron IPC 环境的持久化：Android/iOS/浏览器） ============
// 两个对象仓库：
//   kv    — 键值（library.json 等 JSON 字符串）
//   blobs — 音频原件（ArrayBuffer，key = songId）

const DB_NAME = 'beatchart';
const DB_VERSION = 1;
let _db = null;

function openDB() {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
  return _db;
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    let result;
    try { result = fn(os); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && typeof result.then !== 'function' ? unwrap(result) : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function unwrap(req) {
  return new Promise((resolve, reject) => {
    if (!req || typeof req.onsuccess !== 'function') { resolve(undefined); return; }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- kv ----
export function idbGet(key) {
  return tx('kv', 'readonly', (os) => {
    const r = os.get(key);
    return new Promise((resolve) => {
      r.onsuccess = () => resolve(r.result != null ? String(r.result) : null);
      r.onerror = () => resolve(null);
    });
  }).catch(() => null);
}

export function idbSet(key, value) {
  return tx('kv', 'readwrite', (os) => {
    const r = os.put(String(value), key);
    return new Promise((resolve) => {
      r.onsuccess = () => resolve(true);
      r.onerror = () => resolve(false);
    });
  }).catch(() => false);
}

// ---- blobs ----
export function idbPutBlob(key, arrayBuffer) {
  return tx('blobs', 'readwrite', (os) => {
    const r = os.put(arrayBuffer, key);
    return new Promise((resolve) => {
      r.onsuccess = () => resolve(true);
      r.onerror = () => resolve(false);
    });
  }).catch(() => false);
}

export function idbGetBlob(key) {
  return tx('blobs', 'readonly', (os) => {
    const r = os.get(key);
    return new Promise((resolve) => {
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  }).catch(() => null);
}

export function idbDeleteBlob(key) {
  return tx('blobs', 'readwrite', (os) => {
    const r = os.delete(key);
    return new Promise((resolve) => {
      r.onsuccess = () => resolve(true);
      r.onerror = () => resolve(false);
    });
  }).catch(() => false);
}

/** 环境可用性探测（失败则退回 localStorage） */
export async function idbAvailable() {
  try {
    await idbSet('__probe__', '1');
    const v = await idbGet('__probe__');
    return v === '1';
  } catch (e) {
    return false;
  }
}
