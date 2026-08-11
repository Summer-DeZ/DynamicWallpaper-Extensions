import { expect, test } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { importWallpaperEngineProject } from '../../src/importers/wallpaperEngineImporter';

const repository = path.resolve(__dirname, '..', '..');

test('WebGL2 runtime renders a deterministic native IR and survives context loss', async ({ page }) => {
  const diagnostics: unknown[] = [];
  await page.exposeFunction('captureRuntimeMessage', (message: unknown) => diagnostics.push(message));
  await page.addInitScript(() => {
    window.addEventListener('message', event => {
      if (event.data?.channel === 'dynamic-wallpaper-host') {
        void (window as unknown as { captureRuntimeMessage(message: unknown): Promise<void> }).captureRuntimeMessage(event.data);
      }
    });
  });
  await page.route('http://dwr.local/runtime/**', async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/runtime\//, ''));
    const filename = path.join(repository, 'dist', 'webgl-runtime', relative);
    const extension = path.extname(filename).toLowerCase();
    await route.fulfill({
      status: 200,
      contentType: extension === '.html' ? 'text/html'
        : extension === '.js' ? 'text/javascript'
          : extension === '.css' ? 'text/css'
            : extension === '.wasm' ? 'application/wasm'
              : 'application/octet-stream',
      body: await fs.readFile(filename)
    });
  });
  await page.goto('http://dwr.local/runtime/renderer.html');
  await page.evaluate(() => {
    const configuration = {
      runtime: { protocolVersion: 1, kind: 'native', networkHosts: [], userProperties: {} },
      renderLayer: 'front', surfaceOpacity: 0, backgroundColor: '#081020', pauseWhenUnfocused: false,
      opaqueEditorForMedia: false, opaqueEditorFileTypes: [], performance: { profile: 'quality', maxFps: 60, suspendAfterSeconds: 15 },
      layers: [{ id: 'gradient', type: 'gradient', colors: ['#102060', '#40a0d0'], angle: 45, animationDuration: 0, opacity: 1, blendMode: 'normal', fit: 'cover', position: 'center', scale: 1, rotate: 0, parallax: 0, filters: { blur: 0, brightness: 1, contrast: 1, saturation: 1, hueRotate: 0, grayscale: 0 }, muted: true, playbackRate: 1, motion: { type: 'none', duration: 1, intensity: 0, delay: 0 } }],
      effects: { overlayOpacity: 0, vignette: 0, grain: 0, scanlines: 0 }
    };
    window.postMessage({ channel: 'dynamic-wallpaper-runtime', protocolVersion: 1, type: 'initialize', configuration, userProperties: {} }, '*');
  });
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const gl = document.querySelector('canvas')?.getContext('webgl2');
    return Boolean(gl && gl.drawingBufferWidth > 0);
  })).toBe(true);
  const before = await canvas.screenshot();
  expect(before.byteLength).toBeGreaterThan(1000);
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (canvas) canvas.setAttribute('data-before-context-loss', 'true');
    const gl = canvas?.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    extension?.loseContext();
    setTimeout(() => extension?.restoreContext(), 50);
  });
  await expect(page.locator('canvas:not([data-before-context-loss])')).toHaveCount(1, { timeout: 10_000 });
  expect(diagnostics.some(message => (message as { diagnostics?: Array<{ code?: string }> }).diagnostics?.some(item => item.code === 'webgl-context-lost'))).toBe(true);
  expect(diagnostics.some(message => (message as { type?: string }).type === 'fatal')).toBe(false);
});

test('global post effects use one off-screen framebuffer', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeCreateFramebuffer = WebGL2RenderingContext.prototype.createFramebuffer;
    (window as unknown as { dwrFramebufferCreations: number }).dwrFramebufferCreations = 0;
    WebGL2RenderingContext.prototype.createFramebuffer = function createFramebuffer(): WebGLFramebuffer | null {
      (window as unknown as { dwrFramebufferCreations: number }).dwrFramebufferCreations++;
      return nativeCreateFramebuffer.call(this);
    };
  });
  await page.route('http://dwr.local/runtime/**', async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/runtime\//, ''));
    const filename = path.join(repository, 'dist', 'webgl-runtime', relative);
    const extension = path.extname(filename).toLowerCase();
    await route.fulfill({
      status: 200,
      contentType: extension === '.html' ? 'text/html'
        : extension === '.js' ? 'text/javascript'
          : extension === '.css' ? 'text/css'
            : 'application/octet-stream',
      body: await fs.readFile(filename)
    });
  });
  await page.goto('http://dwr.local/runtime/renderer.html');
  const configuration = nativeConfiguration('none', 15);
  configuration.effects = { overlayOpacity: 0.15, vignette: 0.2, grain: 0, scanlines: 0 };
  await page.evaluate(configuration => window.postMessage({
    channel: 'dynamic-wallpaper-runtime', protocolVersion: 1, type: 'initialize',
    configuration, userProperties: {}
  }, '*'), configuration);

  await expect(page.locator('canvas')).toBeVisible();
  // WebGLRenderer reserves three scratch FBOs; the post-effect pipeline adds
  // exactly one. EffectComposer previously added two (five total).
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { dwrFramebufferCreations: number }).dwrFramebufferCreations
  )).toBe(4);
  expect((await page.locator('canvas').screenshot()).byteLength).toBeGreaterThan(1000);
});

test('visible focus pause retains runtime resources and resumes without a cold rebuild', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks = 0;
    window.requestAnimationFrame = callback => nativeRequestAnimationFrame(time => {
      (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks++;
      callback(time);
    });
  });
  await page.route('http://dwr.local/runtime/**', async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/runtime\//, ''));
    const filename = path.join(repository, 'dist', 'webgl-runtime', relative);
    const extension = path.extname(filename).toLowerCase();
    await route.fulfill({
      status: 200,
      contentType: extension === '.html' ? 'text/html'
        : extension === '.js' ? 'text/javascript'
          : extension === '.css' ? 'text/css'
            : 'application/octet-stream',
      body: await fs.readFile(filename)
    });
  });
  await page.goto('http://dwr.local/runtime/renderer.html');
  await page.evaluate(configuration => window.postMessage({
    channel: 'dynamic-wallpaper-runtime', protocolVersion: 1, type: 'initialize',
    configuration, userProperties: {}
  }, '*'), nativeConfiguration('drift', 0.1));
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  )).toBeGreaterThan(2);
  await page.locator('canvas').evaluate(canvas => {
    canvas.setAttribute('data-runtime-instance', 'visible-pause');
  });

  await page.evaluate(() => window.postMessage({
    channel: 'dynamic-wallpaper-runtime', protocolVersion: 1, type: 'lifecycle',
    paused: true, focused: false, visible: true
  }, '*'));
  await page.waitForTimeout(50);
  const pausedFrameCount = await page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  );
  // Wait well beyond suspendAfterSeconds. A normal focus switch must retain
  // the same GPU/media runtime so returning does not pay cold-start latency.
  await page.waitForTimeout(300);
  await expect(page.locator('canvas[data-runtime-instance="visible-pause"]')).toHaveCount(1);
  expect(await page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  )).toBe(pausedFrameCount);

  await page.evaluate(() => window.postMessage({
    channel: 'dynamic-wallpaper-runtime', protocolVersion: 1, type: 'lifecycle',
    paused: false, focused: true, visible: true
  }, '*'));
  await expect(page.locator('canvas[data-runtime-instance="visible-pause"]')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  ), { timeout: 1_000, intervals: [20, 50, 100] }).toBeGreaterThan(pausedFrameCount);
});

test('static parallax renders on pointer invalidation without keeping a continuous RAF loop', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks = 0;
    window.requestAnimationFrame = callback => nativeRequestAnimationFrame(time => {
      (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks++;
      callback(time);
    });
  });
  await page.route('http://dwr.local/runtime/**', async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/runtime\//, ''));
    const filename = path.join(repository, 'dist', 'webgl-runtime', relative);
    const extension = path.extname(filename).toLowerCase();
    await route.fulfill({
      status: 200,
      contentType: extension === '.html' ? 'text/html'
        : extension === '.js' ? 'text/javascript'
          : extension === '.css' ? 'text/css'
            : 'application/octet-stream',
      body: await fs.readFile(filename)
    });
  });
  await page.goto('http://dwr.local/runtime/renderer.html');
  const configuration = nativeConfiguration('none', 15);
  configuration.layers[0].parallax = 24;
  configuration.effects.vignette = 0.2;
  await page.evaluate(configuration => window.postMessage({
    channel: 'dynamic-wallpaper-runtime', protocolVersion: 1, type: 'initialize',
    configuration, userProperties: {}
  }, '*'), configuration);
  await expect(page.locator('canvas')).toHaveCount(1);
  await page.waitForTimeout(200);
  const idleFrames = await page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  );
  await page.waitForTimeout(200);
  expect(await page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  )).toBe(idleFrames);

  await page.evaluate(() => window.postMessage({
    channel: 'dynamic-wallpaper-runtime', protocolVersion: 1, type: 'pointer',
    x: 160, y: 120, buttons: 0
  }, '*'));
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  )).toBeGreaterThan(idleFrames);
  const pointerFrames = await page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  );
  await page.waitForTimeout(200);
  expect(await page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  )).toBe(pointerFrames);

  await page.setViewportSize({ width: 800, height: 500 });
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  )).toBeGreaterThan(pointerFrames);
  const resizeFrames = await page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  );
  await page.waitForTimeout(200);
  expect(await page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  )).toBe(resizeFrames);
});

test('pure Web native wallpaper does not allocate an empty WebGL context', async ({ page }) => {
  await page.route('http://dwr.local/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/wallpaper.html') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><body><div>web wallpaper</div></body></html>'
      });
      return;
    }
    const relative = decodeURIComponent(url.pathname.replace(/^\/runtime\//, ''));
    const filename = path.join(repository, 'dist', 'webgl-runtime', relative);
    const extension = path.extname(filename).toLowerCase();
    await route.fulfill({
      status: 200,
      contentType: extension === '.html' ? 'text/html'
        : extension === '.js' ? 'text/javascript'
          : extension === '.css' ? 'text/css'
            : 'application/octet-stream',
      body: await fs.readFile(filename)
    });
  });
  await page.goto('http://dwr.local/runtime/renderer.html');
  const native = nativeConfiguration('none', 15);
  const configuration = {
    ...native,
    backgroundColor: '#123456',
    layers: [{
      ...native.layers[0],
      id: 'web',
      type: 'web' as const,
      sourceUri: 'http://dwr.local/wallpaper.html'
    }]
  };
  await page.evaluate(configuration => window.postMessage({
    channel: 'dynamic-wallpaper-runtime', protocolVersion: 1, type: 'initialize',
    configuration, userProperties: {}
  }, '*'), configuration);

  await expect(page.locator('iframe.dwr-web-surface')).toHaveCount(1);
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(await page.locator('#runtime-root').evaluate(element =>
    getComputedStyle(element).backgroundColor
  )).toBe('rgb(18, 52, 86)');
});

test('hidden lifecycle pause suspends resources and cancels a stale context restart', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks = 0;
    window.requestAnimationFrame = callback => nativeRequestAnimationFrame(time => {
      (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks++;
      callback(time);
    });
  });
  await page.route('http://dwr.local/runtime/**', async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/runtime\//, ''));
    const filename = path.join(repository, 'dist', 'webgl-runtime', relative);
    const extension = path.extname(filename).toLowerCase();
    await route.fulfill({
      status: 200,
      contentType: extension === '.html' ? 'text/html'
        : extension === '.js' ? 'text/javascript'
          : extension === '.css' ? 'text/css'
            : 'application/octet-stream',
      body: await fs.readFile(filename)
    });
  });
  await page.goto('http://dwr.local/runtime/renderer.html');
  await page.evaluate(configuration => window.postMessage({
    channel: 'dynamic-wallpaper-runtime', protocolVersion: 1, type: 'initialize',
    configuration, userProperties: {}
  }, '*'), nativeConfiguration('drift', 0.1));
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  )).toBeGreaterThan(2);
  await page.locator('canvas').evaluate(canvas => {
    canvas.setAttribute('data-runtime-instance', 'before-suspend');
  });

  // Queue a context-restoration rebuild, then suspend before its backoff
  // expires. Suspension must cancel that stale rebuild instead of recreating
  // GPU/media resources in the background.
  await page.evaluate(() => {
    const gl = document.querySelector('canvas')?.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    extension?.loseContext();
    setTimeout(() => extension?.restoreContext(), 10);
  });
  await page.waitForTimeout(50);

  await page.evaluate(() => window.postMessage({
    channel: 'dynamic-wallpaper-runtime', protocolVersion: 1, type: 'lifecycle',
    paused: true, focused: false, visible: false
  }, '*'));
  await expect(page.locator('canvas')).toHaveCount(0, { timeout: 2_000 });
  const pausedFrameCount = await page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  );
  await page.waitForTimeout(300);
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(await page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  )).toBe(pausedFrameCount);

  await page.evaluate(() => window.postMessage({
    channel: 'dynamic-wallpaper-runtime', protocolVersion: 1, type: 'lifecycle',
    paused: false, focused: true, visible: true
  }, '*'));
  await expect(page.locator('canvas')).toHaveCount(1, { timeout: 2_000 });
  await expect(page.locator('canvas[data-runtime-instance="before-suspend"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { dwrFrameCallbacks: number }).dwrFrameCallbacks
  )).toBeGreaterThan(pausedFrameCount);
});

test('disposes a candidate runtime when activation fails after construction', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const nativeRemove = HTMLCanvasElement.prototype.remove;
    let failNextFrameRequest = true;
    (window as unknown as { removedRuntimeCanvases: number }).removedRuntimeCanvases = 0;
    window.requestAnimationFrame = callback => {
      if (failNextFrameRequest) {
        failNextFrameRequest = false;
        throw new Error('forced activation failure');
      }
      return nativeRequestAnimationFrame(callback);
    };
    HTMLCanvasElement.prototype.remove = function remove(): void {
      (window as unknown as { removedRuntimeCanvases: number }).removedRuntimeCanvases++;
      nativeRemove.call(this);
    };
  });
  await page.route('http://dwr.local/runtime/**', async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/runtime\//, ''));
    const filename = path.join(repository, 'dist', 'webgl-runtime', relative);
    const extension = path.extname(filename).toLowerCase();
    await route.fulfill({
      status: 200,
      contentType: extension === '.html' ? 'text/html'
        : extension === '.js' ? 'text/javascript'
          : extension === '.css' ? 'text/css'
            : 'application/octet-stream',
      body: await fs.readFile(filename)
    });
  });
  await page.goto('http://dwr.local/runtime/renderer.html');
  await page.evaluate(configuration => window.postMessage({
    channel: 'dynamic-wallpaper-runtime', protocolVersion: 1, type: 'initialize',
    configuration, userProperties: {}
  }, '*'), nativeConfiguration('drift', 15));

  await expect(page.locator('.dwr-fatal')).toContainText('forced activation failure');
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(await page.evaluate(() =>
    (window as unknown as { removedRuntimeCanvases: number }).removedRuntimeCanvases
  )).toBe(1);
});

test('imports and loads the repository real Scene sample without silently dropping the scene', async ({ page }, testInfo) => {
  // Each repeat/worker needs its own importer transaction directory.
  const outputDirectory = testInfo.outputPath('browser-scene-import');
  await fs.rm(outputDirectory, { recursive: true, force: true });
  try {
    const imported = await importWallpaperEngineProject({
      sourceDirectory: path.join(repository, 'wallpapers', '3351072238'),
      outputDirectory,
      extensionPath: repository
    });
    const project = JSON.parse(await fs.readFile(imported.projectFile, 'utf8')) as {
      runtime: { manifest: string };
    };
    await page.route('http://dwr.local/**', async route => {
      const url = new URL(route.request().url());
      const runtimeRequest = url.pathname.startsWith('/runtime/');
      const relative = url.pathname.replace(/^\/(?:runtime|import)\//, '');
      const root = runtimeRequest ? path.join(repository, 'dist', 'webgl-runtime') : outputDirectory;
      const filename = path.resolve(root, decodeURIComponent(relative));
      try {
        let body = await fs.readFile(filename);
        const extension = path.extname(filename).toLowerCase();
        if (!runtimeRequest && relative === 'scene-runtime.json') {
          const manifest = JSON.parse(body.toString('utf8'));
          body = Buffer.from(JSON.stringify(rewriteResourceUris(manifest, outputDirectory)));
        }
        const contentType = extension === '.json' ? 'application/json'
          : extension === '.html' ? 'text/html'
            : extension === '.js' ? 'text/javascript'
              : extension === '.css' ? 'text/css'
          : extension === '.png' ? 'image/png'
            : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
              : extension === '.webp' ? 'image/webp'
                : 'application/octet-stream';
        await route.fulfill({ status: 200, contentType, body });
      } catch {
        await route.fulfill({ status: 404, body: 'not found' });
      }
    });
    const messages: Array<{ type?: string; diagnostics?: Array<{ code?: string }> }> = [];
    await page.exposeFunction('captureSceneRuntimeMessage', (message: typeof messages[number]) => messages.push(message));
    await page.addInitScript(() => window.addEventListener('message', event => {
      if (event.data?.channel === 'dynamic-wallpaper-host') {
        void (window as unknown as { captureSceneRuntimeMessage(message: unknown): Promise<void> }).captureSceneRuntimeMessage(event.data);
      }
    }));
    await page.goto('http://dwr.local/runtime/renderer.html');
    const manifestUri = `http://dwr.local/import/${project.runtime.manifest}`;
    await page.evaluate(manifestUri => window.postMessage({
      channel: 'dynamic-wallpaper-runtime', protocolVersion: 1, type: 'initialize',
      configuration: {
        runtime: { protocolVersion: 1, kind: 'wallpaper-engine-scene', manifestUri, networkHosts: [], userProperties: {} },
        renderLayer: 'front', surfaceOpacity: 0, backgroundColor: '#000000', pauseWhenUnfocused: false,
        opaqueEditorForMedia: false, opaqueEditorFileTypes: [], performance: { profile: 'quality', maxFps: 60, suspendAfterSeconds: 15 }, layers: [],
        effects: { overlayOpacity: 0, vignette: 0, grain: 0, scanlines: 0 }
      },
      userProperties: {}
    }, '*'), manifestUri);
    await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_000);
    expect(messages.some(message => message.type === 'fatal')).toBe(false);
    expect((await page.locator('canvas').screenshot()).byteLength).toBeGreaterThan(1000);
  } finally {
    await fs.rm(outputDirectory, { recursive: true, force: true });
  }
});

function nativeConfiguration(motionType: 'none' | 'drift', suspendAfterSeconds: number) {
  return {
    runtime: { protocolVersion: 1 as const, kind: 'native' as const, networkHosts: [], userProperties: {} },
    renderLayer: 'front' as const,
    surfaceOpacity: 0,
    backgroundColor: '#081020',
    pauseWhenUnfocused: true,
    opaqueEditorForMedia: false,
    opaqueEditorFileTypes: [],
    performance: { profile: 'quality' as const, maxFps: 60, suspendAfterSeconds },
    layers: [{
      id: 'gradient', type: 'gradient' as const, colors: ['#102060', '#40a0d0'], angle: 45,
      animationDuration: 0, opacity: 1, blendMode: 'normal' as const, fit: 'cover' as const,
      position: 'center' as const, scale: 1, rotate: 0, parallax: 0,
      filters: { blur: 0, brightness: 1, contrast: 1, saturation: 1, hueRotate: 0, grayscale: 0 },
      muted: true, playbackRate: 1,
      motion: { type: motionType, duration: 1, intensity: motionType === 'none' ? 0 : 1, delay: 0 }
    }],
    effects: { overlayOpacity: 0, vignette: 0, grain: 0, scanlines: 0 }
  };
}

function rewriteResourceUris(value: unknown, outputDirectory: string): unknown {
  if (typeof value === 'string' && value.startsWith('vscode-file://vscode-app/')) {
    const filename = decodeURIComponent(new URL(value).pathname).replace(/^\/([a-z]):/i, '$1:');
    const relative = path.relative(outputDirectory, filename).replace(/\\/g, '/');
    if (!relative.startsWith('../') && !path.isAbsolute(relative)) {
      return `http://dwr.local/import/${relative.split('/').map(encodeURIComponent).join('/')}`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => rewriteResourceUris(item, outputDirectory));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteResourceUris(item, outputDirectory)]));
  }
  return value;
}
