import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { toWorkbenchResourceUri } from '../platform/workbench/resourceUri';

interface RuntimeProjectFile {
  version?: unknown;
  runtime?: { manifest?: unknown };
}

/** Rebinds importer-generated absolute resource URIs after copying a v2 project. */
export async function relocateRuntimeProject(
  copiedProjectDirectory: string,
  originalProjectDirectory: string,
  finalProjectDirectory: string
): Promise<number> {
  const copiedRoot = path.resolve(copiedProjectDirectory);
  const projectFile = path.join(copiedRoot, 'wallpaper.json');
  const project = JSON.parse(await fs.readFile(projectFile, 'utf8')) as RuntimeProjectFile;
  if (project.version !== 2) return 0;
  if (typeof project.runtime?.manifest !== 'string' || !project.runtime.manifest.trim()) {
    throw new Error('导出的 v2 壁纸工程缺少 runtime manifest。');
  }

  const manifestFile = path.resolve(copiedRoot, project.runtime.manifest);
  if (!isSameOrInside(manifestFile, copiedRoot)) {
    throw new Error('导出的 runtime manifest 路径越出了工程目录。');
  }
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as unknown;
  const sourceUri = toWorkbenchResourceUri(path.resolve(originalProjectDirectory));
  const destinationUri = toWorkbenchResourceUri(path.resolve(finalProjectDirectory));
  const rewrittenSuffixes: string[] = [];
  const relocated = relocateJsonValue(
    manifest,
    sourceUri,
    destinationUri,
    rewrittenSuffixes
  );

  const localUris = collectWorkbenchResourceUris(relocated);
  const comparableDestination = normalizeUriForComparison(destinationUri);
  for (const uri of localUris) {
    const comparableUri = normalizeUriForComparison(uri);
    if (comparableUri !== comparableDestination
      && !comparableUri.startsWith(`${comparableDestination}/`)) {
      throw new Error(`导出工程仍包含工程目录外的绝对资源 URI：${uri}`);
    }
  }

  for (const suffix of rewrittenSuffixes) {
    const localResource = path.resolve(copiedRoot, decodeUriSuffix(suffix));
    if (!isSameOrInside(localResource, copiedRoot)) {
      throw new Error(`导出资源路径越出了工程目录：${suffix}`);
    }
    await fs.stat(localResource).catch(() => {
      throw new Error(`导出资源不存在：${localResource}`);
    });
  }

  if (rewrittenSuffixes.length > 0) {
    await fs.writeFile(manifestFile, `${JSON.stringify(relocated, null, 2)}\n`, 'utf8');
  }
  return rewrittenSuffixes.length;
}

function collectWorkbenchResourceUris(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.startsWith('vscode-file://vscode-app/')) output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectWorkbenchResourceUris(item, output);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectWorkbenchResourceUris(item, output);
  }
  return output;
}

function normalizeUriForComparison(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function relocateJsonValue(
  value: unknown,
  sourceUri: string,
  destinationUri: string,
  rewrittenSuffixes: string[]
): unknown {
  if (typeof value === 'string') {
    const normalizedValue = process.platform === 'win32' ? value.toLowerCase() : value;
    const normalizedSource = process.platform === 'win32' ? sourceUri.toLowerCase() : sourceUri;
    if (normalizedValue === normalizedSource || normalizedValue.startsWith(`${normalizedSource}/`)) {
      const suffix = value.slice(sourceUri.length);
      rewrittenSuffixes.push(suffix);
      return `${destinationUri}${suffix}`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => relocateJsonValue(
      item,
      sourceUri,
      destinationUri,
      rewrittenSuffixes
    ));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      relocateJsonValue(item, sourceUri, destinationUri, rewrittenSuffixes)
    ]));
  }
  return value;
}

function decodeUriSuffix(suffix: string): string {
  return suffix
    .split('/')
    .filter(Boolean)
    .map(segment => decodeURIComponent(segment))
    .join(path.sep);
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
