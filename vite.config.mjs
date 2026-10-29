import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  // worker 用 iife 格式，确保 app:// 自定义协议与打包后环境兼容
  worker: { format: 'iife' },
  build: {
    target: 'chrome120',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
