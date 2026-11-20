import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths: the build works at any address, e.g. https://<user>.github.io/<repo>/.
  base: './',
  server: { host: true },
  build: { target: 'es2022', sourcemap: true },
  test: { include: ['tests/**/*.test.ts'] },
});
