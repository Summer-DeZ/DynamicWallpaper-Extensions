import type { WebRuntimeManifest } from '../src/domain/runtime';
import type { RuntimeLifecycleParticipant } from './lifecycle';
import { RuntimeDiagnostics } from './diagnostics';

export class WebWallpaperRuntime implements RuntimeLifecycleParticipant {
  private iframe?: HTMLIFrameElement;
  private properties: Record<string, unknown> = {};
  private allowedHosts: string[];
  private sourceHtml?: string;
  private pointer = { x: 0, y: 0, buttons: 0 };
  private paused = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly manifest: WebRuntimeManifest,
    private readonly diagnostics: RuntimeDiagnostics,
    private readonly maxFps = 60
  ) {
    this.allowedHosts = [...manifest.allowedNetworkHosts];
  }

  async initialize(): Promise<void> {
    const response = await fetch(this.manifest.entryUri, { credentials: 'omit', cache: 'no-cache' });
    if (!response.ok) throw new Error(`Web 壁纸入口读取失败：${response.status} ${response.statusText}`);
    const html = await response.text();
    this.sourceHtml = html;
    this.iframe = document.createElement('iframe');
    this.iframe.className = 'dwr-web-surface';
    this.iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-modals allow-pointer-lock allow-downloads'
    );
    this.iframe.setAttribute('allow', 'autoplay; fullscreen');
    this.iframe.srcdoc = buildWebDocument(
      html,
      this.manifest.entryUri,
      this.allowedHosts,
      this.maxFps,
      this.paused
    );
    this.iframe.addEventListener('load', () => this.publishState());
    window.addEventListener('message', this.onMessage);
    this.root.appendChild(this.iframe);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.post({ type: 'dwr-web-lifecycle', paused });
  }

  resize(width: number, height: number): void {
    this.post({ type: 'dwr-web-resize', width, height });
  }

  update(_timeSeconds: number, _deltaSeconds: number): void {
    // Web wallpapers own their animation clock. Lifecycle messages pause media and RAF callbacks.
  }

  needsPointerUpdates(): boolean {
    // Pointer state is delivered directly into the iframe and does not require
    // an otherwise empty outer-runtime animation frame.
    return false;
  }

  updateProperties(values: Record<string, unknown>): void {
    this.properties = { ...values };
    this.post({ type: 'dwr-web-properties', values: this.properties });
  }

  updatePointer(x: number, y: number, buttons: number): void {
    this.pointer = { x, y, buttons };
    this.post({ type: 'dwr-web-pointer', ...this.pointer });
  }

  updateNetworkPolicy(allowedHosts: string[]): void {
    const normalized = [...new Set(allowedHosts.map(host => host.toLowerCase()))].sort();
    if (sameHosts(normalized, this.allowedHosts)) return;
    this.allowedHosts = normalized;
    if (!this.iframe || this.sourceHtml === undefined) return;
    // A policy change does not require refetching the entry. Rebuilding from
    // the source captured at initialization applies grants and revocations
    // immediately and cannot get stranded by a transient file read failure.
    this.iframe.srcdoc = buildWebDocument(
      this.sourceHtml,
      this.manifest.entryUri,
      this.allowedHosts,
      this.maxFps,
      this.paused
    );
  }

  dispose(): void {
    window.removeEventListener('message', this.onMessage);
    this.post({ type: 'dwr-web-dispose' });
    this.iframe?.remove();
    this.iframe = undefined;
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.source !== this.iframe?.contentWindow || !isRecord(event.data)) return;
    if (event.data.type === 'dwr-web-ready') {
      this.publishState();
      return;
    }
    if (event.data.type === 'dwr-network-blocked' && typeof event.data.host === 'string') {
      window.parent.postMessage({
        channel: 'dynamic-wallpaper-host',
        protocolVersion: 1,
        type: 'network-request',
        host: event.data.host
      }, '*');
      this.diagnostics.add({
        code: 'web-network-blocked',
        severity: 'warning',
        message: `Web 壁纸网络请求已阻止：${event.data.host}`,
        resource: event.data.host
      });
    }
  };

  private publishState(): void {
    this.post({ type: 'dwr-web-lifecycle', paused: this.paused });
    this.updateProperties(this.properties);
    this.updatePointer(this.pointer.x, this.pointer.y, this.pointer.buttons);
    this.post({
      type: 'dwr-web-audio',
      values: new Array(128).fill(0),
      systemAudioUnavailable: true
    });
  }

  private post(message: Record<string, unknown>): void {
    this.iframe?.contentWindow?.postMessage(message, '*');
  }
}

export function buildWebDocument(
  html: string,
  entryUri: string,
  allowedHosts: string[],
  maxFps = 60,
  initiallyPaused = false
): string {
  const networkSources = allowedHosts.flatMap(host => [`https://${host}`, `http://${host}`]);
  const network = networkSources.length > 0 ? ` ${networkSources.join(' ')}` : '';
  const csp = [
    `default-src 'none'`,
    `script-src 'unsafe-inline' 'unsafe-eval' blob: data: vscode-file:${network}`,
    `style-src 'unsafe-inline' blob: data: vscode-file:${network}`,
    `img-src blob: data: vscode-file:${network}`,
    `media-src blob: data: vscode-file:${network}`,
    `font-src blob: data: vscode-file:${network}`,
    `connect-src vscode-file:${network}`,
    `worker-src blob: data: vscode-file:${network}`,
    `frame-src blob: data: vscode-file:${network}`
  ].join('; ');
  const base = `<base href="${escapeAttribute(entryUri)}">`;
  const policy = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`;
  const lifecycleStyle = '<style>html.dwr-lifecycle-paused *,html.dwr-lifecycle-paused *::before,html.dwr-lifecycle-paused *::after{animation-play-state:paused!important}</style>';
  const normalizedMaxFps = Math.max(15, Math.min(60, Math.round(maxFps)));
  const bridge = `<script>const __dwrMaxFps=${normalizedMaxFps};const __dwrInitiallyPaused=${initiallyPaused ? 'true' : 'false'};${WEB_BRIDGE_SOURCE}</script>`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${base}${policy}${lifecycleStyle}${bridge}`);
  }
  return `<!doctype html><html><head>${base}${policy}${lifecycleStyle}${bridge}</head><body>${html}</body></html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameHosts(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((host, index) => host === right[index]);
}

const WEB_BRIDGE_SOURCE = `
(() => {
  'use strict';
  let paused = Boolean(__dwrInitiallyPaused);
  let properties = {};
  let audio = new Array(128).fill(0);
  const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
  const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  const monotonicNow = window.performance.now.bind(window.performance);
  const pendingFrames = new Map();
  let nextFrameId = 1;
  let nativeFrameId;
  let nativeFrameScheduledAt = 0;
  let frameWatchdogTimer;
  let lastFrameTime;
  let runningFrame = false;
  const minimumFrameInterval = 1000 / __dwrMaxFps;

  const stopFrameWatchdog = () => {
    if (frameWatchdogTimer === undefined) return;
    nativeClearInterval(frameWatchdogTimer);
    frameWatchdogTimer = undefined;
  };

  const updateFrameWatchdog = () => {
    if (paused || pendingFrames.size === 0) {
      stopFrameWatchdog();
      return;
    }
    if (frameWatchdogTimer !== undefined) return;
    frameWatchdogTimer = nativeSetInterval(() => {
      if (paused || pendingFrames.size === 0) {
        stopFrameWatchdog();
        return;
      }
      // Chromium can occasionally discard a requested RAF while changing
      // visibility/compositor state.  Release the stuck native handle and
      // submit the still-pending callbacks again.
      if (nativeFrameId !== undefined && monotonicNow() - nativeFrameScheduledAt >= 1500) {
        nativeCancelAnimationFrame(nativeFrameId);
        nativeFrameId = undefined;
      }
      scheduleFrame();
    }, 1000);
  };

  const scheduleFrame = () => {
    if (paused || runningFrame || nativeFrameId !== undefined || pendingFrames.size === 0) return;
    nativeFrameId = nativeRequestAnimationFrame(runFrame);
    nativeFrameScheduledAt = monotonicNow();
    updateFrameWatchdog();
  };

  const runFrame = time => {
    nativeFrameId = undefined;
    if (paused || pendingFrames.size === 0) {
      updateFrameWatchdog();
      return;
    }
    if (lastFrameTime !== undefined) {
      const elapsed = time - lastFrameTime;
      if (elapsed + 0.25 < minimumFrameInterval) {
        scheduleFrame();
        return;
      }
      lastFrameTime = time - elapsed % minimumFrameInterval;
    } else {
      lastFrameTime = time;
    }

    const frameIds = [...pendingFrames.keys()];
    runningFrame = true;
    for (const id of frameIds) {
      const callback = pendingFrames.get(id);
      if (!callback) continue;
      pendingFrames.delete(id);
      try {
        callback(time);
      } catch (error) {
        nativeSetTimeout(() => { throw error; }, 0);
      }
    }
    runningFrame = false;
    updateFrameWatchdog();
    scheduleFrame();
  };

  window.requestAnimationFrame = callback => {
    if (typeof callback !== 'function') throw new TypeError('requestAnimationFrame callback must be a function');
    const id = nextFrameId++;
    pendingFrames.set(id, callback);
    scheduleFrame();
    return id;
  };
  window.cancelAnimationFrame = id => {
    pendingFrames.delete(id);
    if (pendingFrames.size === 0 && nativeFrameId !== undefined) {
      nativeCancelAnimationFrame(nativeFrameId);
      nativeFrameId = undefined;
    }
    updateFrameWatchdog();
  };

  const managedTimers = new Map();
  let nextTimerId = 1;
  const clearNativeTimer = timer => {
    if (timer.nativeId === undefined) return;
    nativeClearTimeout(timer.nativeId);
    timer.nativeId = undefined;
  };
  const invokeTimer = timer => {
    if (typeof timer.handler === 'function') timer.handler.apply(window, timer.argumentsList);
    else (0, eval)(String(timer.handler));
  };
  const scheduleManagedTimer = timer => {
    if (paused || timer.nativeId !== undefined) return;
    timer.startedAt = monotonicNow();
    const fire = () => {
      timer.nativeId = undefined;
      if (paused || !managedTimers.has(timer.id)) return;
      if (!timer.repeat) managedTimers.delete(timer.id);
      try {
        invokeTimer(timer);
      } catch (error) {
        nativeSetTimeout(() => { throw error; }, 0);
      }
      if (timer.repeat && managedTimers.has(timer.id)) {
        timer.remaining = timer.delay;
        scheduleManagedTimer(timer);
      }
    };
    timer.nativeId = nativeSetTimeout(fire, timer.repeat
      ? Math.max(1, timer.remaining)
      : timer.remaining);
  };
  const createManagedTimer = (handler, delay, repeat, argumentsList) => {
    const normalizedDelay = Math.max(0, Number(delay) || 0);
    const timer = {
      id: nextTimerId++, handler, argumentsList, repeat,
      delay: normalizedDelay, remaining: normalizedDelay,
      startedAt: 0, nativeId: undefined
    };
    managedTimers.set(timer.id, timer);
    scheduleManagedTimer(timer);
    return timer.id;
  };
  const clearManagedTimer = id => {
    const timer = managedTimers.get(Number(id));
    if (!timer) return;
    clearNativeTimer(timer);
    managedTimers.delete(timer.id);
  };
  const pauseManagedTimers = () => {
    const now = monotonicNow();
    for (const timer of managedTimers.values()) {
      if (timer.nativeId !== undefined) {
        timer.remaining = Math.max(0, timer.remaining - (now - timer.startedAt));
        clearNativeTimer(timer);
      }
    }
  };
  const resumeManagedTimers = () => {
    for (const timer of managedTimers.values()) scheduleManagedTimer(timer);
  };
  window.setTimeout = (handler, delay, ...argumentsList) =>
    createManagedTimer(handler, delay, false, argumentsList);
  window.clearTimeout = clearManagedTimer;
  window.setInterval = (handler, delay, ...argumentsList) =>
    createManagedTimer(handler, delay, true, argumentsList);
  window.clearInterval = clearManagedTimer;

  const lifecyclePausedMedia = new Set();
  const audioContexts = new Set();
  const lifecycleSuspendedAudioContexts = new Set();
  const pendingAudioContextSuspensions = new Set();
  const lifecycleResumeDelays = [100, 250, 500, 1000, 2000];
  let lifecycleGeneration = 0;
  let lifecycleResumeOperation = 0;
  let lifecycleResumeTimer;
  let disposed = false;

  const cancelLifecycleResumeRetry = () => {
    if (lifecycleResumeTimer === undefined) return;
    nativeClearTimeout(lifecycleResumeTimer);
    lifecycleResumeTimer = undefined;
  };

  const suspendOwnedAudioContext = (context, generation) => {
    if (disposed || context.state !== 'running') return;
    lifecycleSuspendedAudioContexts.add(context);
    if (pendingAudioContextSuspensions.has(context)) return;
    pendingAudioContextSuspensions.add(context);
    let suspension;
    try {
      suspension = context.suspend();
    } catch {
      pendingAudioContextSuspensions.delete(context);
      lifecycleSuspendedAudioContexts.delete(context);
      return;
    }
    Promise.resolve(suspension).then(() => {
      pendingAudioContextSuspensions.delete(context);
      if (disposed) return;
      if (!paused) void resumeLifecycle(lifecycleGeneration, 0);
    }, () => {
      pendingAudioContextSuspensions.delete(context);
      if (disposed) return;
      if (context.state !== 'suspended') {
        lifecycleSuspendedAudioContexts.delete(context);
        // A newer pause may have shared this now-failed suspension.
        if (paused && generation !== lifecycleGeneration && context.state === 'running') {
          suspendOwnedAudioContext(context, lifecycleGeneration);
        }
        return;
      }
      if (!paused) void resumeLifecycle(lifecycleGeneration, 0);
    });
  };

  for (const constructorName of ['AudioContext', 'webkitAudioContext']) {
    const NativeAudioContext = window[constructorName];
    if (typeof NativeAudioContext !== 'function') continue;
    window[constructorName] = new Proxy(NativeAudioContext, {
      construct(target, argumentsList, newTarget) {
        const context = Reflect.construct(target, argumentsList, newTarget);
        audioContexts.add(context);
        if (paused && context.state === 'running') {
          suspendOwnedAudioContext(context, lifecycleGeneration);
        }
        return context;
      }
    });
  }

  const pauseAudioContexts = generation => {
    for (const context of audioContexts) {
      if (context.state !== 'running') continue;
      suspendOwnedAudioContext(context, generation);
    }
  };
  const pauseMedia = () => {
    for (const media of document.querySelectorAll('video,audio')) {
      if (media.paused || media.ended) continue;
      lifecyclePausedMedia.add(media);
      media.pause();
    }
  };

  const hasRetryableLifecycleResume = () => {
    for (const media of [...lifecyclePausedMedia]) {
      if (!media.isConnected || media.ended) lifecyclePausedMedia.delete(media);
    }
    for (const context of [...lifecycleSuspendedAudioContexts]) {
      if (context.state === 'closed') lifecycleSuspendedAudioContexts.delete(context);
    }
    return lifecyclePausedMedia.size > 0 || [...lifecycleSuspendedAudioContexts]
      .some(context => !pendingAudioContextSuspensions.has(context));
  };

  const resumeLifecycle = async (generation, retryIndex) => {
    if (disposed || paused || generation !== lifecycleGeneration) return;
    cancelLifecycleResumeRetry();
    const operation = ++lifecycleResumeOperation;
    const mediaTargets = [];
    for (const media of [...lifecyclePausedMedia]) {
      if (!media.isConnected || media.ended) {
        lifecyclePausedMedia.delete(media);
      } else if (!media.paused) {
        lifecyclePausedMedia.delete(media);
      } else {
        mediaTargets.push(media);
      }
    }
    const mediaResults = mediaTargets.map(async media => {
      try {
        await media.play();
        return true;
      } catch {
        return false;
      }
    });

    const contextTargets = [];
    for (const context of [...lifecycleSuspendedAudioContexts]) {
      if (context.state === 'closed') {
        lifecycleSuspendedAudioContexts.delete(context);
      } else if (pendingAudioContextSuspensions.has(context)) {
        continue;
      } else if (context.state === 'running') {
        lifecycleSuspendedAudioContexts.delete(context);
      } else {
        contextTargets.push(context);
      }
    }
    const contextResults = contextTargets.map(async context => {
      try {
        await context.resume();
        return context.state === 'running';
      } catch {
        return false;
      }
    });

    const [resolvedMedia, resolvedContexts] = await Promise.all([
      Promise.all(mediaResults),
      Promise.all(contextResults)
    ]);
    if (
      disposed
      || paused
      || generation !== lifecycleGeneration
      || operation !== lifecycleResumeOperation
    ) {
      if (!disposed && paused) {
        mediaTargets.forEach(media => {
          if (!media.isConnected || media.ended || media.paused) return;
          lifecyclePausedMedia.add(media);
          media.pause();
        });
        contextTargets.forEach(context => {
          if (context.state === 'running') suspendOwnedAudioContext(context, lifecycleGeneration);
        });
      }
      return;
    }

    mediaTargets.forEach((media, index) => {
      if (resolvedMedia[index] || !media.paused) lifecyclePausedMedia.delete(media);
    });
    contextTargets.forEach((context, index) => {
      if (resolvedContexts[index]) lifecycleSuspendedAudioContexts.delete(context);
    });
    if (hasRetryableLifecycleResume() && retryIndex < lifecycleResumeDelays.length) {
      lifecycleResumeTimer = nativeSetTimeout(() => {
        lifecycleResumeTimer = undefined;
        void resumeLifecycle(generation, retryIndex + 1);
      }, lifecycleResumeDelays[retryIndex]);
    }
  };

  const setLifecyclePaused = nextPaused => {
    if (disposed) return;
    paused = nextPaused;
    const generation = ++lifecycleGeneration;
    lifecycleResumeOperation += 1;
    cancelLifecycleResumeRetry();
    document.documentElement?.classList.toggle('dwr-lifecycle-paused', paused);
    if (paused) {
      if (nativeFrameId !== undefined) {
        nativeCancelAnimationFrame(nativeFrameId);
        nativeFrameId = undefined;
      }
      updateFrameWatchdog();
      pauseManagedTimers();
      pauseMedia();
      pauseAudioContexts(generation);
      return;
    }
    lastFrameTime = undefined;
    resumeManagedTimers();
    void resumeLifecycle(generation, 0);
    scheduleFrame();
  };

  const disposeLifecycle = () => {
    if (disposed) return;
    disposed = true;
    paused = true;
    lifecycleGeneration += 1;
    lifecycleResumeOperation += 1;
    cancelLifecycleResumeRetry();
    stopFrameWatchdog();
    if (nativeFrameId !== undefined) {
      nativeCancelAnimationFrame(nativeFrameId);
      nativeFrameId = undefined;
    }
    pauseManagedTimers();
    pauseMedia();
  };

  document.documentElement?.classList.toggle('dwr-lifecycle-paused', paused);

  window.wallpaperPropertyListener = window.wallpaperPropertyListener || {};
  window.wallpaperRegisterAudioListener = callback => {
    window.__dwrAudioListener = callback;
    callback(audio);
  };
  window.wallpaperRequestRandomFileForProperty = property => {
    const value = properties[property];
    return typeof value === 'string' ? value : '';
  };

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'dwr-web-lifecycle') {
      setLifecyclePaused(Boolean(message.paused));
    } else if (message.type === 'dwr-web-dispose') {
      disposeLifecycle();
    } else if (message.type === 'dwr-web-properties') {
      properties = message.values || {};
      const converted = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, { value }]));
      window.wallpaperPropertyListener.applyUserProperties?.(converted);
    } else if (message.type === 'dwr-web-audio') {
      audio = message.values || audio;
      window.__dwrAudioListener?.(audio);
    } else if (message.type === 'dwr-web-pointer') {
      window.dispatchEvent(new CustomEvent('wallpaperMousePosition', { detail: message }));
    }
  });
  window.addEventListener('pagehide', disposeLifecycle, { once: true });

  document.addEventListener('play', event => {
    if (!paused || !(event.target instanceof HTMLMediaElement)) return;
    lifecyclePausedMedia.add(event.target);
    event.target.pause();
  }, true);
  document.addEventListener('DOMContentLoaded', () => {
    if (paused) pauseMedia();
  }, { once: true });

  document.addEventListener('securitypolicyviolation', event => {
    try {
      const host = new URL(event.blockedURI).hostname;
      if (host) parent.postMessage({ type: 'dwr-network-blocked', host }, '*');
    } catch {}
  });

  parent.postMessage({ type: 'dwr-web-ready' }, '*');
})();`;
