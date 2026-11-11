// Builds the static router into dist/ (login_router.md §2): one bundled
// script, the pages, the stylesheet, and the security headers file.
// Files are overwritten in place; dist/ holds nothing else.
//
// ROUTER_WALLETS=<path> bakes a different certified wallet list into the
// bundle (used by the browser tests); the default is ./wallets.json, which
// scripts/build-wallet-list.mjs generates from the chain.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const outdir = process.env.ROUTER_OUTDIR ?? 'dist';
const walletsPath = resolve(process.env.ROUTER_WALLETS ?? 'wallets.json');

mkdirSync(outdir, { recursive: true });
cpSync('public', outdir, { recursive: true, force: true });
await build({
  entryPoints: ['src/pages.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  outfile: `${outdir}/router.js`,
  logLevel: 'info',
  plugins: [
    {
      name: 'wallet-list',
      setup(b) {
        b.onResolve({ filter: /wallets\.json$/ }, () => ({ path: walletsPath }));
      },
    },
  ],
});
