import { ChildProcess, execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  CompatibilityDiagnostic,
  RuntimeResource,
  RuntimeUserProperty,
  RuntimeCompatibilityReport,
  SceneRuntimeManifest,
  VideoRuntimeManifest,
  WebRuntimeManifest
} from '../domain/runtime';
import { toWorkbenchResourceUri } from '../platform/workbench/resourceUri';
import { loadWallpaperProject } from '../project/wallpaperProject';
import {
  readWallpaperEngineProject,
  WallpaperEngineImportError,
  type WallpaperEngineProject,
  type WallpaperEngineProjectType
} from './wallpaperEngine/project';
import type {
  ConversionOutcome,
  ExtractedSceneConversionOptions,
  WallpaperEngineImportOptions,
  WallpaperEngineImportResult,
  WallpaperEngineImportStage
} from './wallpaperEngine/types';

export { readWallpaperEngineProject, WallpaperEngineImportError } from './wallpaperEngine/project';
export type {
  ConversionOutcome,
  ExtractedSceneConversionOptions,
  WallpaperEngineImportOptions,
  WallpaperEngineImportProgress,
  WallpaperEngineImportResult
} from './wallpaperEngine/types';

const PROJECT_FILE = 'wallpaper.json';
const RUNTIME_MANIFEST_FILE = 'scene-runtime.json';
const COMPATIBILITY_REPORT_FILE = 'compatibility-report.json';
const CONVERSION_REPORT_FILE = 'conversion-report.json';
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.m4v']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.apng', '.gif', '.webp', '.avif', '.bmp', '.svg']);

interface SceneTextureConversion {
  convert(textureFile: string): Promise<void>;
  failures: Set<string>;
}

interface ConversionReport {
  formatVersion: 1;
  status: 'converted';
  convertedAt: string;
  source: {
    directory: string;
    title: string;
    type: WallpaperEngineProjectType;
    version?: number;
    workshopId?: string;
    entryFile: string;
  };
  output: { directory: string; projectFile: string };
  converter: { name: string; sceneCompatibility: string };
  warnings: string[];
}

export async function importWallpaperEngineProject(
  options: WallpaperEngineImportOptions
): Promise<WallpaperEngineImportResult> {
  const sourceDirectory = path.resolve(options.sourceDirectory);
  const outputDirectory = path.resolve(options.outputDirectory);
  assertSafeDirectories(sourceDirectory, outputDirectory);
  checkCancellation(options);
  reportProgress(options, 'inspect', '正在读取 Wallpaper Engine 工程配置…', 5);
  if (!(await statOrUndefined(sourceDirectory))?.isDirectory()) {
    throw new WallpaperEngineImportError(`源工程文件夹不存在：${sourceDirectory}`);
  }
  const project = await readWallpaperEngineProject(sourceDirectory);
  const outputExists = await statOrUndefined(outputDirectory);
  if (outputExists && !options.overwrite) {
    throw new WallpaperEngineImportError(`转换目标已存在：${outputDirectory}`);
  }

  const nonce = `${process.pid}-${Date.now()}`;
  const staging = path.join(path.dirname(outputDirectory), `.${path.basename(outputDirectory)}.importing-${nonce}`);
  const backup = path.join(path.dirname(outputDirectory), `.${path.basename(outputDirectory)}.backup-${nonce}`);
  let movedExisting = false;
  let installed = false;
  try {
    await fs.mkdir(path.dirname(outputDirectory), { recursive: true });
    await fs.mkdir(staging);
    const conversion = await convertProject(project, sourceDirectory, staging, outputDirectory, options);
    checkCancellation(options);
    reportProgress(options, 'validate', '正在验证无损 WebGL2 运行时工程…', 15);
    await loadWallpaperProject(path.join(staging, PROJECT_FILE));
    const report: ConversionReport = {
      formatVersion: 1,
      status: 'converted',
      convertedAt: new Date().toISOString(),
      source: {
        directory: sourceDirectory,
        title: project.title,
        type: project.type,
        version: project.version,
        workshopId: project.workshopid,
        entryFile: project.file
      },
      output: { directory: outputDirectory, projectFile: PROJECT_FILE },
      converter: {
        name: 'Dynamic Wallpaper Renderer lossless WebGL2 importer',
        sceneCompatibility: conversion.sceneCompatibility ?? runtimeLabel(project.type)
      },
      warnings: conversion.warnings
    };
    await writeJson(path.join(staging, CONVERSION_REPORT_FILE), report);
    checkCancellation(options);
    if (outputExists) {
      await renameWithRetry(outputDirectory, backup);
      movedExisting = true;
    }
    await renameWithRetry(staging, outputDirectory);
    installed = true;
    if (movedExisting) {
      await fs.rm(backup, { recursive: true, force: true });
      movedExisting = false;
    }
    reportProgress(options, 'finish', '无损 WebGL2 转换完成。', 10);
    return {
      sourceDirectory,
      outputDirectory,
      projectFile: path.join(outputDirectory, PROJECT_FILE),
      reportFile: path.join(outputDirectory, CONVERSION_REPORT_FILE),
      sourceType: project.type,
      title: project.title,
      warnings: conversion.warnings
    };
  } catch (error) {
    if (movedExisting && !installed) {
      await renameWithRetry(backup, outputDirectory).catch(() => undefined);
      movedExisting = false;
    }
    throw error;
  } finally {
    if (!installed) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (movedExisting) await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  let delayMilliseconds = 20;
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      const retryable = isNodeError(error)
        && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY');
      if (!retryable || attempt >= 7) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMilliseconds));
      delayMilliseconds = Math.min(200, delayMilliseconds * 2);
    }
  }
}

/** Converts an already extracted Scene with the same lossless v2 IR used by normal imports. */
export async function convertExtractedWallpaperEngineScene(
  options: ExtractedSceneConversionOptions
): Promise<ConversionOutcome> {
  const extractedDirectory = path.resolve(options.extractedDirectory);
  const outputDirectory = path.resolve(options.outputDirectory);
  const sceneFile = path.resolve(options.sceneFile);
  const project: WallpaperEngineProject = {
    file: 'scene.json',
    title: options.title,
    type: 'Scene',
    workshopid: options.workshopId
  };
  await fs.mkdir(outputDirectory, { recursive: true });
  const assets = path.join(outputDirectory, 'assets');
  await fs.mkdir(assets, { recursive: true });
  await copyDirectoryContents(extractedDirectory, assets);
  if (!(await statOrUndefined(path.join(assets, 'scene.json')))?.isFile()) {
    await fs.copyFile(sceneFile, path.join(assets, 'scene.json'));
  }
  return writeLosslessSceneRuntime(project, sceneFile, {}, assets, outputDirectory, new Set());
}

async function convertProject(
  project: WallpaperEngineProject,
  sourceDirectory: string,
  stagingDirectory: string,
  outputDirectory: string,
  options: WallpaperEngineImportOptions
): Promise<ConversionOutcome> {
  return project.type === 'Scene'
    ? convertScene(project, sourceDirectory, stagingDirectory, outputDirectory, options)
    : convertWebOrVideo(project, sourceDirectory, stagingDirectory, outputDirectory, options);
}

async function convertWebOrVideo(
  project: WallpaperEngineProject,
  sourceDirectory: string,
  stagingDirectory: string,
  outputDirectory: string,
  options: WallpaperEngineImportOptions
): Promise<ConversionOutcome> {
  reportProgress(options, 'convert', '正在复制完整工程并生成统一运行时清单…', 45);
  const entry = ensureEntryWithinProject(sourceDirectory, project.file);
  if (!(await statOrUndefined(entry))?.isFile()) {
    throw new WallpaperEngineImportError(`Wallpaper Engine 入口文件不存在：${project.file}`);
  }
  const assets = path.join(stagingDirectory, 'assets');
  await fs.mkdir(assets);
  await copyDirectoryContents(sourceDirectory, assets);
  const rawProject = await readJsonObject(path.join(sourceDirectory, 'project.json'));
  const compatibility = compatibilityReport([]);
  const entryUri = toWorkbenchResourceUri(path.join(outputDirectory, 'assets', project.file));
  const manifest: WebRuntimeManifest | VideoRuntimeManifest = project.type === 'Web'
    ? {
        formatVersion: 1,
        kind: 'wallpaper-engine-web',
        title: project.title,
        entryUri,
        userProperties: normalizeUserProperties(asObject(rawProject.general).properties),
        allowedNetworkHosts: [],
        compatibility
      }
    : {
        formatVersion: 1,
        kind: 'wallpaper-engine-video',
        title: project.title,
        entryUri,
        compatibility
      };
  await writeRuntimeProject(stagingDirectory, project, manifest);
  return { warnings: [], sceneCompatibility: runtimeLabel(project.type) };
}

async function convertScene(
  project: WallpaperEngineProject,
  sourceDirectory: string,
  stagingDirectory: string,
  outputDirectory: string,
  options: WallpaperEngineImportOptions
): Promise<ConversionOutcome> {
  const packageFile = path.join(sourceDirectory, 'scene.pkg');
  const repkg = path.join(options.extensionPath, 'tools', 'repkg', 'RePKG.exe');
  if (!(await statOrUndefined(packageFile))?.isFile()) throw new WallpaperEngineImportError('Scene 工程缺少 scene.pkg。');
  if (!(await statOrUndefined(repkg))?.isFile()) throw new WallpaperEngineImportError('扩展安装包中缺少内置 RePKG。');
  const extracted = await fs.mkdtemp(path.join(os.tmpdir(), 'dwr-webgl-'));
  try {
    reportProgress(options, 'extract', '正在使用内置 RePKG 无损解包 scene.pkg…', 20);
    await runRePkg(repkg, packageFile, extracted, options);
    const sceneFile = await findFile(extracted, 'scene.json');
    if (!sceneFile) throw new WallpaperEngineImportError('RePKG 已完成，但没有找到 scene.json。');
    const textures = (await listFiles(extracted)).filter(file => path.extname(file).toLowerCase() === '.tex');
    const conversion = createTextureConversion(repkg, extracted, options);
    reportProgress(options, 'convert', `正在转换 ${textures.length} 个 Scene 纹理…`, 20);
    for (const texture of textures) {
      checkCancellation(options);
      await conversion.convert(texture);
    }
    const assets = path.join(stagingDirectory, 'assets');
    await fs.mkdir(assets);
    await copyDirectoryContents(extracted, assets);
    const rawProject = await readJsonObject(path.join(sourceDirectory, 'project.json'));
    return writeLosslessSceneRuntime(
      project,
      sceneFile,
      rawProject,
      assets,
      outputDirectory,
      conversion.failures,
      stagingDirectory
    );
  } finally {
    await fs.rm(extracted, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeLosslessSceneRuntime(
  project: WallpaperEngineProject,
  sourceSceneFile: string,
  rawProject: Record<string, unknown>,
  assetsDirectory: string,
  finalOutputDirectory: string,
  textureFailures: Set<string>,
  projectDirectory = finalOutputDirectory
): Promise<ConversionOutcome> {
  const sceneAsset = await findFile(assetsDirectory, 'scene.json');
  const rawScene = await readJsonObject(sceneAsset ?? sourceSceneFile);
  const assetFiles = await listFiles(assetsDirectory);
  const diagnostics = await inspectCompatibility(
    rawScene,
    rawProject,
    assetsDirectory,
    assetFiles,
    textureFailures
  );
  const manifest: SceneRuntimeManifest = {
    formatVersion: 1,
    kind: 'wallpaper-engine-scene',
    title: project.title,
    sourceVersion: project.version,
    workshopId: project.workshopid,
    assetRootUri: toWorkbenchResourceUri(path.join(finalOutputDirectory, 'assets')),
    scene: rawScene as SceneRuntimeManifest['scene'],
    resources: createResources(assetsDirectory, finalOutputDirectory, assetFiles),
    userProperties: normalizeUserProperties(asObject(rawProject.general).properties),
    compatibility: compatibilityReport(diagnostics)
  };
  await writeRuntimeProject(projectDirectory, project, manifest);
  return {
    sceneCompatibility: 'webgl2-lossless-scene-runtime',
    warnings: diagnostics.filter(item => item.severity !== 'info').map(item => item.message)
  };
}

async function writeRuntimeProject(
  directory: string,
  project: WallpaperEngineProject,
  manifest: SceneRuntimeManifest | WebRuntimeManifest | VideoRuntimeManifest
): Promise<void> {
  await writeJson(path.join(directory, RUNTIME_MANIFEST_FILE), manifest);
  await writeJson(path.join(directory, COMPATIBILITY_REPORT_FILE), manifest.compatibility);
  await writeJson(path.join(directory, PROJECT_FILE), {
    version: 2,
    name: `${project.title} (Wallpaper Engine WebGL Import)`,
    runtime: {
      kind: manifest.kind,
      manifest: RUNTIME_MANIFEST_FILE,
      report: COMPATIBILITY_REPORT_FILE,
      networkHosts: []
    },
    render: {
      layer: 'front', surfaceOpacity: 0.72, backgroundColor: '#000000',
      pauseWhenUnfocused: true, opaqueEditorForMedia: true
    },
    performance: { profile: 'quality', maxFps: 60, suspendAfterSeconds: 15 },
    effects: { overlayOpacity: 0, vignette: 0, grain: 0, scanlines: 0 }
  });
}

function compatibilityReport(diagnostics: CompatibilityDiagnostic[]): RuntimeCompatibilityReport {
  return {
    formatVersion: 1,
    status: diagnostics.some(item => item.severity !== 'info') ? 'partial' : 'compatible',
    generatedAt: new Date().toISOString(),
    diagnostics
  };
}

function normalizeUserProperties(value: unknown): RuntimeUserProperty[] {
  if (!isObject(value)) return [];
  return Object.entries(value).map(([id, raw], index) => {
    const property = asObject(raw);
    return {
      id,
      type: propertyType(property.type),
      label: typeof property.text === 'string' ? property.text : id,
      value: jsonValue(property.value),
      order: finiteNumber(property.order) ?? index,
      condition: typeof property.condition === 'string' ? property.condition : undefined,
      minimum: finiteNumber(property.min),
      maximum: finiteNumber(property.max),
      step: finiteNumber(property.step),
      options: Array.isArray(property.options)
        ? property.options.filter(isObject).map(option => ({
            label: typeof option.label === 'string' ? option.label : String(option.value ?? ''),
            value: jsonValue(option.value)
          }))
        : undefined
    };
  }).sort((left, right) => left.order - right.order);
}

function propertyType(value: unknown): RuntimeUserProperty['type'] {
  const supported: RuntimeUserProperty['type'][] = ['bool', 'slider', 'combo', 'color', 'textinput', 'text', 'file', 'scenetexture'];
  return typeof value === 'string' && supported.includes(value as RuntimeUserProperty['type'])
    ? value as RuntimeUserProperty['type']
    : 'text';
}

function createResources(
  assets: string,
  finalOutput: string,
  files: readonly string[]
): RuntimeResource[] {
  const relativeFiles = files.map(file => relativePath(path.relative(assets, file)));
  const convertedByBase = new Map<string, string>();
  for (const candidate of relativeFiles) {
    const extension = path.extname(candidate).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension)) continue;
    const base = candidate.slice(0, -extension.length).toLowerCase();
    if (!convertedByBase.has(base)) convertedByBase.set(base, candidate);
  }
  return relativeFiles.map(relative => {
    const extension = path.extname(relative).toLowerCase();
    if (extension === '.tex') {
      const base = relative.slice(0, -4).toLowerCase();
      const converted = convertedByBase.get(base);
      if (converted) {
        const convertedExtension = path.extname(converted).toLowerCase();
        return {
          path: converted,
          sourcePath: relative,
          uri: toWorkbenchResourceUri(path.join(finalOutput, 'assets', converted)),
          kind: VIDEO_EXTENSIONS.has(convertedExtension) ? 'video' : 'texture'
        };
      }
    }
    return {
      path: relative,
      uri: toWorkbenchResourceUri(path.join(finalOutput, 'assets', relative)),
      kind: resourceKind(extension)
    };
  });
}

function resourceKind(extension: string): RuntimeResource['kind'] {
  if (IMAGE_EXTENSIONS.has(extension) || extension === '.tex') return 'texture';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (['.mp3', '.wav', '.flac', '.aac', '.m4a'].includes(extension)) return 'audio';
  if (['.ttf', '.otf', '.woff', '.woff2'].includes(extension)) return 'font';
  if (['.frag', '.vert', '.glsl', '.dxs'].includes(extension)) return 'shader';
  if (['.mdl', '.obj', '.fbx', '.gltf', '.glb'].includes(extension)) return 'model';
  if (extension === '.json') return 'json';
  if (['.html', '.htm', '.css', '.js'].includes(extension)) return 'web';
  return 'binary';
}

async function inspectCompatibility(
  scene: Record<string, unknown>,
  project: Record<string, unknown>,
  assets: string,
  files: readonly string[],
  textureFailures: Set<string>
): Promise<CompatibilityDiagnostic[]> {
  const diagnostics: CompatibilityDiagnostic[] = [...textureFailures].map(resource => ({
    code: 'texture-conversion-failed', severity: 'error',
    message: `纹理无法转换，引用它的 Pass 将被隔离：${resource}`, resource
  }));
  const binaryShaders = files.filter(file => path.extname(file).toLowerCase() === '.dxs');
  if (binaryShaders.length) diagnostics.push({
    code: 'binary-shader-present', severity: 'warning',
    message: `检测到 ${binaryShaders.length} 个二进制 shader；缺少 GLSL 源码的 Pass 会单独隔离。`
  });
  for (const filename of files.filter(file => path.extname(file).toLowerCase() === '.mdl')) {
    const header = await fs.readFile(filename).then(buffer => buffer.subarray(0, 8)).catch(() => undefined);
    const resource = relativePath(path.relative(assets, filename));
    diagnostics.push(header?.subarray(0, 4).toString('ascii') === 'MDLV'
      ? { code: 'model-container-preserved', severity: 'info', message: `已无损保留 ${header.toString('ascii')} 模型容器。`, resource }
      : { code: 'unknown-model-container', severity: 'error', message: `无法识别模型容器：${resource}`, resource });
  }
  if (asObject(project.general).supportsaudioprocessing === true || containsString(scene, 'registerAudioBuffers')) {
    diagnostics.push({
      code: 'system-audio-unavailable', severity: 'warning',
      message: '壁纸自身音频可分析；纯浏览器模式的系统音频输入固定为 0。'
    });
  }
  return diagnostics;
}

function containsString(value: unknown, needle: string, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => containsString(item, needle, seen));
  return Object.values(value).some(item => containsString(item, needle, seen));
}

async function copyDirectoryContents(source: string, destination: string): Promise<void> {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await Promise.all(entries.map(entry => fs.cp(
    path.join(source, entry.name),
    path.join(destination, entry.name),
    { recursive: true, force: true }
  )));
}

async function runRePkg(
  executable: string,
  input: string,
  output: string,
  options: WallpaperEngineImportOptions,
  disableTextureConversion = true
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess | undefined;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(cancellation);
      error ? reject(error) : resolve();
    };
    const cancellation = setInterval(() => {
      if (options.isCancellationRequested?.()) {
        child?.kill();
        finish(new WallpaperEngineImportError('转换已取消。'));
      }
    }, 100);
    const args = ['extract', '--output', output, '--overwrite'];
    if (disableTextureConversion) args.push('--no-tex-convert');
    args.push(input);
    child = execFile(executable, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, _stdout, stderr) => {
      finish(error ? new WallpaperEngineImportError('RePKG 处理失败。', [stderr.trim() || error.message]) : undefined);
    });
    child.on('error', finish);
  });
}

function createTextureConversion(
  executable: string,
  extracted: string,
  options: WallpaperEngineImportOptions
): SceneTextureConversion {
  const pending = new Map<string, Promise<void>>();
  const failures = new Set<string>();
  return {
    failures,
    async convert(textureFile: string): Promise<void> {
      const resolved = path.resolve(textureFile);
      let conversion = pending.get(resolved);
      if (!conversion) {
        conversion = runRePkg(executable, resolved, path.dirname(resolved), options, false)
          .catch(error => {
            if (options.isCancellationRequested?.()) throw error;
            failures.add(relativePath(path.relative(extracted, resolved)));
          });
        pending.set(resolved, conversion);
      }
      await conversion;
    }
  };
}

async function findFile(directory: string, filename: string): Promise<string | undefined> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) return candidate;
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, filename);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function listFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(candidate));
    else if (entry.isFile()) output.push(candidate);
  }
  return output;
}

async function readJsonObject(filename: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(stripBom(await fs.readFile(filename, 'utf8'))) as unknown;
  if (!isObject(value)) throw new WallpaperEngineImportError(`JSON 不是对象：${filename}`);
  return value;
}

async function writeJson(filename: string, value: unknown): Promise<void> {
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function ensureEntryWithinProject(source: string, entry: string): string {
  const candidate = path.resolve(source, entry);
  const relative = path.relative(source, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new WallpaperEngineImportError(`入口文件越出了工程目录：${entry}`);
  }
  return candidate;
}

function assertSafeDirectories(source: string, output: string): void {
  const outputRelative = path.relative(source, output);
  const sourceRelative = path.relative(output, source);
  if (samePath(source, output)
    || (!outputRelative.startsWith('..') && !path.isAbsolute(outputRelative))
    || (!sourceRelative.startsWith('..') && !path.isAbsolute(sourceRelative))) {
    throw new WallpaperEngineImportError('转换目标与源工程不能相同，也不能互相包含。');
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonValue(value: unknown): RuntimeUserProperty['value'] {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return value as RuntimeUserProperty['value'];
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  return null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function runtimeLabel(type: WallpaperEngineProjectType): string {
  return type === 'Scene' ? 'webgl2-lossless-scene-runtime'
    : type === 'Web' ? 'sandboxed-web-runtime'
      : 'webgl2-video-texture';
}

function relativePath(value: string): string {
  return value.split(path.sep).join('/');
}

function samePath(left: string, right: string): boolean {
  return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
}

function reportProgress(
  options: WallpaperEngineImportOptions,
  stage: WallpaperEngineImportStage,
  message: string,
  increment?: number
): void {
  options.onProgress?.({ stage, message, increment });
}

function checkCancellation(options: WallpaperEngineImportOptions): void {
  if (options.isCancellationRequested?.()) throw new WallpaperEngineImportError('转换已取消。');
}

async function statOrUndefined(candidate: string): Promise<Awaited<ReturnType<typeof fs.stat>> | undefined> {
  try { return await fs.stat(candidate); } catch { return undefined; }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
