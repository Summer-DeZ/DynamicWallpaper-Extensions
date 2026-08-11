export interface RuntimeLifecycleParticipant {
  setPaused(paused: boolean): void;
  resize(width: number, height: number, pixelRatio: number): void;
  update(timeSeconds: number, deltaSeconds: number): void;
  dispose(): void;
  needsFrameUpdates?(): boolean;
  needsPointerUpdates?(): boolean;
  updateProperties?(values: Record<string, unknown>): void;
  updatePointer?(x: number, y: number, buttons: number): void;
  updateNetworkPolicy?(allowedHosts: string[]): void;
}
