import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupGlobalStorageDirectory,
  discoverGlobalStorageDirectories,
  EXTENSION_STORAGE_ID
} from '../../src/platform/storage/uninstallDataCleanup';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe('uninstall converted wallpaper cleanup', () => {
  it('removes converted wallpapers and runtime state while preserving unrelated data', async () => {
    const root = await createTemporaryDirectory();
    const storage = path.join(root, 'Code', 'User', 'globalStorage', EXTENSION_STORAGE_ID);
    await fs.mkdir(path.join(storage, 'wallpapers', 'workshop-1'), { recursive: true });
    await fs.writeFile(path.join(storage, 'wallpapers', 'workshop-1', 'wallpaper.json'), '{}');
    await fs.mkdir(path.join(storage, 'runtime-state'));
    await fs.writeFile(path.join(storage, 'runtime-state', 'state.json'), '{}');
    await fs.writeFile(path.join(storage, 'keep.txt'), 'keep');

    const result = await cleanupGlobalStorageDirectory(storage);
    expect(result.errors).toEqual([]);
    expect(result.removed).toHaveLength(2);
    expect(await exists(path.join(storage, 'wallpapers'))).toBe(false);
    expect(await exists(path.join(storage, 'runtime-state'))).toBe(false);
    expect(await fs.readFile(path.join(storage, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('discovers stable, Insiders and portable extension storage', async () => {
    const root = await createTemporaryDirectory();
    const portable = await createTemporaryDirectory();
    const expected = [
      path.join(root, 'Code', 'User', 'globalStorage', EXTENSION_STORAGE_ID),
      path.join(root, 'Code - Insiders', 'User', 'globalStorage', EXTENSION_STORAGE_ID),
      path.join(portable, 'data', 'user-data', 'User', 'globalStorage', EXTENSION_STORAGE_ID)
    ];
    await Promise.all(expected.map(directory => fs.mkdir(directory, { recursive: true })));
    expect(await discoverGlobalStorageDirectories({ APPDATA: root, VSCODE_PORTABLE: portable }))
      .toEqual(expected);
  });

  it('rejects cleanup outside the extension-owned globalStorage directory', async () => {
    const root = await createTemporaryDirectory();
    await expect(cleanupGlobalStorageDirectory(root)).rejects.toThrow('拒绝清理');
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dwr-uninstall-data-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function exists(candidate: string): Promise<boolean> {
  try { await fs.stat(candidate); return true; } catch { return false; }
}
