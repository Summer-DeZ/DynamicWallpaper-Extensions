import { describe, expect, it } from 'vitest';
import { originToLocalPosition } from '../../runtime-src/sceneTransform';

describe('Wallpaper Engine scene transforms', () => {
  it('converts root scene coordinates around the scene center', () => {
    expect(originToLocalPosition([1920, 1080, 0], 3840, 2160, false))
      .toEqual([0, 0, 0]);
  });

  it('preserves child coordinates as parent-local values', () => {
    expect(originToLocalPosition([0, 0, 0], 3840, 2160, true))
      .toEqual([0, 0, 0]);
    expect(originToLocalPosition([-135.59619, -182.86682, 0], 3840, 2160, true))
      .toEqual([-135.59619, -182.86682, 0]);
  });
});
