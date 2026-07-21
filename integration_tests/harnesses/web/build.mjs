import { build } from 'esbuild';

await build({
  entryPoints: ['src/scenario.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'static/scenario.js',
  inject: ['src/browser-shims.ts'],
  sourcemap: true,
  logLevel: 'info',
});
