import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyWorkbenchPatch,
  buildInjectionScript,
  removeWorkbenchPatch
} from '../../src/platform/workbench/workbenchPatch';
import type { RendererConfiguration } from '../../src/domain/renderer';

const configuration: RendererConfiguration = {
  runtime: { protocolVersion: 1, kind: 'native', networkHosts: [], userProperties: {} },
  renderLayer: 'front', surfaceOpacity: 0.2, backgroundColor: '#000000', pauseWhenUnfocused: true,
  opaqueEditorForMedia: true, opaqueEditorFileTypes: ['pdf', 'png'],
  performance: { profile: 'quality', maxFps: 60, suspendAfterSeconds: 15 }, layers: [],
  effects: { overlayOpacity: 0, vignette: 0, grain: 0, scanlines: 0 }
};

type Listener = (event: Record<string, unknown>) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  dispatchEvent(event: { type: string }): boolean {
    this.dispatch(event.type, event as unknown as Record<string, unknown>);
    return true;
  }
}

class FakeElement extends FakeEventTarget {
  readonly nodeType = 1;
  readonly children: FakeElement[] = [];
  readonly classList = { toggle: () => undefined };
  parentElement: FakeElement | null = null;
  contentWindow?: { postMessage(message: Record<string, unknown>): void };
  id = '';
  textContent = '';
  src = '';
  sandbox = '';
  allow = '';
  referrerPolicy = '';

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  prepend(child: FakeElement): void {
    child.parentElement = this;
    this.children.unshift(child);
  }

  setAttribute(): void {}
  remove(): void {}
  matches(): boolean { return false; }
  closest(): FakeElement | null { return null; }
  querySelector(): FakeElement | null { return null; }
  querySelectorAll(): FakeElement[] { return []; }
  getAttribute(): string | null { return null; }
}

class FakeDocument extends FakeEventTarget {
  readonly head = new FakeElement();
  readonly body = new FakeElement();
  readonly readyState = 'complete';
  hidden = false;
  focused = true;
  iframe?: FakeElement;

  constructor(private readonly rendererWindow: { postMessage(message: Record<string, unknown>): void }) {
    super();
  }

  hasFocus(): boolean { return this.focused; }
  getElementById(): FakeElement | null { return null; }
  querySelector(): FakeElement | null { return null; }

  createElement(tagName: string): FakeElement {
    const element = new FakeElement();
    if (tagName === 'iframe') {
      element.contentWindow = this.rendererWindow;
      this.iframe = element;
    }
    return element;
  }
}

function createHostHarness() {
  const messages: Array<Record<string, unknown>> = [];
  const storageWrites: string[] = [];
  const warningLogs: unknown[][] = [];
  const errorLogs: unknown[][] = [];
  const rendererWindow = {
    postMessage(message: Record<string, unknown>): void { messages.push(message); }
  };
  const document = new FakeDocument(rendererWindow);
  const window = new FakeEventTarget();
  const frames = new Map<number, (time: number) => void>();
  let nextFrame = 1;

  const requestAnimationFrame = (callback: (time: number) => void): number => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = (id: number): void => { frames.delete(id); };
  const source = buildInjectionScript(configuration, 'dynamicwallpaper.runtime.123456789abc');
  const execute = new Function(
    'window', 'document', 'MutationObserver', 'CustomEvent', 'localStorage',
    'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
    'innerWidth', 'innerHeight', 'devicePixelRatio', 'console', source
  );
  execute(
    window,
    document,
    class { disconnect(): void {} observe(): void {} },
    class { constructor(readonly type: string, readonly init?: unknown) {} },
    { setItem: (_key: string, value: string) => storageWrites.push(value) },
    requestAnimationFrame,
    cancelAnimationFrame,
    (callback: () => void, delay: number) => setTimeout(callback, delay),
    (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    1280,
    720,
    1,
    {
      warn: (...args: unknown[]) => warningLogs.push(args),
      error: (...args: unknown[]) => errorLogs.push(args)
    }
  );

  return {
    document,
    window,
    messages,
    storageWrites,
    warningLogs,
    errorLogs,
    loadRuntime(): void { document.iframe?.dispatch('load'); },
    postFromRuntime(data: Record<string, unknown>): void {
      window.dispatch('message', {
        source: rendererWindow,
        data: { channel: 'dynamic-wallpaper-host', protocolVersion: 1, ...data }
      });
    },
    runAnimationFrame(): void {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(16);
    }
  };
}

function pointerEvent(x: number, y = x): Record<string, unknown> {
  return { clientX: x, clientY: y, buttons: 0, button: -1, pointerId: 1, pointerType: 'mouse' };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('trusted Workbench bootstrap', () => {
  it('contains only the iframe protocol host and no legacy Scene renderer', () => {
    const source = buildInjectionScript(configuration, 'dynamicwallpaper.runtime.123456789abc');
    expect(() => new Function(source)).not.toThrow();
    expect(source).toContain('dynamic-wallpaper-runtime');
    expect(source).toContain('dynamic-wallpaper-host');
    expect(source).toContain('renderer.html');
    expect(source).not.toContain('CanvasRenderingContext2D');
    expect(source).not.toContain('createSceneLayer');
    expect(source).not.toContain('backend');
  });

  it('observes only editor structure and filters unrelated Monaco mutations', () => {
    const source = buildInjectionScript(configuration, 'dynamicwallpaper.runtime.123456789abc');
    expect(source).toContain('dynamic-wallpaper-opaque-editor');
    expect(source).toContain('mutations.some(opaqueEditorMutationMatters)');
    expect(source).toContain('observeEditorStructure(current)');
    expect(source).toContain("root.querySelectorAll('.tabs-container, .tabs-and-actions-container')");
    expect(source).not.toContain('observe(current, { subtree: true, childList: true })');
    expect(source).toContain('if (groups.length === 0)');
    expect(source).toContain("target.matches('.tab')");
  });

  it('self-recovers quickly when Electron loses the focus event', () => {
    vi.useFakeTimers();
    const harness = createHostHarness();
    harness.loadRuntime();

    harness.document.focused = false;
    harness.window.dispatch('blur');
    expect(harness.messages.at(-1)).toMatchObject({ type: 'lifecycle', paused: true, focused: false });

    // Simulate Electron restoring focus without dispatching focus/pageshow.
    harness.document.focused = true;
    vi.advanceTimersByTime(200);
    expect(harness.messages.at(-1)).toMatchObject({ type: 'lifecycle', paused: false, focused: true });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('detects a missing blur event while the host still believes it is active', () => {
    vi.useFakeTimers();
    const harness = createHostHarness();
    harness.loadRuntime();
    harness.messages.length = 0;

    // No blur/visibility event is dispatched at all.
    harness.document.focused = false;
    vi.advanceTimersByTime(99);
    expect(harness.messages).toEqual([]);
    vi.advanceTimersByTime(101);
    expect(harness.messages.at(-1)).toMatchObject({
      type: 'lifecycle', paused: true, focused: false
    });
  });

  it('re-sends resume once Chromium has fully foregrounded the window', () => {
    vi.useFakeTimers();
    const harness = createHostHarness();
    harness.loadRuntime();
    harness.document.focused = false;
    harness.window.dispatch('blur');
    harness.messages.length = 0;

    harness.document.focused = true;
    harness.window.dispatch('focus');
    expect(harness.messages.filter(message => message.type === 'lifecycle')).toHaveLength(1);
    vi.advanceTimersByTime(120);
    expect(harness.messages.filter(message => message.type === 'lifecycle')).toHaveLength(2);
    expect(harness.messages.at(-1)).toMatchObject({ type: 'lifecycle', paused: false });
  });

  it('cancels an older delayed resume when blur wins a rapid focus race', () => {
    const harness = createHostHarness();
    harness.loadRuntime();
    harness.document.focused = false;
    harness.window.dispatch('blur');

    harness.document.focused = true;
    harness.window.dispatch('focus');
    harness.window.dispatch('blur');
    const messageCountAfterBlur = harness.messages.length;
    vi.advanceTimersByTime(120);

    expect(harness.messages).toHaveLength(messageCountAfterBlur);
    expect(harness.messages.at(-1)).toMatchObject({ type: 'lifecycle', paused: true });
  });

  it('coalesces pointer moves per frame and drops pending work after blur', () => {
    const harness = createHostHarness();
    harness.loadRuntime();
    harness.messages.length = 0;

    harness.document.dispatch('pointermove', pointerEvent(1));
    harness.document.dispatch('pointermove', pointerEvent(2));
    harness.document.dispatch('pointermove', pointerEvent(3));
    expect(harness.messages).toEqual([]);
    harness.runAnimationFrame();
    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]).toMatchObject({ type: 'pointer', event: 'move', x: 3, y: 3 });

    harness.document.dispatch('pointerdown', { ...pointerEvent(4), button: 0, buttons: 1 });
    expect(harness.messages.at(-1)).toMatchObject({ type: 'pointer', event: 'down', x: 4 });

    harness.document.dispatch('pointermove', pointerEvent(5));
    harness.document.focused = false;
    harness.window.dispatch('blur');
    harness.runAnimationFrame();
    expect(harness.messages.filter(message => message.type === 'pointer')).toHaveLength(2);

    harness.document.dispatch('pointermove', pointerEvent(6));
    harness.runAnimationFrame();
    expect(harness.messages.filter(message => message.type === 'pointer')).toHaveLength(2);
  });

  it('replaces cumulative diagnostic snapshots with one storage write per message', () => {
    const harness = createHostHarness();
    const first = { severity: 'warning', code: 'first', message: 'First warning' };
    const second = { severity: 'error', code: 'second', message: 'Second error' };

    harness.postFromRuntime({ type: 'diagnostics', diagnostics: [first] });
    harness.postFromRuntime({ type: 'diagnostics', diagnostics: [first, first, second] });

    expect(harness.storageWrites).toHaveLength(2);
    expect(JSON.parse(harness.storageWrites.at(-1) ?? '[]')).toEqual([first, second]);
    expect(harness.warningLogs).toHaveLength(1);
    expect(harness.errorLogs).toHaveLength(1);
  });

  it('retains content-addressed generations on apply and cleans them on restore', () => {
    const applySource = applyWorkbenchPatch.toString();
    const restoreSource = removeWorkbenchPatch.toString();
    expect(applySource).not.toContain('removeStaleInjectionFiles');
    expect(applySource).not.toContain('removeStaleWebDirectories');
    expect(applySource).not.toContain('removeStaleRuntimeDirectories');
    expect(restoreSource).toContain('removeStaleInjectionFiles');
    expect(restoreSource).toContain('removeStaleWebDirectories');
    expect(restoreSource).toContain('removeStaleRuntimeDirectories');
  });
});
