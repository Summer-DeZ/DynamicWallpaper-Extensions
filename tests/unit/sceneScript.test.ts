import { describe, expect, it, vi } from 'vitest';
import { SceneScriptRuntime, transformSceneScript } from '../../runtime-src/sceneScript';
import type { RuntimeDiagnostics } from '../../runtime-src/diagnostics';

describe('SceneScript source transform', () => {
  it('removes module syntax while retaining API declarations', () => {
    const output = transformSceneScript(`import { Vec3 } from 'scene';\nexport function update(v) { return v + 1; }`);
    expect(output).not.toContain('import');
    expect(output).toContain('function update');
  });

  it('executes scripts in QuickJS with live property and frame bindings', async () => {
    const diagnostics = { add: vi.fn() } as unknown as RuntimeDiagnostics;
    const runtime = new SceneScriptRuntime(diagnostics);
    await runtime.initialize();
    runtime.register('layer:origin', `
      export const scriptProperties = createScriptProperties().addSlider({ name: 'speed', value: 1 }).finish();
      export function update(value) { return scriptProperties.speed + engine.frametime + value; }
    `, 2);
    const result = runtime.update('layer:origin', 2, {
      time: 1, delta: 0.25, canvasSize: [1920, 1080], pointer: [0, 0], pointerDown: false,
      audioSpectrum16: new Array(16).fill(0), userProperties: { speed: 5 }
    });
    expect(result).toBe(7.25);
    expect(diagnostics.add).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('updates multiple bindings in one QuickJS frame batch', async () => {
    const diagnostics = { add: vi.fn() } as unknown as RuntimeDiagnostics;
    const runtime = new SceneScriptRuntime(diagnostics);
    await runtime.initialize();
    runtime.register('a', 'export function update(value) { return value + engine.frametime; }', 1);
    runtime.register('b', 'export function update(value) { return value * 2; }', 3);
    const values = runtime.updateBatch([
      { id: 'a', value: 1 },
      { id: 'b', value: 3 }
    ], {
      time: 1,
      delta: 0.25,
      canvasSize: [1920, 1080],
      pointer: [0, 0],
      pointerDown: false,
      audioSpectrum16: new Array(16).fill(0),
      userProperties: {}
    });
    expect(values).toEqual({ a: 1.25, b: 6 });
    expect(diagnostics.add).not.toHaveBeenCalled();
    runtime.dispose();
  });
});
