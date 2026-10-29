// ============ 最小 ZIP 读取器（零依赖，v1.6.0 导入 .osz/.mcz 谱面包） ============
// 能力：读 central directory + 本地文件头，解压 STORE(0) / DEFLATE(8)。
// DEFLATE 用浏览器原生 DecompressionStream('deflate-raw')
// （Electron 31 / 现代 Android WebView 均支持；不支持时抛出友好错误）。
// 覆盖面：普通 zip 与 zip64 之外的常规包（osu/Malody 社区包均为常规 zip）。

async function inflateRaw(u8) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前环境不支持解压 zip（无 DecompressionStream），请解压后导入内部谱面文件');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** 解析 zip → [{ name, data:Uint8Array }]（只解压目标扩展名，避免解音频外的冗余） */
export async function unzipFiles(arrayBuffer, wantedExts) {
  const u8 = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);

  // ---- 找 EOCD（从尾部向前搜签名 0x06054b50，EOCD 最小 22 字节）----
  let eocd = -1;
  const scanStart = Math.max(0, u8.length - 22 - 65536);
  for (let i = u8.length - 22; i >= scanStart; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 包（未找到目录结束记录）');
  const entries = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  if (cdOffset + cdSize > u8.length) throw new Error('zip 目录损坏（可能是不支持的 zip64 格式）');

  // ---- 遍历 central directory ----
  const files = [];
  let p = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip 目录项签名错误');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // 目录
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (!wantedExts.includes(ext)) continue;
    files.push({ name, method, compSize, localOffset });
  }
  if (!files.length) throw new Error('zip 包内没有匹配的文件（扩展名：' + wantedExts.join('/') + '）');

  // ---- 逐文件读本地头 + 解压 ----
  const out = [];
  for (const f of files) {
    if (dv.getUint32(f.localOffset, true) !== 0x04034b50) throw new Error('zip 本地头签名错误：' + f.name);
    const lNameLen = dv.getUint16(f.localOffset + 26, true);
    const lExtraLen = dv.getUint16(f.localOffset + 28, true);
    const dataStart = f.localOffset + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(dataStart, dataStart + f.compSize);
    if (f.method === 0) {
      out.push({ name: f.name, data: raw });
    } else if (f.method === 8) {
      out.push({ name: f.name, data: await inflateRaw(raw) });
    } else {
      // 未知压缩方法：跳过该文件
    }
  }
  return out;
}

/** 解码为文本（UTF-8 优先，失败退 GBK 情况仅去掉 BOM；社区谱面基本 UTF-8/ASCII） */
export function bytesToText(u8) {
  let s = new TextDecoder('utf-8', { fatal: false }).decode(u8);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

// ---------- 最小 ZIP 写出器（零依赖，v1.8.1 导出 .osz 谱面包） ----------
// 仅使用 STORE(method=0)：谱面包内音频通常已压缩，再 DEFLATE 收益很小，
// 同时避免引入压缩实现。文件名按 UTF-8 写入并置通用标志位 11。

const DOS_TIME = 0;         // 00:00:00
const DOS_DATE = 0x21;      // 1980-01-01，ZIP 可表示的最早日期
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(u8) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) crc = CRC32_TABLE[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * 生成标准 ZIP（仅 STORE）。
 * @param {Array<{name:string,data:Uint8Array}>} files
 * @returns {Uint8Array}
 */
export function zipStore(files) {
  const entries = Array.isArray(files) ? files : [];
  if (entries.length > 0xFFFF) throw new Error('文件数量过多，无法写入 zip');
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let localOffset = 0;

  for (const file of entries) {
    const name = String(file && file.name != null ? file.name : '');
    if (!name) throw new Error('zip 文件名不能为空');
    const nameB = encoder.encode(name);
    if (nameB.length > 0xFFFF) throw new Error('zip 文件名过长');
    const data = file.data instanceof Uint8Array
      ? file.data
      : new Uint8Array(file.data instanceof ArrayBuffer ? file.data : (file.data || []));
    if (data.length > 0xFFFFFFFF) throw new Error('zip 文件过大');
    const crc = crc32(data);

    // local file header: 30 B + name + data
    const lh = new Uint8Array(30 + nameB.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034B50, true);
    lv.setUint16(4, 20, true);              // version needed
    lv.setUint16(6, 0x0800, true);          // general purpose flag: UTF-8
    lv.setUint16(8, 0, true);               // method: STORE
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);    // compressed size
    lv.setUint32(22, data.length, true);    // uncompressed size
    lv.setUint16(26, nameB.length, true);
    lv.setUint16(28, 0, true);              // extra length
    lh.set(nameB, 30);
    locals.push(lh, data);

    // central directory header: 46 B + name
    const ch = new Uint8Array(46 + nameB.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014B50, true);
    cv.setUint16(4, 20, true);              // version made by
    cv.setUint16(6, 20, true);              // version needed
    cv.setUint16(8, 0x0800, true);          // UTF-8
    cv.setUint16(10, 0, true);              // method: STORE
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint16(30, 0, true);              // extra length
    cv.setUint16(32, 0, true);              // comment length
    cv.setUint16(34, 0, true);              // disk number start
    cv.setUint16(36, 0, true);              // internal attributes
    cv.setUint32(38, 0, true);              // external attributes
    cv.setUint32(42, localOffset, true);
    ch.set(nameB, 46);
    centrals.push(ch);

    localOffset += lh.length + data.length;
    if (localOffset > 0xFFFFFFFF) throw new Error('zip 总体积过大');
  }

  const cdSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054B50, true);
  ev.setUint16(4, 0, true);                 // this disk
  ev.setUint16(6, 0, true);                 // central directory disk
  ev.setUint16(8, entries.length, true);    // entries on this disk
  ev.setUint16(10, entries.length, true);   // total entries
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, localOffset, true);
  ev.setUint16(20, 0, true);                // comment length

  const out = new Uint8Array(localOffset + cdSize + eocd.length);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) { out.set(part, p); p += part.length; }
  return out;
}
