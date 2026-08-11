import type { RendererConfiguration } from './renderer';

export const RUNTIME_PROTOCOL_VERSION = 1 as const;
export const SCENE_RUNTIME_FORMAT_VERSION = 1 as const;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type CompatibilitySeverity = 'info' | 'warning' | 'error';

export interface CompatibilityDiagnostic {
  code: string;
  severity: CompatibilitySeverity;
  message: string;
  resource?: string;
  nodeId?: string | number;
  details?: string;
}

export interface RuntimeCompatibilityReport {
  formatVersion: 1;
  status: 'compatible' | 'partial' | 'incompatible';
  generatedAt: string;
  diagnostics: CompatibilityDiagnostic[];
}

export interface RuntimeResource {
  path: string;
  uri: string;
  kind:
    | 'json'
    | 'texture'
    | 'video'
    | 'audio'
    | 'font'
    | 'shader'
    | 'model'
    | 'binary'
    | 'web';
  sourcePath?: string;
}

export interface RuntimeUserPropertyOption {
  label: string;
  value: JsonValue;
}

export interface RuntimeUserProperty {
  id: string;
  type: 'bool' | 'slider' | 'combo' | 'color' | 'textinput' | 'text' | 'file' | 'scenetexture';
  label: string;
  value: JsonValue;
  order: number;
  condition?: string;
  minimum?: number;
  maximum?: number;
  step?: number;
  options?: RuntimeUserPropertyOption[];
}

export interface SceneRuntimeManifest {
  formatVersion: 1;
  kind: 'wallpaper-engine-scene';
  title: string;
  sourceVersion?: number;
  workshopId?: string;
  assetRootUri: string;
  scene: Record<string, JsonValue>;
  resources: RuntimeResource[];
  userProperties: RuntimeUserProperty[];
  compatibility: RuntimeCompatibilityReport;
}

export interface WebRuntimeManifest {
  formatVersion: 1;
  kind: 'wallpaper-engine-web';
  title: string;
  entryUri: string;
  userProperties: RuntimeUserProperty[];
  allowedNetworkHosts: string[];
  compatibility: RuntimeCompatibilityReport;
}

export interface VideoRuntimeManifest {
  formatVersion: 1;
  kind: 'wallpaper-engine-video';
  title: string;
  entryUri: string;
  compatibility: RuntimeCompatibilityReport;
}

export type WallpaperEngineRuntimeManifest =
  | SceneRuntimeManifest
  | WebRuntimeManifest
  | VideoRuntimeManifest;

export interface RuntimeInitMessage {
  channel: 'dynamic-wallpaper-runtime';
  protocolVersion: 1;
  type: 'initialize';
  configuration: RendererConfiguration;
  userProperties: Record<string, JsonValue>;
}

export interface RuntimeLifecycleMessage {
  channel: 'dynamic-wallpaper-runtime';
  protocolVersion: 1;
  type: 'lifecycle';
  paused: boolean;
  /** Optional for compatibility with hosts that predate focus-aware lifecycle messages. */
  focused?: boolean;
  /** Distinguishes an unfocused visible window from a hidden/minimized window. */
  visible?: boolean;
}

export interface RuntimePointerMessage {
  channel: 'dynamic-wallpaper-runtime';
  protocolVersion: 1;
  type: 'pointer';
  event: 'move' | 'down' | 'up' | 'leave';
  x: number;
  y: number;
  buttons: number;
}

export interface RuntimePropertyMessage {
  channel: 'dynamic-wallpaper-runtime';
  protocolVersion: 1;
  type: 'properties';
  values: Record<string, JsonValue>;
}

export interface RuntimeNetworkPolicyMessage {
  channel: 'dynamic-wallpaper-runtime';
  protocolVersion: 1;
  type: 'network-policy';
  allowedHosts: string[];
}

export type HostToRuntimeMessage =
  | RuntimeInitMessage
  | RuntimeLifecycleMessage
  | RuntimePointerMessage
  | RuntimePropertyMessage
  | RuntimeNetworkPolicyMessage;

export interface RuntimeReadyMessage {
  channel: 'dynamic-wallpaper-host';
  protocolVersion: 1;
  type: 'ready';
}

export interface RuntimeDiagnosticsMessage {
  channel: 'dynamic-wallpaper-host';
  protocolVersion: 1;
  type: 'diagnostics';
  diagnostics: CompatibilityDiagnostic[];
}

export interface RuntimeFatalMessage {
  channel: 'dynamic-wallpaper-host';
  protocolVersion: 1;
  type: 'fatal';
  message: string;
  details?: string;
}

export interface RuntimeNetworkRequestMessage {
  channel: 'dynamic-wallpaper-host';
  protocolVersion: 1;
  type: 'network-request';
  host: string;
}

export type RuntimeToHostMessage =
  | RuntimeReadyMessage
  | RuntimeDiagnosticsMessage
  | RuntimeFatalMessage
  | RuntimeNetworkRequestMessage;
