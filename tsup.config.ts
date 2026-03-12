import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'acumatica/index': 'src/acumatica/index.ts',
    'github/index': 'src/github/index.ts',
    'railway/index': 'src/railway/index.ts',
    'shared/config': 'src/shared/config.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
});
