const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectDirectory = path.resolve(__dirname, '..', '..');
const vsceEntry = require.resolve('@vscode/vsce/vsce');
const result = spawnSync(process.execPath, [vsceEntry, 'ls', '--no-dependencies'], {
  cwd: projectDirectory,
  encoding: 'utf8'
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} else {
  const files = result.stdout.split(/\r?\n/).map(file => file.trim()).filter(Boolean);
  const forbiddenPrefixes = ['examples/', 'wallpapers/', 'tools/wallpaper-engine/'];
  const forbidden = files.filter(file =>
    forbiddenPrefixes.some(prefix => file.startsWith(prefix))
  );
  if (forbidden.length > 0) {
    throw new Error(`Release contains bundled rendering content:\n${forbidden.join('\n')}`);
  }
  const requiredFiles = [
    'dist/extension.js',
    'dist/uninstall.js',
    'dist/webgl-runtime/renderer.html',
    'tools/repkg/RePKG.exe',
    'tools/repkg/LICENSE-RePKG.txt',
    'tools/repkg/THIRD-PARTY-NOTICES.txt',
    'THIRD_PARTY_NOTICES.md'
  ];
  const missing = requiredFiles.filter(file => !files.includes(file));
  if (missing.length > 0) {
    throw new Error(`Release is missing WebGL runtime files:\n${missing.join('\n')}`);
  }
  const runtimeAssets = files.filter(file => file.startsWith('dist/webgl-runtime/assets/'));
  if (!runtimeAssets.some(file => /index-[A-Z0-9]+\.js$/i.test(file))
    || !runtimeAssets.some(file => /renderer-[a-f0-9]{12}\.css$/i.test(file))
    || !runtimeAssets.some(file => /emscripten-module-[a-f0-9]{12}\.wasm$/i.test(file))
    || !runtimeAssets.some(file => /\.js\.LEGAL\.txt$/i.test(file))) {
    throw new Error('Release is missing content-hashed JS/CSS/WASM or bundled license metadata.');
  }
  const unwantedDevelopmentFiles = files.filter(file =>
    file.startsWith('runtime-src/')
    || file.startsWith('tests/')
    || file.endsWith('.map')
  );
  if (unwantedDevelopmentFiles.length > 0) {
    throw new Error(`Release contains development-only files:\n${unwantedDevelopmentFiles.join('\n')}`);
  }
  const patchSource = require('node:fs').readFileSync(
    path.join(projectDirectory, 'dist', 'platform', 'workbench', 'workbenchPatch.js'),
    'utf8'
  );
  for (const legacyEntry of ['createSceneLayer', 'CanvasRenderingContext2D', 'rendererBackend']) {
    if (patchSource.includes(legacyEntry)) {
      throw new Error(`Release still contains a legacy Scene renderer entry: ${legacyEntry}`);
    }
  }
  console.log(`Verified ${files.length} release files; no bundled rendering content found.`);
}
