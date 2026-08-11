import { describe, expect, it } from 'vitest';
import { gradientPhaseRadians } from '../../runtime-src/nativeRuntime';

describe('native gradient animation', () => {
  it('advances and wraps the gradient rotation over animationDuration', () => {
    expect(gradientPhaseRadians(0, 8)).toBe(0);
    expect(gradientPhaseRadians(2, 8)).toBeCloseTo(Math.PI / 2);
    expect(gradientPhaseRadians(10, 8)).toBeCloseTo(Math.PI / 2);
    expect(gradientPhaseRadians(4, 0)).toBe(0);
  });
});
