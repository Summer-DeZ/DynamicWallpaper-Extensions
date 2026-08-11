import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toWorkbenchResourceUri } from '../../src/platform/workbench/resourceUri';
import { relocateRuntimeProject } from '../../src/project/relocateRuntimeProject';

let testRoot: string;

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dwr-relocate-test-'));
});

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe('exported runtime project relocation', () => {
  it('rewrites and validates every importer URI against the final export directory', async () => {
    const original = path.join(testRoot, 'managed', 'wallpaper-1');
    const staging = path.join(testRoot, '.exporting');
    const destination = path.join(testRoot, 'exports', 'wallpaper-1');
    await fs.mkdir(path.join(staging, 'assets', 'textures'), { recursive: true });
    await fs.writeFile(path.join(staging, 'assets', 'scene.json'), '{}');
    await fs.writeFile(path.join(staging, 'assets', 'textures', 'main.png'), 'png');
    await fs.writeFile(path.join(staging, 'wallpaper.json'), JSON.stringify({
      version: 2,
      runtime: { kind: 'wallpaper-engine-scene', manifest: 'scene-runtime.json' }
    }));
    await fs.writeFile(path.join(staging, 'scene-runtime.json'), JSON.stringify({
      formatVersion: 1,
      kind: 'wallpaper-engine-scene',
      assetRootUri: toWorkbenchResourceUri(path.join(original, 'assets')),
      resources: [
        { path: 'scene.json', uri: toWorkbenchResourceUri(path.join(original, 'assets', 'scene.json')) },
        {
          path: 'textures/main.png',
          uri: toWorkbenchResourceUri(path.join(original, 'assets', 'textures', 'main.png'))
        }
      ]
    }));

    const rewritten = await relocateRuntimeProject(staging, original, destination);
    const manifestText = await fs.readFile(path.join(staging, 'scene-runtime.json'), 'utf8');

    expect(rewritten).toBe(3);
    expect(manifestText).not.toContain(toWorkbenchResourceUri(original));
    expect(manifestText).toContain(toWorkbenchResourceUri(destination));
  });

  it('fails the export if a rewritten manifest URI has no copied resource', async () => {
    const original = path.join(testRoot, 'managed', 'wallpaper-1');
    const staging = path.join(testRoot, '.exporting');
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(path.join(staging, 'wallpaper.json'), JSON.stringify({
      version: 2,
      runtime: { kind: 'wallpaper-engine-video', manifest: 'video-runtime.json' }
    }));
    await fs.writeFile(path.join(staging, 'video-runtime.json'), JSON.stringify({
      entryUri: toWorkbenchResourceUri(path.join(original, 'assets', 'missing.mp4'))
    }));

    await expect(relocateRuntimeProject(
      staging,
      original,
      path.join(testRoot, 'exported')
    )).rejects.toThrow('导出资源不存在');
  });
});
