import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.teleagent.beatchart',
  appName: 'BeatChart Arcade',
  webDir: 'dist',
  android: {
    // 允许 WebView 使用的混合特性
    allowMixedContent: false,
  },
  // 保持屏幕常亮由应用层处理；此处仅基础配置
};

export default config;
