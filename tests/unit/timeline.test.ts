import { describe, expect, it } from 'vitest';
import { sampleKeyframes, timelineLocalTime, TimelineEngine } from '../../runtime-src/timeline';

describe('TimelineEngine', () => {
  it('supports loop, mirror and single time modes', () => {
    expect(timelineLocalTime(2.5, 2, 'loop')).toBeCloseTo(0.5);
    expect(timelineLocalTime(2.5, 2, 'mirror')).toBeCloseTo(1.5);
    expect(timelineLocalTime(2.5, 2, 'single')).toBe(2);
  });

  it('interpolates numeric and vector keyframes deterministically', () => {
    expect(sampleKeyframes([{ time: 0, value: 0 }, { time: 1, value: 10 }], 0.25)).toBeCloseTo(2.5);
    expect(sampleKeyframes([{ time: 0, value: [0, 2] }, { time: 1, value: [4, 6] }], 0.5)).toEqual([2, 4]);
  });

  it('accepts unsorted keyframes without mutating the reusable track data', () => {
    const keyframes = Object.freeze([
      { time: 1, value: 10 },
      { time: 0, value: 0 }
    ]);
    expect(sampleKeyframes(keyframes, 0.25)).toBeCloseTo(2.5);
    expect(sampleKeyframes(keyframes, 0.75)).toBeCloseTo(7.5);
    expect(keyframes.map(frame => frame.time)).toEqual([1, 0]);
  });

  it('honors pause, play, rate and stop', () => {
    const engine = new TimelineEngine();
    const track = { id: 'opacity', duration: 1, mode: 'single' as const, startPaused: true, keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] };
    expect(engine.advance(track, 0.5)).toBe(0);
    engine.play(track.id);
    engine.setRate(track.id, 2);
    expect(engine.advance(track, 0.25)).toBeCloseTo(0.5);
    engine.stop(track.id);
    expect(engine.advance(track, 1)).toBe(0);
  });
});
