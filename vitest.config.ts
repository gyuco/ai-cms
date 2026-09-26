import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages,templates}/*/{src,lib}/**/*.test.ts'],
    passWithNoTests: true,
  },
});
