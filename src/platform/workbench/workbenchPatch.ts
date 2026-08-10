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

export async function applyWorkbenchPatch(
  appRoot: string,
  configuration: RendererConfiguration
): Promise<PatchResult> {
  const workbenchHtml = await findWorkbenchHtml(appRoot);
  const workbenchDirectory = path.dirname(workbenchHtml);
  const backupFile = `${workbenchHtml}.dynamicwallpaper.backup`;
  const prepared = await prepareWebLayers(configuration, workbenchDirectory, true);
  const injectionScript = buildInjectionScript(prepared.configuration);
  const injectionFileName = injectionFileNameForScript(injectionScript);
  const injectionFile = path.join(workbenchDirectory, injectionFileName);

  const originalHtml = await fs.readFile(workbenchHtml, 'utf8');
  const cleanedHtml = removePatchBlock(originalHtml);
  const patchedHtml = insertPatchBlock(cleanedHtml, injectionFileName);

  await createBackupIfMissing(workbenchHtml, backupFile);
  await fs.writeFile(injectionFile, injectionScript, 'utf8');
  await fs.writeFile(workbenchHtml, patchedHtml, 'utf8');
  await removeStaleInjectionFiles(workbenchDirectory, injectionFileName);
  await removeStaleWebDirectories(workbenchDirectory, prepared.webDirectoryNames);

  return { workbenchHtml, injectionFile };
}

export async function getWorkbenchPatchStatus(
  appRoot: string,
  configuration: RendererConfiguration
): Promise<WorkbenchPatchStatus> {
  const workbenchHtml = await findWorkbenchHtml(appRoot);
  const html = await fs.readFile(workbenchHtml, 'utf8');
  if (!html.includes(PATCH_START)) {
    return 'missing';
  }

  const prepared = await prepareWebLayers(configuration, path.dirname(workbenchHtml), false);
  const injectionScript = buildInjectionScript(prepared.configuration);
  const injectionFileName = injectionFileNameForScript(injectionScript);
  if (!html.includes(`src="./${injectionFileName}"`)) {
    return 'stale';
  }

  try {
    for (const entry of prepared.webEntryFiles) {
      if (!(await fs.stat(entry)).isFile()) {
        return 'stale';
      }
    }
    const installedScript = await fs.readFile(
      path.join(path.dirname(workbenchHtml), injectionFileName),
      'utf8'
    );
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

  return { workbenchHtml, injectionFile };
}

export async function findWorkbenchHtml(appRoot: string): Promise<string> {
  const relativeCandidates = [
    ['out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'],
    ['out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.html']
  ];

  for (const parts of relativeCandidates) {
    const candidate = path.join(appRoot, ...parts);
    try {
      if ((await fs.stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next VS Code layout.
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

  const after = end + PATCH_END.length;
  return html.slice(0, start) + html.slice(after);
}

export function insertPatchBlock(
  html: string,
  injectionFileName: string = INJECTION_FILE_NAME
): string {
  const closingTag = html.lastIndexOf('</html>');
  if (closingTag < 0) {
    throw new Error('Workbench HTML 中没有 </html>，无法安全注入。');
  }

  const before = html.slice(0, closingTag);
  const after = html.slice(closingTag);
  const patchBlock = `${PATCH_START}
<script src="./${injectionFileName}"></script>
${PATCH_END}`;
  return `${before}${patchBlock}${after}`;
}

export function buildInjectionScript(configuration: RendererConfiguration): string {
  const serialized = JSON.stringify(configuration).replace(/</g, '\\u003c');
  const isFrontLayer = configuration.renderLayer === 'front';
  const rootZIndex = isFrontLayer ? 2147483000 : 0;
  const rootOpacity = isFrontLayer ? 1 - configuration.surfaceOpacity : 1;
  const behindWorkbenchCss = isFrontLayer ? '' : `
      body > .monaco-workbench {
        position: relative;
        z-index: 1;
        background-color: transparent !important;
      }
      .monaco-workbench .part.editor,
      .monaco-workbench .part.editor > .content,
      .monaco-workbench .part.editor .editor-group-container,
      .monaco-workbench .part.editor .editor-container,
      .monaco-workbench .part.editor .editor-pane,
      .monaco-workbench .part.editor .editor-instance,
      .monaco-workbench .part.editor .text-file-editor,
      .monaco-workbench .part.editor .monaco-editor,
      .monaco-workbench .part.editor .monaco-editor-background,
      .monaco-workbench .part.editor .margin,
      .monaco-workbench .part.sidebar,
      .monaco-workbench .part.auxiliarybar,
      .monaco-workbench .part.panel,
      .monaco-workbench .part.activitybar,
      .monaco-workbench .part.titlebar,
      .monaco-workbench .part.statusbar {
        background-color: color-mix(
          in srgb,
          var(--vscode-editor-background) ${Math.round(configuration.surfaceOpacity * 100)}%,
          transparent
        ) !important;
      }
      .monaco-workbench .part.editor .monaco-editor .overflow-guard,
      .monaco-workbench .part.editor .monaco-editor .monaco-scrollable-element,
      .monaco-workbench .part.editor .monaco-editor .lines-content,
      .monaco-workbench .part.editor .monaco-editor .view-lines,
      .monaco-workbench .part.editor .editor-group-watermark,
      .monaco-workbench .part.editor .empty,
      .monaco-workbench .part.sidebar .content,
      .monaco-workbench .part.auxiliarybar .content,
      .monaco-workbench .part.panel .content,
      .monaco-workbench .pane-body,
      .monaco-workbench .composite {
        background-color: transparent !important;
        background: transparent !important;
      }
  `;
  const mediaOpaqueCss = configuration.opaqueEditorForMedia ? `
      body.dwr-media-editor-opaque .monaco-workbench .part.editor,
      body.dwr-media-editor-opaque .monaco-workbench .part.editor > .content,
      body.dwr-media-editor-opaque .monaco-workbench .part.editor .editor-group-container,
      body.dwr-media-editor-opaque .monaco-workbench .part.editor .editor-container,
      body.dwr-media-editor-opaque .monaco-workbench .part.editor .editor-pane,
      body.dwr-media-editor-opaque .monaco-workbench .part.editor .editor-instance,
      body.dwr-media-editor-opaque .monaco-workbench .part.editor .monaco-editor,
      body.dwr-media-editor-opaque .monaco-workbench .part.editor .monaco-editor-background,
      body.dwr-media-editor-opaque .monaco-workbench .part.editor .overflow-guard {
        background: var(--vscode-editor-background) !important;
        background-color: var(--vscode-editor-background) !important;
      }
  ` : '';
  return `/* Generated by Dynamic Wallpaper Renderer. Do not edit by hand. */
(() => {
  'use strict';
  const config = ${serialized};
  const ROOT_ID = 'dynamic-wallpaper-engine-root';
  const STYLE_ID = 'dynamic-wallpaper-engine-style';
  const MEDIA_FILE_PATTERN =
    /\\.(?:apng|avif|bmp|gif|ico|jpe?g|png|svg|webp|heic|tiff?|avi|m4v|mkv|mov|mp4|og[gv]|webm|pdf)(?=$|[\\s,;:|?#)\\]])/i;
  const mediaEntries = [];
  const parallaxLayers = [];
  const economyMode = config.performance.profile === 'economy';
  const qualityMode = config.performance.profile === 'quality';
  let rendererRoot;
  let sceneCanvas;
  let suspendTimer = 0;
  let activityCheckTimer = 0;
  let activityPaused = false;
  let appliedActivityPaused;
  let pageVisible = !document.hidden;
  let windowFocused = document.hasFocus();

  function start() {
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    activityPaused = config.pauseWhenUnfocused && (!pageVisible || !windowFocused);

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = \`
      body {
        background: #000 !important;
      }
      #\${ROOT_ID} {
        position: fixed;
        inset: 0;
        z-index: ${rootZIndex};
        overflow: hidden;
        pointer-events: none;
        isolation: isolate;
        contain: strict;
        opacity: ${rootOpacity};
        background: ${isFrontLayer ? 'transparent' : '#000'};
      }
      #\${ROOT_ID} > .dwr-layer,
      #\${ROOT_ID} > .dwr-effect,
      #\${ROOT_ID} > .dwr-scene-canvas > .dwr-layer {
        position: absolute;
        width: 100%;
        height: 100%;
        inset: 0;
        border: 0;
        pointer-events: none;
      }
      #\${ROOT_ID} > .dwr-scene-canvas {
        position: absolute;
        left: 0;
        top: 0;
        overflow: visible;
        pointer-events: none;
        transform-origin: 0 0;
      }
      @keyframes dwr-gradient-motion {
        0% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
        100% { background-position: 0% 50%; }
      }
      @keyframes dwr-grain-motion {
        0% { transform: translate3d(-1%, -1%, 0); }
        25% { transform: translate3d(1%, -2%, 0); }
        50% { transform: translate3d(-2%, 1%, 0); }
        75% { transform: translate3d(2%, 2%, 0); }
        100% { transform: translate3d(-1%, -1%, 0); }
      }
      @keyframes dwr-motion-sway {
        0%, 100% { transform: translate3d(var(--dwr-parallax-x), calc(var(--dwr-parallax-y) + var(--dwr-motion-y-negative)), 0) var(--dwr-base-transform) rotate(var(--dwr-motion-rotation-negative)); }
        50% { transform: translate3d(var(--dwr-parallax-x), calc(var(--dwr-parallax-y) + var(--dwr-motion-y)), 0) var(--dwr-base-transform) rotate(var(--dwr-motion-rotation)); }
      }
      @keyframes dwr-motion-water {
        0%, 100% { transform: translate3d(var(--dwr-parallax-x), calc(var(--dwr-parallax-y) + var(--dwr-motion-y-negative)), 0) var(--dwr-base-transform) skewX(var(--dwr-motion-skew-negative)); }
        50% { transform: translate3d(var(--dwr-parallax-x), calc(var(--dwr-parallax-y) + var(--dwr-motion-y)), 0) var(--dwr-base-transform) skewX(var(--dwr-motion-skew)); }
      }
      @keyframes dwr-motion-float {
        0%, 100% { transform: translate3d(var(--dwr-parallax-x), calc(var(--dwr-parallax-y) + var(--dwr-motion-y-negative)), 0) var(--dwr-base-transform); }
        50% { transform: translate3d(var(--dwr-parallax-x), calc(var(--dwr-parallax-y) + var(--dwr-motion-y)), 0) var(--dwr-base-transform); }
      }
      @keyframes dwr-motion-pulse {
        0%, 100% { transform: translate3d(var(--dwr-parallax-x), var(--dwr-parallax-y), 0) var(--dwr-base-transform) scale(1); }
        50% { transform: translate3d(var(--dwr-parallax-x), var(--dwr-parallax-y), 0) var(--dwr-base-transform) scale(var(--dwr-motion-scale)); }
      }
      @keyframes dwr-motion-shake {
        0%, 100% { transform: translate3d(var(--dwr-parallax-x), var(--dwr-parallax-y), 0) var(--dwr-base-transform); }
        20% { transform: translate3d(calc(var(--dwr-parallax-x) + var(--dwr-motion-x-negative)), calc(var(--dwr-parallax-y) + var(--dwr-motion-y)), 0) var(--dwr-base-transform); }
        40% { transform: translate3d(calc(var(--dwr-parallax-x) + var(--dwr-motion-x)), calc(var(--dwr-parallax-y) + var(--dwr-motion-y-negative)), 0) var(--dwr-base-transform); }
        60% { transform: translate3d(calc(var(--dwr-parallax-x) + var(--dwr-motion-x-negative)), calc(var(--dwr-parallax-y) + var(--dwr-motion-y-negative)), 0) var(--dwr-base-transform); }
        80% { transform: translate3d(calc(var(--dwr-parallax-x) + var(--dwr-motion-x)), calc(var(--dwr-parallax-y) + var(--dwr-motion-y)), 0) var(--dwr-base-transform); }
      }
      @keyframes dwr-motion-drift {
        0%, 100% { transform: translate3d(calc(var(--dwr-parallax-x) + var(--dwr-motion-x-negative)), var(--dwr-parallax-y), 0) var(--dwr-base-transform); }
        50% { transform: translate3d(calc(var(--dwr-parallax-x) + var(--dwr-motion-x)), var(--dwr-parallax-y), 0) var(--dwr-base-transform); }
      }
      ${behindWorkbenchCss}
      ${mediaOpaqueCss}
    \`;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = ROOT_ID;
    rendererRoot = root;
    root.style.backgroundColor = config.renderLayer === 'front'
      ? 'transparent'
      : config.backgroundColor;

    let layerParent = root;
    if (config.sceneCanvas) {
      sceneCanvas = document.createElement('div');
      sceneCanvas.className = 'dwr-scene-canvas';
      sceneCanvas.style.width = config.sceneCanvas.width + 'px';
      sceneCanvas.style.height = config.sceneCanvas.height + 'px';
      root.appendChild(sceneCanvas);
      layerParent = sceneCanvas;
      layoutSceneCanvas();
      window.addEventListener('resize', layoutSceneCanvas, { passive: true });
    }

    for (const layer of config.layers) {
      const element = createLayer(layer);
      layerParent.appendChild(element);
    }
    appendEffects(root);
    document.body.prepend(root);
    setupMediaEditorProtection();

    if (config.pauseWhenUnfocused) {
      document.addEventListener('visibilitychange', () => {
        pageVisible = !document.hidden;
        if (!pageVisible) {
          updateActivityState(true);
        } else {
          scheduleActivityReconciliation();
        }
      });
      window.addEventListener('focus', () => {
        windowFocused = true;
        updateActivityState(!pageVisible);
        scheduleActivityReconciliation();
      });
      window.addEventListener('blur', () => {
        windowFocused = false;
        updateActivityState(true);
        scheduleActivityReconciliation();
      });
      window.addEventListener('pageshow', () => {
        pageVisible = !document.hidden;
        windowFocused = document.hasFocus();
        scheduleActivityReconciliation();
      });
      window.addEventListener('pagehide', () => {
        pageVisible = false;
        updateActivityState(true);
        suspendMedia();
      });
      document.addEventListener('freeze', () => {
        updateActivityState(true);
        suspendMedia();
      });
      document.addEventListener('resume', scheduleActivityReconciliation);
      window.setInterval(reconcileActivityState, 1000);
      updateActivityState(activityPaused, true);
    }

    if (parallaxLayers.length > 0 && !economyMode) {
      let animationFrame = 0;
      let pointerX = 0;
      let pointerY = 0;
      window.addEventListener('pointermove', event => {
        pointerX = event.clientX / Math.max(window.innerWidth, 1) - 0.5;
        pointerY = event.clientY / Math.max(window.innerHeight, 1) - 0.5;
        if (animationFrame) return;
        animationFrame = requestAnimationFrame(() => {
          animationFrame = 0;
          for (const item of parallaxLayers) {
            const x = pointerX * item.amount;
            const y = pointerY * item.amount;
            item.element.style.setProperty('--dwr-parallax-x', x + 'px');
            item.element.style.setProperty('--dwr-parallax-y', y + 'px');
          }
        });
      }, { passive: true });
    }
  }

  function layoutSceneCanvas() {
    if (!sceneCanvas || !config.sceneCanvas) return;
    const canvasWidth = Math.max(config.sceneCanvas.width, 1);
    const canvasHeight = Math.max(config.sceneCanvas.height, 1);
    const scale = Math.max(
      window.innerWidth / canvasWidth,
      window.innerHeight / canvasHeight
    );
    const left = (window.innerWidth - canvasWidth * scale) / 2;
    const top = (window.innerHeight - canvasHeight * scale) / 2;
    sceneCanvas.style.transform =
      'translate3d(' + left + 'px,' + top + 'px,0) scale(' + scale + ')';
  }

  function createLayer(layer) {
    let element;
    if (layer.type === 'video') {
      element = document.createElement('video');
      element.preload = 'metadata';
      element.autoplay = true;
      element.loop = true;
      element.muted = layer.muted;
      element.defaultMuted = layer.muted;
      element.playsInline = true;
      element.disablePictureInPicture = true;
      element.disableRemotePlayback = true;
      element.volume = layer.muted ? 0 : 1;
      element.playbackRate = layer.playbackRate;
      element.src = layer.sourceUri;
      element.addEventListener('canplay', () => {
        element.playbackRate = layer.playbackRate;
        if (activityPaused) {
          element.pause();
        } else {
          void element.play().catch(() => {});
        }
      });
      element.addEventListener('playing', () => {
        if (activityPaused) element.pause();
      });
      mediaEntries.push({
        element,
        source: layer.sourceUri,
        type: layer.type,
        playbackRate: layer.playbackRate
      });
    } else if (layer.type === 'image') {
      element = document.createElement('img');
      element.src = layer.sourceUri;
      element.alt = '';
      element.decoding = 'async';
      element.loading = 'eager';
      mediaEntries.push({ element, source: layer.sourceUri, type: layer.type });
    } else if (layer.type === 'web') {
      element = document.createElement('iframe');
      element.src = layer.sourceUri;
      element.setAttribute('allow', 'autoplay');
      element.setAttribute('sandbox', 'allow-scripts');
      element.addEventListener('load', () => {
        setWebLayerActivity(element, activityPaused);
      });
      mediaEntries.push({ element, source: layer.sourceUri, type: layer.type });
    } else if (layer.type === 'particle') {
      element = document.createElement('canvas');
      startParticleRenderer(element, layer);
    } else {
      element = document.createElement('div');
      element.style.backgroundImage =
        'linear-gradient(' + layer.angle + 'deg,' + layer.colors.join(',') + ')';
      element.style.backgroundSize = '300% 300%';
      element.style.backgroundPosition = layer.position;
      if (layer.animationDuration > 0 && !economyMode) {
        element.style.animation =
          'dwr-gradient-motion ' + layer.animationDuration + 's ease infinite';
        element.dataset.dwrAnimated = 'true';
      }
    }

    element.className = 'dwr-layer dwr-layer-' + layer.type;
    element.dataset.layerId = layer.id;
    element.style.opacity = String(layer.opacity);
    element.style.mixBlendMode = layer.blendMode;
    element.style.objectFit = layer.fit;
    element.style.objectPosition = layer.position;
    element.style.filter = filterString(layer.filters);
    if (layer.layout) {
      element.style.inset = 'auto';
      element.style.left = layer.layout.left + '%';
      element.style.top = layer.layout.top + '%';
      element.style.width = layer.layout.width + '%';
      element.style.height = layer.layout.height + '%';
      if (layer.type === 'image' || layer.type === 'video') {
        element.style.objectFit = 'fill';
      }
    }
    const transforms = [];
    if (layer.scale !== 1) transforms.push('scale(' + layer.scale + ')');
    if (layer.rotate !== 0) transforms.push('rotate(' + layer.rotate + 'deg)');
    const baseTransform = transforms.join(' ') || 'translateZ(0)';
    element.style.setProperty('--dwr-base-transform', baseTransform);
    element.style.setProperty('--dwr-parallax-x', '0px');
    element.style.setProperty('--dwr-parallax-y', '0px');
    element.style.transform = 'translate3d(var(--dwr-parallax-x), var(--dwr-parallax-y), 0) '
      + baseTransform;
    if (layer.parallax !== 0 && !economyMode) {
      parallaxLayers.push({ element, amount: layer.parallax, baseTransform });
    }
    applyLayerMotion(element, layer.motion);
    return element;
  }

  function applyLayerMotion(element, motion) {
    if (!motion || motion.type === 'none' || motion.intensity <= 0 || economyMode) return;
    const intensity = motion.intensity;
    element.style.setProperty('--dwr-motion-x', intensity + 'px');
    element.style.setProperty('--dwr-motion-x-negative', -intensity + 'px');
    element.style.setProperty('--dwr-motion-y', intensity + 'px');
    element.style.setProperty('--dwr-motion-y-negative', -intensity + 'px');
    element.style.setProperty('--dwr-motion-rotation', (intensity * 0.08) + 'deg');
    element.style.setProperty('--dwr-motion-rotation-negative', (-intensity * 0.08) + 'deg');
    element.style.setProperty('--dwr-motion-skew', (intensity * 0.05) + 'deg');
    element.style.setProperty('--dwr-motion-skew-negative', (-intensity * 0.05) + 'deg');
    element.style.setProperty('--dwr-motion-scale', String(1 + intensity / 500));
    element.style.animation = 'dwr-motion-' + motion.type + ' '
      + motion.duration + 's ease-in-out ' + motion.delay + 's infinite';
    element.dataset.dwrAnimated = 'true';
  }

  function startParticleRenderer(canvas, layer) {
    const settings = layer.particle;
    if (!settings) return;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return;
    const particles = [];
    const sprite = layer.sourceUri ? new Image() : undefined;
    if (sprite) sprite.src = layer.sourceUri;
    const countScale = economyMode ? 0.35 : qualityMode ? 1 : 0.7;
    const maximum = Math.max(1, Math.round(settings.maxCount * countScale));
    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let previousTime = performance.now();
    let spawnBudget = 0;

    function resize() {
      const nextWidth = Math.max(1, canvas.clientWidth);
      const nextHeight = Math.max(1, canvas.clientHeight);
      const nextRatio = qualityMode ? Math.min(window.devicePixelRatio || 1, 2) : 1;
      if (nextWidth === width && nextHeight === height && nextRatio === pixelRatio) return;
      width = nextWidth;
      height = nextHeight;
      pixelRatio = nextRatio;
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    }

    function randomBetween(minimum, maximumValue) {
      return minimum + Math.random() * Math.max(0, maximumValue - minimum);
    }

    function spawnParticle() {
      const preset = settings.preset;
      const life = randomBetween(settings.lifetimeMin, settings.lifetimeMax);
      const scale = width / 1920;
      const speed = randomBetween(settings.speedMin, settings.speedMax) * scale;
      const angle = Math.atan2(-settings.directionY, settings.directionX)
        + randomBetween(-settings.spread, settings.spread);
      const emitterWidth = settings.emitterWidth * scale;
      const emitterHeight = settings.emitterHeight * scale;
      const emitterCenterX = settings.emitterX * width;
      const emitterCenterY = settings.emitterY * height;
      let x = emitterCenterX;
      let y = emitterCenterY;
      if (settings.emitterShape === 'viewport') {
        x = Math.random() * width;
        y = Math.random() * height;
      } else if (settings.emitterShape === 'box') {
        x += randomBetween(-emitterWidth / 2, emitterWidth / 2);
        y += randomBetween(-emitterHeight / 2, emitterHeight / 2);
      } else if (settings.emitterShape === 'sphere') {
        const emitterAngle = Math.random() * Math.PI * 2;
        const emitterRadius = Math.sqrt(Math.random());
        x += Math.cos(emitterAngle) * emitterWidth * emitterRadius / 2;
        y += Math.sin(emitterAngle) * emitterHeight * emitterRadius / 2;
      }
      let velocityX = Math.cos(angle) * speed;
      let velocityY = Math.sin(angle) * speed;
      if (settings.emitterShape === 'viewport' && preset === 'embers') {
        y = height + 10;
        velocityX += randomBetween(-12, 12) * scale;
        velocityY = -Math.max(speed, 15 * scale);
      } else if (settings.emitterShape === 'viewport' && preset === 'fog') {
        x = -Math.max(20, settings.sizeMax * scale);
        velocityX = Math.max(speed, 8 * scale);
        velocityY *= 0.15;
      } else if (settings.emitterShape === 'viewport' && preset === 'rain') {
        y = -20;
        velocityX = randomBetween(-20, -5) * scale;
        velocityY = Math.max(speed, 180 * scale);
      } else if (settings.emitterShape === 'viewport' && preset === 'snow') {
        y = -20;
        velocityX = randomBetween(-18, 18) * scale;
        velocityY = Math.max(speed, 15 * scale);
      } else if (settings.emitterShape === 'viewport' && preset === 'stars') {
        x = randomBetween(-width * 0.2, width * 0.8);
        y = randomBetween(-height * 0.1, height * 0.65);
        velocityX = Math.max(speed, 80 * scale);
        velocityY = velocityX * randomBetween(0.2, 0.55);
      }
      particles.push({
        x,
        y,
        velocityX,
        velocityY,
        age: 0,
        life,
        size: randomBetween(settings.sizeMin, settings.sizeMax) * scale,
        opacity: randomBetween(settings.opacityMin, settings.opacityMax),
        color: settings.colors[Math.floor(Math.random() * settings.colors.length)],
        rotation: Math.random() * Math.PI * 2,
        spin: randomBetween(-0.35, 0.35)
      });
    }

    function render(time) {
      resize();
      const delta = Math.min(0.05, Math.max(0, (time - previousTime) / 1000));
      previousTime = time;
      if (!activityPaused) {
        context.clearRect(0, 0, width, height);
        spawnBudget += delta * settings.spawnRate * countScale;
        while (spawnBudget >= 1 && particles.length < maximum) {
          spawnParticle();
          spawnBudget -= 1;
        }
        for (let index = particles.length - 1; index >= 0; index--) {
          const particle = particles[index];
          particle.age += delta;
          if (particle.age >= particle.life) {
            particles.splice(index, 1);
            continue;
          }
          if (settings.turbulence > 0) {
            const turbulence = settings.turbulence * (width / 1920) * delta;
            particle.velocityX += randomBetween(-turbulence, turbulence);
            particle.velocityY += randomBetween(-turbulence, turbulence);
          }
          particle.x += particle.velocityX * delta;
          particle.y += particle.velocityY * delta;
          particle.rotation += particle.spin * delta;
          const progress = particle.age / particle.life;
          const fade = Math.min(1, progress * 6, (1 - progress) * 4);
          context.save();
          context.globalAlpha = particle.opacity * Math.max(0, fade);
          context.translate(particle.x, particle.y);
          context.rotate(particle.rotation);
          if (settings.trail || settings.preset === 'rain') {
            context.strokeStyle = particle.color;
            context.lineWidth = Math.max(1, particle.size * 0.18);
            context.beginPath();
            context.moveTo(-particle.size * 2.5, 0);
            context.lineTo(particle.size * 0.5, 0);
            context.stroke();
          } else if (sprite?.complete && sprite.naturalWidth > 0) {
            context.drawImage(
              sprite,
              -particle.size / 2,
              -particle.size / 2,
              particle.size,
              particle.size
            );
          } else {
            const gradient = context.createRadialGradient(0, 0, 0, 0, 0, particle.size / 2);
            gradient.addColorStop(0, particle.color);
            gradient.addColorStop(1, 'transparent');
            context.fillStyle = gradient;
            context.beginPath();
            context.arc(0, 0, particle.size / 2, 0, Math.PI * 2);
            context.fill();
          }
          context.restore();
        }
      }
      requestAnimationFrame(render);
    }
    requestAnimationFrame(render);
  }

  function filterString(filters) {
    const values = [];
    const blurLimit = qualityMode ? 100 : economyMode ? 4 : 24;
    const blur = Math.min(filters.blur, blurLimit);
    if (blur > 0) values.push('blur(' + blur + 'px)');
    if (filters.brightness !== 1) values.push('brightness(' + filters.brightness + ')');
    if (filters.contrast !== 1) values.push('contrast(' + filters.contrast + ')');
    if (filters.saturation !== 1) values.push('saturate(' + filters.saturation + ')');
    if (filters.hueRotate !== 0) values.push('hue-rotate(' + filters.hueRotate + 'deg)');
    if (filters.grayscale !== 0) values.push('grayscale(' + filters.grayscale + ')');
    return values.length > 0 ? values.join(' ') : 'none';
  }

  function appendEffects(root) {
    if (config.effects.overlayColor && config.effects.overlayOpacity > 0) {
      appendEffect(root, 'overlay', config.effects.overlayOpacity, config.effects.overlayColor);
    }
    if (config.effects.vignette > 0) {
      appendEffect(
        root,
        'vignette',
        config.effects.vignette,
        'radial-gradient(circle at center, transparent 35%, rgba(0,0,0,.92) 100%)'
      );
    }
    if (config.effects.grain > 0 && !economyMode) {
      const grain = appendEffect(
        root,
        'grain',
        config.effects.grain,
        'repeating-radial-gradient(circle at 30% 40%, rgba(255,255,255,.38) 0 1px, transparent 1px 3px)'
      );
      grain.style.backgroundSize = '5px 5px';
      grain.style.mixBlendMode = 'soft-light';
      if (qualityMode) {
        grain.style.animation = 'dwr-grain-motion .5s steps(2) infinite';
        grain.dataset.dwrAnimated = 'true';
      }
    }
    if (config.effects.scanlines > 0 && !economyMode) {
      const scanlines = appendEffect(
        root,
        'scanlines',
        config.effects.scanlines,
        'repeating-linear-gradient(to bottom, transparent 0 2px, rgba(0,0,0,.75) 2px 3px)'
      );
      scanlines.style.mixBlendMode = 'multiply';
    }
  }

  function appendEffect(root, name, opacity, background) {
    const effect = document.createElement('div');
    effect.className = 'dwr-effect dwr-effect-' + name;
    effect.style.opacity = String(opacity);
    if (/gradient\\(/.test(background)) {
      effect.style.backgroundImage = background;
    } else {
      effect.style.backgroundColor = background;
    }
    root.appendChild(effect);
    return effect;
  }

  function setupMediaEditorProtection() {
    if (!config.opaqueEditorForMedia) return;

    const observedContainers = new WeakSet();
    const observedGroups = new WeakSet();
    let scheduledFrame = 0;
    const tabObserver = new MutationObserver(scheduleUpdate);
    const editorPart = document.querySelector('.monaco-workbench .part.editor');

    function observeTabContainers() {
      for (const group of document.querySelectorAll(
        '.monaco-workbench .part.editor .editor-group-container'
      )) {
        if (observedGroups.has(group)) continue;
        observedGroups.add(group);
        tabObserver.observe(group, {
          attributes: true,
          attributeFilter: ['class']
        });
      }
      for (const container of document.querySelectorAll(
        '.monaco-workbench .part.editor .tabs-container'
      )) {
        if (observedContainers.has(container)) continue;
        observedContainers.add(container);
        tabObserver.observe(container, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['class', 'aria-selected', 'data-resource-name', 'title']
        });
      }
    }

    function scheduleUpdate() {
      if (scheduledFrame) return;
      scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = 0;
        observeTabContainers();
        updateMediaEditorProtection();
      });
    }

    observeTabContainers();
    document.addEventListener('click', scheduleUpdate, { capture: true, passive: true });
    document.addEventListener('keydown', scheduleUpdate, { capture: true });
    window.addEventListener('resize', scheduleUpdate, { passive: true });
    if (editorPart && typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(scheduleUpdate).observe(editorPart);
    }
    updateMediaEditorProtection();
  }

  function updateMediaEditorProtection() {
    const editorPart = document.querySelector('.monaco-workbench .part.editor');
    const activeGroup = document.querySelector(
      '.monaco-workbench .part.editor .editor-group-container.active'
    );
    const tabScope = activeGroup
      || document.querySelector('.monaco-workbench .part.editor .editor-group-container');
    const activeTab = tabScope?.querySelector(
      '.tabs-container .tab.active, .tabs-container .tab[aria-selected="true"]'
    );
    const tabText = activeTab
      ? [
          activeTab.getAttribute('data-resource-name'),
          activeTab.getAttribute('aria-label'),
          activeTab.getAttribute('title'),
          activeTab.querySelector('.label-name')?.textContent
        ].filter(Boolean).join(' ')
      : '';
    const isMediaFile = MEDIA_FILE_PATTERN.test(tabText);
    document.body.classList.toggle('dwr-media-editor-opaque', isMediaFile);

    if (!rendererRoot || config.renderLayer !== 'front') return;
    if (!isMediaFile || !editorPart) {
      rendererRoot.style.clipPath = '';
      return;
    }

    const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth);
    const viewportHeight = Math.max(document.documentElement.clientHeight, window.innerHeight);
    const rect = editorPart.getBoundingClientRect();
    const left = Math.max(0, Math.min(viewportWidth, rect.left));
    const top = Math.max(0, Math.min(viewportHeight, rect.top));
    const right = Math.max(left, Math.min(viewportWidth, rect.right));
    const bottom = Math.max(top, Math.min(viewportHeight, rect.bottom));
    rendererRoot.style.clipPath =
      'polygon(evenodd, 0 0, ' + viewportWidth + 'px 0, '
      + viewportWidth + 'px ' + viewportHeight + 'px, 0 '
      + viewportHeight + 'px, 0 0, '
      + left + 'px ' + top + 'px, '
      + left + 'px ' + bottom + 'px, '
      + right + 'px ' + bottom + 'px, '
      + right + 'px ' + top + 'px, '
      + left + 'px ' + top + 'px)';
  }

  function scheduleActivityReconciliation() {
    window.clearTimeout(activityCheckTimer);
    activityCheckTimer = window.setTimeout(reconcileActivityState, 100);
  }

  function reconcileActivityState() {
    pageVisible = !document.hidden;
    windowFocused = document.hasFocus();
    updateActivityState(!pageVisible || !windowFocused);
  }

  function updateActivityState(shouldPause, force = false) {
    activityPaused = shouldPause;
    if (!force && appliedActivityPaused === shouldPause) return;
    appliedActivityPaused = shouldPause;
    window.clearTimeout(suspendTimer);
    suspendTimer = 0;
    if (shouldPause) {
      for (const entry of mediaEntries) {
        if (entry.element instanceof HTMLVideoElement) {
          entry.element.pause();
        } else if (entry.element instanceof HTMLIFrameElement) {
          setWebLayerActivity(entry.element, true);
        }
      }
      setAnimationState('paused');
      if (config.performance.suspendAfterSeconds > 0) {
        suspendTimer = window.setTimeout(
          suspendMedia,
          config.performance.suspendAfterSeconds * 1000
        );
      }
      return;
    }

    resumeMedia();
    for (const entry of mediaEntries) {
      if (entry.element instanceof HTMLIFrameElement) {
        setWebLayerActivity(entry.element, false);
      }
    }
    setAnimationState('running');
  }

  function setWebLayerActivity(element, paused) {
    element.contentWindow?.postMessage({
      type: 'dynamic-wallpaper-activity',
      paused
    }, '*');
  }

  function setAnimationState(state) {
    if (!rendererRoot) return;
    for (const animated of rendererRoot.querySelectorAll('[data-dwr-animated]')) {
      animated.style.animationPlayState = state;
    }
  }

  function suspendMedia() {
    window.clearTimeout(suspendTimer);
    suspendTimer = 0;
    for (const entry of mediaEntries) {
      const element = entry.element;
      if (element.dataset.dwrSuspended === 'true') continue;
      if (element instanceof HTMLVideoElement) {
        element.pause();
        captureVideoFrame(entry, element);
        element.removeAttribute('src');
        element.load();
        element.dataset.dwrSuspended = 'true';
      }
    }
  }

  function captureVideoFrame(entry, element) {
    if (
      element.readyState < 2
      || element.videoWidth <= 0
      || element.videoHeight <= 0
    ) {
      return;
    }

    const scale = Math.min(
      1,
      1920 / element.videoWidth,
      1080 / element.videoHeight
    );
    const snapshot = document.createElement('canvas');
    snapshot.width = Math.max(1, Math.round(element.videoWidth * scale));
    snapshot.height = Math.max(1, Math.round(element.videoHeight * scale));
    snapshot.className = element.className + ' dwr-media-snapshot';
    snapshot.style.cssText = element.style.cssText;
    snapshot.dataset.layerId = element.dataset.layerId || '';
    try {
      const context = snapshot.getContext('2d', { alpha: false });
      if (!context) return;
      context.drawImage(element, 0, 0, snapshot.width, snapshot.height);
      entry.snapshot?.remove();
      entry.snapshot = snapshot;
      element.after(snapshot);
    } catch {
      snapshot.remove();
    }
  }

  function resumeMedia() {
    for (const entry of mediaEntries) {
      const element = entry.element;
      if (element.dataset.dwrSuspended === 'true') {
        element.src = entry.source;
        delete element.dataset.dwrSuspended;
        if (element instanceof HTMLVideoElement) {
          if (entry.snapshot) {
            element.addEventListener('loadeddata', () => {
              entry.snapshot?.remove();
              entry.snapshot = undefined;
            }, { once: true });
          }
          element.load();
        }
      }
      if (element instanceof HTMLVideoElement) {
        element.playbackRate = entry.playbackRate;
        if (!activityPaused && element.readyState >= 2) {
          void element.play().catch(() => {});
        }
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
`;
}

function injectionFileNameForScript(injectionScript: string): string {
  const contentHash = createHash('sha256').update(injectionScript).digest('hex').slice(0, 12);
  return `dynamicwallpaper.inject.${contentHash}.js`;
}

async function prepareWebLayers(
  configuration: RendererConfiguration,
  workbenchDirectory: string,
  copyAssets: boolean
): Promise<{
  configuration: RendererConfiguration;
  webDirectoryNames: Set<string>;
  webEntryFiles: string[];
}> {
  const webDirectoryNames = new Set<string>();
  const webEntryFiles: string[] = [];
  const layers = await Promise.all(configuration.layers.map(async layer => {
    if (layer.type !== 'web' || !layer.sourcePath) {
      return layer;
    }

    const sourceDirectory = path.dirname(layer.sourcePath);
    const contentHash = await hashDirectory(sourceDirectory);
    const directoryName = `dynamicwallpaper.web.${contentHash}`;
    const targetDirectory = path.join(workbenchDirectory, directoryName);
    const entryName = path.basename(layer.sourcePath);
    const targetEntry = path.join(targetDirectory, entryName);
    webDirectoryNames.add(directoryName);
    webEntryFiles.push(targetEntry);

    if (copyAssets) {
      await copyDirectoryIfMissing(sourceDirectory, targetDirectory);
    }

    const { sourcePath: _sourcePath, ...serializableLayer } = layer;
    return {
      ...serializableLayer,
      sourceUri: `./${directoryName}/${encodeURIComponent(entryName)}`
    };
  }));

  return {
    configuration: { ...configuration, layers },
    webDirectoryNames,
    webEntryFiles
  };
}

async function hashDirectory(directory: string): Promise<string> {
  const hash = createHash('sha256');

  async function visit(currentDirectory: string, relativeDirectory: string): Promise<void> {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const fullPath = path.join(currentDirectory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) {
        throw new Error(`Web 壁纸目录不能包含符号链接：${fullPath}`);
      }
      if (entry.isDirectory()) {
        await visit(fullPath, relativePath);
      } else if (entry.isFile()) {
        hash.update(relativePath);
        hash.update('\0');
        hash.update(await fs.readFile(fullPath));
        hash.update('\0');
      }
    }
  }

  await visit(directory, '');
  return hash.digest('hex').slice(0, 12);
}

async function copyDirectoryIfMissing(source: string, target: string): Promise<void> {
  try {
    if ((await fs.stat(target)).isDirectory()) {
      return;
    }
  } catch {
    // Copy the content below.
  }

  const temporaryTarget = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.cp(source, temporaryTarget, {
    recursive: true,
    force: false,
    errorOnExist: true
  });
  try {
    await fs.rename(temporaryTarget, target);
  } catch (error) {
    try {
      if ((await fs.stat(target)).isDirectory()) {
        await fs.rm(temporaryTarget, { recursive: true, force: true });
        return;
      }
    } catch {
      // Preserve the original rename error below.
    }
    throw error;
  }
}

async function createBackupIfMissing(source: string, backup: string): Promise<void> {
  try {
    await fs.access(backup);
  } catch {
    await fs.copyFile(source, backup);
  }
}

async function removeStaleInjectionFiles(
  workbenchDirectory: string,
  keepFileName?: string
): Promise<void> {
  const entries = await fs.readdir(workbenchDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isFile()
      || entry.name === keepFileName
      || !INJECTION_FILE_PATTERN.test(entry.name)
    ) {
      continue;
    }
    try {
      await fs.unlink(path.join(workbenchDirectory, entry.name));
    } catch {
      // A stale cached file is harmless if another process temporarily holds it open.
    }
  }
}

async function removeStaleWebDirectories(
  workbenchDirectory: string,
  keepDirectoryNames: Set<string>
): Promise<void> {
  const entries = await fs.readdir(workbenchDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isDirectory()
      || keepDirectoryNames.has(entry.name)
      || !WEB_DIRECTORY_PATTERN.test(entry.name)
    ) {
      continue;
    }
    try {
      await fs.rm(path.join(workbenchDirectory, entry.name), {
        recursive: true,
        force: true
      });
    } catch {
      // A stale Web asset directory is harmless if another process holds it open.
    }
  }
}
