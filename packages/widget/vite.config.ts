import { defineConfig } from 'vite';
import { devApiMock } from './dev/mock-api.ts';

// Library build: one self-contained ES module (Preact and CSS included) that cms-api serves
// at /_cms/widget.js. Only the dev server adds the fake /_cms/api used by dev/index.html.
export default defineConfig(({ command }) => ({
  plugins: command === 'serve' ? [devApiMock()] : [],
  define: command === 'build' ? { 'process.env.NODE_ENV': JSON.stringify('production') } : {},
  build: {
    target: 'es2022',
    minify: true,
    rolldownOptions: { output: { minify: true } },
    emptyOutDir: true,
    lib: {
      entry: 'src/main.tsx',
      formats: ['es'],
      fileName: () => 'widget.js',
    },
  },
}));
