import { defineConfig } from 'vitest/config';

/**
 * 单元测试配置。与 vite.config.ts 分开，避免把 dev server warmup / manualChunks
 * 带进测试环境；纯函数测试用 node 环境即可，无需 jsdom。
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    // qa-gate 的 report() 会写 process.exitCode，测试里用 vi.resetModules 隔离，
    // 这里不并发同一个 worker，避免 exitCode 互相污染。
    fileParallelism: false,
    reporters: ['default'],
  },
});
