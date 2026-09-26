import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages,templates}/*/src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
