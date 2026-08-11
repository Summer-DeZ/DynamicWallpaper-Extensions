import type { RendererPerformance } from '../src/domain/renderer';

export function targetFramesPerSecond(
  profile: RendererPerformance['profile'],
  maximumFps = 60
): number {
  const profileLimit = profile === 'economy' ? 30 : profile === 'balanced' ? 45 : 60;
  return Math.min(profileLimit, Math.max(15, Math.min(60, Math.round(maximumFps))));
}

export function frameIntervalMilliseconds(
  profile: RendererPerformance['profile'],
  maximumFps = 60
): number {
  return 1000 / targetFramesPerSecond(profile, maximumFps);
}

export function runtimeStatePollIntervalMilliseconds(
  unchangedPolls: number,
  paused: boolean
): number {
  if (paused) return 3_000;
  const backoffStep = Math.min(3, Math.max(0, Math.floor(unchangedPolls)));
  return 750 * (backoffStep + 1);
}
