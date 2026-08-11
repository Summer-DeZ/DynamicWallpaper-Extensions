import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import {
  loadRuntimeState,
  prepareRuntimeStateBridge,
  updateRuntimeState,
  type PersistentRuntimeState
} from '../../src/application/runtimeState';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe('runtime state bridge', () => {
  it('serializes concurrent updates without losing properties or reusing a revision', async () => {
    const directory = await createTemporaryDirectory('dwr-runtime-state-');
    const context = createContext(directory, 2);
    const projectFile = path.join(directory, 'wallpaper.json');

    const results = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      updateRuntimeState(context as never, projectFile, state => ({
        ...state,
        userProperties: { ...state.userProperties, [`property-${index}`]: index }
      }))
    ));

    const state = await loadRuntimeState(context as never, projectFile);
    expect(Object.keys(state.userProperties)).toHaveLength(24);
    expect(state.userProperties['property-0']).toBe(0);
    expect(state.userProperties['property-23']).toBe(23);
    expect(new Set(results.map(result => result.revision))).toHaveLength(24);

    const bridge = await prepareRuntimeStateBridge(context as never, projectFile);
    const persisted = JSON.parse(await fs.readFile(uriToPath(bridge.uri), 'utf8')) as PersistentRuntimeState;
    expect(persisted.userProperties).toEqual(state.userProperties);
  });

  it('coordinates independent extension-host module instances through the file lock', async () => {
    const directory = await createTemporaryDirectory('dwr-runtime-processes-');
    const firstContext = createContext(directory, 3);
    const secondContext = createContext(directory, 1);
    const projectFile = path.join(directory, 'wallpaper.json');
    const firstModule = await import('../../src/application/runtimeState');
    vi.resetModules();
    const secondModule = await import('../../src/application/runtimeState');

    const firstUpdates = Array.from({ length: 12 }, (_, index) =>
      firstModule.updateRuntimeState(firstContext as never, projectFile, state => ({
        ...state,
        userProperties: { ...state.userProperties, [`first-${index}`]: index }
      }))
    );
    const secondUpdates = Array.from({ length: 12 }, (_, index) =>
      secondModule.updateRuntimeState(secondContext as never, projectFile, state => ({
        ...state,
        userProperties: { ...state.userProperties, [`second-${index}`]: index }
      }))
    );
    const results = await Promise.all([...firstUpdates, ...secondUpdates]);

    const state = await firstModule.loadRuntimeState(firstContext as never, projectFile);
    expect(Object.keys(state.userProperties)).toHaveLength(24);
    expect(state.userProperties['first-11']).toBe(11);
    expect(state.userProperties['second-11']).toBe(11);
    expect(new Set(results.map(result => result.revision))).toHaveLength(24);
  });

  it('persists different projects under independent globalState keys', async () => {
    const directory = await createTemporaryDirectory('dwr-runtime-projects-');
    const context = createContext(directory, 5);
    const firstProject = path.join(directory, 'first', 'wallpaper.json');
    const secondProject = path.join(directory, 'second', 'wallpaper.json');

    await Promise.all([
      updateRuntimeState(context as never, firstProject, state => ({
        ...state,
        userProperties: { first: true }
      })),
      updateRuntimeState(context as never, secondProject, state => ({
        ...state,
        userProperties: { second: true }
      }))
    ]);

    await expect(loadRuntimeState(context as never, firstProject))
      .resolves.toMatchObject({ userProperties: { first: true } });
    await expect(loadRuntimeState(context as never, secondProject))
      .resolves.toMatchObject({ userProperties: { second: true } });
    expect(context.keys().filter(key => key.startsWith('dynamicWallpaper.runtimeState.')))
      .toHaveLength(2);
    expect(context.keys()).not.toContain('dynamicWallpaper.runtimeStateByProject');
  });

  it('migrates a legacy shared-map value without changing its runtime revision', async () => {
    const directory = await createTemporaryDirectory('dwr-runtime-migrate-');
    const projectFile = path.join(directory, 'wallpaper.json');
    const key = projectKey(projectFile);
    const legacy: PersistentRuntimeState = {
      formatVersion: 1,
      revision: 42,
      userProperties: { migrated: true },
      networkHosts: ['example.com'],
      diagnosticsVisible: true
    };
    const context = createContext(directory, 0, new Map([
      ['dynamicWallpaper.runtimeStateByProject', { [key]: legacy }]
    ]));

    const bridge = await prepareRuntimeStateBridge(context as never, projectFile);

    expect(bridge.state).toEqual(legacy);
    expect(context.value(`dynamicWallpaper.runtimeState.${key}`)).toEqual(legacy);
    await expect(fs.readFile(uriToPath(bridge.uri), 'utf8'))
      .resolves.toContain('"revision":42');
  });

  it('recovers a corrupt bridge from the latest per-project state', async () => {
    const directory = await createTemporaryDirectory('dwr-runtime-recover-');
    const context = createContext(directory, 0);
    const projectFile = path.join(directory, 'wallpaper.json');
    await updateRuntimeState(context as never, projectFile, state => ({
      ...state,
      userProperties: { recovered: 'yes' }
    }));
    const bridge = await prepareRuntimeStateBridge(context as never, projectFile);
    const bridgeFile = uriToPath(bridge.uri);
    await fs.writeFile(bridgeFile, '{"formatVersion":1,"revision":', 'utf8');

    const recovered = await loadRuntimeState(context as never, projectFile);

    expect(recovered.userProperties).toEqual({ recovered: 'yes' });
    const repaired = JSON.parse(await fs.readFile(bridgeFile, 'utf8')) as PersistentRuntimeState;
    expect(repaired).toEqual(recovered);
  });

  it('recovers an abandoned cross-process lock', async () => {
    const directory = await createTemporaryDirectory('dwr-runtime-lock-');
    const context = createContext(directory, 0);
    const projectFile = path.join(directory, 'wallpaper.json');
    const bridge = await prepareRuntimeStateBridge(context as never, projectFile);
    const lockFile = `${uriToPath(bridge.uri)}.lock`;
    await fs.writeFile(lockFile, JSON.stringify({
      createdAt: 0,
      pid: 2_147_483_647,
      token: randomUUID()
    }), 'utf8');

    await expect(updateRuntimeState(context as never, projectFile, state => ({
      ...state,
      diagnosticsVisible: true
    }))).resolves.toMatchObject({ diagnosticsVisible: true });
    await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

interface TestContext {
  globalStorageUri: { fsPath: string };
  globalState: {
    get<T>(key: string, fallback?: T): T;
    update(key: string, value: unknown): Promise<void>;
  };
  keys(): string[];
  value(key: string): unknown;
}

function createContext(
  directory: string,
  updateDelayMilliseconds: number,
  initialValues = new Map<string, unknown>()
): TestContext {
  const values = new Map(initialValues);
  return {
    globalStorageUri: { fsPath: directory },
    globalState: {
      get<T>(key: string, fallback?: T): T {
        return (values.has(key) ? values.get(key) : fallback) as T;
      },
      async update(key: string, value: unknown): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, updateDelayMilliseconds));
        values.set(key, structuredClone(value));
      }
    },
    keys: () => [...values.keys()],
    value: key => values.get(key)
  };
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function projectKey(projectFile: string): string {
  return createHash('sha256').update(path.resolve(projectFile).toLowerCase()).digest('hex').slice(0, 24);
}

function uriToPath(uri: string): string {
  const parsed = new URL(uri);
  return decodeURIComponent(parsed.pathname).replace(/^\/([a-z]):/i, '$1:');
}
