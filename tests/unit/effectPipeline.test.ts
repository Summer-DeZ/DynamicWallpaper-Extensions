import { RawShaderMaterial, Texture, Uniform, VideoTexture, type WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { AssetLoader } from '../../runtime-src/assets';
import type { RuntimeDiagnostics } from '../../runtime-src/diagnostics';
import { LayerEffectPipeline } from '../../runtime-src/effectPipeline';
import type { WallpaperShaderCompiler } from '../../runtime-src/shaderCompiler';

describe('layer effect pipeline rendering efficiency', () => {
  it('allocates only the transient targets actually selected by passes', async () => {
    const single = await createPipeline([{ material: 'one' }], [material()]);
    expect(ownedTargetCount(single.pipeline)).toBe(1);

    const double = await createPipeline(
      [{ material: 'one' }, { material: 'two' }],
      [material(), material()]
    );
    expect(ownedTargetCount(double.pipeline)).toBe(2);

    const named = await createPipeline([{ material: 'one', target: 'result' }], [material()]);
    expect(ownedTargetCount(named.pipeline)).toBe(1);

    const separated = await createPipeline(
      [
        { material: 'first' },
        { material: 'named', target: 'intermediate' },
        { material: 'last' }
      ],
      [material(), material(), material()]
    );
    expect(ownedTargetCount(separated.pipeline)).toBe(2);

    single.pipeline.dispose();
    double.pipeline.dispose();
    named.pipeline.dispose();
    separated.pipeline.dispose();
  });

  it('clears each pass once, restores renderer state, and caches static output', async () => {
    const input = new Texture();
    const { pipeline, renderer, renderAutoClearStates } = await createPipeline(
      [{ material: 'one' }],
      [material()],
      input
    );

    expect(pipeline.needsFrameUpdates()).toBe(true);
    pipeline.render(1);
    expect(renderer.clear).toHaveBeenCalledTimes(1);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(renderAutoClearStates).toEqual([false]);
    expect(renderer.autoClear).toBe(true);
    expect(pipeline.needsFrameUpdates()).toBe(false);

    pipeline.render(2);
    expect(renderer.clear).toHaveBeenCalledTimes(1);
    expect(renderer.render).toHaveBeenCalledTimes(1);

    pipeline.invalidate();
    expect(pipeline.needsFrameUpdates()).toBe(true);
    pipeline.render(2.5);
    expect(renderer.clear).toHaveBeenCalledTimes(2);
    expect(pipeline.needsFrameUpdates()).toBe(false);

    input.needsUpdate = true;
    expect(pipeline.needsFrameUpdates()).toBe(true);
    pipeline.render(3);
    expect(renderer.clear).toHaveBeenCalledTimes(3);

    pipeline.resize(320, 180);
    expect(pipeline.needsFrameUpdates()).toBe(true);
    pipeline.render(4);
    expect(renderer.clear).toHaveBeenCalledTimes(4);
    pipeline.dispose();
  });

  it('keeps time shaders and previous-frame target feedback animated', async () => {
    const timed = await createPipeline(
      [{ material: 'timed' }],
      [material('uniform float g_Time; void main() { float t = g_Time; }')]
    );
    timed.pipeline.render(1);
    expect(timed.pipeline.needsFrameUpdates()).toBe(true);

    const feedback = await createPipeline(
      [
        { material: 'consumer' },
        { material: 'producer', target: 'history' }
      ],
      [material('', { history: new Uniform(null) }), material()]
    );
    feedback.pipeline.render(1);
    expect(feedback.pipeline.needsFrameUpdates()).toBe(true);

    timed.pipeline.dispose();
    feedback.pipeline.dispose();
  });

  it('does not animate a shader that only declares time uniforms', async () => {
    const declaredOnly = await createPipeline(
      [{ material: 'declared' }],
      [material('uniform float u_Time; void main() {}')]
    );
    declaredOnly.pipeline.render(1);
    expect(declaredOnly.pipeline.needsFrameUpdates()).toBe(false);
    declaredOnly.pipeline.dispose();
  });

  it('renders a primary video only when Chromium publishes a new source frame', async () => {
    const videoElement = {
      requestVideoFrameCallback: vi.fn(() => 1),
      cancelVideoFrameCallback: vi.fn()
    } as unknown as HTMLVideoElement;
    const video = new VideoTexture(videoElement);
    const movingInput = await createPipeline([{ material: 'video' }], [material()], video);

    movingInput.pipeline.render(1);
    expect(movingInput.pipeline.needsFrameUpdates()).toBe(false);
    movingInput.pipeline.render(2);
    expect(movingInput.renderer.render).toHaveBeenCalledTimes(1);

    video.needsUpdate = true;
    expect(movingInput.pipeline.needsFrameUpdates()).toBe(true);
    movingInput.pipeline.render(3);
    expect(movingInput.renderer.render).toHaveBeenCalledTimes(2);
    expect(movingInput.pipeline.needsFrameUpdates()).toBe(false);

    const secondaryInput = await createPipeline(
      [{ material: 'secondary-video' }],
      [material('', { auxiliaryVideo: new Uniform(video) })]
    );
    expect(secondaryInput.pipeline.videoTextures()).toContain(video);
    secondaryInput.pipeline.render(1);
    expect(secondaryInput.pipeline.needsFrameUpdates()).toBe(false);
    secondaryInput.pipeline.invalidate();
    expect(secondaryInput.pipeline.needsFrameUpdates()).toBe(true);
    secondaryInput.pipeline.render(2);
    expect(secondaryInput.pipeline.needsFrameUpdates()).toBe(false);

    movingInput.pipeline.dispose();
    secondaryInput.pipeline.dispose();
    video.dispose();
  });

  it('caches named targets when every consumer uses current-frame output', async () => {
    const forward = await createPipeline(
      [
        { material: 'producer', target: 'intermediate' },
        { material: 'consumer' }
      ],
      [material(), material('', { intermediate: new Uniform(null) })]
    );
    forward.pipeline.render(1);
    expect(forward.pipeline.needsFrameUpdates()).toBe(false);
    forward.pipeline.dispose();
  });

  it('settles a self-referential named target once before caching it', async () => {
    const originalInput = new Texture();
    const selfUniform = new Uniform(originalInput);
    const self = await createPipeline(
      [{ material: 'self', target: 'history' }],
      [material('', { history: selfUniform })]
    );

    self.pipeline.render(1);
    expect(self.pipeline.needsFrameUpdates()).toBe(true);
    self.pipeline.render(2);
    expect(self.pipeline.needsFrameUpdates()).toBe(false);
    expect(selfUniform.value).toBeNull();
    expect(self.renderer.render).toHaveBeenCalledTimes(2);
    self.pipeline.dispose();
  });
});

function material(
  fragmentShader = 'void main() {}',
  uniforms: Record<string, Uniform> = {}
): RawShaderMaterial {
  return new RawShaderMaterial({
    uniforms: {
      g_Texture0: new Uniform(null),
      u_Texture: new Uniform(null),
      g_Time: new Uniform(0),
      u_Time: new Uniform(0),
      ...uniforms
    },
    vertexShader: 'void main() {}',
    fragmentShader
  });
}

async function createPipeline(
  passDefinitions: Array<{ material: string; target?: string }>,
  materials: RawShaderMaterial[],
  input = new Texture()
): Promise<{
  pipeline: LayerEffectPipeline;
  renderer: WebGLRenderer & { clear: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn> };
  renderAutoClearStates: boolean[];
}> {
  let currentTarget: unknown = null;
  const renderAutoClearStates: boolean[] = [];
  const renderer = {
    autoClear: true,
    getRenderTarget: vi.fn(() => currentTarget),
    setRenderTarget: vi.fn(target => { currentTarget = target; }),
    clear: vi.fn(),
    render: vi.fn(() => { renderAutoClearStates.push(renderer.autoClear); })
  } as unknown as WebGLRenderer & {
    clear: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
  };
  const assets = {
    json: vi.fn(async (path: string) => path === 'effect'
      ? { passes: passDefinitions }
      : { passes: [{}] })
  } as unknown as AssetLoader;
  let materialIndex = 0;
  const compiler = {
    materialForPass: vi.fn(async () => materials[materialIndex++])
  } as unknown as WallpaperShaderCompiler;
  const diagnostics = { add: vi.fn() } as unknown as RuntimeDiagnostics;
  const pipeline = await LayerEffectPipeline.create(
    renderer,
    input,
    [{ file: 'effect' }],
    64,
    32,
    assets,
    compiler,
    diagnostics
  );
  if (!pipeline) throw new Error('Expected effect pipeline');
  return { pipeline, renderer, renderAutoClearStates };
}

function ownedTargetCount(pipeline: LayerEffectPipeline): number {
  return (pipeline as unknown as { ownedTargets: Set<unknown> }).ownedTargets.size;
}
