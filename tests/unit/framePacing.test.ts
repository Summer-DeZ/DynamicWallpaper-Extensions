import { describe, expect, it } from 'vitest';
import {
  frameIntervalMilliseconds,
  runtimeStatePollIntervalMilliseconds,
  targetFramesPerSecond
} from '../../runtime-src/framePacing';

describe('runtime frame pacing', () => {
  it('caps quality rendering at the 60 FPS release target', () => {
    expect(targetFramesPerSecond('quality')).toBe(60);
    expect(frameIntervalMilliseconds('quality')).toBeCloseTo(1000 / 60);
  });

  it('uses progressively lower rates for balanced and economy profiles', () => {
    expect(targetFramesPerSecond('balanced')).toBe(45);
    expect(targetFramesPerSecond('economy')).toBe(30);
  });

  it('honors a lower user frame-rate limit', () => {
    expect(targetFramesPerSecond('quality', 30)).toBe(30);
    expect(targetFramesPerSecond('balanced', 24)).toBe(24);
    expect(targetFramesPerSecond('quality', 5)).toBe(15);
  });

  it('backs off unchanged state polling and polls slowly while paused', () => {
    expect(runtimeStatePollIntervalMilliseconds(0, false)).toBe(750);
    expect(runtimeStatePollIntervalMilliseconds(1, false)).toBe(1_500);
    expect(runtimeStatePollIntervalMilliseconds(10, false)).toBe(3_000);
    expect(runtimeStatePollIntervalMilliseconds(0, true)).toBe(3_000);
  });
});
