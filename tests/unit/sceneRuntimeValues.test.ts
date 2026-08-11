import { Group, RawShaderMaterial, Texture, Uniform, VideoTexture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  jsonValuesEqual,
  isEffectivelyRenderable,
  materialNeedsFrameUpdates,
  materialPassSupportsFrustumCulling,
  materialUsesPointer,
  WallpaperEngineSceneRuntime
} from '../../runtime-src/sceneRuntime';

describe('Scene runtime value change detection', () => {
  it('recognizes structurally equal script vectors and arrays', () => {
    expect(jsonValuesEqual({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 })).toBe(true);
    expect(jsonValuesEqual([1, { value: true }], [1, { value: true }])).toBe(true);
    expect(jsonValuesEqual({ x: 1 }, { x: 2 })).toBe(false);
  });

  it('only enables geometry culling for image shaders with static vertices', () => {
    expect(materialPassSupportsFrustumCulling(undefined)).toBe(true);
    expect(materialPassSupportsFrustumCulling('genericimage2')).toBe(true);
    expect(materialPassSupportsFrustumCulling('materials\\sprite')).toBe(true);
    expect(materialPassSupportsFrustumCulling('effects/wave')).toBe(false);
  });

  it('detects shader and video inputs that require continuous frames', () => {
    const staticMaterial = new RawShaderMaterial({
      vertexShader: 'void main() { gl_Position = vec4(0.0); }',
      fragmentShader: 'void main() {}',
      uniforms: { g_Texture0: new Uniform(new Texture()) }
    });
    expect(materialNeedsFrameUpdates(staticMaterial)).toBe(false);

    const timedMaterial = staticMaterial.clone();
    timedMaterial.fragmentShader = 'uniform float g_Time; void main() { float value = g_Time; }';
    expect(materialNeedsFrameUpdates(timedMaterial)).toBe(true);

    const declarationOnlyMaterial = staticMaterial.clone();
    declarationOnlyMaterial.fragmentShader = 'uniform float g_Time; void main() {}';
    expect(materialNeedsFrameUpdates(declarationOnlyMaterial)).toBe(false);

    const pointerMaterial = staticMaterial.clone();
    pointerMaterial.fragmentShader = [
      'uniform vec2 g_PointerPosition;',
      'void main() { vec2 point = g_PointerPosition; }'
    ].join('\n');
    expect(materialUsesPointer(pointerMaterial)).toBe(true);
    expect(materialUsesPointer(declarationOnlyMaterial)).toBe(false);
    const pointerDeclarationOnly = staticMaterial.clone();
    pointerDeclarationOnly.fragmentShader = 'uniform vec2 g_PointerPosition; void main() {}';
    expect(materialUsesPointer(pointerDeclarationOnly)).toBe(false);

    const videoMaterial = staticMaterial.clone();
    videoMaterial.uniforms.g_Texture0.value = new VideoTexture({} as HTMLVideoElement);
    // Video cadence is driven by AssetLoader's decoded-frame gate instead of
    // permanently keeping the display RAF active.
    expect(materialNeedsFrameUpdates(videoMaterial)).toBe(false);
    staticMaterial.dispose();
    timedMaterial.dispose();
    declarationOnlyMaterial.dispose();
    pointerMaterial.dispose();
    pointerDeclarationOnly.dispose();
    videoMaterial.dispose();
  });

  it('rejects hidden ancestors and effectively transparent nodes before GPU work', () => {
    const parent = new Group();
    const child = new Group();
    parent.add(child);
    expect(isEffectivelyRenderable({ object: child, opacity: 1 })).toBe(true);
    parent.visible = false;
    expect(isEffectivelyRenderable({ object: child, opacity: 1 })).toBe(false);
    parent.visible = true;
    expect(isEffectivelyRenderable({ object: child, opacity: 0.001 })).toBe(false);
  });

  it('lets decoded-frame gates drive video-only scene scheduling', () => {
    const texture = new VideoTexture({} as HTMLVideoElement);
    const assets = {
      videoTextureHasNewFrame: vi.fn(() => false),
      videoTextureRequiresPolling: vi.fn(() => false)
    };
    const runtime = sceneRuntimeHarness([sceneNode(new Group(), [texture])], assets);

    expect(runtime.needsFrameUpdates()).toBe(false);
    assets.videoTextureHasNewFrame.mockReturnValue(true);
    expect(runtime.needsFrameUpdates()).toBe(true);
    assets.videoTextureHasNewFrame.mockReturnValue(false);
    assets.videoTextureRequiresPolling.mockReturnValue(true);
    expect(runtime.needsFrameUpdates()).toBe(true);
  });

  it('keeps a shared video active when any referencing node is drawable', () => {
    const texture = new VideoTexture({} as HTMLVideoElement);
    const visible = new Group();
    const hidden = new Group();
    hidden.visible = false;
    const setTextureActive = vi.fn();
    const runtime = sceneRuntimeHarness(
      [sceneNode(visible, [texture]), sceneNode(hidden, [texture])],
      { setTextureActive }
    ) as WallpaperEngineSceneRuntime & { visualActivityDirty: boolean };
    runtime.visualActivityDirty = true;

    (WallpaperEngineSceneRuntime.prototype as unknown as {
      syncVisualActivity(this: WallpaperEngineSceneRuntime): void;
    }).syncVisualActivity.call(runtime);

    expect(setTextureActive).toHaveBeenCalledTimes(1);
    expect(setTextureActive).toHaveBeenCalledWith(texture, true);
  });
});

function sceneNode(object: Group, videoTextures: VideoTexture[]): Record<string, unknown> {
  return {
    object,
    opacity: 1,
    videoTextures,
    scriptBindings: [],
    timelineBindings: []
  };
}

function sceneRuntimeHarness(
  nodeList: Record<string, unknown>[],
  assets: Record<string, unknown>
): WallpaperEngineSceneRuntime {
  return Object.assign(Object.create(WallpaperEngineSceneRuntime.prototype), {
    disposed: false,
    paused: false,
    renderInvalidated: false,
    animatedHostEffects: false,
    visualActivityDirty: false,
    nodeList,
    assets
  }) as WallpaperEngineSceneRuntime;
}
