import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importWallpaperEngineProject } from '../../src/importers/wallpaperEngineImporter';

const repository = path.resolve(__dirname, '..', '..');
const sourceDirectory = path.join(repository, 'wallpapers', '3351072238');
const outputDirectory = path.join(repository, '.tmp', 'integration-import', '3351072238');

describe('lossless Wallpaper Engine Scene import', () => {
  beforeAll(async () => {
    await fs.rm(path.dirname(outputDirectory), { recursive: true, force: true });
  });

  afterAll(async () => {
    await fs.rm(path.dirname(outputDirectory), { recursive: true, force: true });
  });

  it('creates a v2 WebGL runtime IR without flattening the Scene', async () => {
    const result = await importWallpaperEngineProject({
      sourceDirectory,
      outputDirectory,
      extensionPath: repository
    });
    const project = JSON.parse(await fs.readFile(result.projectFile, 'utf8')) as {
      version: number;
      layers?: unknown[];
      runtime: { kind: string; manifest: string; report: string };
    };
    expect(project.version).toBe(2);
    expect(project.layers).toBeUndefined();
    expect(project.runtime.kind).toBe('wallpaper-engine-scene');
    const manifest = JSON.parse(await fs.readFile(path.join(outputDirectory, project.runtime.manifest), 'utf8')) as {
      formatVersion: number;
      scene: { objects?: unknown[] };
      resources: Array<{ path: string }>;
      compatibility: { status: string; diagnostics: unknown[] };
    };
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.scene.objects?.length).toBeGreaterThan(0);
    expect(manifest.resources.length).toBeGreaterThan(10);
    expect(manifest.resources.some(resource => resource.path.toLowerCase() === 'scene.json')).toBe(true);
    expect(['compatible', 'partial']).toContain(manifest.compatibility.status);
    await expect(fs.stat(path.join(outputDirectory, 'assets', 'scene.json'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(outputDirectory, project.runtime.report))).resolves.toBeDefined();
  }, 120_000);
});
