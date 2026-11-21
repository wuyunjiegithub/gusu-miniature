import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    /**
     * 预转换入口依赖图。
     * 本项目有 60 多个源文件、drei/three 两个大包，冷启动后第一次打开页面时
     * Vite 要按请求逐个 transform，浏览器端就是一条几百毫秒一段的瀑布，
     * 叠加首帧的几何计算，看起来就像"点开卡住不动"。
     * 这里让 dev server 启动时就把这些文件转完，第一次打开能直接命中缓存。
     */
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/App.tsx',
        './src/components/*.tsx',
        './src/data/*.ts',
        './src/utils/*.ts',
        './src/hooks/*.ts',
        './src/store/*.ts',
        './src/constants/*.ts',
      ],
    },
  },
  build: {
    rollupOptions: {
      output: {
        /**
         * 分包：按依赖归属把 1.2MB 单包拆成 4 块，核心价值是长缓存——
         * three/react 几乎不变，业务代码改动时不必让用户重下整个包。
         *
         * 分组边界原则：
         * - three 与 three-stdlib 必须同块（GLTFLoader/OrbitControls 深度依赖
         *   three 内部模块，拆开会产生重复或循环引用风险）；
         * - react-reconciler 与 fiber 紧耦合，归入 r3f 组；
         * - zustand 等极小包不单独成块，跟随默认 chunk；
         * - 不按组件/图层拆（它们运行时必须同时就绪，拆开只会暴涨请求数）。
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules[\\/](three|three-stdlib|three-mesh-bvh)[\\/]/.test(id)) {
            return 'vendor-three';
          }
          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'vendor-react';
          }
          if (
            /node_modules[\\/](@react-three[\\/]|react-reconciler|its-fine|react-use-measure|use-sync-external-store|suspend-react)[\\/]/.test(
              id,
            )
          ) {
            return 'vendor-r3f';
          }
          return undefined;
        },
      },
    },
  },
});
