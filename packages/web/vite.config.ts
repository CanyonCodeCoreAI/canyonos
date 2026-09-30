import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

import { getWebServerPort } from './env-loader';

export default defineConfig(({ mode }) => ({
  plugins: [
    tsconfigPaths(),
    tailwindcss(),
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react({ tsDecorators: true, devTarget: 'es2022' }),
  ],
  build: {
    target: ['chrome111', 'safari16.4', 'firefox128', 'edge111'],
    sourcemap: mode === 'development' ? true : 'hidden',
    minify: mode === 'development' ? false : 'terser',
    terserOptions:
      mode === 'development'
        ? undefined
        : {
            compress: {
              drop_console: true,
              drop_debugger: true,
              pure_funcs: ['console.log', 'console.info', 'console.debug'],
            },
            format: { comments: false },
          },
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
        manualChunks: {
          vendor: ['react', 'react-dom'],
          tanstack: ['@tanstack/react-query', '@tanstack/react-router'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom', '@tanstack/react-query'],
    esbuildOptions: { target: ['chrome111', 'safari16.4', 'firefox128', 'edge111'] },
  },
  server: {
    port: getWebServerPort(),
    allowedHosts: true,
    hmr: { overlay: mode === 'development' },
    warmup: { clientFiles: ['./src/**/*.tsx'] },
  },
}));
