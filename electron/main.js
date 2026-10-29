// ============ Electron 主进程：窗口 / app:// 协议 / 文件持久化 / 导出 ============
const { app, BrowserWindow, ipcMain, protocol, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

const DIST_DIR = path.join(__dirname, '..', 'dist');
// 未打包时默认加载本地 dist（开箱即用）；显式 BC_DEV=1 且 vite dev server 运行中时走热更新
const isDev = !app.isPackaged && process.env.BC_DEV === '1';

// 便携版：数据跟随 exe 所在目录（U 盘/绿色软件场景）
function resolveUserData() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir && fs.existsSync(portableDir)) {
    const dataDir = path.join(portableDir, 'BeatChartData');
    try { fs.mkdirSync(dataDir, { recursive: true }); app.setPath('userData', dataDir); } catch (e) { /* 忽略，回退默认 */ }
  }
}
resolveUserData();

function audioDir() {
  const dir = path.join(app.getPath('userData'), 'audio');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 自定义安全协议（规避 file:// 下 ES Module 的 CORS 限制）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#0a0e18',
    autoHideMenuBar: true,
    title: 'BeatChart Arcade',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadURL('app://./index.html');
  }
  // 渲染进程诊断日志转发（便于排查白屏等问题）
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[renderer]', message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, failedUrl) => {
    console.error('[load-fail]', code, desc, failedUrl);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[render-gone]', details.reason);
  });
  // 冒烟测试：BC_SMOKE=1 时两阶段执行——
  //   阶段1：注入 v1.0.0 旧格式数据（keymap 为对象，即线上崩溃根因）后重载页面
  //   阶段2：验证页面渲染 / 存储自愈归一化 / IPC / 静态资源 / Worker / AudioContext
  if (process.env.BC_SMOKE) {
    let smokePhase = 0;
    win.webContents.on('did-finish-load', async () => {
      smokePhase++;
      try {
        if (smokePhase === 1) {
          await win.webContents.executeJavaScript(
            `window.beatchart.storageSet('library.json', JSON.stringify({library:{songs:{},order:[]},settings:{keyCount:4,keymap:{0:'KeyD',1:'KeyF',2:'KeyJ',3:'KeyK'},scrollSpeed:5,volume:0.8}}))`
          );
          win.webContents.reload();
          return;
        }
        await new Promise((r) => setTimeout(r, 3500));
        const result = await win.webContents.executeJavaScript(`(async function(){
          var out = {};
          var el = document.querySelector('.library-screen') || document.querySelector('.boot-screen');
          out.page = { found: !!el, cls: el && el.className };
          // 旧格式数据自愈：keymap 应回写为数组
          try {
            var raw = await window.beatchart.storageGet('library.json');
            var parsed = JSON.parse(raw);
            out.healedKeymap = Array.isArray(parsed.settings && parsed.settings.keymap)
              && parsed.settings.keymap.length === 4;
          } catch (e) { out.healedKeymap = false; }
          // IPC 存储往返
          try {
            await window.beatchart.storageSet('e2e-smoke.json', 'PING_OK');
            out.ipc = (await window.beatchart.storageGet('e2e-smoke.json')) === 'PING_OK';
          } catch (e) { out.ipc = false; }
          // 静态资源 + data URL Worker 机制验证（内联 worker 同机制）
          try {
            var scriptSrc = document.querySelector('script[type=module]').getAttribute('src');
            var res = await fetch(new URL(scriptSrc, location.href).href);
            out.assets = res.status === 200;
            var b64 = btoa('self.onmessage=function(e){self.postMessage(e.data.x*2)}');
            out.realWorker = await new Promise(function (resolve) {
              try {
                var w = new Worker('data:text/javascript;base64,' + b64);
                var done = false;
                function fin(v) { if (!done) { done = true; resolve(v); try { w.terminate(); } catch (e) {} } }
                w.onmessage = function (e) { fin(e.data === 84); };
                w.onerror = function () { fin(false); };
                w.postMessage({ x: 42 });
                setTimeout(function () { fin(false); }, 4000);
              } catch (e) { resolve(false); }
            });
          } catch (e) { out.assets = false; out.realWorker = false; }
          // Worker 机制
          out.worker = await new Promise(function (resolve) {
            try {
              var blob = new Blob(['self.onmessage=function(e){self.postMessage(e.data.x*2)}'], { type: 'text/javascript' });
              var w = new Worker(URL.createObjectURL(blob));
              w.onmessage = function (e) { resolve(e.data === 84); w.terminate(); };
              w.onerror = function () { resolve(false); };
              w.postMessage({ x: 42 });
              setTimeout(function () { resolve(false); w.terminate(); }, 3000);
            } catch (e) { resolve(false); }
          });
          // AudioContext
          try { var ac = new AudioContext(); out.audio = ac.sampleRate > 0; ac.close(); } catch (e) { out.audio = false; }
          // PixiJS 渲染器无头构造（下落式 + 放射式，覆盖 CSP unsafe-eval / WebGL 初始化类错误）
          try {
            out.rendererPoke = window.__BCPokeRenderer ? window.__BCPokeRenderer() : 'no_hook';
            out.renderer = out.rendererPoke === true;
          } catch (e) { out.renderer = false; out.rendererPoke = String(e); }
          return JSON.stringify(out);
        })()`);
        console.log('SMOKE_RESULT=' + result);
        const parsed = JSON.parse(result);
        const ok = parsed.page && parsed.page.found === true && parsed.ipc === true
          && parsed.worker === true && parsed.audio === true && parsed.assets === true
          && parsed.realWorker === true && parsed.healedKeymap === true && parsed.renderer === true;
        app.exit(ok ? 0 : 4);
      } catch (err) {
        console.error('SMOKE_ERR', String(err));
        app.exit(4);
      }
    });
  }
  return win;
}

// ---- IPC：存储 ----
ipcMain.handle('storage:get', async (_e, key) => {
  try {
    const file = path.join(app.getPath('userData'), String(key).replace(/[\\/]/g, '_'));
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf-8');
  } catch (err) { return null; }
});
ipcMain.handle('storage:set', async (_e, key, value) => {
  try {
    const file = path.join(app.getPath('userData'), String(key).replace(/[\\/]/g, '_'));
    fs.writeFileSync(file, String(value), 'utf-8');
    return true;
  } catch (err) { return false; }
});

// ---- IPC：音频文件 ----
ipcMain.handle('audio:save', async (_e, id, ext, data) => {
  try {
    const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '') + '.' + String(ext).replace(/[^a-zA-Z0-9]/g, '');
    const file = path.join(audioDir(), safe);
    fs.writeFileSync(file, Buffer.from(data));
    return true;
  } catch (err) { return false; }
});
ipcMain.handle('audio:read', async (_e, id, ext) => {
  try {
    const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '') + '.' + String(ext).replace(/[^a-zA-Z0-9]/g, '');
    const file = path.join(audioDir(), safe);
    if (!fs.existsSync(file)) return null;
    const buf = fs.readFileSync(file);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch (err) { return null; }
});
ipcMain.handle('audio:delete', async (_e, fileName) => {
  try {
    const safe = String(fileName).replace(/[^a-zA-Z0-9_.-]/g, '');
    const file = path.join(audioDir(), safe);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch (err) { return false; }
});

// ---- IPC：导出（保存对话框） ----
ipcMain.handle('export:save', async (e, defaultName, data) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showSaveDialog(win, { defaultPath: String(defaultName) });
  if (res.canceled || !res.filePath) return { canceled: true };
  try {
    fs.writeFileSync(res.filePath, Buffer.from(data));
    return { canceled: false, path: res.filePath };
  } catch (err) {
    return { canceled: true, error: String(err) };
  }
});

// ---- 应用生命周期 ----
app.whenReady().then(() => {
  if (!isDev) {
    protocol.handle('app', (request) => {
      try {
        const u = new URL(request.url);
        let pathname = decodeURIComponent(u.pathname);
        if (pathname === '/' || pathname === '') pathname = '/index.html';
        const filePath = path.normalize(path.join(DIST_DIR, pathname));
        if (!filePath.startsWith(path.normalize(DIST_DIR))) {
          return new Response(null, { status: 403 });
        }
        return net.fetch(url.pathToFileURL(filePath).toString());
      } catch (err) {
        return new Response(null, { status: 500 });
      }
    });
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
