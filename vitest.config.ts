import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'], setupFiles: ['./tests/setup.ts'], pool: 'threads', isolate: true }
});
