import { describe, expect, it } from 'vitest';
import { postEffectFragmentShader } from '../../runtime-src/threeHost';

describe('ThreeHost post-effect shader specialization', () => {
  it('omits all disabled per-pixel effect operations', () => {
    const shader = postEffectFragmentShader({
      overlayOpacity: 0,
      vignette: 0,
      grain: 0,
      scanlines: 0
    });
    expect(shader).toContain('texture2D(tDiffuse, vUv)');
    expect(shader).not.toContain('mix(color.rgb');
    expect(shader).not.toContain('distanceFromCenter');
    expect(shader).not.toContain('float hash');
    expect(shader).not.toContain('float scanline');
  });

  it('emits only the operations required by an overlay', () => {
    const shader = postEffectFragmentShader({
      overlayColor: '#123456',
      overlayOpacity: 0.2,
      vignette: 0,
      grain: 0,
      scanlines: 0
    });
    expect(shader).toContain('mix(color.rgb');
    expect(shader).not.toContain('distanceFromCenter');
    expect(shader).not.toContain('float hash');
    expect(shader).not.toContain('uResolution');
  });

  it('retains time and resolution work for animated grain', () => {
    const shader = postEffectFragmentShader({
      overlayOpacity: 0,
      vignette: 0,
      grain: 0.1,
      scanlines: 0
    });
    expect(shader).toContain('uniform vec2 uResolution');
    expect(shader).toContain('uniform float uTime');
    expect(shader).toContain('float hash');
    expect(shader).not.toContain('float scanline');
  });
});
