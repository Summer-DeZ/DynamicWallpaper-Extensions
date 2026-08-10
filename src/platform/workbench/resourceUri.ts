import * as path from 'node:path';

export function toWorkbenchResourceUri(filePath: string): string {
  const normalized = path.resolve(filePath).replace(/\\/g, '/');
  const encoded = normalized
    .split('/')
    .map((segment, index) => {
      if (index === 0 && /^[A-Za-z]:$/.test(segment)) {
        return `${segment[0].toLowerCase()}%3A`;
      }
      return encodeURIComponent(segment);
    })
    .join('/');

  return `vscode-file://vscode-app/${encoded}`;
}

export function sourceTypeFromPath(filePath: string): 'video' | 'image' | 'web' | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.html' || extension === '.htm') {
    return 'web';
  }
  if (['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.m4v'].includes(extension)) {
    return 'video';
  }
  if (
    ['.jpg', '.jpeg', '.png', '.apng', '.gif', '.webp', '.avif', '.bmp', '.svg'].includes(extension)
  ) {
    return 'image';
  }
  return undefined;
}
