import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const EXTENSION_STORAGE_ID = 'summer-dez.dynamic-wallpaper-engine';
const OWNED_DIRECTORIES = ['wallpapers', 'runtime-state'] as const;

export interface UninstallDataCleanupResult {
  storageDirectory: string;
  removed: string[];
  errors: string[];
}

export async function discoverGlobalStorageDirectories(
  environment: NodeJS.ProcessEnv = process.env
): Promise<string[]> {
  const candidates = new Set<string>();
  addCandidate(candidates, environment.APPDATA, 'Code', 'User', 'globalStorage', EXTENSION_STORAGE_ID);
  addCandidate(candidates, environment.APPDATA, 'Code - Insiders', 'User', 'globalStorage', EXTENSION_STORAGE_ID);
  if (environment.VSCODE_PORTABLE) {
    addCandidate(
      candidates,
      environment.VSCODE_PORTABLE,
      'data',
      'user-data',
      'User',
      'globalStorage',
      EXTENSION_STORAGE_ID
    );
    addCandidate(
      candidates,
      environment.VSCODE_PORTABLE,
      'user-data',
      'User',
      'globalStorage',
      EXTENSION_STORAGE_ID
    );
  }
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) existing.push(candidate);
  }
  return existing;
}

export async function cleanupGlobalStorageDirectory(
  storageDirectory: string
): Promise<UninstallDataCleanupResult> {
  const directory = path.resolve(storageDirectory);
  assertExtensionStorageDirectory(directory);
  const result: UninstallDataCleanupResult = {
    storageDirectory: directory,
    removed: [],
    errors: []
  };

  for (const name of OWNED_DIRECTORIES) {
    const target = path.resolve(directory, name);
    if (path.dirname(target) !== directory) {
      result.errors.push(`unsafe target rejected: ${target}`);
      continue;
    }
    if (!(await isDirectory(target))) continue;
    try {
      await fs.rm(target, { recursive: true, force: true });
      result.removed.push(target);
    } catch (error) {
      result.errors.push(`${name}: ${messageOf(error)}`);
    }
  }

  try {
    if ((await fs.readdir(directory)).length === 0) await fs.rmdir(directory);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) result.errors.push(`storage: ${messageOf(error)}`);
  }
  return result;
}

function assertExtensionStorageDirectory(directory: string): void {
  if (path.basename(directory).toLowerCase() !== EXTENSION_STORAGE_ID
    || path.basename(path.dirname(directory)).toLowerCase() !== 'globalstorage') {
    throw new Error(`拒绝清理非扩展 globalStorage 目录：${directory}`);
  }
}

function addCandidate(candidates: Set<string>, base: string | undefined, ...parts: string[]): void {
  if (base) candidates.add(path.resolve(base, ...parts));
}

async function isDirectory(candidate: string): Promise<boolean> {
  try { return (await fs.stat(candidate)).isDirectory(); } catch { return false; }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
