export type SceneVector3 = [number, number, number];

/**
 * Wallpaper Engine stores root origins in scene coordinates, whose center is
 * (width / 2, height / 2). Child origins are already local to their parent.
 * Applying the scene-center offset to children a second time moves an entire
 * nested layer by half a canvas in both axes.
 */
export function originToLocalPosition(
  origin: readonly number[],
  sceneWidth: number,
  sceneHeight: number,
  hasParent: boolean
): SceneVector3 {
  const x = origin[0] ?? 0;
  const y = origin[1] ?? 0;
  const z = origin[2] ?? 0;
  return hasParent
    ? [x, y, z]
    : [x - sceneWidth / 2, y - sceneHeight / 2, z];
}
