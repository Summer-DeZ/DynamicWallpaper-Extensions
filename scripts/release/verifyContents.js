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
  const forbiddenPrefixes = ['wallpapers/', 'tools/wallpaper-engine/'];
  const forbidden = files.filter(file =>
    forbiddenPrefixes.some(prefix => file.startsWith(prefix))
  );
  if (forbidden.length > 0) {
    throw new Error(`Release contains bundled rendering content:\n${forbidden.join('\n')}`);
  }
  console.log(`Verified ${files.length} release files; no bundled rendering content found.`);
}
