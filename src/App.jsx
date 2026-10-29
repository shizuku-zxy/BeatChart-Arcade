import React, { useEffect, useState } from 'react';
import { initStore } from './core/store.js';
import { useStore } from './core/hooks.js';
import { isTouchDevice, isNativeApp } from './core/constants.js';
import { startLibraryUpgrade } from './core/upgrade.js';
import LibraryScreen from './screens/LibraryScreen.jsx';
import SongScreen from './screens/SongScreen.jsx';
import GameScreen from './screens/GameScreen.jsx';
import ResultScreen from './screens/ResultScreen.jsx';
import SettingsScreen from './screens/SettingsScreen.jsx';
import MusicAxisScreen from './screens/MusicAxisScreen.jsx';
import CalibScreen from './screens/CalibScreen.jsx';
import RecorderScreen from './screens/RecorderScreen.jsx';

export default function App() {
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState({ screen: 'library' });
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    // 移动环境标记（紧凑横屏布局）+ 阻止移动端双击缩放/长按菜单
    if (isTouchDevice() || isNativeApp()) {
      document.documentElement.classList.add('mobile');
      if (isTouchDevice()) document.documentElement.classList.add('touch');
      document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
    }
    initStore().then(() => {
      setReady(true);
      startLibraryUpgrade(3000); // v1.8.1：旧版分析自动升级队列（后台串行，seed 保留可回退）
    });
  }, []);

  const state = useStore();

  if (!ready) {
    return (
      <div className="boot-screen">
        <div className="boot-logo">BeatChart Arcade</div>
        <div className="boot-sub">正在载入曲库…</div>
      </div>
    );
  }

  const navigate = (next) => setRoute(next);

  let screen = null;
  if (route.screen === 'library') {
    screen = (
      <LibraryScreen
        state={state}
        navigate={navigate}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    );
  } else if (route.screen === 'song') {
    screen = <SongScreen state={state} songId={route.songId} navigate={navigate} />;
  } else if (route.screen === 'axis') {
    screen = <MusicAxisScreen state={state} songId={route.songId} chartId={route.chartId} navigate={navigate} />;
  } else if (route.screen === 'game') {
    screen = <GameScreen key={route.runId} state={state} songId={route.songId} diff={route.diff} navigate={navigate} />;
  } else if (route.screen === 'result') {
    screen = <ResultScreen state={state} result={route.result} navigate={navigate} />;
  } else if (route.screen === 'calib') {
    screen = <CalibScreen state={state} navigate={navigate} />;
  } else if (route.screen === 'recorder') {
    screen = <RecorderScreen key={route.runId || 'rec'} state={state} songId={route.songId} navigate={navigate} />;
  }

  return (
    <div className="app-root">
      {screen}
      {settingsOpen && (
        <SettingsScreen
          state={state}
          onClose={() => setSettingsOpen(false)}
          onOpenCalib={() => { setSettingsOpen(false); navigate({ screen: 'calib' }); }}
        />
      )}
    </div>
  );
}
