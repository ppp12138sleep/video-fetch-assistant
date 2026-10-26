import { copyFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build as viteBuild } from 'vite';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function buildContentScript(entry, outfile) {
  await viteBuild({
    configFile: false,
    root,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir: dist,
      emptyOutDir: false,
      copyPublicDir: false,
      target: 'chrome116',
      minify: true,
      sourcemap: false,
      lib: {
        entry: resolve(root, entry),
        formats: ['iife'],
        name: 'VVAContentScript',
        fileName: () => outfile,
      },
    },
  });
  const info = await stat(resolve(dist, outfile));
  console.log(`[content] ${outfile}  ${mb(info.size)}`);
}

async function copyFfmpeg() {
  const vendor = resolve(dist, 'vendor', 'ffmpeg');
  await mkdir(vendor, { recursive: true });
  for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
    const from = resolve(root, 'node_modules/@ffmpeg/core/dist/esm', file);
    await copyFile(from, resolve(vendor, file));
    const info = await stat(resolve(vendor, file));
    console.log(`[ffmpeg] vendor/ffmpeg/${file}  ${mb(info.size)}`);
  }
}

console.log('[build] 1/3 构建扩展页面与 Service Worker');
await viteBuild({ configFile: resolve(root, 'vite.config.ts'), mode: 'production' });

console.log('[build] 2/3 构建隔离内容脚本');
await buildContentScript('src/content/content-script.ts', 'content-script.js');
await buildContentScript('src/content/network-hook.ts', 'network-hook.js');

console.log('[build] 3/3 复制本地 ffmpeg.wasm 核心');
await copyFfmpeg();

console.log('[build] 完成，输出目录：dist/');
