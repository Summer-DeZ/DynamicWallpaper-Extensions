import { afterEach, describe, expect, it, vi } from 'vitest';
import { WallpaperAudioManager } from '../../runtime-src/audio';
import type { RuntimeDiagnostics } from '../../runtime-src/diagnostics';

describe('WallpaperAudioManager idle behavior', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeAudioContext.instances.length = 0;
  });

  it('does not create an AudioContext for a scene without audio and reuses silence bands', () => {
    const constructor = vi.fn();
    vi.stubGlobal('AudioContext', constructor);
    const manager = new WallpaperAudioManager({ add: vi.fn() } as unknown as RuntimeDiagnostics);

    const first = manager.spectrum16();
    const second = manager.spectrum16();
    expect(constructor).not.toHaveBeenCalled();
    expect(second).toBe(first);
    expect(second).toEqual(new Array(16).fill(0));
    manager.dispose();
  });

  it('resumes only audio that the lifecycle pause actually stopped', async () => {
    const createdAudio: FakeAudioElement[] = [];
    vi.stubGlobal('document', {
      createElement: () => {
        const audio = new FakeAudioElement();
        createdAudio.push(audio);
        return audio;
      }
    });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const manager = new WallpaperAudioManager({ add: vi.fn() } as unknown as RuntimeDiagnostics);
    const playing = manager.add('playing.ogg') as unknown as FakeAudioElement;
    const autoplayDisabled = manager.add('idle.ogg', { autoplay: false }) as unknown as FakeAudioElement;
    const scriptPaused = manager.add('script-paused.ogg') as unknown as FakeAudioElement;
    scriptPaused.pause();

    await manager.setPaused(true);
    await manager.setPaused(false);
    await Promise.resolve();

    expect(playing.playCalls).toBe(2);
    expect(autoplayDisabled.playCalls).toBe(0);
    expect(scriptPaused.playCalls).toBe(1);
    expect(createdAudio).toHaveLength(3);
    manager.dispose();
  });

  it('retries failed media and AudioContext resumes with bounded backoff', async () => {
    vi.useFakeTimers();
    const { manager, audio, context } = createAudioManager();
    audio.playFailuresRemaining = 2;
    context.resumeFailuresRemaining = 2;

    await manager.setPaused(true);
    await manager.setPaused(false);
    expect(audio.playCalls).toBe(2);
    expect(context.resumeCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(audio.playCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(audio.playCalls).toBe(3);
    expect(context.resumeCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(250);

    expect(audio.playCalls).toBe(4);
    expect(audio.paused).toBe(false);
    expect(context.resumeCalls).toBe(3);
    expect(context.state).toBe('running');
    expect(vi.getTimerCount()).toBe(0);
    manager.dispose();
  });

  it('stops retrying after the bounded retry budget', async () => {
    vi.useFakeTimers();
    const { manager, audio, context } = createAudioManager();
    audio.playFailuresRemaining = 100;
    context.resumeFailuresRemaining = 100;

    await manager.setPaused(true);
    await manager.setPaused(false);
    await vi.runAllTimersAsync();

    // One initial autoplay, one immediate lifecycle resume, then five retries.
    expect(audio.playCalls).toBe(7);
    expect(context.resumeCalls).toBe(6);
    expect(vi.getTimerCount()).toBe(0);
    manager.dispose();
  });

  it('cancels pending retries when paused again or disposed', async () => {
    vi.useFakeTimers();
    const { manager, audio, context } = createAudioManager();
    audio.playFailuresRemaining = 100;
    context.resumeFailuresRemaining = 100;

    await manager.setPaused(true);
    await manager.setPaused(false);
    expect(vi.getTimerCount()).toBe(1);
    await manager.setPaused(true);
    await vi.runAllTimersAsync();
    expect(audio.playCalls).toBe(2);
    expect(context.resumeCalls).toBe(1);

    await manager.setPaused(false);
    expect(vi.getTimerCount()).toBe(1);
    manager.dispose();
    await vi.runAllTimersAsync();
    expect(audio.playCalls).toBe(3);
    expect(context.resumeCalls).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers when a delayed suspend settles after a rapid resume', async () => {
    const { manager, audio, context } = createAudioManager();
    const finishSuspend = context.deferNextSuspend();

    const pausing = manager.setPaused(true);
    const resuming = manager.setPaused(false);
    expect(audio.paused).toBe(false);
    expect(context.resumeCalls).toBe(0);

    finishSuspend();
    await pausing;
    await resuming;
    await Promise.resolve();
    await Promise.resolve();

    expect(audio.playCalls).toBe(2);
    expect(context.resumeCalls).toBe(1);
    expect(context.state).toBe('running');
    manager.dispose();
  });
});

class FakeAudioElement {
  src = '';
  crossOrigin = '';
  preload = '';
  loop = false;
  volume = 1;
  paused = true;
  ended = false;
  playCalls = 0;
  playFailuresRemaining = 0;

  play(): Promise<void> {
    this.playCalls += 1;
    if (this.playFailuresRemaining > 0) {
      this.playFailuresRemaining -= 1;
      this.paused = true;
      return Promise.reject(new Error('Playback is temporarily blocked'));
    }
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  removeAttribute(): void {}
}

class FakeAudioContext {
  static readonly instances: FakeAudioContext[] = [];
  destination = {};
  state: AudioContextState = 'running';
  suspendCalls = 0;
  resumeCalls = 0;
  resumeFailuresRemaining = 0;
  private deferredSuspend?: Deferred<void>;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getByteFrequencyData: vi.fn()
    };
  }

  createGain() {
    return {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn()
    };
  }

  createMediaElementSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }

  suspend(): Promise<void> {
    this.suspendCalls += 1;
    const deferred = this.deferredSuspend;
    this.deferredSuspend = undefined;
    if (deferred) {
      return deferred.promise.then(() => {
        this.state = 'suspended';
      });
    }
    this.state = 'suspended';
    return Promise.resolve();
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.resumeFailuresRemaining > 0) {
      this.resumeFailuresRemaining -= 1;
      return Promise.reject(new Error('AudioContext resume is temporarily blocked'));
    }
    this.state = 'running';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }

  deferNextSuspend(): () => void {
    const deferred = createDeferred<void>();
    this.deferredSuspend = deferred;
    return () => deferred.resolve(undefined);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolver => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createAudioManager(): {
  manager: WallpaperAudioManager;
  audio: FakeAudioElement;
  context: FakeAudioContext;
} {
  let audio: FakeAudioElement | undefined;
  vi.stubGlobal('document', {
    createElement: () => {
      audio = new FakeAudioElement();
      return audio;
    }
  });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  const manager = new WallpaperAudioManager({ add: vi.fn() } as unknown as RuntimeDiagnostics);
  const created = manager.add('playing.ogg') as unknown as FakeAudioElement;
  const context = FakeAudioContext.instances.at(-1);
  if (!audio || !context) throw new Error('Audio test fixtures were not created');
  return { manager, audio: created, context };
}
