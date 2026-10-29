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
