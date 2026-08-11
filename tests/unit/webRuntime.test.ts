import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebRuntimeManifest } from '../../src/domain/runtime';
import type { RuntimeDiagnostics } from '../../runtime-src/diagnostics';
import { buildWebDocument, WebWallpaperRuntime } from '../../runtime-src/webRuntime';

describe('Web wallpaper sandbox document', () => {
  it('denies network by default and exposes the Wallpaper Engine bridge', () => {
    const result = buildWebDocument('<html><head></head><body></body></html>', 'vscode-file://asset/index.html', []);
    expect(result).toContain("default-src 'none'");
    expect(result).not.toContain('https://');
    expect(result).toContain('wallpaperPropertyListener');
    expect(result).toContain('securitypolicyviolation');
  });

  it('adds only explicitly authorized hosts to CSP', () => {
    const result = buildWebDocument('<body>ok</body>', 'vscode-file://asset/index.html', ['api.example.com']);
    expect(result).toContain('https://api.example.com');
    expect(result).toContain('http://api.example.com');
  });

  it('injects the configured requestAnimationFrame limit and initial lifecycle state', () => {
    const result = buildWebDocument(
      '<body>ok</body>',
      'vscode-file://asset/index.html',
      [],
      30,
      true
    );
    expect(result).toContain('const __dwrMaxFps=30');
    expect(result).toContain('const __dwrInitiallyPaused=true');
    expect(result).toContain('minimumFrameInterval');
    expect(result).toContain('animation-play-state:paused');
  });
});

describe('Web wallpaper animation bridge', () => {
  it('runs every callback in the same permitted frame without making the loops compete', () => {
    const bridge = createBridgeHarness(30);
    const calls: string[] = [];

    bridge.window.requestAnimationFrame(() => calls.push('first'));
    bridge.window.requestAnimationFrame(() => calls.push('second'));

    expect(bridge.scheduledFrameCount()).toBe(1);
    bridge.fireNextFrame(10);
    expect(calls).toEqual(['first', 'second']);

    bridge.window.requestAnimationFrame(() => calls.push('third'));
    bridge.fireNextFrame(26);
    expect(calls).toEqual(['first', 'second']);
    expect(bridge.scheduledFrameCount()).toBe(1);

    bridge.fireNextFrame(44);
    expect(calls).toEqual(['first', 'second', 'third']);
  });

  it('cancels custom frame IDs without forwarding them to the native scheduler', () => {
    const bridge = createBridgeHarness(60);
    const calls: string[] = [];
    const first = bridge.window.requestAnimationFrame(() => calls.push('first'));
    bridge.window.requestAnimationFrame(() => calls.push('second'));

    bridge.window.cancelAnimationFrame(first);
    expect(bridge.cancelledNativeFrames).toEqual([]);
    bridge.fireNextFrame(10);
    expect(calls).toEqual(['second']);

    const only = bridge.window.requestAnimationFrame(() => calls.push('cancelled'));
    const nativeFrame = bridge.scheduledFrameIds()[0];
    bridge.window.cancelAnimationFrame(only);
    expect(bridge.cancelledNativeFrames).toContain(nativeFrame);
    expect(bridge.cancelledNativeFrames).not.toContain(only);
    expect(bridge.scheduledFrameCount()).toBe(0);
  });

  it('keeps pending frames across pause and schedules them once on resume', () => {
    const bridge = createBridgeHarness(60, true);
    const callback = vi.fn();
    const id = bridge.window.requestAnimationFrame(callback);

    expect(bridge.scheduledFrameCount()).toBe(0);
    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: false });
    expect(bridge.scheduledFrameCount()).toBe(1);
    bridge.fireNextFrame(1000);
    expect(callback).toHaveBeenCalledOnce();

    const cancelledWhilePaused = bridge.window.requestAnimationFrame(callback);
    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: true });
    bridge.window.cancelAnimationFrame(cancelledWhilePaused);
    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: false });
    expect(bridge.scheduledFrameCount()).toBe(0);
    expect(callback).toHaveBeenCalledOnce();
    expect(id).not.toBe(cancelledWhilePaused);
  });

  it('recovers when Chromium drops a native animation frame', () => {
    const bridge = createBridgeHarness(60);
    const callback = vi.fn();
    bridge.window.requestAnimationFrame(callback);
    const droppedNativeFrame = bridge.scheduledFrameIds()[0];

    bridge.fireFrameWatchdog(2000);

    expect(bridge.cancelledNativeFrames).toContain(droppedNativeFrame);
    expect(bridge.scheduledFrameCount()).toBe(1);
    expect(bridge.scheduledFrameIds()[0]).not.toBe(droppedNativeFrame);
    bridge.fireNextFrame(2001);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('resumes only media that lifecycle pause actually stopped', async () => {
    const playing = new FakeMediaElement(false);
    const alreadyPaused = new FakeMediaElement(true);
    const bridge = createBridgeHarness(60, false, [playing, alreadyPaused]);

    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: true });
    expect(playing.pauseCalls).toBe(1);
    expect(alreadyPaused.pauseCalls).toBe(0);

    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: false });
    await Promise.resolve();
    expect(playing.playCalls).toBe(1);
    expect(alreadyPaused.playCalls).toBe(0);
  });

  it('stops media that starts while paused and restores it afterwards', async () => {
    const bridge = createBridgeHarness(60);
    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: true });

    const lateMedia = new FakeMediaElement(false);
    bridge.media.push(lateMedia);
    bridge.fireDocumentEvent('play', { target: lateMedia });
    expect(lateMedia.pauseCalls).toBe(1);

    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: false });
    await Promise.resolve();
    expect(lateMedia.playCalls).toBe(1);
  });

  it('retains lifecycle ownership when media playback cannot resume yet', async () => {
    const media = new FakeMediaElement(false, true);
    const bridge = createBridgeHarness(60, false, [media]);
    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: true });

    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: false });
    await Promise.resolve();
    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: false });

    expect(media.playCalls).toBe(2);
  });

  it('autonomously retries failed media and audio context resumes', async () => {
    const media = new FakeMediaElement(false);
    const bridge = createBridgeHarness(60, false, [media]);
    const context = new bridge.window.AudioContext();
    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: true });
    await flushMicrotasks();
    media.playFailuresRemaining = 2;
    context.resumeFailuresRemaining = 2;

    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: false });
    await flushMicrotasks();
    expect(media.playCalls).toBe(1);
    expect(context.resumeCalls).toBe(1);
    expect(bridge.scheduledTimeoutCount()).toBe(1);

    bridge.fireNativeTimeouts(100);
    await flushMicrotasks();
    expect(media.playCalls).toBe(2);
    expect(context.resumeCalls).toBe(2);
    bridge.fireNativeTimeouts(350);
    await flushMicrotasks();

    expect(media.playCalls).toBe(3);
    expect(media.paused).toBe(false);
    expect(context.resumeCalls).toBe(3);
    expect(context.state).toBe('running');
    expect(bridge.scheduledTimeoutCount()).toBe(0);
  });

  it('bounds lifecycle resume retries and cancels them on pause or disposal', async () => {
    const media = new FakeMediaElement(false);
    const bridge = createBridgeHarness(60, false, [media]);
    const context = new bridge.window.AudioContext();
    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: true });
    await flushMicrotasks();
    media.playFailuresRemaining = Number.POSITIVE_INFINITY;
    context.resumeFailuresRemaining = Number.POSITIVE_INFINITY;

    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: false });
    await flushMicrotasks();
    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: true });
    expect(bridge.scheduledTimeoutCount()).toBe(0);
    bridge.fireNativeTimeouts(10_000);
    await flushMicrotasks();
    expect(media.playCalls).toBe(1);
    expect(context.resumeCalls).toBe(1);

    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: false });
    await flushMicrotasks();
    for (let retry = 0; retry < 5; retry++) {
      bridge.fireNativeTimeouts(20_000 + retry * 2000);
      await flushMicrotasks();
    }
    expect(media.playCalls).toBe(7);
    expect(context.resumeCalls).toBe(7);
    expect(bridge.scheduledTimeoutCount()).toBe(0);

    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: false });
    await flushMicrotasks();
    expect(bridge.scheduledTimeoutCount()).toBe(1);
    bridge.sendMessage({ type: 'dwr-web-dispose' });
    expect(bridge.scheduledTimeoutCount()).toBe(0);
    bridge.fireNativeTimeouts(99_000);
    await flushMicrotasks();
    expect(media.playCalls).toBe(8);
    expect(context.resumeCalls).toBe(8);
  });

  it('recovers when a delayed context suspension settles after a rapid resume', async () => {
    const bridge = createBridgeHarness(60);
    const context = new bridge.window.AudioContext();
    const finishSuspend = context.deferNextSuspend();

    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: true });
    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: false });
    expect(context.resumeCalls).toBe(0);
    finishSuspend();
    await flushMicrotasks();

    expect(context.resumeCalls).toBe(1);
    expect(context.state).toBe('running');
  });

  it('suspends only bridge-created running audio contexts and resumes them', async () => {
    const bridge = createBridgeHarness(60);
    const context = new bridge.window.AudioContext();

    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: true });
    await Promise.resolve();
    expect(context.suspendCalls).toBe(1);
    expect(context.state).toBe('suspended');

    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: false });
    await Promise.resolve();
    expect(context.resumeCalls).toBe(1);
    expect(context.state).toBe('running');
  });

  it('freezes managed timeouts while paused and continues them on resume', () => {
    const bridge = createBridgeHarness(60);
    const callback = vi.fn();
    bridge.window.setTimeout(callback, 1000);

    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: true });
    bridge.fireNativeTimeouts(2000);
    expect(callback).not.toHaveBeenCalled();

    bridge.sendMessage({ type: 'dwr-web-lifecycle', paused: false });
    bridge.fireNativeTimeouts(3000);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('announces readiness after installing the bridge listeners', () => {
    const bridge = createBridgeHarness(60);
    expect(bridge.parentMessages).toContainEqual({ type: 'dwr-web-ready' });
  });
});

describe('Web wallpaper host lifecycle synchronization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('embeds and republishes pause state that changed before iframe load', async () => {
    const host = installWebRuntimeHost(async () => testResponse('<html><head></head><body></body></html>'));

    const runtime = new WebWallpaperRuntime(
      host.root as unknown as HTMLElement,
      createManifest(),
      host.diagnostics as unknown as RuntimeDiagnostics,
      30
    );
    runtime.setPaused(true);
    await runtime.initialize();

    expect(host.iframe.srcdoc).toContain('const __dwrInitiallyPaused=true');
    host.fireLoad();
    expect(host.posted).toContainEqual({ type: 'dwr-web-lifecycle', paused: true });

    host.posted.length = 0;
    host.fireMessage({ type: 'dwr-web-ready' });
    expect(host.posted[0]).toEqual({ type: 'dwr-web-lifecycle', paused: true });
  });

  it('applies the latest network policy from cached source without refetching', async () => {
    const host = installWebRuntimeHost(async () => testResponse('<body>initial</body>'));
    const runtime = new WebWallpaperRuntime(
      host.root as unknown as HTMLElement,
      createManifest(),
      host.diagnostics as unknown as RuntimeDiagnostics
    );
    await runtime.initialize();

    runtime.updateNetworkPolicy(['old.example.com']);
    runtime.updateNetworkPolicy(['new.example.com']);
    expect(host.iframe.srcdoc).toContain('new.example.com');
    expect(host.iframe.srcdoc).not.toContain('old.example.com');
    expect(host.iframe.srcdoc).toContain('initial');
    expect(host.requests).toHaveLength(1);
  });

  it('does not mutate the detached iframe after disposal', async () => {
    const host = installWebRuntimeHost(async () => testResponse('<body>initial</body>'));
    const runtime = new WebWallpaperRuntime(
      host.root as unknown as HTMLElement,
      createManifest(),
      host.diagnostics as unknown as RuntimeDiagnostics
    );
    await runtime.initialize();
    const initialDocument = host.iframe.srcdoc;

    runtime.dispose();
    runtime.updateNetworkPolicy(['api.example.com']);

    expect(host.iframe.srcdoc).toBe(initialDocument);
    expect(host.iframe.remove).toHaveBeenCalledOnce();
    expect(host.requests).toHaveLength(1);
  });

  it('revokes an active host immediately without waiting for a fetch', async () => {
    const host = installWebRuntimeHost(async () => testResponse('<body>initial</body>'));
    const runtime = new WebWallpaperRuntime(
      host.root as unknown as HTMLElement,
      createManifest(['api.example.com']),
      host.diagnostics as unknown as RuntimeDiagnostics
    );
    await runtime.initialize();
    expect(host.iframe.srcdoc).toContain('api.example.com');

    runtime.updateNetworkPolicy([]);

    expect(host.iframe.srcdoc).not.toContain('api.example.com');
    expect(host.requests).toHaveLength(1);
  });
});

class FakeMediaElement {
  ended = false;
  isConnected = true;
  pauseCalls = 0;
  playCalls = 0;
  playFailuresRemaining: number;

  constructor(public paused: boolean, rejectPlayback = false) {
    this.playFailuresRemaining = rejectPlayback ? Number.POSITIVE_INFINITY : 0;
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }

  play(): Promise<void> {
    this.playCalls += 1;
    if (this.playFailuresRemaining > 0) {
      this.playFailuresRemaining -= 1;
      this.paused = true;
      return Promise.reject(new Error('Autoplay is temporarily blocked'));
    }
    this.paused = false;
    return Promise.resolve();
  }
}

function createBridgeHarness(
  maxFps: number,
  initiallyPaused = false,
  initialMedia: FakeMediaElement[] = []
) {
  type Listener = (event: { data?: unknown; target?: unknown; blockedURI?: string }) => void;
  const nativeFrames = new Map<number, (time: number) => void>();
  const windowListeners = new Map<string, Listener[]>();
  const documentListeners = new Map<string, Listener[]>();
  const cancelledNativeFrames: number[] = [];
  const parentMessages: Record<string, unknown>[] = [];
  const watchdogIntervals = new Map<number, () => void>();
  const nativeTimeouts = new Map<number, () => void>();
  const media = [...initialMedia];
  const audioContexts: FakeAudioContext[] = [];
  let nextNativeFrameId = 100;
  let nextIntervalId = 1;
  let nextTimeoutId = 1_000;
  let wallTime = 0;

  class FakeAudioContext {
    state = 'running';
    suspendCalls = 0;
    resumeCalls = 0;
    resumeFailuresRemaining = 0;
    private deferredSuspend?: Deferred<void>;

    constructor() {
      audioContexts.push(this);
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

    deferNextSuspend(): () => void {
      const deferred = createDeferred<void>();
      this.deferredSuspend = deferred;
      return () => deferred.resolve(undefined);
    }
  }

  const addListener = (listeners: Map<string, Listener[]>, type: string, listener: Listener): void => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  };
  const fakeWindow = {
    requestAnimationFrame: (callback: (time: number) => void): number => {
      const id = nextNativeFrameId++;
      nativeFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number): void => {
      cancelledNativeFrames.push(id);
      nativeFrames.delete(id);
    },
    setTimeout: (callback: () => void): number => {
      const id = nextTimeoutId++;
      nativeTimeouts.set(id, callback);
      return id;
    },
    clearTimeout: (id: number): void => {
      nativeTimeouts.delete(id);
    },
    setInterval: (callback: () => void): number => {
      const id = nextIntervalId++;
      watchdogIntervals.set(id, callback);
      return id;
    },
    clearInterval: (id: number): void => {
      watchdogIntervals.delete(id);
    },
    performance: { now: (): number => wallTime },
    AudioContext: FakeAudioContext,
    addEventListener: (type: string, listener: Listener): void => {
      addListener(windowListeners, type, listener);
    },
    dispatchEvent: vi.fn()
  };
  const fakeDocument = {
    documentElement: { classList: { toggle: vi.fn() } },
    querySelectorAll: (_selector: string): FakeMediaElement[] => media,
    addEventListener: (type: string, listener: Listener): void => {
      addListener(documentListeners, type, listener);
    }
  };
  const fakeParent = {
    postMessage: (message: Record<string, unknown>): void => {
      parentMessages.push(message);
    }
  };
  class FakeCustomEvent {
    constructor(public type: string, public init?: unknown) {}
  }

  const documentText = buildWebDocument(
    '<html><head></head><body></body></html>',
    'vscode-file://asset/index.html',
    [],
    maxFps,
    initiallyPaused
  );
  const script = documentText.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('Web bridge script was not injected');
  const execute = new Function(
    'window',
    'document',
    'parent',
    'CustomEvent',
    'HTMLMediaElement',
    'setInterval',
    'clearInterval',
    'Date',
    script
  );
  execute(
    fakeWindow,
    fakeDocument,
    fakeParent,
    FakeCustomEvent,
    FakeMediaElement,
    (callback: () => void): number => {
      const id = nextIntervalId++;
      watchdogIntervals.set(id, callback);
      return id;
    },
    (id: number): void => {
      watchdogIntervals.delete(id);
    },
    { now: (): number => wallTime }
  );

  return {
    window: fakeWindow,
    media,
    cancelledNativeFrames,
    parentMessages,
    audioContexts,
    scheduledFrameCount: () => nativeFrames.size,
    scheduledFrameIds: () => [...nativeFrames.keys()],
    scheduledTimeoutCount: () => nativeTimeouts.size,
    fireFrameWatchdog: (time: number): void => {
      wallTime = time;
      for (const callback of [...watchdogIntervals.values()]) callback();
    },
    fireNativeTimeouts: (time: number): void => {
      wallTime = time;
      const callbacks = [...nativeTimeouts.values()];
      nativeTimeouts.clear();
      for (const callback of callbacks) callback();
    },
    fireNextFrame: (time: number): void => {
      wallTime = time;
      const entry = nativeFrames.entries().next().value as [number, (frameTime: number) => void] | undefined;
      if (!entry) throw new Error('No native animation frame is scheduled');
      nativeFrames.delete(entry[0]);
      entry[1](time);
    },
    sendMessage: (data: unknown): void => {
      for (const listener of windowListeners.get('message') ?? []) listener({ data });
    },
    fireDocumentEvent: (type: string, event: { target?: unknown; blockedURI?: string }): void => {
      for (const listener of documentListeners.get(type) ?? []) listener(event);
    }
  };
}

function createManifest(allowedNetworkHosts: string[] = []): WebRuntimeManifest {
  return {
    formatVersion: 1,
    kind: 'wallpaper-engine-web',
    title: 'test',
    entryUri: 'vscode-file://asset/index.html',
    userProperties: [],
    allowedNetworkHosts,
    compatibility: {
      formatVersion: 1,
      status: 'compatible',
      generatedAt: '2026-08-11T00:00:00.000Z',
      diagnostics: []
    }
  };
}

interface TestResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}

function testResponse(
  html: string,
  ok = true,
  status = ok ? 200 : 500,
  statusText = ok ? 'OK' : 'Error'
): TestResponse {
  return { ok, status, statusText, text: async () => html };
}

function installWebRuntimeHost(fetchImplementation: (init?: RequestInit) => Promise<TestResponse>) {
  const posted: Record<string, unknown>[] = [];
  const requests: RequestInit[] = [];
  const contentWindow = {
    postMessage: (message: Record<string, unknown>) => posted.push(message)
  };
  let loadListener: (() => void) | undefined;
  let messageListener: ((event: MessageEvent) => void) | undefined;
  const iframe = {
    className: '',
    srcdoc: '',
    contentWindow,
    setAttribute: vi.fn(),
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'load') loadListener = listener;
    },
    remove: vi.fn()
  };
  const root = { appendChild: vi.fn() };
  const diagnostics = { add: vi.fn() };
  vi.stubGlobal('document', { createElement: () => iframe });
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'message') messageListener = listener;
    },
    removeEventListener: vi.fn(),
    parent: { postMessage: vi.fn() }
  });
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {});
    return fetchImplementation(init);
  }));
  return {
    posted,
    requests,
    contentWindow,
    iframe,
    root,
    diagnostics,
    fireLoad: (): void => loadListener?.(),
    fireMessage: (data: Record<string, unknown>): void => messageListener?.({
      source: contentWindow,
      data
    } as unknown as MessageEvent)
  };
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
