import { getQuickJS } from 'quickjs-emscripten';
import type { QuickJSContext, QuickJSRuntime } from 'quickjs-emscripten-core';
import type { JsonValue } from '../src/domain/runtime';
import { RuntimeDiagnostics } from './diagnostics';

export interface SceneScriptFrameState {
  time: number;
  delta: number;
  canvasSize: [number, number];
  pointer: [number, number];
  pointerDown: boolean;
  audioSpectrum16: number[];
  userProperties: Record<string, JsonValue>;
}

export interface SceneScriptCommand {
  target: string;
  action: string;
  args: JsonValue[];
}

export interface SceneScriptBatchBinding {
  id: string;
  value: JsonValue;
}

export class SceneScriptRuntime {
  private runtime?: QuickJSRuntime;
  private context?: QuickJSContext;
  private deadline = Number.POSITIVE_INFINITY;
  private readonly bindings = new Set<string>();

  constructor(private readonly diagnostics: RuntimeDiagnostics) {}

  async initialize(): Promise<void> {
    const module = await getQuickJS();
    this.runtime = module.newRuntime();
    this.runtime.setMemoryLimit(64 * 1024 * 1024);
    this.runtime.setMaxStackSize(1024 * 1024);
    this.runtime.setInterruptHandler(() => performance.now() > this.deadline);
    this.context = this.runtime.newContext();
    this.evaluate(BOOTSTRAP_SOURCE, 'scene-script-bootstrap.js', 100);
  }

  register(id: string, source: string, initialValue: JsonValue): void {
    const safeId = JSON.stringify(id);
    const transformed = transformSceneScript(source);
    const wrapper = `
      (() => {
        ${transformed}
        const binding = {
          init: typeof init === 'function' ? init : undefined,
          update: typeof update === 'function' ? update : undefined,
          scriptProperties: typeof scriptProperties !== 'undefined' ? scriptProperties : undefined
        };
        globalThis.__dwrBindings[${safeId}] = binding;
        if (binding.init) binding.init(${JSON.stringify(initialValue)});
      })();
    `;
    try {
      this.evaluate(wrapper, `scene-script:${id}`, 20);
      this.bindings.add(id);
    } catch (error) {
      this.diagnostics.add({
        code: 'scene-script-compile-failed',
        severity: 'error',
        message: `SceneScript 编译失败：${id}`,
        resource: id,
        details: error instanceof Error ? error.message : String(error)
      });
    }
  }

  update(id: string, currentValue: JsonValue, frame: SceneScriptFrameState): JsonValue {
    if (!this.bindings.has(id)) return currentValue;
    const source = `
      __dwrApplyFrame(${JSON.stringify(frame)});
      (() => {
        const binding = __dwrBindings[${JSON.stringify(id)}];
        return binding && binding.update ? binding.update(${JSON.stringify(currentValue)}) : ${JSON.stringify(currentValue)};
      })();
    `;
    try {
      return this.evaluate(source, `scene-script-update:${id}`, 4) as JsonValue;
    } catch (error) {
      this.bindings.delete(id);
      this.diagnostics.add({
        code: 'scene-script-runtime-failed',
        severity: 'error',
        message: `SceneScript 已隔离：${id}`,
        resource: id,
        details: error instanceof Error ? error.message : String(error)
      });
      return currentValue;
    }
  }

  updateBatch(
    bindings: readonly SceneScriptBatchBinding[],
    frame: SceneScriptFrameState
  ): Record<string, JsonValue> {
    if (bindings.length === 0) return {};
    const input = Object.fromEntries(bindings.map(binding => [binding.id, binding.value]));
    const source = `
      __dwrApplyFrame(${JSON.stringify(frame)});
      (() => {
        const input = ${JSON.stringify(input)};
        const values = Object.create(null);
        const failures = [];
        for (const id of Object.keys(input)) {
          const binding = __dwrBindings[id];
          if (!binding || !binding.update) {
            values[id] = input[id];
            continue;
          }
          try {
            values[id] = binding.update(input[id]);
          } catch (error) {
            values[id] = input[id];
            failures.push({ id, message: String(error && (error.stack || error.message) || error) });
          }
        }
        return { values, failures };
      })();
    `;
    try {
      const result = this.evaluate(source, 'scene-script-frame-batch', 12);
      if (!isRecord(result) || !isRecord(result.values)) return input;
      const failures = Array.isArray(result.failures) ? result.failures : [];
      for (const rawFailure of failures) {
        if (!isRecord(rawFailure) || typeof rawFailure.id !== 'string') continue;
        this.bindings.delete(rawFailure.id);
        this.diagnostics.add({
          code: 'scene-script-runtime-failed',
          severity: 'error',
          message: `SceneScript 已隔离：${rawFailure.id}`,
          resource: rawFailure.id,
          details: typeof rawFailure.message === 'string' ? rawFailure.message : undefined
        });
      }
      return Object.fromEntries(Object.entries(result.values).map(([id, value]) => [
        id,
        isJsonValue(value) ? value : input[id] ?? null
      ]));
    } catch (error) {
      this.diagnostics.add({
        code: 'scene-script-batch-failed',
        severity: 'error',
        message: 'SceneScript 帧批处理超时或执行失败；本帧保留上一状态。',
        details: error instanceof Error ? error.message : String(error)
      });
      return input;
    }
  }

  applyFrame(frame: SceneScriptFrameState): void {
    this.evaluate(`__dwrApplyFrame(${JSON.stringify(frame)});`, 'scene-script-frame', 4);
  }

  drainCommands(): SceneScriptCommand[] {
    const value = this.evaluate(`(() => { const value = __dwrCommands; __dwrCommands = []; return value; })();`, 'scene-script-commands', 4);
    return Array.isArray(value) ? value as SceneScriptCommand[] : [];
  }

  dispose(): void {
    this.context?.dispose();
    this.runtime?.dispose();
    this.context = undefined;
    this.runtime = undefined;
    this.bindings.clear();
  }

  private evaluate(source: string, filename: string, budgetMilliseconds: number): unknown {
    if (!this.context) throw new Error('SceneScript runtime 尚未初始化。');
    this.deadline = performance.now() + budgetMilliseconds;
    const result = this.context.evalCode(source, filename, { type: 'global' });
    try {
      if ('error' in result && result.error) {
        const dumped = this.context.dump(result.error);
        throw new Error(typeof dumped === 'string' ? dumped : JSON.stringify(dumped));
      }
      if (!('value' in result) || !result.value) {
        throw new Error('SceneScript 没有返回可读取的结果。');
      }
      return this.context.dump(result.value);
    } finally {
      if ('error' in result) result.error?.dispose();
      if ('value' in result) result.value?.dispose();
      this.deadline = Number.POSITIVE_INFINITY;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function transformSceneScript(source: string): string {
  return source
    .replace(/^\s*import[^;]+;?/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+(?=(?:async\s+)?function\b|class\b|(?:const|let|var)\b)/g, '');
}

const BOOTSTRAP_SOURCE = `
  'use strict';
  globalThis.__dwrBindings = Object.create(null);
  globalThis.__dwrCommands = [];
  globalThis.__dwrFrame = {
    time: 0,
    delta: 0,
    canvasSize: [1920, 1080],
    pointer: [0, 0],
    pointerDown: false,
    audioSpectrum16: new Array(16).fill(0),
    userProperties: Object.create(null)
  };

  class Vec2 {
    constructor(x = 0, y = 0) { this.x = x; this.y = y; }
    add(value) { return new Vec2(this.x + value.x, this.y + value.y); }
    subtract(value) { return new Vec2(this.x - value.x, this.y - value.y); }
    multiply(value) { return typeof value === 'number' ? new Vec2(this.x * value, this.y * value) : new Vec2(this.x * value.x, this.y * value.y); }
    length() { return Math.hypot(this.x, this.y); }
    normalized() { const length = this.length() || 1; return new Vec2(this.x / length, this.y / length); }
  }
  class Vec3 extends Vec2 {
    constructor(x = 0, y = 0, z = 0) { super(x, y); this.z = z; }
    add(value) { return new Vec3(this.x + value.x, this.y + value.y, this.z + value.z); }
    subtract(value) { return new Vec3(this.x - value.x, this.y - value.y, this.z - value.z); }
    multiply(value) { return typeof value === 'number' ? new Vec3(this.x * value, this.y * value, this.z * value) : new Vec3(this.x * value.x, this.y * value.y, this.z * value.z); }
    length() { return Math.hypot(this.x, this.y, this.z); }
    normalized() { const length = this.length() || 1; return new Vec3(this.x / length, this.y / length, this.z / length); }
  }
  class Vec4 extends Vec3 {
    constructor(x = 0, y = 0, z = 0, w = 0) { super(x, y, z); this.w = w; }
  }

  function createScriptProperties() {
    const values = Object.create(null);
    const builder = {
      addSlider(options) { values[options.name] = options.value; return builder; },
      addCheckbox(options) { values[options.name] = options.value; return builder; },
      addColor(options) { values[options.name] = options.value; return builder; },
      addCombo(options) { values[options.name] = options.value; return builder; },
      addText(options) { values[options.name] = options.value; return builder; },
      finish() { return values; }
    };
    return builder;
  }

  function layerProxy(name) {
    const command = (action, args) => __dwrCommands.push({ target: name, action, args });
    return {
      play() { command('play', []); },
      pause() { command('pause', []); },
      stop() { command('stop', []); },
      setVisibility(value) { command('setVisibility', [Boolean(value)]); },
      setOpacity(value) { command('setOpacity', [Number(value)]); },
      setTransform(value) { command('setTransform', [value]); },
      get name() { return name; }
    };
  }

  globalThis.engine = {
    AUDIO_RESOLUTION_16: 16,
    AUDIO_RESOLUTION_32: 32,
    AUDIO_RESOLUTION_64: 64,
    get frametime() { return __dwrFrame.delta; },
    get runtime() { return __dwrFrame.time; },
    get canvasSize() { return new Vec2(__dwrFrame.canvasSize[0], __dwrFrame.canvasSize[1]); },
    registerAudioBuffers(resolution) {
      const values = __dwrFrame.audioSpectrum16;
      const output = Array.from({ length: resolution }, (_, index) => values[Math.floor(index * values.length / resolution)] || 0);
      return { average: output, left: output.slice(), right: output.slice() };
    }
  };
  globalThis.input = {
    get cursorWorldPosition() { return new Vec3(__dwrFrame.pointer[0], __dwrFrame.pointer[1], 0); },
    get mouseLeftDown() { return __dwrFrame.pointerDown; }
  };
  globalThis.thisScene = { getLayer: layerProxy };
  globalThis.thisLayer = layerProxy('thisLayer');
  globalThis.thisObject = Object.create(null);

  globalThis.__dwrApplyFrame = function(frame) {
    __dwrFrame = frame;
    for (const binding of Object.values(__dwrBindings)) {
      if (!binding || !binding.scriptProperties) continue;
      for (const [name, value] of Object.entries(frame.userProperties)) {
        if (name in binding.scriptProperties) binding.scriptProperties[name] = value;
      }
    }
  };
`;
