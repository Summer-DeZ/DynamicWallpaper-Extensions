import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetLoader } from '../../runtime-src/assets';
import type { RuntimeDiagnostics } from '../../runtime-src/diagnostics';
import type { RuntimeResource } from '../../src/domain/runtime';

const resources: RuntimeResource[] = [
  { path: 'materials/background.json', uri: 'http://assets/materials/background.json', kind: 'json' },
  { path: 'materials/background.mp4', uri: 'http://assets/materials/background.mp4', kind: 'video' },
  { path: 'materials/background.tex', uri: 'http://assets/materials/background.tex', kind: 'texture' }
];

describe('Wallpaper Engine material texture resolution', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('resolves an extensionless texture beside its owning material to converted video', () => {
    const loader = new AssetLoader(
      'http://assets/',
      { add: () => undefined } as unknown as RuntimeDiagnostics,
      resources
    );
    expect(loader.resolveTexture('background', 'materials/background.json'))
      .toBe('http://assets/materials/background.mp4');
    expect(loader.resolveTexture('background.tex', 'materials/background.json'))
      .toBe('http://assets/materials/background.mp4');
  });

  it('releases direct video textures exactly once', () => {
    const video = {
      paused: true,
      pause: vi.fn(),
      play: vi.fn(async () => undefined),
      removeAttribute: vi.fn(),
      load: vi.fn()
    };
    vi.stubGlobal('document', { createElement: () => video });
    const loader = new AssetLoader(
      'http://assets/',
      { add: () => undefined } as unknown as RuntimeDiagnostics
    );
    const loaded = loader.video('wallpaper.mp4');
    const dispose = vi.spyOn(loaded.texture, 'dispose');

    loader.releaseVideo(loaded.element);
    loader.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('shares decoded-frame invalidation state with video texture consumers', () => {
    const callbacks = new Map<number, VideoFrameRequestCallback>();
    let nextCallbackId = 1;
    const video = {
      HAVE_CURRENT_DATA: 2,
      readyState: 2,
      currentTime: 0,
      paused: false,
      ended: false,
      pause: vi.fn(() => { video.paused = true; }),
      play: vi.fn(async () => { video.paused = false; }),
      removeAttribute: vi.fn(),
      load: vi.fn(),
      requestVideoFrameCallback: vi.fn((callback: VideoFrameRequestCallback): number => {
        const id = nextCallbackId++;
        callbacks.set(id, callback);
        return id;
      }),
      cancelVideoFrameCallback: vi.fn((id: number): void => { callbacks.delete(id); })
    };
    vi.stubGlobal('document', { createElement: () => video });
    const invalidate = vi.fn();
    const loader = new AssetLoader(
      'http://assets/',
      { add: () => undefined } as unknown as RuntimeDiagnostics,
      [],
      invalidate
    );
    const loaded = loader.video('wallpaper.mp4');

    expect(loader.videoTextureHasNewFrame(loaded.texture)).toBe(true);
    loader.consumeVideoTextureFrame(loaded.texture);
    expect(loader.videoTextureHasNewFrame(loaded.texture)).toBe(false);

    const scheduled = [...callbacks.values()];
    callbacks.clear();
    for (const callback of scheduled) {
      callback(performance.now(), {
        expectedDisplayTime: performance.now(), height: 1080, mediaTime: 0.04,
        presentationTime: performance.now(), presentedFrames: 1,
        processingDuration: 0, width: 1920
      });
    }
    expect(invalidate).toHaveBeenCalledOnce();
    expect(loader.videoTextureHasNewFrame(loaded.texture)).toBe(true);

    loader.setTextureActive(loaded.texture, false);
    expect(loader.videoTextureHasNewFrame(loaded.texture)).toBe(false);
    loader.setTextureActive(loaded.texture, true);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(loader.videoTextureHasNewFrame(loaded.texture)).toBe(true);
    loader.dispose();
  });
});
