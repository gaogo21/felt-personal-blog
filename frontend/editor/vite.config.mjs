import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: '../../src/Blog.Web/wwwroot/js/admin', emptyOutDir: false,
    minify: true, sourcemap: false,
    lib: { entry: resolve(import.meta.dirname, 'src/editor.mjs'), formats: ['es'], fileName: () => 'editor.bundle.js' },
    rolldownOptions: { output: { banner: readFileSync(resolve(import.meta.dirname, 'generated/runtime-licenses.txt'), 'utf8') } },
  },
});
