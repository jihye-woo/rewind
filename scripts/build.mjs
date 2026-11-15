/**
 * 빌드. 두 가지를 만든다.
 *   1) 앱 화면: web/app.js + shared/core.js 를 묶어 web/index.html 안에 넣는다 → dist/web/index.html
 *   2) Lambda:  server/handler.mjs 와 그 의존성, 위 화면 파일을 한 파일로 묶는다 → dist/lambda/index.mjs
 * Terraform은 dist/lambda 폴더를 zip으로 만들어 올린다.
 */
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(root, ...p);

await rm(at('dist'), { recursive: true, force: true });
await mkdir(at('dist/web'), { recursive: true });
await mkdir(at('dist/lambda'), { recursive: true });

// 1) 앱 화면
const app = await build({
  entryPoints: [at('web/app.js')], bundle: true, format: 'iife', target: 'es2019', minify: false, write: false, charset: 'utf8',
  loader: { '.json': 'json' }, legalComments: 'none',
});
const js = app.outputFiles[0].text;
if (js.includes('</script>')) throw new Error('앱 코드에 </script> 가 들어 있어 HTML 안에 넣을 수 없습니다.');
const css = await readFile(at('web/style.css'), 'utf8');
const page = (await readFile(at('web/index.html'), 'utf8')).replace('/*__CSS__*/', () => css).replace('/*__APP__*/', () => js);
await writeFile(at('dist/web/index.html'), page);

// 서버가 내려 줄 정적 파일을 모듈 하나로 만든다 (글자는 그대로, 그림은 base64)
const text = async (f) => ({ body: await readFile(at('web', f), 'utf8') });
const bin = async (f) => ({ body: (await readFile(at('web', f))).toString('base64'), base64: true });
const assets = {
  'index.html': { body: page },
  'manifest.webmanifest': await text('manifest.webmanifest'),
  'icon.svg': await text('icon.svg'),
  'icon-192.png': await bin('icon-192.png'),
  'icon-512.png': await bin('icon-512.png'),
  'apple-touch-icon.png': await bin('apple-touch-icon.png'),
};
await writeFile(at('dist/web-assets.mjs'), 'export const assets = ' + JSON.stringify(assets) + ';\n');

// 2) Lambda
await build({
  entryPoints: [at('server/handler.mjs')], outfile: at('dist/lambda/index.mjs'), bundle: true, platform: 'node', format: 'esm',
  target: 'node20', minify: true, legalComments: 'none', charset: 'utf8',
  // AWS SDK 일부가 require 를 쓰므로 ESM 묶음에서도 동작하게 한다
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const size = (await readFile(at('dist/lambda/index.mjs'))).length;
console.log(`build: dist/web/index.html ${(page.length / 1024).toFixed(0)}KB, dist/lambda/index.mjs ${(size / 1024).toFixed(0)}KB`);
