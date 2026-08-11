import {
  AdditiveBlending,
  Color,
  CustomBlending,
  DoubleSide,
  DstColorFactor,
  Mesh,
  NormalBlending,
  Object3D,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  ShaderMaterial,
  SrcAlphaFactor,
  Texture,
  VideoTexture,
  Vector2,
  ZeroFactor
} from 'three';
import type { RendererConfiguration, RendererLayer } from '../src/domain/renderer';
import { AssetLoader, VideoFrameGate } from './assets';
import { RuntimeDiagnostics } from './diagnostics';
import { targetFramesPerSecond } from './framePacing';
import type { RuntimeLifecycleParticipant } from './lifecycle';
import { ParticleEmitter } from './particles';
import { ThreeHost } from './threeHost';
import { buildWebDocument } from './webRuntime';

interface NativeLayerState {
  source: RendererLayer;
  object: Object3D;
  mesh?: Mesh<PlaneGeometry, ShaderMaterial>;
  naturalWidth: number;
  naturalHeight: number;
  video?: HTMLVideoElement;
  videoFrames?: VideoFrameGate;
  particle?: ParticleEmitter;
  web?: HTMLIFrameElement;
}

export class NativeWallpaperRuntime implements RuntimeLifecycleParticipant {
  private readonly assets: AssetLoader;
  private host?: ThreeHost;
  private readonly layers: NativeLayerState[] = [];
  private paused = false;
  private disposed = false;
  private renderInvalidated = true;
  private readonly previousRootBackground: string;
  private rootBackgroundApplied = false;
  private pointerX = 0;
  private pointerY = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly configuration: RendererConfiguration,
    private readonly diagnostics: RuntimeDiagnostics,
    private readonly onContextRestoreRequired: () => void,
    private readonly onFrameRequested: () => void = () => undefined
  ) {
    this.assets = new AssetLoader(
      configuration.runtime.projectUri ?? location.href,
      diagnostics,
      [],
      () => this.invalidateRender()
    );
    this.previousRootBackground = root.style.backgroundColor;
  }

  async initialize(): Promise<void> {
    // A pure Web wallpaper is already rendered by its isolated iframe. Avoid
    // allocating a second, permanently empty WebGL context behind it.
    if (this.configuration.layers.some(layer => layer.type !== 'web') || this.hasConfiguredEffects()) {
      this.host = new ThreeHost(
        this.root,
        this.configuration.backgroundColor,
        this.configuration.performance.profile,
        this.configuration.effects,
        this.diagnostics,
        this.onContextRestoreRequired
      );
    } else {
      // Preserve the WebGL clear-color appearance for transparent Web pages
      // without retaining a GPU context solely to paint a flat background.
      this.root.style.backgroundColor = this.configuration.backgroundColor;
      this.rootBackgroundApplied = true;
    }
    for (const [index, layer] of this.configuration.layers.entries()) {
      try {
        const state = await this.createLayer(layer, index);
        this.layers.push(state);
        this.host?.scene.add(state.object);
      } catch (error) {
        this.diagnostics.add({
          code: 'native-layer-failed',
          severity: 'error',
          message: `图层已隔离：${layer.id}`,
          nodeId: layer.id,
          details: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (this.layers.length === 0) throw new Error('没有可由 WebGL2 运行时加载的图层。');
  }

  setPaused(paused: boolean): void {
    const changed = this.paused !== paused;
    this.paused = paused;
    for (const layer of this.layers) {
      layer.particle?.setPaused(paused);
      layer.videoFrames?.setPaused(paused);
      if (layer.video) {
        if (paused) layer.video.pause();
        else {
          void layer.video.play().then(() => {
            // rVFC wakes the modern path. The fallback has no event source of
            // its own, so begin currentTime polling only after playback starts.
            if (layer.videoFrames?.requiresPolling()) this.invalidateRender();
          }).catch(() => undefined);
        }
      }
      layer.web?.contentWindow?.postMessage({ type: 'dwr-web-lifecycle', paused }, '*');
      layer.web?.contentWindow?.postMessage({ type: 'dynamic-wallpaper-activity', paused }, '*');
    }
    if (changed && !paused) this.renderInvalidated = true;
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.host?.resize(width, height, pixelRatio);
    this.layoutLayers(width, height);
    this.renderInvalidated = true;
  }

  update(timeSeconds: number, deltaSeconds: number): void {
    const host = this.host;
    if (!host) return;
    const shouldRender = this.renderInvalidated
      || this.hasContinuousAnimation()
      || this.layers.some(layer => layer.videoFrames?.needsFrame() === true);
    // Legacy video polling may call update at the configured frame cap. Keep
    // those checks CPU-only until currentTime actually advances.
    if (!shouldRender) return;
    if (!this.paused) {
      const viewport = host.viewport();
      this.layers.forEach(layer => {
        layer.particle?.update(deltaSeconds, viewport.width, viewport.height);
        this.applyMotion(layer, timeSeconds);
      });
    }
    host.render(timeSeconds, deltaSeconds);
    this.renderInvalidated = false;
    for (const layer of this.layers) layer.videoFrames?.consumeFrame();
  }

  needsFrameUpdates(): boolean {
    if (this.paused || this.disposed || !this.host) return false;
    return this.renderInvalidated
      || this.hasContinuousAnimation()
      || this.layers.some(layer =>
        layer.videoFrames?.needsFrame() === true
        || layer.videoFrames?.requiresPolling() === true
      );
  }

  needsPointerUpdates(): boolean {
    return !this.disposed && !this.paused && Boolean(this.host)
      && this.layers.some(layer => layer.source.parallax !== 0);
  }

  updatePointer(x: number, y: number): void {
    const viewport = this.host?.viewport();
    if (!viewport) return;
    const nextX = x / Math.max(1, viewport.width) - 0.5;
    const nextY = y / Math.max(1, viewport.height) - 0.5;
    if (nextX === this.pointerX && nextY === this.pointerY) return;
    this.pointerX = nextX;
    this.pointerY = nextY;
    if (this.layers.some(layer => layer.source.parallax !== 0)) this.renderInvalidated = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const layer of this.layers) {
      layer.video?.pause();
      layer.videoFrames?.dispose();
      layer.particle?.dispose();
      layer.web?.remove();
      if (layer.mesh) {
        layer.mesh.geometry.dispose();
        layer.mesh.material.dispose();
      }
    }
    this.layers.length = 0;
    this.assets.dispose();
    this.host?.dispose();
    this.host = undefined;
    if (this.rootBackgroundApplied) this.root.style.backgroundColor = this.previousRootBackground;
  }

  private async createLayer(layer: RendererLayer, index: number): Promise<NativeLayerState> {
    if (layer.type === 'particle') {
      const sprite = layer.sourceUri ? await this.assets.texture(layer.sourceUri) : undefined;
      if (!layer.particle) throw new Error('粒子图层缺少 particle 设置。');
      const particle = new ParticleEmitter(layer.particle, sprite, hashString(layer.id));
      particle.object.renderOrder = index;
      return {
        source: layer,
        object: particle.object,
        particle,
        naturalWidth: 1,
        naturalHeight: 1
      };
    }
    if (layer.type === 'web') {
      if (!layer.sourceUri) throw new Error('Web 图层缺少入口。');
      const frame = document.createElement('iframe');
      frame.className = 'dwr-web-surface';
      const response = await fetch(layer.sourceUri, { credentials: 'omit', cache: 'no-cache' });
      if (!response.ok) throw new Error(`Web 图层入口读取失败：${response.status} ${response.statusText}`);
      const html = await response.text();
      frame.setAttribute(
        'sandbox',
        'allow-scripts allow-forms allow-modals allow-pointer-lock allow-downloads'
      );
      frame.setAttribute('allow', 'autoplay; fullscreen');
      frame.srcdoc = buildWebDocument(
        html,
        layer.sourceUri,
        this.configuration.runtime.networkHosts,
        targetFramesPerSecond(
          this.configuration.performance.profile,
          this.configuration.performance.maxFps
        ),
        this.paused
      );
      frame.addEventListener('load', () => {
        frame.contentWindow?.postMessage({ type: 'dwr-web-lifecycle', paused: this.paused }, '*');
      });
      frame.style.zIndex = String(index + 1);
      this.root.appendChild(frame);
      this.diagnostics.add({
        code: 'native-web-surface',
        severity: 'info',
        message: 'Web 图层在统一 runtime 的隔离网页表面中运行。',
        nodeId: layer.id
      });
      return {
        source: layer,
        object: new Object3D(),
        web: frame,
        naturalWidth: 1,
        naturalHeight: 1
      };
    }

    let texture: Texture | VideoTexture | undefined;
    let video: HTMLVideoElement | undefined;
    let videoFrames: VideoFrameGate | undefined;
    let naturalWidth = 1;
    let naturalHeight = 1;
    if (layer.type === 'image') {
      if (!layer.sourceUri) throw new Error('图片图层缺少 source。');
      texture = await this.assets.texture(layer.sourceUri);
      const image = texture.image as { width?: number; height?: number } | undefined;
      naturalWidth = image?.width ?? 1;
      naturalHeight = image?.height ?? 1;
    } else if (layer.type === 'video') {
      if (!layer.sourceUri) throw new Error('视频图层缺少 source。');
      const loaded = this.assets.video(layer.sourceUri, layer.muted, layer.playbackRate);
      texture = loaded.texture;
      video = loaded.element;
      videoFrames = loaded.frames;
      try {
        await waitForVideoMetadata(video);
      } catch (error) {
        this.assets.releaseVideo(video);
        throw error;
      }
      naturalWidth = video.videoWidth || 1;
      naturalHeight = video.videoHeight || 1;
    }
    const material = createLayerMaterial(layer, texture);
    const mesh = new Mesh(new PlaneGeometry(1, 1), material);
    mesh.renderOrder = index;
    mesh.frustumCulled = false;
    return { source: layer, object: mesh, mesh, video, videoFrames, naturalWidth, naturalHeight };
  }

  private layoutLayers(width: number, height: number): void {
    for (const state of this.layers) {
      if (!state.mesh) continue;
      const layout = state.source.layout;
      const box = layout
        ? {
            x: -width / 2 + width * (layout.left + layout.width / 2) / 100,
            y: height / 2 - height * (layout.top + layout.height / 2) / 100,
            width: width * layout.width / 100,
            height: height * layout.height / 100
          }
        : { x: 0, y: 0, width, height };
      const fitted = fitSize(
        state.naturalWidth,
        state.naturalHeight,
        box.width,
        box.height,
        state.source.fit
      );
      state.mesh.position.set(box.x, box.y, 0);
      state.mesh.scale.set(fitted.width * state.source.scale, fitted.height * state.source.scale, 1);
      state.mesh.rotation.z = -state.source.rotate * Math.PI / 180;
    }
  }

  private applyMotion(state: NativeLayerState, timeSeconds: number): void {
    if (!state.mesh) return;
    const gradientDuration = state.source.type === 'gradient'
      ? state.source.animationDuration ?? 0
      : 0;
    if (gradientDuration > 0) {
      state.mesh.material.uniforms.uGradientPhase.value = gradientPhaseRadians(
        timeSeconds,
        gradientDuration
      );
    }
    const motion = state.source.motion;
    if (motion.intensity === 0 && state.source.parallax === 0) return;
    const phase = ((timeSeconds + motion.delay) / Math.max(0.001, motion.duration)) * Math.PI * 2;
    const wave = Math.sin(phase) * motion.intensity;
    const parallaxX = this.pointerX * state.source.parallax;
    const parallaxY = -this.pointerY * state.source.parallax;
    state.mesh.material.uniforms.uMotionOffset.value.set(
      parallaxX + (motion.type === 'drift' || motion.type === 'shake' ? wave : 0),
      parallaxY + (
        motion.type === 'sway' || motion.type === 'water'
        || motion.type === 'float' || motion.type === 'shake'
          ? wave
          : 0
      )
    );
    state.mesh.material.uniforms.uMotionScale.value = motion.type === 'pulse'
      ? 1 + (Math.sin(phase) * 0.5 + 0.5) * motion.intensity / 500
      : 1;
  }

  private hasContinuousAnimation(): boolean {
    if (this.configuration.effects.grain > 0) return true;
    return this.layers.some(layer =>
      Boolean(layer.particle)
      || (layer.source.type === 'gradient' && (layer.source.animationDuration ?? 0) > 0)
      || (layer.source.motion.type !== 'none' && layer.source.motion.intensity !== 0)
    );
  }

  private hasConfiguredEffects(): boolean {
    const effects = this.configuration.effects;
    return effects.overlayOpacity > 0
      || effects.vignette > 0
      || effects.grain > 0
      || effects.scanlines > 0;
  }

  private invalidateRender(): void {
    if (this.disposed) return;
    this.renderInvalidated = true;
    this.onFrameRequested();
  }
}

function createLayerMaterial(layer: RendererLayer, texture?: Texture): ShaderMaterial {
  const material = new ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uTexture: { value: texture ?? null },
      uHasTexture: { value: texture ? 1 : 0 },
      uOpacity: { value: layer.opacity },
      uBrightness: { value: layer.filters.brightness },
      uContrast: { value: layer.filters.contrast },
      uSaturation: { value: layer.filters.saturation },
      uGrayscale: { value: layer.filters.grayscale },
      uHue: { value: layer.filters.hueRotate * Math.PI / 180 },
      uMotionOffset: { value: new Vector2() },
      uMotionScale: { value: 1 },
      uGradientA: { value: new Color(layer.colors?.[0] ?? '#000000') },
      uGradientB: { value: new Color(layer.colors?.[1] ?? '#ffffff') },
      uGradientAngle: { value: (layer.angle ?? 135) * Math.PI / 180 },
      uGradientPhase: { value: 0 }
    },
    vertexShader: `
      uniform vec2 uMotionOffset;
      uniform float uMotionScale;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec3 transformed = position;
        transformed.xy = transformed.xy * uMotionScale + uMotionOffset;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uTexture;
      uniform int uHasTexture;
      uniform float uOpacity;
      uniform float uBrightness;
      uniform float uContrast;
      uniform float uSaturation;
      uniform float uGrayscale;
      uniform float uHue;
      uniform vec3 uGradientA;
      uniform vec3 uGradientB;
      uniform float uGradientAngle;
      uniform float uGradientPhase;
      varying vec2 vUv;
      vec3 hueRotate(vec3 color, float angle) {
        const mat3 toYiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
        const mat3 toRgb = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
        vec3 yiq = toYiq * color;
        float hue = atan(yiq.z, yiq.y) + angle;
        float chroma = length(yiq.yz);
        return toRgb * vec3(yiq.x, chroma * cos(hue), chroma * sin(hue));
      }
      void main() {
        vec4 color;
        if (uHasTexture == 1) {
          color = texture2D(uTexture, vUv);
        } else {
          vec2 direction = vec2(
            cos(uGradientAngle + uGradientPhase),
            sin(uGradientAngle + uGradientPhase)
          );
          float amount = dot(vUv - 0.5, direction) + 0.5;
          color = vec4(mix(uGradientA, uGradientB, clamp(amount, 0.0, 1.0)), 1.0);
        }
        color.rgb *= uBrightness;
        color.rgb = (color.rgb - 0.5) * uContrast + 0.5;
        float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
        color.rgb = mix(vec3(luminance), color.rgb, uSaturation);
        color.rgb = mix(color.rgb, vec3(luminance), uGrayscale);
        color.rgb = hueRotate(color.rgb, uHue);
        color.a *= uOpacity;
        gl_FragColor = color;
      }
    `
  });
  applyLayerBlend(material, layer.blendMode);
  return material;
}

function applyLayerBlend(material: ShaderMaterial, blendMode: string): void {
  if (blendMode === 'normal') material.blending = NormalBlending;
  else if (blendMode === 'screen') {
    material.blending = CustomBlending;
    material.blendSrc = OneFactor;
    material.blendDst = OneMinusSrcAlphaFactor;
  } else if (blendMode === 'multiply') {
    material.blending = CustomBlending;
    material.blendSrc = DstColorFactor;
    material.blendDst = ZeroFactor;
  } else if (blendMode === 'color-dodge' || blendMode === 'lighten') {
    material.blending = AdditiveBlending;
  } else {
    material.blending = CustomBlending;
    material.blendSrc = SrcAlphaFactor;
    material.blendDst = OneMinusSrcAlphaFactor;
  }
}

function fitSize(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  fit: RendererLayer['fit']
): { width: number; height: number } {
  if (fit === 'fill') return { width: targetWidth, height: targetHeight };
  if (fit === 'none') return { width: sourceWidth, height: sourceHeight };
  const containScale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const scale = fit === 'cover'
    ? Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
    : fit === 'scale-down'
      ? Math.min(1, containScale)
      : containScale;
  return { width: sourceWidth * scale, height: sourceHeight * scale };
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error('视频元数据读取超时。')), 10_000);
    const onLoaded = (): void => finish();
    const onError = (): void => finish(new Error('视频元数据读取失败。'));
    const finish = (error?: Error): void => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function gradientPhaseRadians(timeSeconds: number, durationSeconds: number): number {
  if (!Number.isFinite(timeSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const phase = ((timeSeconds % durationSeconds) + durationSeconds) % durationSeconds;
  return phase / durationSeconds * Math.PI * 2;
}
