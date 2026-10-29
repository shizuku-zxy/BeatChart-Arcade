// ============ 构建防呆：拒绝用陈旧 dist 打包 ============
// 事故背景：v1.3.1 exe 打包时复用了旧 dist（chartgen 修复未编入），
// 导致用户拿到"重复段复现全开"的 v1.3.0 行为（前 10 秒后全空）。
// 守卫：dist 产物必须新于 src/ 与 electron/ 中所有源文件，
// 否则直接失败，提示先 vite build。
import { readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function newestMtime(dir, acc = { mtime: 0, file: '' }) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.temp' || name === 'dist' || name === 'android' || name === 'release') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) acc = newestMtime(p, acc);
    else if (st.mtimeMs > acc.mtime) acc = { mtime: st.mtimeMs, file: p };
  }
  return acc;
}

const srcNewest = newestMtime(join(root, 'src'));
const distDir = join(root, 'dist');
if (!existsSync(distDir)) {
  console.error('[verify-dist] dist/ 不存在，请先 npm run build');
  process.exit(1);
}
const distNewest = newestMtime(distDir);

if (srcNewest.mtime >= distNewest.mtime) {
  console.error('[verify-dist] dist 产物比源码旧，禁止打包（曾因此把旧 chartgen 发给用户）：');
  console.error('  最新源文件: ' + srcNewest.file + ' (' + new Date(srcNewest.mtime).toLocaleString() + ')');
  console.error('  最新产物:   ' + distNewest.file + ' (' + new Date(distNewest.mtime).toLocaleString() + ')');
  console.error('  → 请先执行 npm run build');
  process.exit(1);
}
console.log('[verify-dist] OK：dist (' + new Date(distNewest.mtime).toLocaleString() + ') 新于全部源码');
