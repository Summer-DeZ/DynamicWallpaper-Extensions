import { describe, expect, it, vi } from 'vitest';
import { VideoFrameGate } from '../../runtime-src/assets';

describe('native video frame gate', () => {
  it('wakes WebGL only for decoded frames and cancels callbacks while paused', () => {
    const video = new FakeVideo(true);
    const invalidate = vi.fn();
    const gate = new VideoFrameGate(video as unknown as HTMLVideoElement, invalidate);

    expect(video.requestVideoFrameCallback).toHaveBeenCalledOnce();
    expect(gate.needsFrame()).toBe(true);
    gate.consumeFrame();
    expect(gate.needsFrame()).toBe(false);

    video.fireFrame();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(gate.needsFrame()).toBe(true);
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(2);
    gate.consumeFrame();

    gate.setPaused(true);
    expect(gate.needsFrame()).toBe(false);
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledOnce();

    gate.setPaused(false);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(gate.needsFrame()).toBe(true);
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(3);

    gate.dispose();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledTimes(2);
    expect(gate.needsFrame()).toBe(false);
  });

  it('polls currentTime on older Chromium without redrawing duplicate frames', () => {
    const video = new FakeVideo(false);
    const gate = new VideoFrameGate(video as unknown as HTMLVideoElement, vi.fn());

    expect(gate.requiresPolling()).toBe(true);
    expect(gate.needsFrame()).toBe(true);
    gate.consumeFrame();
    expect(gate.needsFrame()).toBe(false);

    video.currentTime = 0.04;
    expect(gate.needsFrame()).toBe(true);
    gate.consumeFrame();
    expect(gate.needsFrame()).toBe(false);

    video.ended = true;
    expect(gate.needsFrame()).toBe(false);
    expect(gate.requiresPolling()).toBe(false);
  });
});

class FakeVideo {
  readonly HAVE_CURRENT_DATA = 2;
  currentTime = 0;
  readyState = 2;
  paused = false;
  ended = false;
  readonly requestVideoFrameCallback?: ReturnType<typeof vi.fn>;
  readonly cancelVideoFrameCallback?: ReturnType<typeof vi.fn>;
  private nextCallbackId = 1;
  private readonly callbacks = new Map<number, VideoFrameRequestCallback>();

  constructor(withFrameCallbacks: boolean) {
    if (!withFrameCallbacks) return;
    this.requestVideoFrameCallback = vi.fn((callback: VideoFrameRequestCallback): number => {
      const id = this.nextCallbackId++;
      this.callbacks.set(id, callback);
      return id;
    });
    this.cancelVideoFrameCallback = vi.fn((id: number): void => {
      this.callbacks.delete(id);
    });
  }

  fireFrame(): void {
    const entry = this.callbacks.entries().next().value as
      | [number, VideoFrameRequestCallback]
      | undefined;
    if (!entry) throw new Error('No video frame callback is pending.');
    this.callbacks.delete(entry[0]);
    entry[1](performance.now(), {
      expectedDisplayTime: performance.now(),
      height: 1080,
      mediaTime: this.currentTime,
      presentationTime: performance.now(),
      presentedFrames: 1,
      processingDuration: 0,
      width: 1920
    });
  }
}
