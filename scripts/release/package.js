const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectDirectory = path.resolve(__dirname, '..', '..');
const manifest = require(path.join(projectDirectory, 'package.json'));
const buildDirectory = path.join(projectDirectory, 'build');
const outputFile = path.join(
  buildDirectory,
  `${manifest.name}-${manifest.version}.vsix`
);
const vsceEntry = require.resolve('@vscode/vsce/vsce');

fs.mkdirSync(buildDirectory, { recursive: true });

async function main() {
  const result = spawnSync(
    process.execPath,
    [
      vsceEntry,
      'package',
      '--target',
      'win32-x64',
      '--out',
      outputFile
    ],
    {
      cwd: projectDirectory,
      stdio: 'inherit'
    }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
