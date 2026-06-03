import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'apps/api/vitest.config.ts',
      'apps/web/vitest.config.ts',
      'packages/protocols/vitest.config.ts',
      'packages/provider/vitest.config.ts',
      'packages/translate/vitest.config.ts',
      'packages/provider-azure/vitest.config.ts',
      'packages/provider-copilot/vitest.config.ts',
      'packages/provider-custom/vitest.config.ts',
    ],
  },
});
