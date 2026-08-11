import { RuntimeDiagnostics } from './diagnostics';

interface AudioEntry {
  element: HTMLAudioElement;
  source?: MediaElementAudioSourceNode;
  lifecyclePaused: boolean;
}

const RESUME_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000] as const;

export class WallpaperAudioManager {
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private gain?: GainNode;
  private readonly entries: AudioEntry[] = [];
  private readonly spectrum = new Uint8Array(128);
  private readonly bands = new Array<number>(16).fill(0);
  private volume = 1;
  private paused = false;
  private disposed = false;
  private lifecycleGeneration = 0;
  private resumeOperation = 0;
  private resumeRetryTimer?: ReturnType<typeof setTimeout>;
  private lifecycleSuspendedContext?: AudioContext;
  private contextSuspendPromise?: Promise<void>;

  constructor(private readonly diagnostics: RuntimeDiagnostics) {
    diagnostics.add({
      code: 'system-audio-unavailable',
      severity: 'warning',
      message: '纯浏览器模式只能分析壁纸自身音频，系统音频响应值固定为 0。'
    });
  }

  add(uri: string, options: { loop?: boolean; volume?: number; autoplay?: boolean } = {}): HTMLAudioElement {
    const element = document.createElement('audio');
    element.src = uri;
    element.crossOrigin = 'anonymous';
    element.preload = 'auto';
    element.loop = options.loop ?? true;
    element.volume = Math.min(1, Math.max(0, options.volume ?? 1));
    const graph = this.ensureGraph();
    let source: MediaElementAudioSourceNode | undefined;
    if (graph) {
      try {
        source = graph.context.createMediaElementSource(element);
        source.connect(graph.gain);
      } catch (error) {
        this.diagnostics.add({
          code: 'wallpaper-audio-graph-failed',
          severity: 'warning',
          message: '壁纸音频分析链路创建失败；音频元素将继续独立播放。',
          resource: uri,
          details: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const shouldAutoplay = options.autoplay !== false;
    this.entries.push({
      element,
      source,
      lifecyclePaused: this.paused && shouldAutoplay
    });
    if (this.paused) {
      if (graph) void this.suspendContextForLifecycle(this.lifecycleGeneration);
    } else if (shouldAutoplay) {
      void element.play().catch(() => undefined);
    }
    return element;
  }

  spectrum16(): number[] {
    if (!this.analyser || this.entries.length === 0) return this.bands;
    this.analyser.getByteFrequencyData(this.spectrum);
    const bucketSize = this.spectrum.length / this.bands.length;
    for (let bucket = 0; bucket < this.bands.length; bucket++) {
      let total = 0;
      const start = Math.floor(bucket * bucketSize);
      const end = Math.floor((bucket + 1) * bucketSize);
      for (let index = start; index < end; index++) total += this.spectrum[index];
      this.bands[bucket] = total / Math.max(1, end - start) / 255;
    }
    return this.bands;
  }

  async setPaused(paused: boolean): Promise<void> {
    if (this.disposed) return;
    this.paused = paused;
    const generation = ++this.lifecycleGeneration;
    this.resumeOperation += 1;
    this.cancelResumeRetry();
    if (paused) {
      for (const entry of this.entries) {
        if (entry.element.paused || entry.element.ended) continue;
        entry.lifecyclePaused = true;
        entry.element.pause();
      }
      await this.suspendContextForLifecycle(generation);
      return;
    }
    await this.resumeLifecycle(generation, 0);
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.paused = true;
    this.lifecycleGeneration += 1;
    this.resumeOperation += 1;
    this.cancelResumeRetry();
    for (const entry of this.entries) {
      entry.element.pause();
      entry.element.removeAttribute('src');
      entry.source?.disconnect();
    }
    this.entries.length = 0;
    this.bands.fill(0);
    this.gain?.disconnect();
    this.analyser?.disconnect();
    const context = this.context;
    this.context = undefined;
    this.gain = undefined;
    this.analyser = undefined;
    this.lifecycleSuspendedContext = undefined;
    this.contextSuspendPromise = undefined;
    if (context) void context.close();
  }

  private suspendContextForLifecycle(generation: number): Promise<void> {
    const context = this.context;
    if (!context || context.state !== 'running') return Promise.resolve();
    this.lifecycleSuspendedContext = context;
    if (this.contextSuspendPromise) return this.contextSuspendPromise;

    let suspension: Promise<void>;
    try {
      suspension = Promise.resolve(context.suspend());
    } catch {
      if (this.lifecycleSuspendedContext === context) this.lifecycleSuspendedContext = undefined;
      return Promise.resolve();
    }

    let tracked!: Promise<void>;
    tracked = suspension.then(
      () => this.completeContextSuspension(context, generation, tracked, true),
      () => this.completeContextSuspension(context, generation, tracked, false)
    );
    this.contextSuspendPromise = tracked;
    return tracked;
  }

  private completeContextSuspension(
    context: AudioContext,
    generation: number,
    operation: Promise<void>,
    succeeded: boolean
  ): void {
    if (this.contextSuspendPromise === operation) this.contextSuspendPromise = undefined;
    if (this.disposed || this.context !== context) return;
    if (!succeeded && context.state !== 'suspended') {
      if (this.lifecycleSuspendedContext === context) this.lifecycleSuspendedContext = undefined;
      // A newer pause request may have shared the failed in-flight suspension.
      if (this.paused && this.lifecycleGeneration !== generation) {
        void this.suspendContextForLifecycle(this.lifecycleGeneration);
      }
      return;
    }
    if (!this.paused) void this.resumeLifecycle(this.lifecycleGeneration, 0);
  }

  private async resumeLifecycle(generation: number, retryIndex: number): Promise<void> {
    if (this.disposed || this.paused || generation !== this.lifecycleGeneration) return;
    this.cancelResumeRetry();
    const operation = ++this.resumeOperation;
    const mediaTargets = this.entries.filter(entry => {
      if (!entry.lifecyclePaused) return false;
      if (entry.element.ended) {
        entry.lifecyclePaused = false;
        return false;
      }
      if (!entry.element.paused) {
        entry.lifecyclePaused = false;
        return false;
      }
      return true;
    });
    const mediaResults = mediaTargets.map(async entry => {
      try {
        await entry.element.play();
        return true;
      } catch {
        return false;
      }
    });

    const context = this.lifecycleSuspendedContext;
    let contextResult: Promise<boolean> | undefined;
    if (context) {
      if (context !== this.context || context.state === 'closed') {
        this.lifecycleSuspendedContext = undefined;
      } else if (!this.contextSuspendPromise && context.state === 'running') {
        this.lifecycleSuspendedContext = undefined;
      } else if (!this.contextSuspendPromise) {
        contextResult = (async () => {
          try {
            await context.resume();
            return context.state === 'running';
          } catch {
            return false;
          }
        })();
      }
    }

    const [resolvedMedia, resolvedContext] = await Promise.all([
      Promise.all(mediaResults),
      contextResult ?? Promise.resolve(undefined)
    ]);
    if (
      this.disposed
      || generation !== this.lifecycleGeneration
      || operation !== this.resumeOperation
      || this.paused
    ) {
      if (!this.disposed && this.paused) {
        for (const entry of mediaTargets) {
          if (entry.element.ended || entry.element.paused) continue;
          entry.lifecyclePaused = true;
          entry.element.pause();
        }
        if (context && context === this.context && context.state === 'running') {
          this.lifecycleSuspendedContext = context;
          void this.suspendContextForLifecycle(this.lifecycleGeneration);
        }
      }
      return;
    }

    mediaTargets.forEach((entry, index) => {
      if (resolvedMedia[index] || !entry.element.paused) entry.lifecyclePaused = false;
    });
    if (context && resolvedContext && this.lifecycleSuspendedContext === context) {
      this.lifecycleSuspendedContext = undefined;
    }
    if (this.hasRetryableLifecycleResume() && retryIndex < RESUME_RETRY_DELAYS_MS.length) {
      const delay = RESUME_RETRY_DELAYS_MS[retryIndex];
      this.resumeRetryTimer = setTimeout(() => {
        this.resumeRetryTimer = undefined;
        void this.resumeLifecycle(generation, retryIndex + 1);
      }, delay);
    }
  }

  private hasRetryableLifecycleResume(): boolean {
    if (this.entries.some(entry => entry.lifecyclePaused && !entry.element.ended)) return true;
    const context = this.lifecycleSuspendedContext;
    return Boolean(
      context
      && context === this.context
      && context.state !== 'closed'
      && !this.contextSuspendPromise
    );
  }

  private cancelResumeRetry(): void {
    if (this.resumeRetryTimer === undefined) return;
    clearTimeout(this.resumeRetryTimer);
    this.resumeRetryTimer = undefined;
  }

  private ensureGraph(): { context: AudioContext; gain: GainNode } | undefined {
    if (this.context && this.gain) return { context: this.context, gain: this.gain };
    try {
      const context = new AudioContext({ latencyHint: 'playback' });
      const analyser = context.createAnalyser();
      const gain = context.createGain();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      gain.gain.value = this.volume;
      gain.connect(analyser);
      analyser.connect(context.destination);
      this.context = context;
      this.analyser = analyser;
      this.gain = gain;
      return { context, gain };
    } catch (error) {
      this.diagnostics.add({
        code: 'wallpaper-audio-context-failed',
        severity: 'warning',
        message: '浏览器拒绝创建壁纸音频分析上下文。',
        details: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }
}
