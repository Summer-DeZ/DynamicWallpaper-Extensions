import type { RendererConfiguration, RendererLayer } from '../src/domain/renderer';
import type {
  HostToRuntimeMessage,
  JsonValue,
  RuntimeInitMessage,
  VideoRuntimeManifest,
  WallpaperEngineRuntimeManifest
} from '../src/domain/runtime';
import { loadRuntimeManifest } from './assets';
import { RuntimeDiagnostics } from './diagnostics';
import {
  frameIntervalMilliseconds,
  runtimeStatePollIntervalMilliseconds,
  targetFramesPerSecond
} from './framePacing';
import type { RuntimeLifecycleParticipant } from './lifecycle';
import { NativeWallpaperRuntime } from './nativeRuntime';
import { WallpaperEngineSceneRuntime } from './sceneRuntime';
import { WebWallpaperRuntime } from './webRuntime';

const root = requireRuntimeRoot();

const diagnostics = new RuntimeDiagnostics();
let active: RuntimeLifecycleParticipant | undefined;
let lastInitialization: RuntimeInitMessage | undefined;
let animationFrame: number | undefined;
let previousTime = performance.now();
let simulationTime = 0;
let paused = false;
let hostVisible = true;
let suspended = false;
let suspensionTimer: number | undefined;
let initializationGeneration = 0;
let statePollGeneration = 0;
let renderFailureCount = 0;
let lastAnimationFrameTime = previousTime;
let automaticRestartTimer: number | undefined;
let runtimeQuarantined = false;
let activeFrameInvalidated = false;
const automaticRestartTimes: number[] = [];

window.addEventListener('message', event => {
  if (event.source !== window.parent || !isHostMessage(event.data)) return;
  void handleMessage(event.data);
});

window.addEventListener('error', event => {
  diagnostics.add({
    code: 'runtime-window-error',
    severity: 'error',
    message: event.message || 'WebGL runtime 发生未捕获错误。',
    resource: event.filename,
    details: event.error instanceof Error ? event.error.stack : undefined
  });
});

window.addEventListener('unhandledrejection', event => {
  diagnostics.add({
    code: 'runtime-unhandled-rejection',
    severity: 'error',
    message: 'WebGL runtime Promise 发生未处理异常。',
    details: event.reason instanceof Error ? event.reason.stack : String(event.reason)
  });
});

window.parent.postMessage({
  channel: 'dynamic-wallpaper-host',
  protocolVersion: 1,
  type: 'ready'
}, '*');

async function handleMessage(message: HostToRuntimeMessage): Promise<void> {
  if (message.type === 'initialize') {
    clearAutomaticRestart();
    automaticRestartTimes.length = 0;
    runtimeQuarantined = false;
    lastInitialization = message;
    suspended = false;
    await initialize(message, false);
  } else if (message.type === 'lifecycle') {
    paused = message.paused;
    // Older hosts did not send `visible`. The iframe visibility is the best
    // compatible fallback and still distinguishes ordinary focus changes from
    // a genuinely hidden/minimized workbench in supported Chromium versions.
    hostVisible = message.visible ?? document.visibilityState !== 'hidden';
    if (!runtimeQuarantined) active?.setPaused(paused);
    if (paused) {
      activeFrameInvalidated = false;
      stopRendering();
      if (hostVisible) clearSuspensionTimer();
      else scheduleSuspension();
    } else {
      clearSuspensionTimer();
      if (suspended && lastInitialization) {
        suspended = false;
        void initialize(lastInitialization, true);
      } else if (active && !runtimeQuarantined) {
        // Background throttling can delay or discard an old RAF callback.
        // Render once immediately and start a fresh callback chain. The
        // simulation clock deliberately excludes wall time spent paused.
        renderFailureCount = 0;
        previousTime = performance.now();
        resizeRuntime(false);
        updateActive(simulationTime, 0);
        activeFrameInvalidated = false;
        startRendering();
      }
    }
  } else if (message.type === 'pointer') {
    const runtime = active;
    runtime?.updatePointer?.(message.x, message.y, message.buttons);
    if (runtime?.needsPointerUpdates?.() ?? true) invalidateActiveFrame();
  } else if (message.type === 'properties') {
    rememberProperties(message.values);
    if (active?.updateProperties) {
      active.updateProperties(message.values);
      invalidateActiveFrame();
    }
  } else if (message.type === 'network-policy') {
    rememberNetworkPolicy(message.allowedHosts);
    if (active?.updateNetworkPolicy) {
      active.updateNetworkPolicy(message.allowedHosts);
      invalidateActiveFrame();
    }
  }
}

async function initialize(message: RuntimeInitMessage, preserveSimulationTime: boolean): Promise<void> {
  const generation = ++initializationGeneration;
  const pollGeneration = ++statePollGeneration;
  clearSuspensionTimer();
  stopRendering();
  activeFrameInvalidated = false;
  if (!preserveSimulationTime) simulationTime = 0;
  renderFailureCount = 0;
  disposeActive();
  root.replaceChildren();

  let runtime: RuntimeLifecycleParticipant | undefined;
  try {
    runtime = await createRuntime(message.configuration, message.userProperties);
    if (generation !== initializationGeneration) {
      disposeRuntime(runtime);
      return;
    }
    active = runtime;
    active.updateNetworkPolicy?.(message.configuration.runtime.networkHosts);
    resizeRuntime(false);
    active.setPaused(paused);
    previousTime = performance.now();
    lastAnimationFrameTime = previousTime;
    updateActive(simulationTime, 0);
    activeFrameInvalidated = false;
    if (paused && !hostVisible) scheduleSuspension();
    else startRendering();
    if (message.configuration.runtime.stateUri) {
      void pollRuntimeState(message.configuration.runtime.stateUri, pollGeneration);
    }
    runtime = undefined;
  } catch (error) {
    if (runtime) {
      if (active === runtime) active = undefined;
      stopRendering();
      disposeRuntime(runtime);
    }
    if (generation !== initializationGeneration) return;
    const details = error instanceof Error ? error.stack ?? error.message : String(error);
    diagnostics.fatal('WebGL runtime 初始化失败。', details);
    showFatal(details);
  }
}

async function pollRuntimeState(uri: string, generation: number): Promise<void> {
  let revision = -1;
  let unchangedPolls = 0;
  while (generation === statePollGeneration && active) {
    try {
      const response = await fetch(uri, {
        cache: 'no-store',
        credentials: 'omit'
      });
      if (generation !== statePollGeneration) return;
      if (response.ok) {
        const state = await response.json() as {
          formatVersion?: number;
          revision?: number;
          userProperties?: Record<string, JsonValue>;
          networkHosts?: string[];
          diagnosticsVisible?: boolean;
        };
        if (generation !== statePollGeneration) return;
        if (state.formatVersion === 1 && typeof state.revision === 'number' && state.revision !== revision) {
          revision = state.revision;
          unchangedPolls = 0;
          if (state.userProperties && typeof state.userProperties === 'object') {
            rememberProperties(state.userProperties);
            active?.updateProperties?.(state.userProperties);
            invalidateActiveFrame();
          }
          if (Array.isArray(state.networkHosts)) {
            const allowedHosts = state.networkHosts.filter(host => typeof host === 'string');
            rememberNetworkPolicy(allowedHosts);
            active?.updateNetworkPolicy?.(allowedHosts);
            invalidateActiveFrame();
          }
          diagnostics.setVisible(state.diagnosticsVisible === true);
        } else {
          unchangedPolls++;
        }
      } else {
        unchangedPolls++;
      }
    } catch (error) {
      if (generation !== statePollGeneration) return;
      unchangedPolls++;
      diagnostics.add({
        code: 'runtime-state-read-failed',
        severity: 'warning',
        message: '无法读取实时属性状态；运行时将保留最后一次有效值。',
        resource: uri,
        details: error instanceof Error ? error.message : String(error)
      });
    }
    const delay = runtimeStatePollIntervalMilliseconds(unchangedPolls, paused);
    await new Promise(resolve => window.setTimeout(resolve, delay));
  }
}

async function createRuntime(
  configuration: RendererConfiguration,
  userProperties: Record<string, JsonValue>
): Promise<RuntimeLifecycleParticipant> {
  const restart = (): void => {
    requestAutomaticRestart();
  };
  if (configuration.runtime.kind === 'native') {
    return initializeRuntime(
      new NativeWallpaperRuntime(root, configuration, diagnostics, restart, invalidateActiveFrame)
    );
  }
  const manifestUri = configuration.runtime.manifestUri;
  if (!manifestUri) throw new Error('Wallpaper Engine runtime 缺少 manifestUri。');
  const manifest = await loadRuntimeManifest(manifestUri, diagnostics);
  assertManifestKind(configuration, manifest);
  if (manifest.kind === 'wallpaper-engine-scene') {
    return initializeRuntime(new WallpaperEngineSceneRuntime(
      configuration,
      manifest,
      root,
      diagnostics,
      userProperties,
      restart,
      invalidateActiveFrame
    ));
  }
  if (manifest.kind === 'wallpaper-engine-web') {
    const runtime = await initializeRuntime(new WebWallpaperRuntime(
      root,
      manifest,
      diagnostics,
      targetFramesPerSecond(
        configuration.performance.profile,
        configuration.performance.maxFps
      )
    ));
    runtime.updateProperties(userProperties);
    return runtime;
  }
  return createVideoRuntime(configuration, manifest, restart);
}

async function createVideoRuntime(
  configuration: RendererConfiguration,
  manifest: VideoRuntimeManifest,
  restart: () => void
): Promise<RuntimeLifecycleParticipant> {
  const layer: RendererLayer = {
    id: 'wallpaper-engine-video',
    type: 'video',
    sourceUri: manifest.entryUri,
    opacity: 1,
    blendMode: 'normal',
    fit: 'cover',
    position: 'center',
    scale: 1,
    rotate: 0,
    parallax: 0,
    filters: {
      blur: 0,
      brightness: 1,
      contrast: 1,
      saturation: 1,
      hueRotate: 0,
      grayscale: 0
    },
    muted: true,
    playbackRate: 1,
    motion: { type: 'none', duration: 8, intensity: 0, delay: 0 }
  };
  return initializeRuntime(new NativeWallpaperRuntime(
    root,
    { ...configuration, layers: [layer] },
    diagnostics,
    restart,
    invalidateActiveFrame
  ));
}

function render(time: number): void {
  animationFrame = undefined;
  lastAnimationFrameTime = time;
  if (!active || paused) return;
  const performanceConfiguration = lastInitialization?.configuration.performance;
  const profile = performanceConfiguration?.profile ?? 'quality';
  const interval = frameIntervalMilliseconds(profile, performanceConfiguration?.maxFps ?? 60);
  const elapsed = Math.max(0, time - previousTime);
  if (elapsed + 0.25 >= interval) {
    const delta = Math.min(0.05, elapsed / 1000);
    previousTime = time - elapsed % interval;
    simulationTime += delta;
    activeFrameInvalidated = false;
    updateActive(simulationTime, delta);
  }
  startRendering();
}

function startRendering(): void {
  if (!active || paused || runtimeQuarantined || automaticRestartTimer !== undefined
    || (!activeFrameInvalidated && !needsFrameUpdates(active))
    || animationFrame !== undefined) return;
  animationFrame = requestAnimationFrame(render);
}

function stopRendering(): void {
  if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
  animationFrame = undefined;
}

function updateActive(timeSeconds: number, deltaSeconds: number): void {
  const runtime = active;
  if (!runtime) return;
  try {
    runtime.update(timeSeconds, deltaSeconds);
    renderFailureCount = 0;
  } catch (error) {
    renderFailureCount++;
    diagnostics.add({
      code: 'runtime-frame-failed',
      severity: 'error',
      message: '运行时帧更新失败；连续失败时将自动重建。',
      details: error instanceof Error ? error.stack ?? error.message : String(error)
    });
    if (renderFailureCount >= 3 && lastInitialization) {
      renderFailureCount = 0;
      requestAutomaticRestart();
    }
  }
}

function invalidateActiveFrame(): void {
  // A Web wallpaper owns its iframe/compositor clock; scheduling an empty
  // outer-runtime frame for every property or pointer message only adds work.
  if (!active || active instanceof WebWallpaperRuntime || paused || runtimeQuarantined
    || automaticRestartTimer !== undefined) return;
  activeFrameInvalidated = true;
  startRendering();
}

function requestAutomaticRestart(): void {
  if (!lastInitialization || automaticRestartTimer !== undefined || runtimeQuarantined) return;
  const now = performance.now();
  while (automaticRestartTimes.length > 0 && now - automaticRestartTimes[0] > 60_000) {
    automaticRestartTimes.shift();
  }
  if (automaticRestartTimes.length >= 3) {
    runtimeQuarantined = true;
    activeFrameInvalidated = false;
    stopRendering();
    active?.setPaused(true);
    diagnostics.add({
      code: 'runtime-restart-budget-exhausted',
      severity: 'error',
      message: '运行时在一分钟内连续重建失败，已停止自动重建以避免循环。'
    });
    return;
  }
  automaticRestartTimes.push(now);
  const delay = 250 * 2 ** (automaticRestartTimes.length - 1);
  stopRendering();
  activeFrameInvalidated = false;
  automaticRestartTimer = window.setTimeout(() => {
    automaticRestartTimer = undefined;
    if (lastInitialization) void initialize(lastInitialization, true);
  }, delay);
}

function clearAutomaticRestart(): void {
  if (automaticRestartTimer !== undefined) window.clearTimeout(automaticRestartTimer);
  automaticRestartTimer = undefined;
}

function needsFrameUpdates(runtime: RuntimeLifecycleParticipant): boolean {
  if (runtime instanceof WebWallpaperRuntime) return false;
  return runtime.needsFrameUpdates?.() ?? true;
}

function scheduleSuspension(): void {
  if (suspensionTimer !== undefined || suspended || !paused || hostVisible) return;
  const seconds = lastInitialization?.configuration.performance.suspendAfterSeconds ?? 0;
  if (seconds <= 0) return;
  suspensionTimer = window.setTimeout(() => {
    suspensionTimer = undefined;
    if (!paused || hostVisible || !active) return;
    ++initializationGeneration;
    ++statePollGeneration;
    clearAutomaticRestart();
    stopRendering();
    disposeActive();
    root.replaceChildren();
    suspended = true;
  }, seconds * 1000);
}

function clearSuspensionTimer(): void {
  if (suspensionTimer !== undefined) window.clearTimeout(suspensionTimer);
  suspensionTimer = undefined;
}

function rememberProperties(values: Record<string, unknown>): void {
  if (!lastInitialization) return;
  lastInitialization = {
    ...lastInitialization,
    userProperties: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, value as JsonValue])
    )
  };
}

function rememberNetworkPolicy(allowedHosts: string[]): void {
  if (!lastInitialization) return;
  lastInitialization = {
    ...lastInitialization,
    configuration: {
      ...lastInitialization.configuration,
      runtime: {
        ...lastInitialization.configuration.runtime,
        networkHosts: [...allowedHosts]
      }
    }
  };
}

async function initializeRuntime<T extends RuntimeLifecycleParticipant & { initialize(): Promise<void> }>(
  runtime: T
): Promise<T> {
  try {
    await runtime.initialize();
    return runtime;
  } catch (error) {
    disposeRuntime(runtime);
    throw error;
  }
}

function disposeActive(): void {
  const runtime = active;
  active = undefined;
  if (runtime) disposeRuntime(runtime);
}

function disposeRuntime(runtime: RuntimeLifecycleParticipant): void {
  try {
    runtime.dispose();
  } catch (error) {
    diagnostics.add({
      code: 'runtime-dispose-failed',
      severity: 'warning',
      message: '旧运行时释放不完整；新实例将继续启动。',
      details: error instanceof Error ? error.message : String(error)
    });
  }
}

function resize(): void {
  resizeRuntime(true);
}

function resizeRuntime(renderOnDemand: boolean): void {
  if (!active) return;
  const profile = lastInitialization?.configuration.performance.profile;
  const maximumRatio = profile === 'quality' ? 2 : profile === 'balanced' ? 1.5 : 1;
  active.resize(
    Math.max(1, root.clientWidth),
    Math.max(1, root.clientHeight),
    Math.min(window.devicePixelRatio || 1, maximumRatio)
  );
  // resize() can turn a previously static runtime dirty (for example an
  // EffectComposer target reallocation). Always schedule one capped frame;
  // the lifecycle guard inside invalidateActiveFrame suppresses background
  // work, while Web iframe runtimes apply their resize message directly.
  if (renderOnDemand) invalidateActiveFrame();
}

function showFatal(details: string): void {
  const message = document.createElement('pre');
  message.className = 'dwr-fatal';
  message.textContent = `Dynamic Wallpaper WebGL Runtime\n\n${details}`;
  root.replaceChildren(message);
}

function assertManifestKind(
  configuration: RendererConfiguration,
  manifest: WallpaperEngineRuntimeManifest
): void {
  if (configuration.runtime.kind !== manifest.kind) {
    throw new Error(`运行时类型不匹配：配置为 ${configuration.runtime.kind}，清单为 ${manifest.kind}。`);
  }
}

function isHostMessage(value: unknown): value is HostToRuntimeMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<HostToRuntimeMessage>;
  return candidate.channel === 'dynamic-wallpaper-runtime'
    && candidate.protocolVersion === 1
    && typeof candidate.type === 'string';
}

new ResizeObserver(resize).observe(root);

window.setInterval(() => {
  if (paused || runtimeQuarantined || automaticRestartTimer !== undefined
    || !active || (!activeFrameInvalidated && !needsFrameUpdates(active))
    || document.visibilityState === 'hidden') return;
  const now = performance.now();
  if (animationFrame === undefined || now - lastAnimationFrameTime > 5_000) {
    stopRendering();
    previousTime = now;
    lastAnimationFrameTime = now;
    startRendering();
  }
}, 2_000);

window.addEventListener('pageshow', () => {
  if (!paused && active) {
    previousTime = performance.now();
    startRendering();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!paused && document.visibilityState === 'visible' && active) {
    previousTime = performance.now();
    startRendering();
  }
});

function requireRuntimeRoot(): HTMLElement {
  const element = document.getElementById('runtime-root');
  if (!element) throw new Error('WebGL runtime root 不存在。');
  return element;
}
