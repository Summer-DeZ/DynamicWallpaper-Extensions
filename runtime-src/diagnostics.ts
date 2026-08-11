import type {
  CompatibilityDiagnostic,
  RuntimeToHostMessage
} from '../src/domain/runtime';

export class RuntimeDiagnostics {
  private static readonly maximumEntries = 500;
  private static readonly publishDelayMs = 50;
  private readonly entries: CompatibilityDiagnostic[] = [];
  private readonly entryKeys = new Set<string>();
  private overlay?: HTMLElement;
  private visible = false;
  private publishTimer?: ReturnType<typeof setTimeout>;

  add(entry: CompatibilityDiagnostic): void {
    if (!this.append(entry)) return;
    this.schedulePublish();
  }

  merge(entries: readonly CompatibilityDiagnostic[]): void {
    let changed = false;
    for (const entry of entries) changed = this.append(entry) || changed;
    if (!changed) return;
    // Import reports can contain hundreds of resource diagnostics. Publishing
    // after every item repeatedly serializes an ever-growing snapshot and
    // floods the Workbench message channel; one batch message is sufficient.
    this.flushPublish();
  }

  fatal(message: string, details?: string): void {
    this.post({
      channel: 'dynamic-wallpaper-host',
      protocolVersion: 1,
      type: 'fatal',
      message: truncate(message, 2_000),
      details: details === undefined ? undefined : truncate(details, 8_000)
    });
  }

  snapshot(): CompatibilityDiagnostic[] {
    return this.entries.map(entry => ({ ...entry }));
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.renderOverlay();
  }

  private renderOverlay(): void {
    if (!this.visible) {
      this.overlay?.remove();
      this.overlay = undefined;
      return;
    }
    if (!this.overlay) {
      this.overlay = document.createElement('section');
      this.overlay.className = 'dwr-diagnostics';
      document.body.appendChild(this.overlay);
    }
    const errors = this.entries.filter(entry => entry.severity === 'error').length;
    const warnings = this.entries.filter(entry => entry.severity === 'warning').length;
    this.overlay.textContent = [
      `Dynamic Wallpaper 运行时诊断（错误 ${errors} / 警告 ${warnings}）`,
      ...this.entries.map(entry => `[${entry.severity}] ${entry.code}: ${entry.message}${entry.resource ? `\n  ${entry.resource}` : ''}${entry.details ? `\n  ${entry.details}` : ''}`)
    ].join('\n');
  }

  private publish(): void {
    this.post({
      channel: 'dynamic-wallpaper-host',
      protocolVersion: 1,
      type: 'diagnostics',
      diagnostics: this.snapshot()
    });
  }

  private schedulePublish(): void {
    if (this.publishTimer !== undefined) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      this.publish();
      this.renderOverlay();
    }, RuntimeDiagnostics.publishDelayMs);
  }

  private flushPublish(): void {
    if (this.publishTimer !== undefined) {
      clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
    }
    this.publish();
    this.renderOverlay();
  }

  private post(message: RuntimeToHostMessage): void {
    window.parent.postMessage(message, '*');
  }

  private append(entry: CompatibilityDiagnostic): boolean {
    const boundedEntry = boundDiagnostic(entry);
    const key = diagnosticKey(boundedEntry);
    if (this.entryKeys.has(key)) return false;
    this.entryKeys.add(key);
    this.entries.push(boundedEntry);
    if (this.entries.length > RuntimeDiagnostics.maximumEntries) {
      const removed = this.entries.shift();
      if (removed) this.entryKeys.delete(diagnosticKey(removed));
    }
    return true;
  }
}

function boundDiagnostic(entry: CompatibilityDiagnostic): CompatibilityDiagnostic {
  return {
    ...entry,
    code: truncate(entry.code, 200),
    message: truncate(entry.message, 2_000),
    resource: entry.resource === undefined ? undefined : truncate(entry.resource, 2_000),
    nodeId: typeof entry.nodeId === 'string' ? truncate(entry.nodeId, 500) : entry.nodeId,
    details: entry.details === undefined ? undefined : truncate(entry.details, 8_000)
  };
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength - 1)}…`;
}

function diagnosticKey(entry: CompatibilityDiagnostic): string {
  return `${entry.code}\u0000${entry.resource ?? ''}\u0000${entry.nodeId ?? ''}\u0000${entry.message}`;
}
