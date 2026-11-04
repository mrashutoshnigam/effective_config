// @ts-check
import { build, context } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  mainFields: ['module', 'main'],
  sourcemap: true,
};

/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
};

/** Copies the webview stylesheet into dist. */
async function copyStyles() {
  await mkdir('dist', { recursive: true });
  await copyFile('src/webview/styles.css', 'dist/webview.css');
}

if (watch) {
  const ctxs = await Promise.all([context(extensionOptions), context(webviewOptions)]);
  await copyStyles();
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching...');
} else {
  await Promise.all([build(extensionOptions), build(webviewOptions)]);
  await copyStyles();
}
