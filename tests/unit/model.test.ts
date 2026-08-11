import { describe, expect, it } from 'vitest';
import { parseMdlContainer, PuppetMeshRuntime } from '../../runtime-src/model';

describe('MDLV container reader', () => {
  it('retains the complete binary and discovers referenced resources', () => {
    const payload = new TextEncoder().encode('MDLV0021\0materials/test.json\0textures/albedo.tex\0future-chunk-data');
    const model = parseMdlContainer(payload.buffer);
    expect(model.version).toBe(21);
    expect(model.byteLength).toBe(payload.byteLength);
    expect(model.referencedResources).toEqual(['materials/test.json', 'textures/albedo.tex']);
    expect(model.raw).toBe(payload.buffer);
  });

  it('rejects unknown containers without guessing', () => {
    const payload = new TextEncoder().encode('NOPE0021data');
    expect(() => parseMdlContainer(payload.buffer)).toThrow(/魔数/);
  });

  it('updates constrained puppet bones without per-frame target objects', () => {
    const definition = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      uvs: [0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
      boneIndices: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      boneWeights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      bones: [{
        name: 'root', parent: -1, position: [1, 0, 0] as [number, number, number],
        constraint: { type: 'spring' as const, stiffness: 10, damping: 0 }
      }]
    };
    const runtime = new PuppetMeshRuntime(definition);
    expect(runtime.hasActivePhysics()).toBe(true);
    runtime.mesh.skeleton.bones[0].position.x = 0;
    runtime.updatePhysics(0.1, definition.bones);
    expect(runtime.mesh.skeleton.bones[0].position.x).toBeGreaterThan(0);
    runtime.dispose();
  });

  it('does not request animation frames for a puppet without constraints', () => {
    const runtime = new PuppetMeshRuntime({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      uvs: [0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
      boneIndices: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      boneWeights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      bones: [{ name: 'root', parent: -1, position: [0, 0, 0] }]
    });
    expect(runtime.hasActivePhysics()).toBe(false);
    runtime.dispose();
  });
});
