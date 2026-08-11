import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('extension configuration', () => {
  it('offers pause-on-unfocus as an enabled-by-default user setting', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'package.json'),
      'utf8'
    )) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };

    expect(manifest.contributes.configuration.properties)
      .toMatchObject({
        'dynamicWallpaper.pauseWhenUnfocused': {
          type: 'boolean',
          default: true
        }
      });
  });

  it('exposes wallpaper-library switching with a discoverable title and extension menu entry', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'package.json'),
      'utf8'
    )) as {
      contributes: {
        commands: Array<{ command: string; title: string }>;
        menus: Record<string, Array<{ command: string }>>;
      };
    };
    const command = 'dynamicWallpaper.selectImportedWallpaper';

    expect(manifest.contributes.commands).toContainEqual({
      command,
      title: 'Dynamic Wallpaper: 浏览并切换壁纸库'
    });
    expect(manifest.contributes.menus['extension/context'])
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ command })
      ]));
  });
});
