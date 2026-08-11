import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const PATCH_START = '<!-- dynamic-wallpaper-engine:start -->';
const PATCH_END = '<!-- dynamic-wallpaper-engine:end -->';
const OWNED_FILE = /^dynamicwallpaper\.inject(?:\.[a-f0-9]{12})?\.js$/;
const OWNED_DIRECTORY = /^dynamicwallpaper\.(?:web|runtime)\.[a-f0-9]{12}$/;
const WORKBENCH_LAYOUTS = [
  ['out', 'vs', 'code', 'electron-browser', 'workbench'],
  ['out', 'vs', 'code', 'electron-sandbox', 'workbench']
] as const;

export interface UninstallCleanupResult {
  workbenchDirectory: string;
  patchRemoved: boolean;
  removed: string[];
  errors: string[];
}

export function removeOwnedPatchBlock(html: string): { html: string; removed: boolean } {
  const start = html.indexOf(PATCH_START);
  if (start < 0) return { html, removed: false };
  const end = html.indexOf(PATCH_END, start);
  if (end < 0) return { html, removed: false };
  let before = html.slice(0, start);
  const after = html.slice(end + PATCH_END.length);
  if (before.endsWith('\r\n') && after.startsWith('\r\n')) before = before.slice(0, -2);
  else if (before.endsWith('\n') && after.startsWith('\n')) before = before.slice(0, -1);
  return { html: before + after, removed: true };
}

export async function discoverWorkbenchDirectories(
  environment: NodeJS.ProcessEnv = process.env,
  executable = process.execPath
): Promise<string[]> {
  const installRoots = new Set<string>();
  addRoot(installRoots, environment.LOCALAPPDATA, 'Programs', 'Microsoft VS Code');
  addRoot(installRoots, environment.LOCALAPPDATA, 'Programs', 'Microsoft VS Code Insiders');
  addRoot(installRoots, environment.ProgramFiles, 'Microsoft VS Code');
  addRoot(installRoots, environment['ProgramFiles(x86)'], 'Microsoft VS Code');
  if (environment.VSCODE_PORTABLE) installRoots.add(path.resolve(environment.VSCODE_PORTABLE));
  if (executable) installRoots.add(path.dirname(path.resolve(executable)));

  const appRoots = new Set<string>();
  for (const installRoot of installRoots) {
    await addAppRootIfPresent(appRoots, path.join(installRoot, 'resources', 'app'));
    let children: import('node:fs').Dirent[] = [];
    try { children = await fs.readdir(installRoot, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      await addAppRootIfPresent(appRoots, path.join(installRoot, child.name, 'resources', 'app'));
    }
  }

  const directories = new Set<string>();
  for (const appRoot of appRoots) {
    for (const layout of WORKBENCH_LAYOUTS) {
      const directory = path.join(appRoot, ...layout);
      if (await isFile(path.join(directory, 'workbench.html'))) directories.add(directory);
    }
  }
  return [...directories];
}

export async function cleanupWorkbenchDirectory(
  workbenchDirectory: string
): Promise<UninstallCleanupResult> {
  const directory = path.resolve(workbenchDirectory);
  const result: UninstallCleanupResult = {
    workbenchDirectory: directory,
    patchRemoved: false,
    removed: [],
    errors: []
  };
  const workbenchFile = path.join(directory, 'workbench.html');
  try {
    const original = await fs.readFile(workbenchFile, 'utf8');
    const cleaned = removeOwnedPatchBlock(original);
    if (cleaned.removed) {
      await fs.writeFile(workbenchFile, cleaned.html, 'utf8');
      result.patchRemoved = true;
    }
  } catch (error) {
    result.errors.push(`workbench.html: ${messageOf(error)}`);
  }

  let entries: import('node:fs').Dirent[] = [];
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) {
    result.errors.push(`scan: ${messageOf(error)}`);
    return result;
  }
  for (const entry of entries) {
    const isOwnedFile = entry.isFile()
      && (OWNED_FILE.test(entry.name) || entry.name === 'workbench.html.dynamicwallpaper.backup');
    const isOwnedDirectory = entry.isDirectory() && OWNED_DIRECTORY.test(entry.name);
    if (!isOwnedFile && !isOwnedDirectory) continue;
    const target = path.resolve(directory, entry.name);
    if (path.dirname(target) !== directory) {
      result.errors.push(`unsafe target rejected: ${target}`);
      continue;
    }
    try {
      if (isOwnedDirectory) await fs.rm(target, { recursive: true, force: true });
      else await fs.unlink(target);
      result.removed.push(target);
    } catch (error) {
      result.errors.push(`${entry.name}: ${messageOf(error)}`);
    }
  }
  return result;
}

function addRoot(roots: Set<string>, base: string | undefined, ...parts: string[]): void {
  if (base) roots.add(path.resolve(base, ...parts));
}

async function addAppRootIfPresent(roots: Set<string>, candidate: string): Promise<void> {
  if (await isFile(path.join(candidate, 'product.json'))) roots.add(path.resolve(candidate));
}

async function isFile(candidate: string): Promise<boolean> {
  try { return (await fs.stat(candidate)).isFile(); } catch { return false; }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
