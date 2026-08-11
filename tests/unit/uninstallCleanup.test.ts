import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupWorkbenchDirectory,
  discoverWorkbenchDirectories,
  removeOwnedPatchBlock
} from '../../src/platform/workbench/uninstallCleanup';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe('uninstall cleanup', () => {
  it('removes only the owned marker block', () => {
    const original = `<html>\nkeep-before\n<!-- dynamic-wallpaper-engine:start -->\n<script src="./dynamicwallpaper.inject.123456789abc.js"></script>\n<!-- dynamic-wallpaper-engine:end -->\nkeep-after\n</html>`;
    const result = removeOwnedPatchBlock(original);
    expect(result.removed).toBe(true);
    expect(result.html).toContain('keep-before');
    expect(result.html).toContain('keep-after');
    expect(result.html).not.toContain('dynamic-wallpaper');
  });

  it('deletes owned assets while preserving unrelated files', async () => {
    const directory = await createTemporaryDirectory();
    await fs.writeFile(path.join(directory, 'workbench.html'), '<html>\n<!-- dynamic-wallpaper-engine:start -->x<!-- dynamic-wallpaper-engine:end -->\n</html>');
    await fs.writeFile(path.join(directory, 'dynamicwallpaper.inject.123456789abc.js'), 'old');
    await fs.writeFile(path.join(directory, 'workbench.html.dynamicwallpaper.backup'), 'backup');
    await fs.mkdir(path.join(directory, 'dynamicwallpaper.runtime.123456789abc'));
    await fs.mkdir(path.join(directory, 'dynamicwallpaper.web.abcdefabcdef'));
    await fs.writeFile(path.join(directory, 'unrelated.js'), 'keep');
    const result = await cleanupWorkbenchDirectory(directory);
    expect(result.errors).toEqual([]);
    expect(result.patchRemoved).toBe(true);
    expect(await exists(path.join(directory, 'unrelated.js'))).toBe(true);
    expect(await exists(path.join(directory, 'dynamicwallpaper.inject.123456789abc.js'))).toBe(false);
    expect(await exists(path.join(directory, 'dynamicwallpaper.runtime.123456789abc'))).toBe(false);
  });

  it('discovers versioned VS Code installations', async () => {
    const localAppData = await createTemporaryDirectory();
    const appRoot = path.join(localAppData, 'Programs', 'Microsoft VS Code', 'version-hash', 'resources', 'app');
    const workbench = path.join(appRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench');
    await fs.mkdir(workbench, { recursive: true });
    await fs.writeFile(path.join(appRoot, 'product.json'), '{}');
    await fs.writeFile(path.join(workbench, 'workbench.html'), '<html></html>');
    const result = await discoverWorkbenchDirectories({ LOCALAPPDATA: localAppData }, '');
    expect(result).toEqual([workbench]);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dwr-uninstall-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function exists(candidate: string): Promise<boolean> {
  try { await fs.stat(candidate); return true; } catch { return false; }
}
