/**
 * WebTape recorder esbuild bundle script.
 *
 * Bundles each extension entry point from src/ into the extension root,
 * inlining all imports so Chrome can load them as standalone scripts
 * without any module bundler at runtime.
 */

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const sharedOptions = {
  bundle: true,
  minify: false,
  sourcemap: false,
  target: ['chrome88'],
  logLevel: 'info',
};

await Promise.all([
  // Service Worker — must be a classic script (no ES module syntax in output)
  esbuild.build({
    ...sharedOptions,
    entryPoints: [path.join(root, 'src/background.js')],
    outfile: path.join(root, 'background.js'),
    format: 'iife',
    // Service Workers use globalThis; wrapping in IIFE is safe
    globalName: undefined,
  }),

  // Content Script — injected into web pages as classic script
  esbuild.build({
    ...sharedOptions,
    entryPoints: [path.join(root, 'src/content.js')],
    outfile: path.join(root, 'content.js'),
    format: 'iife',
  }),

  // Popup script — runs in the extension popup page context
  esbuild.build({
    ...sharedOptions,
    entryPoints: [path.join(root, 'src/popup.js')],
    outfile: path.join(root, 'popup.js'),
    format: 'iife',
  }),

  // Record launcher script — runs in record-launcher.html page context
  esbuild.build({
    ...sharedOptions,
    entryPoints: [path.join(root, 'src/record-launcher.js')],
    outfile: path.join(root, 'record-launcher.js'),
    format: 'iife',
  }),
]);

console.log('✅ All bundles built successfully.');
