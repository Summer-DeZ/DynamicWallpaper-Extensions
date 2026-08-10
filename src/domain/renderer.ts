export type RendererLayerType = 'video' | 'image' | 'web' | 'gradient' | 'particle';

export type LayerMotionType =
  | 'none'
  | 'sway'
  | 'water'
  | 'float'
  | 'pulse'
  | 'shake'
  | 'drift';

export interface LayerLayout {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LayerMotion {
  type: LayerMotionType;
  duration: number;
  intensity: number;
  delay: number;
}

export interface ParticleSettings {
  preset: 'ambient' | 'embers' | 'fog' | 'rain' | 'snow' | 'stars';
  emitterShape: 'viewport' | 'point' | 'box' | 'sphere';
  emitterX: number;
  emitterY: number;
  emitterWidth: number;
  emitterHeight: number;
  maxCount: number;
  spawnRate: number;
  lifetimeMin: number;
  lifetimeMax: number;
  sizeMin: number;
  sizeMax: number;
  speedMin: number;
  speedMax: number;
  directionX: number;
  directionY: number;
  spread: number;
  opacityMin: number;
  opacityMax: number;
  colors: string[];
  trail: boolean;
  turbulence: number;
}

export interface LayerFilters {
  blur: number;
  brightness: number;
  contrast: number;
  saturation: number;
  hueRotate: number;
  grayscale: number;
}

export interface RendererLayer {
  id: string;
  type: RendererLayerType;
  sourceUri?: string;
  sourcePath?: string;
  colors?: string[];
  angle?: number;
  animationDuration?: number;
  opacity: number;
  blendMode: string;
  fit: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
  position: string;
  scale: number;
  rotate: number;
  parallax: number;
  filters: LayerFilters;
  muted: boolean;
  playbackRate: number;
  layout?: LayerLayout;
  motion: LayerMotion;
  particle?: ParticleSettings;
}

export interface RendererEffects {
  overlayColor?: string;
  overlayOpacity: number;
  vignette: number;
  grain: number;
  scanlines: number;
}

export interface RendererPerformance {
  profile: 'quality' | 'balanced' | 'economy';
  suspendAfterSeconds: number;
}

export interface RendererConfiguration {
  renderLayer: 'front' | 'behind';
  surfaceOpacity: number;
  backgroundColor: string;
  pauseWhenUnfocused: boolean;
  opaqueEditorForMedia: boolean;
  sceneCanvas?: {
    width: number;
    height: number;
  };
  performance: RendererPerformance;
  layers: RendererLayer[];
  effects: RendererEffects;
}
