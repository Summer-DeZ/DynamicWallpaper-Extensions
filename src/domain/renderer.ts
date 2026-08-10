export type RendererLayerType = 'video' | 'image' | 'web' | 'gradient';

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
  performance: RendererPerformance;
  layers: RendererLayer[];
  effects: RendererEffects;
}
