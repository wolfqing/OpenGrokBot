import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  server: {
    // 网关默认只听 127.0.0.1；/auth 是启动日志里那条登录链接
    proxy: {
      '/api': 'http://127.0.0.1:4747',
      '/auth': 'http://127.0.0.1:4747',
      '/ws': { target: 'ws://127.0.0.1:4747', ws: true },
      // 电脑屏幕（noVNC 页面 + 它的 WebSocket）也经网关
      '/vnc': { target: 'http://127.0.0.1:4747', ws: true },
      // routine 的 webhook：面板复制出来的地址在 dev 下也能直接用
      '/hooks': 'http://127.0.0.1:4747',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test-setup.ts',
  },
})
