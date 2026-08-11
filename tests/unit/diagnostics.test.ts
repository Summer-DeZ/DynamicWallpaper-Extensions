import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeDiagnostics } from '../../runtime-src/diagnostics';

describe('runtime diagnostics', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('deduplicates and publishes an imported report as one bounded snapshot', () => {
    const postMessage = vi.fn();
    vi.stubGlobal('window', { parent: { postMessage } });
    const diagnostics = new RuntimeDiagnostics();
    const entries = Array.from({ length: 550 }, (_, index) => ({
      code: `diagnostic-${index}`,
      severity: 'warning' as const,
      message: `Diagnostic ${index}`
    }));

    diagnostics.merge([...entries, entries[549]]);

    expect(postMessage).toHaveBeenCalledOnce();
    expect(diagnostics.snapshot()).toHaveLength(500);
    expect(diagnostics.snapshot()[0]?.code).toBe('diagnostic-50');
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'diagnostics',
      diagnostics: diagnostics.snapshot()
    }), '*');
  });

  it('batches individual additions and bounds oversized payloads', () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    vi.stubGlobal('window', { parent: { postMessage } });
    const diagnostics = new RuntimeDiagnostics();

    for (let index = 0; index < 200; index++) {
      diagnostics.add({
        code: `shader-${index}`,
        severity: 'error',
        message: `Shader ${index} ${'m'.repeat(3_000)}`,
        details: 'd'.repeat(20_000)
      });
    }

    expect(postMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(postMessage).toHaveBeenCalledOnce();
    expect(diagnostics.snapshot()[0]?.message.length).toBe(2_000);
    expect(diagnostics.snapshot()[0]?.details?.length).toBe(8_000);
  });
});
