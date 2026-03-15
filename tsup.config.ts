import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'acumatica/index': 'src/acumatica/index.ts',
    'github/index': 'src/github/index.ts',
    'railway/index': 'src/railway/index.ts',
    'godaddy/index': 'src/godaddy/index.ts',
    'zoom/index': 'src/zoom/index.ts',
    'microsoft/index': 'src/microsoft/index.ts',
    'hubspot/index': 'src/hubspot/index.ts',
    'slack/index': 'src/slack/index.ts',
    'shared/config': 'src/shared/config.ts',
    'acumatica/recipes': 'src/acumatica/recipes.ts',
    'hubspot/recipes': 'src/hubspot/recipes.ts',
    'zoom/recipes': 'src/zoom/recipes.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
});
