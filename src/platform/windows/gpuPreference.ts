import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';

export async function findCodeExecutable(appRoot: string): Promise<string> {
  const candidates = [
    process.execPath,
    path.resolve(appRoot, '..', '..', 'Code.exe'),
    path.resolve(appRoot, '..', '..', '..', 'Code.exe')
  ];

  for (const candidate of candidates) {
    if (path.basename(candidate).toLowerCase() !== 'code.exe') {
      continue;
    }
    try {
      if ((await fs.stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next installation layout.
    }
  }

  throw new Error('无法定位 Code.exe。');
}

export async function readGpuPreference(codeExecutable: string): Promise<string | undefined> {
  ensureWindows();
  try {
    const { stdout } = await execFileAsync(
      'reg.exe',
      ['query', REGISTRY_KEY, '/v', codeExecutable],
      { windowsHide: true }
    );
    const match = stdout.match(/REG_SZ\s+(.+)\s*$/im);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export async function preferHighPerformanceGpu(codeExecutable: string): Promise<void> {
  ensureWindows();
  await execFileAsync(
    'reg.exe',
    ['add', REGISTRY_KEY, '/v', codeExecutable, '/t', 'REG_SZ', '/d', 'GpuPreference=2;', '/f'],
    { windowsHide: true }
  );
}

export async function restoreGpuPreference(
  codeExecutable: string,
  previousValue?: string
): Promise<void> {
  ensureWindows();
  if (previousValue) {
    await execFileAsync(
      'reg.exe',
      ['add', REGISTRY_KEY, '/v', codeExecutable, '/t', 'REG_SZ', '/d', previousValue, '/f'],
      { windowsHide: true }
    );
    return;
  }

  try {
    await execFileAsync(
      'reg.exe',
      ['delete', REGISTRY_KEY, '/v', codeExecutable, '/f'],
      { windowsHide: true }
    );
  } catch {
    // Deleting a missing value already produces the desired state.
  }
}

function ensureWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('高性能 GPU 首选项目前仅支持 Windows。');
  }
}
