import {
  DataTexture,
  LinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
  VideoTexture
} from 'three';
import type { JsonValue, WallpaperEngineRuntimeManifest } from '../src/domain/runtime';
import type { RuntimeResource } from '../src/domain/runtime';
import { RuntimeDiagnostics } from './diagnostics';

/**
 * Bridges decoded media frames to an on-demand WebGL renderer. Three.js uses
 * the same browser primitive to suppress duplicate texture uploads; consumers
 * use this gate to suppress the corresponding duplicate scene draws as well.
 */
export class VideoFrameGate {
  private callbackId: number | undefined;
  private pending: boolean;
  private paused: boolean;
  private disposed = false;
  private lastRenderedTime = Number.NaN;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onFrameAvailable: () => void,
    initiallyPaused = false
  ) {
    this.paused = initiallyPaused;
    this.pending = !initiallyPaused;
    this.scheduleCallback();
  }

  setPaused(paused: boolean): void {
    if (this.disposed) return;
    const changed = this.paused !== paused;
    this.paused = paused;
    if (paused) {
      this.pending = false;
      this.cancelCallback();
      return;
    }
    this.scheduleCallback();
    if (changed) {
      // Present the retained frame immediately; the first newly decoded frame
      // will independently invalidate the runtime through the callback.
      this.pending = true;
      this.onFrameAvailable();
    }
  }

  needsFrame(): boolean {
    if (this.disposed || this.paused || this.video.ended) return false;
    if (this.supportsFrameCallbacks()) return this.pending;
    return this.pending || (
      this.video.readyState >= this.video.HAVE_CURRENT_DATA
      && this.video.currentTime !== this.lastRenderedTime
    );
  }

  requiresPolling(): boolean {
    return !this.disposed && !this.paused && !this.video.paused && !this.video.ended
      && !this.supportsFrameCallbacks();
  }

  consumeFrame(): void {
    this.pending = false;
    this.lastRenderedTime = this.video.currentTime;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = false;
    this.cancelCallback();
  }

  private supportsFrameCallbacks(): boolean {
    return typeof this.video.requestVideoFrameCallback === 'function';
  }

  private scheduleCallback(): void {
    if (this.disposed || this.paused || this.callbackId !== undefined
      || !this.supportsFrameCallbacks()) return;
    this.callbackId = this.video.requestVideoFrameCallback(() => {
      this.callbackId = undefined;
      if (this.disposed || this.paused) return;
      this.pending = true;
      this.onFrameAvailable();
      this.scheduleCallback();
    });
  }

  private cancelCallback(): void {
    if (this.callbackId === undefined) return;
    this.video.cancelVideoFrameCallback?.(this.callbackId);
    this.callbackId = undefined;
  }
}

export class AssetLoader {
  private readonly jsonCache = new Map<string, Promise<unknown>>();
  private readonly textCache = new Map<string, Promise<string>>();
  private readonly bufferCache = new Map<string, Promise<ArrayBuffer>>();
  private readonly textureCache = new Map<string, Promise<Texture>>();
  private readonly videos = new Set<HTMLVideoElement>();
  private readonly directVideoTextures = new Map<HTMLVideoElement, VideoTexture>();
  private readonly videoActivity = new WeakMap<HTMLVideoElement, boolean>();
  private readonly videoFrameGates = new WeakMap<HTMLVideoElement, VideoFrameGate>();
  private readonly aliases = new Map<string, string>();
  private readonly resourceKinds = new Map<string, RuntimeResource['kind']>();
  private disposed = false;

  constructor(
    private readonly assetRootUri: string,
    private readonly diagnostics: RuntimeDiagnostics,
    resources: readonly RuntimeResource[] = [],
    private readonly onVideoFrameAvailable: () => void = () => undefined
  ) {
    for (const resource of resources) {
      this.aliases.set(normalizePath(resource.path), resource.uri);
      this.resourceKinds.set(normalizePath(resource.path), resource.kind);
      if (resource.sourcePath) {
        this.aliases.set(normalizePath(resource.sourcePath), resource.uri);
        this.resourceKinds.set(normalizePath(resource.sourcePath), resource.kind);
      }
    }
  }

  resolve(relativeOrAbsolute: string): string {
    if (/^(?:[a-z]+:|\/\/)/i.test(relativeOrAbsolute)) return relativeOrAbsolute;
    const alias = this.aliases.get(normalizePath(relativeOrAbsolute));
    if (alias) return alias;
    const withoutExtension = normalizePath(relativeOrAbsolute).replace(/\.(?:tex|json)$/i, '');
    const fuzzy = [...this.aliases.entries()].find(([key]) =>
      key.replace(/\.(?:tex|json|png|jpe?g|webp)$/i, '') === withoutExtension
    );
    if (fuzzy) return fuzzy[1];
    const base = this.assetRootUri.endsWith('/') ? this.assetRootUri : `${this.assetRootUri}/`;
    return new URL(relativeOrAbsolute.replace(/\\/g, '/'), base).toString();
  }

  async json<T = unknown>(path: string): Promise<T> {
    this.assertActive();
    const uri = this.resolve(path);
    let pending = this.jsonCache.get(uri);
    if (!pending) {
      pending = this.fetchChecked(uri).then(response => response.json());
      this.jsonCache.set(uri, pending);
    }
    return await pending as T;
  }

  async text(path: string): Promise<string> {
    this.assertActive();
    const uri = this.resolve(path);
    let pending = this.textCache.get(uri);
    if (!pending) {
      pending = this.fetchChecked(uri).then(response => response.text());
      this.textCache.set(uri, pending);
    }
    return await pending;
  }

  async buffer(path: string): Promise<ArrayBuffer> {
    this.assertActive();
    const uri = this.resolve(path);
    let pending = this.bufferCache.get(uri);
    if (!pending) {
      pending = this.fetchChecked(uri).then(response => response.arrayBuffer());
      this.bufferCache.set(uri, pending);
    }
    return await pending;
  }

  async texture(path: string, colorTexture = true, owner?: string): Promise<Texture> {
    this.assertActive();
    const uri = this.resolveTexture(path, owner);
    const cacheKey = `${uri}\u0000${colorTexture ? 'color' : 'data'}`;
    let pending = this.textureCache.get(cacheKey);
    if (!pending) {
      pending = this.loadVisualTexture(uri, colorTexture).catch(error => {
        if (this.disposed) throw error;
        this.diagnostics.add({
          code: 'texture-load-failed',
          severity: 'error',
          message: `纹理加载失败：${path}`,
          resource: path,
          details: error instanceof Error ? error.message : String(error)
        });
        return fallbackTexture();
      });
      this.textureCache.set(cacheKey, pending);
    }
    return await pending;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const video of [...this.videos]) this.releaseVideo(video);
    for (const pending of this.textureCache.values()) {
      void pending.then(disposeTexture).catch(() => undefined);
    }
    this.textureCache.clear();
    this.jsonCache.clear();
    this.textCache.clear();
    this.bufferCache.clear();
  }

  setTextureActive(texture: Texture | undefined, active: boolean): void {
    if (!(texture instanceof VideoTexture)) return;
    const video = texture.image as HTMLVideoElement;
    if (this.videoActivity.get(video) === active) return;
    this.videoActivity.set(video, active);
    const frames = this.videoFrameGates.get(video);
    frames?.setPaused(!active);
    if (active) {
      if (video.paused) {
        void video.play().then(() => {
          if (frames?.requiresPolling()) this.onVideoFrameAvailable();
        }).catch(() => undefined);
      }
    } else if (!video.paused) {
      video.pause();
    }
  }

  video(path: string, muted = true, playbackRate = 1): {
    element: HTMLVideoElement;
    texture: VideoTexture;
    frames: VideoFrameGate;
  } {
    this.assertActive();
    const video = document.createElement('video');
    video.src = this.resolve(path);
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.loop = true;
    video.autoplay = false;
    video.playsInline = true;
    video.muted = muted;
    video.defaultMuted = muted;
    video.volume = muted ? 0 : 1;
    video.playbackRate = playbackRate;
    const texture = new VideoTexture(video);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    this.videos.add(video);
    this.directVideoTextures.set(video, texture);
    this.videoActivity.set(video, true);
    const frames = new VideoFrameGate(video, this.onVideoFrameAvailable);
    this.videoFrameGates.set(video, frames);
    void video.play().then(() => {
      if (frames.requiresPolling()) this.onVideoFrameAvailable();
    }).catch(() => undefined);
    return { element: video, texture, frames };
  }

  videoTextureHasNewFrame(texture: Texture | undefined): boolean {
    if (!(texture instanceof VideoTexture)) return false;
    return this.videoFrameGates.get(texture.image as HTMLVideoElement)?.needsFrame() ?? false;
  }

  videoTextureRequiresPolling(texture: Texture | undefined): boolean {
    if (!(texture instanceof VideoTexture)) return false;
    return this.videoFrameGates.get(texture.image as HTMLVideoElement)?.requiresPolling() ?? false;
  }

  consumeVideoTextureFrame(texture: Texture | undefined): void {
    if (!(texture instanceof VideoTexture)) return;
    this.videoFrameGates.get(texture.image as HTMLVideoElement)?.consumeFrame();
  }

  releaseVideo(video: HTMLVideoElement): void {
    video.pause();
    video.removeAttribute('src');
    video.load();
    this.videos.delete(video);
    this.videoActivity.delete(video);
    this.videoFrameGates.get(video)?.dispose();
    this.videoFrameGates.delete(video);
    this.directVideoTextures.get(video)?.dispose();
    this.directVideoTextures.delete(video);
  }

  private async loadTexture(uri: string, colorTexture: boolean): Promise<Texture> {
    const response = await this.fetchChecked(uri);
    const bitmap = await createImageBitmap(await response.blob(), {
      imageOrientation: 'flipY',
      premultiplyAlpha: 'none'
    });
    if (this.disposed) {
      bitmap.close();
      throw new Error('资源加载器已释放。');
    }
    const texture = new Texture(bitmap);
    texture.needsUpdate = true;
    texture.colorSpace = colorTexture ? SRGBColorSpace : '';
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    return texture;
  }

  private async loadVisualTexture(uri: string, colorTexture: boolean): Promise<Texture> {
    if (!isVideoUri(uri)) return this.loadTexture(uri, colorTexture);
    const video = document.createElement('video');
    video.src = uri;
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    video.loop = true;
    video.autoplay = false;
    video.playsInline = true;
    video.muted = true;
    video.defaultMuted = true;
    const texture = new VideoTexture(video);
    texture.colorSpace = colorTexture ? SRGBColorSpace : '';
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    this.videos.add(video);
    this.videoActivity.set(video, false);
    this.videoFrameGates.set(video, new VideoFrameGate(video, this.onVideoFrameAvailable, true));
    return texture;
  }

  resolveTexture(reference: string, owner?: string): string {
    if (/^(?:[a-z]+:|\/\/)/i.test(reference)) return reference;
    const normalizedReference = normalizePath(reference);
    const ownerDirectory = owner
      ? normalizePath(owner).split('/').slice(0, -1).join('/')
      : '';
    const candidates = ownerDirectory
      ? [`${ownerDirectory}/${normalizedReference}`, normalizedReference]
      : [normalizedReference];

    for (const candidate of candidates) {
      const direct = this.aliases.get(candidate);
      if (direct && isBrowserVisualUri(direct)) return direct;
      const base = withoutVisualExtension(candidate);
      const matches = [...this.aliases.entries()].filter(([key, uri]) =>
        withoutVisualExtension(key) === base
        && (this.resourceKinds.get(key) === 'texture' || this.resourceKinds.get(key) === 'video')
        && isBrowserVisualUri(uri)
      );
      if (matches.length > 0) {
        const video = matches.find(([, uri]) => isVideoUri(uri));
        return (video ?? matches[0])[1];
      }
    }
    return this.resolve(reference);
  }

  private async fetchChecked(uri: string): Promise<Response> {
    this.assertActive();
    const response = await fetch(uri, { credentials: 'omit', cache: 'force-cache' });
    this.assertActive();
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('资源加载器已释放。');
  }
}

function withoutVisualExtension(value: string): string {
  return value.replace(/\.(?:tex|json|png|jpe?g|webp|avif|bmp|gif|mp4|webm|ogg|ogv|mov|m4v)$/i, '');
}

function isVideoUri(uri: string): boolean {
  return /\.(?:mp4|webm|ogg|ogv|mov|m4v)(?:$|[?#])/i.test(uri);
}

function isBrowserVisualUri(uri: string): boolean {
  return isVideoUri(uri)
    || /\.(?:png|jpe?g|webp|avif|bmp|gif)(?:$|[?#])/i.test(uri);
}

export async function loadRuntimeManifest(
  manifestUri: string,
  diagnostics: RuntimeDiagnostics
): Promise<WallpaperEngineRuntimeManifest> {
  const response = await fetch(manifestUri, { credentials: 'omit', cache: 'no-cache' });
  if (!response.ok) throw new Error(`运行时清单读取失败：${response.status} ${response.statusText}`);
  const manifest = await response.json() as Partial<WallpaperEngineRuntimeManifest>;
  if (manifest.formatVersion !== 1 || typeof manifest.kind !== 'string') {
    throw new Error('运行时清单格式无效或版本不受支持。');
  }
  diagnostics.merge(manifest.compatibility?.diagnostics ?? []);
  return manifest as WallpaperEngineRuntimeManifest;
}

export function asRecord(value: unknown): Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

export function numberValue(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function vectorValue(value: unknown, size: number, fallback = 0): number[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.trim().split(/\s+/)
      : [];
  return Array.from({ length: size }, (_, index) => numberValue(source[index], fallback));
}

export function unwrapValue(value: JsonValue | undefined): JsonValue | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, JsonValue>;
    return object.value;
  }
  return value;
}

function fallbackTexture(): DataTexture {
  const pixels = new Uint8Array([
    255, 0, 255, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
    255, 0, 255, 255
  ]);
  const texture = new DataTexture(pixels, 2, 2, RGBAFormat, UnsignedByteType);
  texture.needsUpdate = true;
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function disposeTexture(texture: Texture): void {
  texture.dispose();
  const image = texture.image as { close?: () => void } | undefined;
  image?.close?.();
}
