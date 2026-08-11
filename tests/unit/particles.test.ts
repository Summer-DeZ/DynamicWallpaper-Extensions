import { describe, expect, it } from 'vitest';
import type { ParticleSettings } from '../../src/domain/renderer';
import { ParticleEmitter } from '../../runtime-src/particles';

describe('ParticleEmitter GPU updates', () => {
  it('caps fractional maxCount at the allocated capacity and uploads only active data', () => {
    const emitter = new ParticleEmitter(settings({ maxCount: 3.8, spawnRate: 100 }));
    emitter.update(0.1, 1920, 1080);

    const geometry = emitter.object.geometry;
    expect(geometry.drawRange.count).toBe(3);
    expect(geometry.getAttribute('position').updateRanges).toEqual([{ start: 0, count: 9 }]);
    expect(geometry.getAttribute('particleSize').updateRanges).toEqual([{ start: 0, count: 3 }]);
    emitter.dispose();
  });

  it('removes expired particles without drawing stale buffer entries', () => {
    const emitter = new ParticleEmitter(settings({
      maxCount: 4,
      spawnRate: 4,
      lifetimeMin: 0.05,
      lifetimeMax: 0.05
    }));
    emitter.update(0.25, 100, 100);
    expect(emitter.object.geometry.drawRange.count).toBe(0);
    emitter.dispose();
  });

  it('does not re-upload immutable color and size buffers for a stable population', () => {
    const emitter = new ParticleEmitter(settings({ maxCount: 3, spawnRate: 100 }));
    emitter.update(0.1, 1920, 1080);
    const geometry = emitter.object.geometry;
    const position = geometry.getAttribute('position');
    const opacity = geometry.getAttribute('particleOpacity');
    const color = geometry.getAttribute('particleColor');
    const size = geometry.getAttribute('particleSize');
    for (const attribute of [position, opacity, color, size]) attribute.clearUpdateRanges();
    const colorVersion = color.version;
    const sizeVersion = size.version;
    const positionVersion = position.version;

    emitter.update(0.01, 1920, 1080);

    expect(position.version).toBe(positionVersion + 1);
    expect(position.updateRanges).toEqual([{ start: 0, count: 9 }]);
    expect(opacity.updateRanges).toEqual([{ start: 0, count: 3 }]);
    expect(color.version).toBe(colorVersion);
    expect(color.updateRanges).toEqual([]);
    expect(size.version).toBe(sizeVersion);
    expect(size.updateRanges).toEqual([]);
    emitter.dispose();
  });

  it('does not dirty GPU buffers for a zero-delta redraw', () => {
    const emitter = new ParticleEmitter(settings({ maxCount: 2, spawnRate: 100 }));
    emitter.update(0.1, 100, 100);
    const attributes = Object.values(emitter.object.geometry.attributes);
    attributes.forEach(attribute => attribute.clearUpdateRanges());
    const versions = attributes.map(attribute => attribute.version);

    emitter.update(0, 100, 100);

    expect(attributes.map(attribute => attribute.version)).toEqual(versions);
    expect(attributes.every(attribute => attribute.updateRanges.length === 0)).toBe(true);
    emitter.dispose();
  });
});

function settings(overrides: Partial<ParticleSettings>): ParticleSettings {
  return {
    preset: 'ambient',
    emitterShape: 'viewport',
    emitterX: 0.5,
    emitterY: 0.5,
    emitterWidth: 100,
    emitterHeight: 100,
    maxCount: 10,
    spawnRate: 1,
    lifetimeMin: 5,
    lifetimeMax: 5,
    sizeMin: 1,
    sizeMax: 2,
    speedMin: 0,
    speedMax: 1,
    directionX: 0,
    directionY: 1,
    spread: 0,
    opacityMin: 1,
    opacityMax: 1,
    colors: ['#ffffff'],
    trail: false,
    turbulence: 0,
    ...overrides
  };
}
