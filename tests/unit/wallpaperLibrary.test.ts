import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureWallpaperLibrary,
  listExistingManagedWallpapers,
  readWallpaperLibraryCatalog,
  removeManagedWallpaperFromCatalog,
  upsertManagedWallpaper
} from '../../src/project/wallpaperLibrary';

let libraryDirectory: string;

beforeEach(async () => {
  libraryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dwr-library-test-'));
});

afterEach(async () => {
  await fs.rm(libraryDirectory, { recursive: true, force: true });
});

describe('managed wallpaper catalog transactions', () => {
  it('preserves every concurrent upsert instead of losing read-modify-write updates', async () => {
    await Promise.all(Array.from({ length: 24 }, (_, index) => upsertManagedWallpaper(
      libraryDirectory,
      {
        id: `wallpaper-${index.toString().padStart(2, '0')}`,
        title: `Wallpaper ${index}`,
        sourceType: 'Scene',
        sourceDirectory: path.join(libraryDirectory, 'sources', String(index)),
        compatibilityStatus: 'compatible'
      }
    )));

    const catalog = await readWallpaperLibraryCatalog(libraryDirectory);
    expect(catalog.wallpapers).toHaveLength(24);
    expect(new Set(catalog.wallpapers.map(entry => entry.id)).size).toBe(24);
  });

  it('serializes readers with a remove and never exposes a transient empty index', async () => {
    await Promise.all(['one', 'two', 'three'].map(id => upsertManagedWallpaper(
      libraryDirectory,
      {
        id,
        title: id,
        sourceType: 'Web',
        sourceDirectory: path.join(libraryDirectory, 'sources', id)
      }
    )));

    const observations = await Promise.all([
      removeManagedWallpaperFromCatalog(libraryDirectory, 'two'),
      ...Array.from({ length: 12 }, () => readWallpaperLibraryCatalog(libraryDirectory))
    ]);

    for (const catalog of observations.slice(1)) {
      expect(catalog?.wallpapers.length).toBeGreaterThanOrEqual(2);
    }
    expect((await readWallpaperLibraryCatalog(libraryDirectory)).wallpapers.map(item => item.id))
      .toEqual(['one', 'three']);
  });

  it('recovers a durable backup left by an interrupted Windows replacement', async () => {
    await ensureWallpaperLibrary(libraryDirectory);
    const backupFile = path.join(libraryDirectory, 'library.json.backup');
    await fs.writeFile(backupFile, JSON.stringify({
      formatVersion: 2,
      updatedAt: '2026-08-11T00:00:00.000Z',
      wallpapers: [{
        id: 'recovered',
        title: 'Recovered',
        sourceType: 'Video',
        sourceDirectory: path.join(libraryDirectory, 'source'),
        relativeDirectory: 'recovered',
        importedAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z',
        runtimeFormatVersion: 1,
        compatibilityStatus: 'compatible',
        networkHosts: []
      }]
    }), 'utf8');

    const catalog = await readWallpaperLibraryCatalog(libraryDirectory);

    expect(catalog.wallpapers.map(entry => entry.id)).toEqual(['recovered']);
    await expect(fs.stat(path.join(libraryDirectory, 'library.json'))).resolves.toBeDefined();
  });

  it('restores an imported project directory left in an overwrite backup', async () => {
    await upsertManagedWallpaper(libraryDirectory, {
      id: 'interrupted',
      title: 'Interrupted',
      sourceType: 'Scene',
      sourceDirectory: path.join(libraryDirectory, 'source')
    });
    const backup = path.join(libraryDirectory, `.interrupted.backup-${process.pid}-123`);
    await fs.mkdir(backup);
    await fs.writeFile(path.join(backup, 'wallpaper.json'), '{}');
    const staleTime = new Date(Date.now() - 10_000);
    await fs.utimes(backup, staleTime, staleTime);

    const existing = await listExistingManagedWallpapers(libraryDirectory);

    expect(existing.map(entry => entry.id)).toEqual(['interrupted']);
    await expect(fs.stat(path.join(libraryDirectory, 'interrupted', 'wallpaper.json')))
      .resolves.toBeDefined();
  });
});
