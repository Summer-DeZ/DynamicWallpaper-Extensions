import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  LayerFilters,
  LayerLayout,
  LayerMotion,
  LayerMotionType,
  ParticleSettings,
  RendererConfiguration,
  RendererEffects,
  RendererLayer,
  RendererLayerType,
  RendererPerformance
} from '../domain/renderer';
import { sourceTypeFromPath, toWorkbenchResourceUri } from '../platform/workbench/resourceUri';

interface RawProject {
  version?: unknown;
  render?: unknown;
  performance?: unknown;
  layers?: unknown;
  effects?: unknown;
}

type JsonObject = Record<string, unknown>;

const SUPPORTED_BLEND_MODES = new Set([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity'
]);

const SUPPORTED_FIT = new Set(['cover', 'contain', 'fill', 'none', 'scale-down']);

export async function loadWallpaperProject(
  projectFile: string
): Promise<RendererConfiguration> {
  const rawText = await fs.readFile(projectFile, 'utf8');
  let raw: RawProject;
  try {
    raw = JSON.parse(stripBom(rawText)) as RawProject;
  } catch (error) {
    throw new Error(`壁纸工程 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }

  if (raw.version !== 1) {
    throw new Error('壁纸工程 version 必须为 1。');
  }
  if (!Array.isArray(raw.layers) || raw.layers.length === 0) {
    throw new Error('壁纸工程至少需要一个 layers 项。');
  }
  if (raw.layers.length > 64) {
    throw new Error('单个壁纸工程最多支持 64 个图层。');
  }

  const projectDirectory = path.dirname(path.resolve(projectFile));
  const render = asObject(raw.render);
  const performance = normalizePerformance(asObject(raw.performance));
  const effects = asObject(raw.effects);
  const layers = await Promise.all(
    raw.layers.map((layer, index) =>
      normalizeLayer(layer, index, projectDirectory, performance.profile)
    )
  );

  return {
    renderLayer: enumValue(render.layer, ['front', 'behind'], 'front') ?? 'front',
    surfaceOpacity: numberValue(render.surfaceOpacity, 0.72, 0, 1),
    backgroundColor: colorValue(render.backgroundColor, '#000000'),
    pauseWhenUnfocused: booleanValue(render.pauseWhenUnfocused, true),
    opaqueEditorForMedia: booleanValue(render.opaqueEditorForMedia, true),
    sceneCanvas: normalizeSceneCanvas(render.sceneCanvas),
    performance,
    layers,
    effects: normalizeEffects(effects)
  };
}

function normalizeSceneCanvas(value: unknown): { width: number; height: number } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const canvas = asObject(value);
  return {
    width: numberValue(canvas.width, 1920, 16, 8192),
    height: numberValue(canvas.height, 1080, 16, 8192)
  };
}

async function normalizeLayer(
  value: unknown,
  index: number,
  projectDirectory: string,
  profile: RendererPerformance['profile']
): Promise<RendererLayer> {
  const layer = asObject(value);
  const type = enumValue<RendererLayerType>(
    layer.type,
    ['video', 'image', 'web', 'gradient', 'particle'],
    undefined
  );
  if (!type) {
    throw new Error(`layers[${index}].type 必须为 video、image、web、gradient 或 particle。`);
  }

  let sourceUri: string | undefined;
  let sourcePathForStaging: string | undefined;
  let colors: string[] | undefined;
  if (type === 'gradient') {
    if (!Array.isArray(layer.colors) || layer.colors.length < 2) {
      throw new Error(`layers[${index}].colors 至少需要两个颜色。`);
    }
    colors = layer.colors.map((color, colorIndex) =>
      colorValue(color, undefined, `layers[${index}].colors[${colorIndex}]`)
    );
  } else if (type === 'particle') {
    if (typeof layer.source === 'string' && layer.source.trim()) {
      const sourcePath = path.isAbsolute(layer.source)
        ? path.normalize(layer.source)
        : path.resolve(projectDirectory, layer.source);
      if (sourceTypeFromPath(sourcePath) !== 'image') {
        throw new Error(`layers[${index}] 的粒子纹理不是支持的图片格式。`);
      }
      try {
        if (!(await fs.stat(sourcePath)).isFile()) {
          throw new Error('不是文件');
        }
      } catch {
        throw new Error(`layers[${index}] 的粒子纹理不存在：${sourcePath}`);
      }
      sourceUri = toWorkbenchResourceUri(sourcePath);
    }
  } else {
    const sources = asObject(layer.sources);
    const selectedSource = typeof sources[profile] === 'string'
      ? sources[profile]
      : typeof layer.source === 'string'
        ? layer.source
        : typeof sources.balanced === 'string'
          ? sources.balanced
          : typeof sources.quality === 'string'
            ? sources.quality
            : sources.economy;
    if (typeof selectedSource !== 'string' || !selectedSource.trim()) {
      throw new Error(`layers[${index}].source 不能为空。`);
    }
    const sourcePath = path.isAbsolute(selectedSource)
      ? path.normalize(selectedSource)
      : path.resolve(projectDirectory, selectedSource);
    const detectedType = sourceTypeFromPath(sourcePath);
    if (type === 'video' && detectedType !== 'video') {
      throw new Error(`layers[${index}] 的文件不是支持的视频格式。`);
    }
    if (type === 'image' && detectedType !== 'image') {
      throw new Error(`layers[${index}] 的文件不是支持的图片格式。`);
    }
    if (type === 'web' && detectedType !== 'web') {
      throw new Error(`layers[${index}] 的入口必须是 HTML 文件。`);
    }
    try {
      if (!(await fs.stat(sourcePath)).isFile()) {
        throw new Error('不是文件');
      }
    } catch {
      throw new Error(`layers[${index}] 的文件不存在：${sourcePath}`);
    }
    sourceUri = toWorkbenchResourceUri(sourcePath);
    if (type === 'web') {
      sourcePathForStaging = sourcePath;
    }
  }

  return {
    id: typeof layer.id === 'string' && layer.id.trim() ? layer.id.trim() : `layer-${index + 1}`,
    type,
    sourceUri,
    sourcePath: sourcePathForStaging,
    colors,
    angle: numberValue(layer.angle, 135, -360, 360),
    animationDuration: numberValue(layer.animationDuration, 20, 0, 3600),
    opacity: numberValue(layer.opacity, 1, 0, 1),
    blendMode: enumFromSet(layer.blendMode, SUPPORTED_BLEND_MODES, 'normal'),
    fit: enumFromSet(layer.fit, SUPPORTED_FIT, 'cover'),
    position: typeof layer.position === 'string' && layer.position.trim()
      ? layer.position.trim()
      : 'center',
    scale: numberValue(layer.scale, 1, 0.1, 10),
    rotate: numberValue(layer.rotate, 0, -360, 360),
    parallax: numberValue(layer.parallax, 0, -100, 100),
    filters: normalizeFilters(asObject(layer.filters)),
    muted: booleanValue(layer.muted, true),
    playbackRate: numberValue(layer.playbackRate, 1, 0.25, 4),
    layout: normalizeLayout(layer.layout),
    motion: normalizeMotion(layer.motion),
    particle: type === 'particle' ? normalizeParticle(layer.particle) : undefined
  };
}

function normalizeLayout(value: unknown): LayerLayout | undefined {
  if (value === undefined) {
    return undefined;
  }
  const layout = asObject(value);
  return {
    left: numberValue(layout.left, 0, -500, 500),
    top: numberValue(layout.top, 0, -500, 500),
    width: numberValue(layout.width, 100, 0.01, 1000),
    height: numberValue(layout.height, 100, 0.01, 1000)
  };
}

function normalizeMotion(value: unknown): LayerMotion {
  const motion = asObject(value);
  return {
    type: enumValue<LayerMotionType>(
      motion.type,
      ['none', 'sway', 'water', 'float', 'pulse', 'shake', 'drift'],
      'none'
    ) ?? 'none',
    duration: numberValue(motion.duration, 8, 0.25, 300),
    intensity: numberValue(motion.intensity, 3, 0, 100),
    delay: numberValue(motion.delay, 0, -300, 300)
  };
}

function normalizeParticle(value: unknown): ParticleSettings {
  const particle = asObject(value);
  const colors = Array.isArray(particle.colors)
    ? particle.colors.slice(0, 8).map((color, index) =>
      colorValue(color, '#ffffff', `particle.colors[${index}]`)
    )
    : ['#ffffff'];
  return {
    preset: enumValue(
      particle.preset,
      ['ambient', 'embers', 'fog', 'rain', 'snow', 'stars'],
      'ambient'
    ) ?? 'ambient',
    emitterShape: enumValue(
      particle.emitterShape,
      ['viewport', 'point', 'box', 'sphere'],
      'viewport'
    ) ?? 'viewport',
    emitterX: numberValue(particle.emitterX, 0.5, -5, 5),
    emitterY: numberValue(particle.emitterY, 0.5, -5, 5),
    emitterWidth: numberValue(particle.emitterWidth, 1920, 0, 16000),
    emitterHeight: numberValue(particle.emitterHeight, 1080, 0, 16000),
    maxCount: Math.round(numberValue(particle.maxCount, 64, 1, 2000)),
    spawnRate: numberValue(particle.spawnRate, 12, 0.1, 1000),
    lifetimeMin: numberValue(particle.lifetimeMin, 2, 0.1, 120),
    lifetimeMax: numberValue(particle.lifetimeMax, 5, 0.1, 120),
    sizeMin: numberValue(particle.sizeMin, 3, 0.1, 2000),
    sizeMax: numberValue(particle.sizeMax, 12, 0.1, 4000),
    speedMin: numberValue(particle.speedMin, 8, 0, 4000),
    speedMax: numberValue(particle.speedMax, 30, 0, 4000),
    directionX: numberValue(particle.directionX, 0, -10, 10),
    directionY: numberValue(particle.directionY, -1, -10, 10),
    spread: numberValue(particle.spread, 0.6, 0, Math.PI * 2),
    opacityMin: numberValue(particle.opacityMin, 0.2, 0, 1),
    opacityMax: numberValue(particle.opacityMax, 0.9, 0, 1),
    colors: colors.length > 0 ? colors : ['#ffffff'],
    trail: booleanValue(particle.trail, false),
    turbulence: numberValue(particle.turbulence, 0, 0, 1000)
  };
}

function normalizeFilters(filters: JsonObject): LayerFilters {
  return {
    blur: numberValue(filters.blur, 0, 0, 100),
    brightness: numberValue(filters.brightness, 1, 0, 4),
    contrast: numberValue(filters.contrast, 1, 0, 4),
    saturation: numberValue(filters.saturation, 1, 0, 4),
    hueRotate: numberValue(filters.hueRotate, 0, -360, 360),
    grayscale: numberValue(filters.grayscale, 0, 0, 1)
  };
}

function normalizeEffects(effects: JsonObject): RendererEffects {
  return {
    overlayColor: effects.overlayColor === undefined
      ? undefined
      : colorValue(effects.overlayColor, undefined, 'effects.overlayColor'),
    overlayOpacity: numberValue(effects.overlayOpacity, 0, 0, 1),
    vignette: numberValue(effects.vignette, 0, 0, 1),
    grain: numberValue(effects.grain, 0, 0, 1),
    scanlines: numberValue(effects.scanlines, 0, 0, 1)
  };
}

function normalizePerformance(performance: JsonObject): RendererPerformance {
  return {
    profile: enumValue(
      performance.profile,
      ['quality', 'balanced', 'economy'],
      'balanced'
    ) ?? 'balanced',
    suspendAfterSeconds: numberValue(performance.suspendAfterSeconds, 15, 0, 3600)
  };
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function numberValue(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T | undefined
): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

function enumFromSet<T extends string>(value: unknown, allowed: Set<string>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value) ? value as T : fallback;
}

function colorValue(value: unknown, fallback: string | undefined, field = '颜色'): string {
  if (
    typeof value === 'string'
    && (
      /^#[0-9a-f]{3,8}$/i.test(value)
      || /^rgba?\(\s*(?:\d{1,3}\s*,\s*){2}\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(value)
    )
  ) {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`${field} 不是支持的 CSS 颜色。`);
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
