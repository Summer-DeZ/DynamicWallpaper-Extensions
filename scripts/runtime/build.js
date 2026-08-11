const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const crypto = require('node:crypto');

const projectDirectory = path.resolve(__dirname, '..', '..');
const sourceDirectory = path.join(projectDirectory, 'runtime-src');
const outputDirectory = path.join(projectDirectory, 'dist', 'webgl-runtime');

async function main() {
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  fs.mkdirSync(outputDirectory, { recursive: true });

  const quickJsWasm = path.join(
    projectDirectory,
    'node_modules', '@jitl', 'quickjs-wasmfile-release-sync', 'dist', 'emscripten-module.wasm'
  );
  const wasm = fs.readFileSync(quickJsWasm);
  const wasmHash = crypto.createHash('sha256').update(wasm).digest('hex').slice(0, 12);
  const wasmName = `emscripten-module-${wasmHash}.wasm`;
  const result = await esbuild.build({
    entryPoints: [path.join(sourceDirectory, 'index.ts')],
    outdir: outputDirectory,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome128'],
    sourcemap: true,
    // This bundle is parsed in every VS Code window. Keep source maps for
    // local diagnostics, but ship optimized code so startup does not pay for
    // Three.js and QuickJS's development-sized syntax.
    minify: true,
    legalComments: 'linked',
    loader: {
      '.wasm': 'file'
    },
    assetNames: 'assets/[name]-[hash]',
    entryNames: 'assets/[name]-[hash]',
    metafile: true,
    conditions: ['browser', 'import', 'default'],
    plugins: [{
      name: 'quickjs-hashed-wasm',
      setup(build) {
        build.onLoad({ filter: /emscripten-module\.browser\.mjs$/ }, async args => ({
          contents: (await fs.promises.readFile(args.path, 'utf8'))
            .replaceAll('emscripten-module.wasm', wasmName),
          loader: 'js'
        }));
      }
    }],
    define: {
      'process.env.NODE_ENV': '"production"'
    }
  });
  const entryOutput = Object.entries(result.metafile.outputs)
    .find(([, metadata]) => metadata.entryPoint?.replace(/\\/g, '/').endsWith('runtime-src/index.ts'))?.[0];
  if (!entryOutput) throw new Error('esbuild did not produce the runtime entry bundle.');
  const scriptPath = path.relative(outputDirectory, path.resolve(entryOutput)).replace(/\\/g, '/');
  const css = fs.readFileSync(path.join(sourceDirectory, 'renderer.css'));
  const cssHash = crypto.createHash('sha256').update(css).digest('hex').slice(0, 12);
  const cssPath = `assets/renderer-${cssHash}.css`;
  fs.writeFileSync(path.join(outputDirectory, cssPath), css);
  fs.writeFileSync(path.join(outputDirectory, 'assets', wasmName), wasm);
  const html = fs.readFileSync(path.join(sourceDirectory, 'renderer.html'), 'utf8')
    .replace('./renderer.css', `./${cssPath}`)
    .replace('./renderer.js', `./${scriptPath}`);
  fs.writeFileSync(path.join(outputDirectory, 'renderer.html'), html);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
