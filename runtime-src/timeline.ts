export type TimelineMode = 'loop' | 'mirror' | 'single';

export interface TimelineKeyframe<T> {
  time: number;
  value: T;
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | [number, number, number, number];
}

export interface TimelineTrack<T> {
  id: string;
  duration: number;
  mode: TimelineMode;
  startPaused: boolean;
  keyframes: TimelineKeyframe<T>[];
}

interface TimelineState {
  time: number;
  playing: boolean;
  rate: number;
}

const sortedKeyframeCache = new WeakMap<object, readonly TimelineKeyframe<unknown>[]>();

export class TimelineEngine {
  private readonly states = new Map<string, TimelineState>();

  register<T>(track: TimelineTrack<T>): void {
    this.states.set(track.id, {
      time: 0,
      playing: !track.startPaused,
      rate: 1
    });
  }

  play(id: string): void {
    const state = this.states.get(id);
    if (state) state.playing = true;
  }

  pause(id: string): void {
    const state = this.states.get(id);
    if (state) state.playing = false;
  }

  stop(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    state.time = 0;
    state.playing = false;
  }

  setRate(id: string, rate: number): void {
    const state = this.states.get(id);
    if (state && Number.isFinite(rate)) state.rate = rate;
  }

  advance<T>(track: TimelineTrack<T>, deltaSeconds: number): T | undefined {
    let state = this.states.get(track.id);
    if (!state) {
      this.register(track);
      state = this.states.get(track.id);
    }
    if (!state || track.keyframes.length === 0) return undefined;
    if (state.playing) state.time += Math.max(0, deltaSeconds) * state.rate;
    const localTime = timelineLocalTime(state.time, track.duration, track.mode);
    if (track.mode === 'single' && state.time >= track.duration) state.playing = false;
    return sampleKeyframes(track.keyframes, localTime);
  }
}

export function timelineLocalTime(time: number, duration: number, mode: TimelineMode): number {
  const length = Math.max(0.000001, duration);
  if (mode === 'single') return Math.min(length, Math.max(0, time));
  if (mode === 'mirror') {
    const cycle = positiveModulo(time, length * 2);
    return cycle <= length ? cycle : length * 2 - cycle;
  }
  return positiveModulo(time, length);
}

export function sampleKeyframes<T>(
  keyframes: readonly TimelineKeyframe<T>[],
  time: number
): T {
  const sorted = sortedKeyframes(keyframes);
  if (time <= sorted[0].time) return cloneValue(sorted[0].value);
  if (time >= sorted[sorted.length - 1].time) return cloneValue(sorted[sorted.length - 1].value);
  for (let index = 1; index < sorted.length; index++) {
    const right = sorted[index];
    if (time > right.time) continue;
    const left = sorted[index - 1];
    const span = Math.max(0.000001, right.time - left.time);
    const progress = applyEasing((time - left.time) / span, right.easing ?? 'linear');
    return interpolateValue(left.value, right.value, progress);
  }
  return cloneValue(sorted[sorted.length - 1].value);
}

function sortedKeyframes<T>(
  keyframes: readonly TimelineKeyframe<T>[]
): readonly TimelineKeyframe<T>[] {
  const cached = sortedKeyframeCache.get(keyframes as object);
  if (cached) return cached as readonly TimelineKeyframe<T>[];
  let ordered = true;
  for (let index = 1; index < keyframes.length; index++) {
    if (keyframes[index - 1].time > keyframes[index].time) {
      ordered = false;
      break;
    }
  }
  const result = ordered
    ? keyframes
    : [...keyframes].sort((left, right) => left.time - right.time);
  sortedKeyframeCache.set(keyframes as object, result as readonly TimelineKeyframe<unknown>[]);
  return result;
}

function interpolateValue<T>(left: T, right: T, progress: number): T {
  if (typeof left === 'number' && typeof right === 'number') {
    return (left + (right - left) * progress) as T;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.map((value, index) => {
      const target = right[index] ?? value;
      return typeof value === 'number' && typeof target === 'number'
        ? value + (target - value) * progress
        : progress < 0.5 ? value : target;
    }) as T;
  }
  return cloneValue(progress < 0.5 ? left : right);
}

function applyEasing(
  progress: number,
  easing: NonNullable<TimelineKeyframe<unknown>['easing']>
): number {
  const value = Math.min(1, Math.max(0, progress));
  if (Array.isArray(easing)) return cubicBezier(value, ...easing);
  if (easing === 'ease-in') return value * value;
  if (easing === 'ease-out') return 1 - (1 - value) * (1 - value);
  if (easing === 'ease-in-out') {
    return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
  }
  return value;
}

function cubicBezier(time: number, x1: number, y1: number, x2: number, y2: number): number {
  let parameter = time;
  for (let iteration = 0; iteration < 6; iteration++) {
    const x = bezier(parameter, 0, x1, x2, 1) - time;
    const derivative = bezierDerivative(parameter, 0, x1, x2, 1);
    if (Math.abs(derivative) < 0.000001) break;
    parameter = Math.min(1, Math.max(0, parameter - x / derivative));
  }
  return bezier(parameter, 0, y1, y2, 1);
}

function bezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const inverse = 1 - t;
  return inverse ** 3 * p0
    + 3 * inverse ** 2 * t * p1
    + 3 * inverse * t ** 2 * p2
    + t ** 3 * p3;
}

function bezierDerivative(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const inverse = 1 - t;
  return 3 * inverse ** 2 * (p1 - p0)
    + 6 * inverse * t * (p2 - p1)
    + 3 * t ** 2 * (p3 - p2);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function cloneValue<T>(value: T): T {
  return Array.isArray(value) ? [...value] as T : value;
}
