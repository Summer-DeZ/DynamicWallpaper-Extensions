import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { RendererConfiguration } from '../../domain/renderer';
import { PatchResult, WorkbenchPatchStatus } from './types';

export type { PatchResult, WorkbenchPatchStatus } from './types';

export const PATCH_START = '<!-- dynamic-wallpaper-engine:start -->';
export const PATCH_END = '<!-- dynamic-wallpaper-engine:end -->';
export const INJECTION_FILE_NAME = 'dynamicwallpaper.inject.js';
const INJECTION_FILE_PATTERN = /^dynamicwallpaper\.inject(?:\.[a-f0-9]{12})?\.js$/;
const WEB_DIRECTORY_PATTERN = /^dynamicwallpaper\.web\.[a-f0-9]{12}$/;
const RUNTIME_DIRECTORY_PATTERN = /^dynamicwallpaper\.runtime\.[a-f0-9]{12}$/;

export async function applyWorkbenchPatch(
  appRoot: string,
  configuration: RendererConfiguration
): Promise<PatchResult> {
  const workbenchHtml = await findWorkbenchHtml(appRoot);
  const workbenchDirectory = path.dirname(workbenchHtml);
  const backupFile = `${workbenchHtml}.dynamicwallpaper.backup`;
  const prepared = await prepareWebLayers(configuration, workbenchDirectory, true);
  const runtime = await prepareRuntimeAssets(workbenchDirectory, true);
  const injectionScript = buildInjectionScript(prepared.configuration, runtime.directoryName);
  const injectionFileName = injectionFileNameForScript(injectionScript);
  const injectionFile = path.join(workbenchDirectory, injectionFileName);

  const originalHtml = await fs.readFile(workbenchHtml, 'utf8');
  const patchedHtml = insertPatchBlock(removePatchBlock(originalHtml), injectionFileName);

  await createBackupIfMissing(workbenchHtml, backupFile);
  await fs.writeFile(injectionFile, injectionScript, 'utf8');
  await fs.writeFile(workbenchHtml, patchedHtml, 'utf8');

  // Content-addressed assets may still be used by another open VS Code window.
  // Keep previous generations until explicit uninstall/restore, when no new
  // Workbench can discover them through the patched HTML anymore.

  return { workbenchHtml, injectionFile };
}

export async function getWorkbenchPatchStatus(
  appRoot: string,
  configuration: RendererConfiguration
): Promise<WorkbenchPatchStatus> {
  const workbenchHtml = await findWorkbenchHtml(appRoot);
  const workbenchDirectory = path.dirname(workbenchHtml);
  const html = await fs.readFile(workbenchHtml, 'utf8');
  if (!html.includes(PATCH_START)) {
    return 'missing';
  }

  const prepared = await prepareWebLayers(configuration, workbenchDirectory, false);
  const runtime = await prepareRuntimeAssets(workbenchDirectory, false);
  const injectionScript = buildInjectionScript(prepared.configuration, runtime.directoryName);
  const injectionFileName = injectionFileNameForScript(injectionScript);
  if (!html.includes(`src="./${injectionFileName}"`)) {
    return 'stale';
  }

  try {
    for (const entry of [...prepared.webEntryFiles, runtime.entryFile]) {
      if (!(await fs.stat(entry)).isFile()) {
        return 'stale';
      }
    }
    const installedScript = await fs.readFile(path.join(workbenchDirectory, injectionFileName), 'utf8');
    return installedScript === injectionScript ? 'current' : 'stale';
  } catch {
    return 'stale';
  }
}

export async function removeWorkbenchPatch(appRoot: string): Promise<PatchResult> {
  const workbenchHtml = await findWorkbenchHtml(appRoot);
  const workbenchDirectory = path.dirname(workbenchHtml);
  const injectionFile = path.join(workbenchDirectory, INJECTION_FILE_NAME);
  const originalHtml = await fs.readFile(workbenchHtml, 'utf8');
  const cleanedHtml = removePatchBlock(originalHtml);

  if (cleanedHtml !== originalHtml) {
    await fs.writeFile(workbenchHtml, cleanedHtml, 'utf8');
  }

  await removeStaleInjectionFiles(workbenchDirectory);
  await removeStaleWebDirectories(workbenchDirectory, new Set());
  await removeStaleRuntimeDirectories(workbenchDirectory, new Set());
  return { workbenchHtml, injectionFile };
}

export async function findWorkbenchHtml(appRoot: string): Promise<string> {
  const candidates = [
    ['out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'],
    ['out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.html']
  ];
  for (const parts of candidates) {
    const candidate = path.join(appRoot, ...parts);
    try {
      if ((await fs.stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next supported VS Code layout.
    }
  }
  throw new Error(`找不到 VS Code Workbench HTML：${appRoot}`);
}

export function removePatchBlock(html: string): string {
  const start = html.indexOf(PATCH_START);
  if (start < 0) {
    return html;
  }
  const end = html.indexOf(PATCH_END, start);
  if (end < 0) {
    throw new Error('检测到不完整的 Dynamic Wallpaper 注入标记，请先修复 workbench.html。');
  }
  return html.slice(0, start) + html.slice(end + PATCH_END.length);
}

export function insertPatchBlock(html: string, injectionFileName = INJECTION_FILE_NAME): string {
  const closingTag = html.lastIndexOf('</html>');
  if (closingTag < 0) {
    throw new Error('Workbench HTML 中没有 </html>，无法安全注入。');
  }
  const patchBlock = `${PATCH_START}\n<script src="./${injectionFileName}"></script>\n${PATCH_END}`;
  return `${html.slice(0, closingTag)}${patchBlock}${html.slice(closingTag)}`;
}

/** Trusted host only: every wallpaper renderer lives in the isolated runtime iframe. */
export function buildInjectionScript(
  configuration: RendererConfiguration,
  runtimeDirectoryName = 'dynamicwallpaper.runtime'
): string {
  const serialized = JSON.stringify(configuration).replace(/</g, '\\u003c');
  const runtimeEntry = `./${runtimeDirectoryName}/renderer.html`;
  const isFront = configuration.renderLayer === 'front';
  const opacity = isFront ? 1 - configuration.surfaceOpacity : 1;
  const zIndex = isFront ? 2147483000 : 0;
  const opaqueEditorCss = configuration.opaqueEditorForMedia ? `
    .monaco-workbench .part.editor.dynamic-wallpaper-opaque-part {
      position: relative;
      z-index: 2147483001 !important;
    }
    .monaco-workbench .editor-group-container.dynamic-wallpaper-opaque-editor,
    .monaco-workbench .editor-group-container.dynamic-wallpaper-opaque-editor .editor-container,
    .monaco-workbench .editor-group-container.dynamic-wallpaper-opaque-editor .editor-pane,
    .monaco-workbench .editor-group-container.dynamic-wallpaper-opaque-editor .editor-instance,
    .monaco-workbench .editor-group-container.dynamic-wallpaper-opaque-editor .monaco-editor,
    .monaco-workbench .editor-group-container.dynamic-wallpaper-opaque-editor .monaco-editor-background,
    .monaco-workbench .editor-group-container.dynamic-wallpaper-opaque-editor .margin {
      background-color: var(--vscode-editor-background) !important;
    }` : '';
  const workbenchCss = isFront ? '' : `
    body > .monaco-workbench { position: relative; z-index: 1; background: transparent !important; }
    .monaco-workbench .part.editor,
    .monaco-workbench .part.editor > .content,
    .monaco-workbench .part.editor .editor-group-container,
    .monaco-workbench .part.editor .editor-container,
    .monaco-workbench .part.editor .editor-pane,
    .monaco-workbench .part.editor .editor-instance,
    .monaco-workbench .part.editor .monaco-editor,
    .monaco-workbench .part.editor .monaco-editor-background,
    .monaco-workbench .part.editor .margin {
      background-color: color-mix(in srgb, var(--vscode-editor-background) ${Math.round(configuration.surfaceOpacity * 100)}%, transparent) !important;
    }`;

  return `(() => {
  'use strict';
  const HOST_CHANNEL = 'dynamic-wallpaper-host';
  const RUNTIME_CHANNEL = 'dynamic-wallpaper-runtime';
  const configuration = ${serialized};
  const ROOT_ID = 'dynamic-wallpaper-root';
  const STYLE_ID = 'dynamic-wallpaper-style';
  const runtimeDiagnostics = [];
  const hostDiagnostics = [];
  let rendererWindow = null;
  let opaqueEditorObserver = null;
  let opaqueEditorRoot = null;
  let opaqueEditorUpdateFrame = 0;
  let hostWindowFocused = document.hasFocus();
  let lifecycleSyncTimer = 0;
  let lifecycleSyncGeneration = 0;
  let lifecycleMonitorTimer = 0;
  let lifecycleMismatchValue = null;
  let lifecycleMismatchCount = 0;
  let lastLifecycleMessage = '';
  let pointerMoveFrame = 0;
  let pendingPointerMove = null;

  const opaqueEditorFileTypes = new Set((configuration.opaqueEditorFileTypes || [])
    .map(value => String(value).trim().toLowerCase().replace(/^\\*?\\./, ''))
    .filter(Boolean));

  function editorMatchesOpaqueFileType(group) {
    if (!configuration.opaqueEditorForMedia || opaqueEditorFileTypes.size === 0) return false;
    const tab = group.querySelector('.tab.active, .tab[aria-selected="true"]');
    if (!tab) return false;
    const candidates = [
      tab.getAttribute('data-resource-name'),
      tab.getAttribute('aria-label'),
      tab.getAttribute('title'),
      tab.querySelector('.label-name')?.textContent,
      tab.textContent
    ].filter(Boolean).join(' ').toLowerCase();
    return Array.from(opaqueEditorFileTypes).some(type => {
      const needle = '.' + type;
      let position = candidates.indexOf(needle);
      while (position >= 0) {
        const next = candidates[position + needle.length];
        if (!next || ' ?#\\t\\r\\n,;:)}]"—'.includes(next)) return true;
        position = candidates.indexOf(needle, position + needle.length);
      }
      return false;
    });
  }

  function updateOpaqueEditors() {
    opaqueEditorUpdateFrame = 0;
    const editorPart = document.querySelector('.monaco-workbench .part.editor');
    let hasOpaqueEditor = false;
    editorPart?.querySelectorAll('.editor-group-container').forEach(group => {
      const opaque = editorMatchesOpaqueFileType(group);
      group.classList.toggle('dynamic-wallpaper-opaque-editor', opaque);
      hasOpaqueEditor ||= opaque;
    });
    editorPart?.classList.toggle('dynamic-wallpaper-opaque-part', hasOpaqueEditor);
  }

  function scheduleOpaqueEditorUpdate() {
    if (!opaqueEditorUpdateFrame) opaqueEditorUpdateFrame = requestAnimationFrame(updateOpaqueEditors);
  }

  function nodeContainsOpaqueEditorMarker(node) {
    return node?.nodeType === 1 && (
      node.matches('.tab, .tabs-container, .tabs-and-actions-container, .editor-group-container, .part.editor')
      || node.querySelector('.tab, .tabs-container, .tabs-and-actions-container, .editor-group-container, .part.editor')
    );
  }

  function opaqueEditorMutationMatters(mutation) {
    const target = mutation.target;
    if (mutation.type === 'attributes') {
      return target?.nodeType === 1 && target.matches('.tab');
    }
    if (target?.nodeType === 1 && target.closest('.tab, .tabs-container, .tabs-and-actions-container')) {
      return true;
    }
    return Array.from(mutation.addedNodes).some(nodeContainsOpaqueEditorMarker)
      || Array.from(mutation.removedNodes).some(nodeContainsOpaqueEditorMarker);
  }

  function watchActiveEditors() {
    opaqueEditorObserver?.disconnect();
    const workbench = document.querySelector('.monaco-workbench');
    if (!workbench || !configuration.opaqueEditorForMedia || opaqueEditorFileTypes.size === 0) return;
    function observeCurrentEditorPart() {
      const current = document.querySelector('.monaco-workbench .part.editor');
      opaqueEditorObserver.disconnect();
      opaqueEditorRoot = current;
      if (!current) {
        // This broad observer exists only during Workbench startup.
        opaqueEditorObserver.observe(workbench, { subtree: true, childList: true });
        return;
      }
      observeEditorStructure(current);
      // Detect replacement of the editor part without observing unrelated
      // Monaco descendants for the rest of the session.
      if (current.parentElement) opaqueEditorObserver.observe(current.parentElement, { childList: true });
      updateOpaqueEditors();
    }
    function observeEditorStructure(root) {
      // Observe only group topology and tab strips.  Watching the whole editor
      // subtree also sees Monaco's per-keystroke/per-scroll DOM churn.
      const groups = Array.from(root.querySelectorAll('.editor-group-container'));
      if (groups.length === 0) {
        // During startup the editor part can precede its first nested group.
        // This temporary broad watch is replaced as soon as that group lands.
        opaqueEditorObserver.observe(root, { subtree: true, childList: true });
        return;
      }
      opaqueEditorObserver.observe(root, { childList: true });
      groups.forEach(group => {
        opaqueEditorObserver.observe(group, { childList: true });
        if (group.parentElement) opaqueEditorObserver.observe(group.parentElement, { childList: true });
      });
      root.querySelectorAll('.tabs-container, .tabs-and-actions-container').forEach(container => {
        opaqueEditorObserver.observe(container, { childList: true });
      });
      observeTabAttributes(root);
    }
    function observeTabAttributes(root) {
      root.querySelectorAll('.tab').forEach(tab => opaqueEditorObserver.observe(tab, {
        attributes: true,
        attributeFilter: ['class', 'aria-selected', 'aria-label', 'title', 'data-resource-name']
      }));
    }
    opaqueEditorObserver = new MutationObserver(mutations => {
      if (!mutations.some(opaqueEditorMutationMatters)) return;
      const current = document.querySelector('.monaco-workbench .part.editor');
      if (current !== opaqueEditorRoot) {
        observeCurrentEditorPart();
        return;
      }
      if (current && mutations.some(mutation => mutation.type === 'childList')) {
        // Structural changes can introduce both new groups and new tabs.  A
        // fresh, narrow target set also drops detached nodes from observation.
        observeCurrentEditorPart();
        return;
      }
      scheduleOpaqueEditorUpdate();
    });
    observeCurrentEditorPart();
  }

  function send(type, payload) {
    if (!rendererWindow) return;
    rendererWindow.postMessage(Object.assign({ channel: RUNTIME_CHANNEL, protocolVersion: 1, type }, payload || {}), '*');
  }

  function isHostInactive() {
    return document.hidden || !hostWindowFocused;
  }

  function setPaused(force = false) {
    const paused = configuration.pauseWhenUnfocused
      && isHostInactive();
    const state = {
      paused,
      focused: hostWindowFocused,
      visible: !document.hidden
    };
    const fingerprint = Number(state.paused) + ':' + Number(state.focused) + ':' + Number(state.visible);
    if (!rendererWindow || (!force && fingerprint === lastLifecycleMessage)) return;
    lastLifecycleMessage = fingerprint;
    send('lifecycle', state);
    if (isHostInactive()) clearPendingPointerMove();
  }

  function observedWindowFocus() {
    return !document.hidden && document.hasFocus();
  }

  function resetLifecycleMismatch() {
    lifecycleMismatchValue = null;
    lifecycleMismatchCount = 0;
  }

  // Electron occasionally omits either edge of the native focus transition.
  // Keep a cheap monitor alive in both states; requiring two equal samples
  // filters the brief document.hasFocus() lag seen just after a focus event.
  function scheduleLifecycleMonitor() {
    if (lifecycleMonitorTimer) return;
    lifecycleMonitorTimer = setTimeout(() => {
      lifecycleMonitorTimer = 0;
      reconcileLifecycleState(false);
      scheduleLifecycleMonitor();
    }, 100);
  }

  function reconcileLifecycleState(immediate = false) {
    const observedFocused = observedWindowFocus();
    if (observedFocused === hostWindowFocused) {
      resetLifecycleMismatch();
      return;
    }
    if (immediate) {
      hostWindowFocused = observedFocused;
      resetLifecycleMismatch();
    } else {
      if (lifecycleMismatchValue === observedFocused) lifecycleMismatchCount++;
      else {
        lifecycleMismatchValue = observedFocused;
        lifecycleMismatchCount = 1;
      }
      if (lifecycleMismatchCount < 2) return;
      hostWindowFocused = observedFocused;
      resetLifecycleMismatch();
    }
    setPaused();
  }

  // Electron can restore a minimized window before it dispatches focus, so
  // repeat the state check on the next frame and shortly afterwards.  Both
  // checks recompute state, which means a new blur cannot be undone by an
  // older queued resume callback.
  function synchronizeLifecycleAfterResume() {
    if (lifecycleSyncTimer) clearTimeout(lifecycleSyncTimer);
    const generation = ++lifecycleSyncGeneration;
    requestAnimationFrame(() => {
      if (generation !== lifecycleSyncGeneration) return;
      if (observedWindowFocus()) {
        hostWindowFocused = true;
        resetLifecycleMismatch();
      }
      setPaused();
    });
    lifecycleSyncTimer = setTimeout(() => {
      if (generation !== lifecycleSyncGeneration) return;
      lifecycleSyncTimer = 0;
      if (!observedWindowFocus()) return;
      hostWindowFocused = true;
      resetLifecycleMismatch();
      // Re-send once after Chromium has fully foregrounded the renderer. This
      // gives media/AudioContext a second resume opportunity without waiting
      // for another OS focus transition.
      setPaused(true);
    }, 120);
  }

  function cancelLifecycleResumeSync() {
    lifecycleSyncGeneration++;
    if (!lifecycleSyncTimer) return;
    clearTimeout(lifecycleSyncTimer);
    lifecycleSyncTimer = 0;
  }

  function handleWindowFocus() {
    hostWindowFocused = true;
    resetLifecycleMismatch();
    setPaused();
    synchronizeLifecycleAfterResume();
  }

  function handleWindowBlur() {
    cancelLifecycleResumeSync();
    hostWindowFocused = false;
    resetLifecycleMismatch();
    setPaused();
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      cancelLifecycleResumeSync();
      hostWindowFocused = false;
    }
    else if (document.hasFocus()) hostWindowFocused = true;
    resetLifecycleMismatch();
    setPaused();
    if (!document.hidden) synchronizeLifecycleAfterResume();
  }

  function handlePageShow() {
    reconcileLifecycleState(true);
    synchronizeLifecycleAfterResume();
  }

  function handlePageHide() {
    cancelLifecycleResumeSync();
    hostWindowFocused = false;
    resetLifecycleMismatch();
    setPaused();
  }

  function recoverLifecycleFromInteraction() {
    if (!document.hidden && document.hasFocus() && !hostWindowFocused) {
      hostWindowFocused = true;
      resetLifecycleMismatch();
      setPaused();
      synchronizeLifecycleAfterResume();
    }
  }

  function diagnosticKey(entry) {
    return [entry.code, entry.resource || '', entry.nodeId || '', entry.message].join('\\u0000');
  }

  function logDiagnostic(entry) {
    const method = entry.severity === 'error' ? 'error' : 'warn';
    console[method]('[Dynamic Wallpaper]', entry.code || 'runtime', entry.message || entry);
  }

  function persistDiagnostics() {
    const unique = [];
    const keys = new Set();
    for (const entry of runtimeDiagnostics.concat(hostDiagnostics)) {
      const key = diagnosticKey(entry);
      if (keys.has(key)) continue;
      keys.add(key);
      unique.push(entry);
    }
    if (unique.length > 500) unique.splice(0, unique.length - 500);
    try { localStorage.setItem('dynamicWallpaper.runtimeDiagnostics', JSON.stringify(unique)); } catch {}
  }

  function replaceRuntimeDiagnostics(snapshot) {
    const previousKeys = new Set(runtimeDiagnostics.map(diagnosticKey));
    const nextKeys = new Set();
    const next = [];
    const entries = Array.isArray(snapshot) ? snapshot.slice(-500) : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const key = diagnosticKey(entry);
      if (nextKeys.has(key)) continue;
      nextKeys.add(key);
      next.push(entry);
      if (!previousKeys.has(key)) logDiagnostic(entry);
    }
    runtimeDiagnostics.splice(0, runtimeDiagnostics.length, ...next);
    persistDiagnostics();
  }

  function recordDiagnostic(entry) {
    const key = diagnosticKey(entry);
    if (hostDiagnostics.some(existing => diagnosticKey(existing) === key)) return;
    hostDiagnostics.push(entry);
    if (hostDiagnostics.length > 500) hostDiagnostics.splice(0, hostDiagnostics.length - 500);
    persistDiagnostics();
    logDiagnostic(entry);
  }

  function pointerPayload(type, event) {
    return {
      event: type,
      x: event.clientX,
      y: event.clientY,
      buttons: event.buttons,
      button: event.button,
      pointerId: event.pointerId,
      pointerType: event.pointerType
    };
  }

  function clearPendingPointerMove() {
    pendingPointerMove = null;
    if (!pointerMoveFrame) return;
    cancelAnimationFrame(pointerMoveFrame);
    pointerMoveFrame = 0;
  }

  function sendPointer(type, event) {
    if (isHostInactive()) return;
    send('pointer', pointerPayload(type, event));
  }

  function schedulePointerMove(event) {
    if (isHostInactive()) {
      clearPendingPointerMove();
      return;
    }
    // Copy the values because Chromium may recycle the PointerEvent object.
    pendingPointerMove = pointerPayload('move', event);
    if (pointerMoveFrame) return;
    pointerMoveFrame = requestAnimationFrame(() => {
      pointerMoveFrame = 0;
      const payload = pendingPointerMove;
      pendingPointerMove = null;
      if (payload && !isHostInactive()) send('pointer', payload);
    });
  }

  function start() {
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = \`
      html, body { background: transparent !important; }
      #\${ROOT_ID} { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: ${zIndex}; opacity: ${opacity}; contain: strict; }
      #\${ROOT_ID} > iframe { width: 100%; height: 100%; border: 0; display: block; background: transparent; pointer-events: none; }
      ${workbenchCss}
      ${opaqueEditorCss}
    \`;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('aria-hidden', 'true');
    const iframe = document.createElement('iframe');
    iframe.src = '${runtimeEntry}';
    iframe.sandbox = 'allow-scripts allow-same-origin';
    iframe.allow = 'autoplay; fullscreen';
    iframe.referrerPolicy = 'no-referrer';
    root.appendChild(iframe);
    document.body.prepend(root);
    rendererWindow = iframe.contentWindow;
    iframe.addEventListener('load', () => {
      rendererWindow = iframe.contentWindow;
      lastLifecycleMessage = '';
      setPaused(true);
    });
    watchActiveEditors();

    window.addEventListener('message', event => {
      if (event.source !== rendererWindow || !event.data || event.data.channel !== HOST_CHANNEL || event.data.protocolVersion !== 1) return;
      if (event.data.type === 'ready') {
        send('initialize', {
          configuration,
          userProperties: configuration.runtime?.userProperties || {}
        });
        setPaused(true);
      } else if (event.data.type === 'diagnostics') {
        replaceRuntimeDiagnostics(event.data.diagnostics);
      } else if (event.data.type === 'fatal') {
        recordDiagnostic({ severity: 'error', code: 'runtime.fatal', message: event.data.message, details: event.data.details });
      } else if (event.data.type === 'network-request') {
        recordDiagnostic({ severity: 'warning', code: 'web.network-blocked', message: '壁纸请求了未授权网络域名：' + event.data.host, resource: event.data.host });
        window.dispatchEvent(new CustomEvent('dynamic-wallpaper-network-request', { detail: event.data }));
      }
    });

    document.addEventListener('pointermove', schedulePointerMove, { capture: true, passive: true });
    document.addEventListener('pointerdown', event => {
      recoverLifecycleFromInteraction();
      sendPointer('down', event);
    }, { capture: true, passive: true });
    document.addEventListener('pointerup', event => sendPointer('up', event), { capture: true, passive: true });
    document.addEventListener('pointercancel', event => sendPointer('leave', event), { capture: true, passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('freeze', handlePageHide);
    document.addEventListener('resume', handlePageShow);
    document.addEventListener('keydown', recoverLifecycleFromInteraction, { capture: true });
    window.addEventListener('resize', () => send('resize', { width: innerWidth, height: innerHeight, devicePixelRatio }));
    scheduleLifecycleMonitor();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();\n`;
}

function injectionFileNameForScript(script: string): string {
  return `dynamicwallpaper.inject.${createHash('sha256').update(script).digest('hex').slice(0, 12)}.js`;
}

async function prepareRuntimeAssets(
  workbenchDirectory: string,
  copyAssets: boolean
): Promise<{ directoryName: string; entryFile: string }> {
  const source = path.resolve(__dirname, '..', '..', 'webgl-runtime');
  const contentHash = await hashDirectory(source);
  const directoryName = `dynamicwallpaper.runtime.${contentHash}`;
  const target = path.join(workbenchDirectory, directoryName);
  if (copyAssets) {
    await copyDirectoryIfMissing(source, target);
  }
  return { directoryName, entryFile: path.join(target, 'renderer.html') };
}

async function prepareWebLayers(
  configuration: RendererConfiguration,
  workbenchDirectory: string,
  copyAssets: boolean
): Promise<{ configuration: RendererConfiguration; webDirectoryNames: Set<string>; webEntryFiles: string[] }> {
  const webDirectoryNames = new Set<string>();
  const webEntryFiles: string[] = [];
  const preparedDirectories = new Map<string, Promise<{ directoryName: string; targetDirectory: string }>>();
  const layers = await Promise.all(configuration.layers.map(async layer => {
    if (layer.type !== 'web' || !layer.sourcePath) return layer;
    const sourceDirectory = path.dirname(layer.sourcePath);
    const normalizedSource = normalizeFilesystemIdentity(sourceDirectory);
    let preparation = preparedDirectories.get(normalizedSource);
    if (!preparation) {
      preparation = (async () => {
        const contentHash = await hashDirectory(sourceDirectory);
        const directoryName = `dynamicwallpaper.web.${contentHash}`;
        const targetDirectory = path.join(workbenchDirectory, directoryName);
        if (copyAssets) await copyDirectoryIfMissing(sourceDirectory, targetDirectory);
        return { directoryName, targetDirectory };
      })();
      preparedDirectories.set(normalizedSource, preparation);
    }
    const { directoryName, targetDirectory } = await preparation;
    const entryName = path.basename(layer.sourcePath);
    webDirectoryNames.add(directoryName);
    webEntryFiles.push(path.join(targetDirectory, entryName));
    const { sourcePath: _sourcePath, ...serializableLayer } = layer;
    return { ...serializableLayer, sourceUri: `./${directoryName}/${encodeURIComponent(entryName)}` };
  }));
  return { configuration: { ...configuration, layers }, webDirectoryNames, webEntryFiles };
}

function normalizeFilesystemIdentity(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function hashDirectory(directory: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(current: string, relative: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relativePath = path.join(relative, entry.name).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) throw new Error(`壁纸资源目录不能包含符号链接：${full}`);
      if (entry.isDirectory()) await visit(full, relativePath);
      else if (entry.isFile()) {
        hash.update(relativePath); hash.update('\0'); hash.update(await fs.readFile(full)); hash.update('\0');
      }
    }
  }
  await visit(directory, '');
  return hash.digest('hex').slice(0, 12);
}

async function copyDirectoryIfMissing(source: string, target: string): Promise<void> {
  try { if ((await fs.stat(target)).isDirectory()) return; } catch { /* Copy below. */ }
  const temporaryTarget = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.cp(source, temporaryTarget, { recursive: true, force: false, errorOnExist: true });
  try {
    await fs.rename(temporaryTarget, target);
  } catch (error) {
    try {
      if ((await fs.stat(target)).isDirectory()) {
        await fs.rm(temporaryTarget, { recursive: true, force: true });
        return;
      }
    } catch { /* Preserve the rename error. */ }
    throw error;
  }
}

async function createBackupIfMissing(source: string, backup: string): Promise<void> {
  try { await fs.access(backup); } catch { await fs.copyFile(source, backup); }
}

async function removeStaleInjectionFiles(directory: string, keep?: string): Promise<void> {
  await removeMatching(directory, INJECTION_FILE_PATTERN, new Set(keep ? [keep] : []), false);
}

async function removeStaleWebDirectories(directory: string, keep: Set<string>): Promise<void> {
  await removeMatching(directory, WEB_DIRECTORY_PATTERN, keep, true);
}

async function removeStaleRuntimeDirectories(directory: string, keep: Set<string>): Promise<void> {
  await removeMatching(directory, RUNTIME_DIRECTORY_PATTERN, keep, true);
}

async function removeMatching(
  directory: string,
  pattern: RegExp,
  keep: Set<string>,
  isDirectory: boolean
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const matchingType = isDirectory ? entry.isDirectory() : entry.isFile();
    if (!matchingType || keep.has(entry.name) || !pattern.test(entry.name)) continue;
    try {
      const target = path.join(directory, entry.name);
      if (isDirectory) await fs.rm(target, { recursive: true, force: true });
      else await fs.unlink(target);
    } catch {
      // Stale assets are harmless if VS Code temporarily holds them open.
    }
  }
}
