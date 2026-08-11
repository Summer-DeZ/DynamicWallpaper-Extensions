import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { toWorkbenchResourceUri } from '../platform/workbench/resourceUri';

export type RuntimePropertyValue = string | number | boolean | null;

export interface PersistentRuntimeState {
  formatVersion: 1;
  revision: number;
  userProperties: Record<string, RuntimePropertyValue>;
  networkHosts: string[];
  diagnosticsVisible: boolean;
}

const LEGACY_STATE_MAP_KEY = 'dynamicWallpaper.runtimeStateByProject';
const STATE_KEY_PREFIX = 'dynamicWallpaper.runtimeState.';
const LOCK_WAIT_TIMEOUT_MILLISECONDS = 10_000;
const MALFORMED_LOCK_STALE_MILLISECONDS = 3_000;
const LIVE_OWNER_LOCK_STALE_MILLISECONDS = 5 * 60_000;
const projectOperations = new Map<string, Promise<void>>();

interface StoredStateCandidate {
  priority: number;
  state: PersistentRuntimeState;
}

interface ResolvedState {
  found: boolean;
  perProjectState?: PersistentRuntimeState;
  primaryState?: PersistentRuntimeState;
  state: PersistentRuntimeState;
}

interface ProjectLock {
  handle: fs.FileHandle;
  lockFile: string;
  token: string;
}

export async function loadRuntimeState(
  context: vscode.ExtensionContext,
  projectFile: string
): Promise<PersistentRuntimeState> {
  return withProjectStateLock(context, projectFile, async (key, file) => {
    const resolved = await resolveStoredState(context, key, file);
    if (resolved.found) {
      // A bridge file is the cross-window source of truth. Repair a missing or
      // interrupted bridge and migrate the old shared-map entry on first use.
      if (!statesEqual(resolved.primaryState, resolved.state)) {
        await writeRuntimeStateFile(file, resolved.state);
      }
      if (!statesEqual(resolved.perProjectState, resolved.state)) {
        await context.globalState.update(stateStorageKey(key), resolved.state);
      }
    }
    return cloneState(resolved.state);
  });
}

export async function updateRuntimeState(
  context: vscode.ExtensionContext,
  projectFile: string,
  update: (state: PersistentRuntimeState) => PersistentRuntimeState
): Promise<PersistentRuntimeState> {
  return withProjectStateLock(context, projectFile, async (key, file) => {
    // Re-read the bridge while holding the inter-process lock. VS Code windows
    // have independent Memento caches, so globalState alone cannot make this
    // read-modify-write transaction safe.
    const current = (await resolveStoredState(context, key, file)).state;
    const next = normalizeState(update(cloneState(current)));
    next.revision = nextRevision(current.revision);

    // Commit the bridge first. If the Memento write is interrupted, another
    // window can still recover the committed value from globalStorage.
    await writeRuntimeStateFile(file, next);
    await context.globalState.update(stateStorageKey(key), next);
    return cloneState(next);
  });
}

export async function prepareRuntimeStateBridge(
  context: vscode.ExtensionContext,
  projectFile: string
): Promise<{ state: PersistentRuntimeState; uri: string }> {
  return withProjectStateLock(context, projectFile, async (key, file) => {
    const resolved = await resolveStoredState(context, key, file);
    const state = resolved.state;
    if (!statesEqual(resolved.primaryState, state)) {
      await writeRuntimeStateFile(file, state);
    }
    if (!statesEqual(resolved.perProjectState, state)) {
      await context.globalState.update(stateStorageKey(key), state);
    }
    return { state: cloneState(state), uri: toWorkbenchResourceUri(file) };
  });
}

async function withProjectStateLock<T>(
  context: vscode.ExtensionContext,
  projectFile: string,
  operation: (key: string, file: string) => Promise<T>
): Promise<T> {
  const key = projectKey(projectFile);
  return serializeProjectOperation(key, async () => {
    const directory = path.join(context.globalStorageUri.fsPath, 'runtime-state');
    const file = path.join(directory, `${key}.json`);
    await fs.mkdir(directory, { recursive: true });
    const lock = await acquireProjectLock(`${file}.lock`);
    try {
      return await operation(key, file);
    } finally {
      await releaseProjectLock(lock);
    }
  });
}

async function resolveStoredState(
  context: vscode.ExtensionContext,
  key: string,
  file: string
): Promise<ResolvedState> {
  const primaryState = await readRuntimeStateFile(file);
  const previousState = await readRuntimeStateFile(`${file}.previous`);
  const perProjectState = normalizeStoredState(
    context.globalState.get<unknown>(stateStorageKey(key))
  );
  const legacyMap = context.globalState.get<Record<string, unknown>>(LEGACY_STATE_MAP_KEY, {});
  const legacyState = normalizeStoredState(legacyMap?.[key]);
  const candidates: StoredStateCandidate[] = [];

  // For equal revisions prefer the bridge: old releases wrote globalState
  // before the bridge, making the latter the final stage of their commit.
  addCandidate(candidates, legacyState, 1);
  addCandidate(candidates, perProjectState, 2);
  addCandidate(candidates, previousState, 3);
  addCandidate(candidates, primaryState, 4);
  candidates.sort((left, right) =>
    right.state.revision - left.state.revision || right.priority - left.priority
  );

  return {
    found: candidates.length > 0,
    perProjectState,
    primaryState,
    state: candidates[0]?.state ?? normalizeState(undefined)
  };
}

function addCandidate(
  candidates: StoredStateCandidate[],
  state: PersistentRuntimeState | undefined,
  priority: number
): void {
  if (state) {
    candidates.push({ priority, state });
  }
}

async function readRuntimeStateFile(file: string): Promise<PersistentRuntimeState | undefined> {
  try {
    return normalizeStoredState(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (isNodeError(error) && error.code !== 'ENOENT') {
      // A truncated/corrupt primary is recovered from .previous or Memento by
      // the caller while the project lock is held.
      return undefined;
    }
    return undefined;
  }
}

async function writeRuntimeStateFile(file: string, state: PersistentRuntimeState): Promise<void> {
  const payload = `${JSON.stringify(state)}\n`;
  let currentPayload: string | undefined;
  let currentState: PersistentRuntimeState | undefined;
  try {
    currentPayload = await fs.readFile(file, 'utf8');
    currentState = normalizeStoredState(JSON.parse(currentPayload));
  } catch {
    currentPayload = undefined;
    currentState = undefined;
  }

  if (currentState && !statesEqual(currentState, state) && currentPayload) {
    // Keep the last valid generation so an interrupted replacement is
    // recoverable even when Memento storage is unavailable.
    await atomicWriteFile(`${file}.previous`, currentPayload);
  }
  if (!currentState || !statesEqual(currentState, state)) {
    await atomicWriteFile(file, payload);
  }
}

async function atomicWriteFile(file: string, contents: string): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await fs.rename(temporary, file);
    } catch {
      // Windows can reject replacement-by-rename while the renderer is
      // fetching the old file. The project lock keeps extension-host writers
      // serialized; the renderer retries a transient partial fetch.
      await fs.copyFile(temporary, file);
      await fs.unlink(temporary).catch(() => undefined);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function acquireProjectLock(lockFile: string): Promise<ProjectLock> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MILLISECONDS;
  let missingLockPermissionAttempts = 0;
  while (true) {
    const token = randomUUID();
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(lockFile, 'wx');
      await handle.writeFile(JSON.stringify({ createdAt: Date.now(), pid: process.pid, token }), 'utf8');
      await handle.sync();
      return { handle, lockFile, token };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        await fs.unlink(lockFile).catch(() => undefined);
        throw error;
      }
      if (!isLockContentionError(error)) {
        throw error;
      }
      // Windows may report EPERM/EACCES instead of EEXIST for an occupied
      // lock. If there is no lock file to wait on, however, this is a real
      // storage permission failure and retrying forever would hang startup.
      if (isNodeError(error) && (error.code === 'EPERM' || error.code === 'EACCES')) {
        const lockExists = await fs.stat(lockFile).then(() => true, statError => {
          if (isNodeError(statError) && statError.code === 'ENOENT') return false;
          throw statError;
        });
        if (!lockExists) {
          // An owner can close/unlink between open() failing with EPERM and
          // this stat on Windows. Retry that short race, but surface a real
          // directory permission failure promptly instead of looping forever.
          missingLockPermissionAttempts += 1;
          if (missingLockPermissionAttempts >= 20 || Date.now() >= deadline) throw error;
          await delay(10);
          continue;
        }
      }
      missingLockPermissionAttempts = 0;
      if (await removeAbandonedLock(lockFile)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for runtime-state lock: ${path.basename(lockFile)}`);
      }
      await delay(10 + Math.floor(Math.random() * 16));
    }
  }
}

function isLockContentionError(error: unknown): boolean {
  if (!isNodeError(error)) {
    return false;
  }
  if (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES') {
    return true;
  }
  return false;
}

async function removeAbandonedLock(lockFile: string): Promise<boolean> {
  try {
    const [contents, stats] = await Promise.all([
      fs.readFile(lockFile, 'utf8'),
      fs.stat(lockFile)
    ]);
    const metadata = parseLockMetadata(contents);
    const age = Math.max(0, Date.now() - stats.mtimeMs);
    const abandoned = metadata
      ? !isProcessRunning(metadata.pid) || age >= LIVE_OWNER_LOCK_STALE_MILLISECONDS
      : age >= MALFORMED_LOCK_STALE_MILLISECONDS;
    if (!abandoned) {
      return false;
    }

    // Re-read the token immediately before moving the lock so a normal owner
    // release is unlikely to make us remove a successor's lock.
    if (metadata) {
      const current = parseLockMetadata(await fs.readFile(lockFile, 'utf8'));
      if (!current || current.token !== metadata.token) {
        return false;
      }
    }
    const abandonedFile = `${lockFile}.abandoned-${process.pid}-${randomUUID()}`;
    await fs.rename(lockFile, abandonedFile);
    await fs.unlink(abandonedFile).catch(() => undefined);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === 'ENOENT';
  }
}

function parseLockMetadata(value: string): { pid: number; token: string } | undefined {
  try {
    const parsed = JSON.parse(value) as { pid?: unknown; token?: unknown };
    if (Number.isInteger(parsed.pid) && (parsed.pid as number) > 0 && typeof parsed.token === 'string') {
      return { pid: parsed.pid as number, token: parsed.token };
    }
  } catch {
    // A newly-created lock can be observed before its metadata write finishes.
  }
  return undefined;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ESRCH');
  }
}

async function releaseProjectLock(lock: ProjectLock): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  try {
    const metadata = parseLockMetadata(await fs.readFile(lock.lockFile, 'utf8'));
    if (metadata?.token === lock.token) {
      await fs.unlink(lock.lockFile);
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function serializeProjectOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectOperations.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const completion = result.then(() => undefined, () => undefined);
  projectOperations.set(key, completion);
  try {
    return await result;
  } finally {
    if (projectOperations.get(key) === completion) {
      projectOperations.delete(key);
    }
  }
}

function stateStorageKey(key: string): string {
  return `${STATE_KEY_PREFIX}${key}`;
}

function projectKey(projectFile: string): string {
  return createHash('sha256').update(path.resolve(projectFile).toLowerCase()).digest('hex').slice(0, 24);
}

function nextRevision(previous: number): number {
  if (previous >= Number.MAX_SAFE_INTEGER) {
    return 0;
  }
  return Math.max(Date.now(), previous + 1);
}

function normalizeStoredState(value: unknown): PersistentRuntimeState | undefined {
  return value && typeof value === 'object' ? normalizeState(value) : undefined;
}

function normalizeState(value: unknown): PersistentRuntimeState {
  const source = value && typeof value === 'object' ? value as Partial<PersistentRuntimeState> : {};
  const properties = source.userProperties && typeof source.userProperties === 'object'
    ? Object.fromEntries(Object.entries(source.userProperties).filter((entry): entry is [string, RuntimePropertyValue] =>
      entry[1] === null || ['string', 'number', 'boolean'].includes(typeof entry[1])
    ))
    : {};
  const networkHosts = Array.isArray(source.networkHosts)
    ? [...new Set(source.networkHosts.filter(host => typeof host === 'string').map(host => host.toLowerCase()).filter(isValidHost))].sort()
    : [];
  return {
    formatVersion: 1,
    revision: typeof source.revision === 'number' && Number.isSafeInteger(source.revision) && source.revision >= 0
      ? source.revision
      : 0,
    userProperties: properties,
    networkHosts,
    diagnosticsVisible: source.diagnosticsVisible === true
  };
}

function cloneState(state: PersistentRuntimeState): PersistentRuntimeState {
  return {
    ...state,
    userProperties: { ...state.userProperties },
    networkHosts: [...state.networkHosts]
  };
}

function statesEqual(
  left: PersistentRuntimeState | undefined,
  right: PersistentRuntimeState
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function isValidHost(host: string): boolean {
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host);
}
