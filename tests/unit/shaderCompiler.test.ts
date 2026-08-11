import { describe, expect, it } from 'vitest';
import { translateShader } from '../../runtime-src/shaderCompiler';

describe('Wallpaper Engine GLSL translation', () => {
  it('preprocesses combos and upgrades legacy fragment syntax', () => {
    const source = `#ifdef USE_COLOR\nvarying vec2 uv0;\nvoid main(){ gl_FragColor = texture2D(g_Texture0, uv0); }\n#endif`;
    const result = translateShader(source, 'fragment', { USE_COLOR: 1 });
    expect(result).toContain('in vec2 uv0');
    expect(result).toContain('out vec4 dwr_FragColor');
    expect(result).toContain('texture(g_Texture0, uv0)');
    expect(result).not.toContain('#ifdef');
  });
});
