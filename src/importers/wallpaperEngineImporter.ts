import { ChildProcess, execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadWallpaperProject } from '../project/wallpaperProject';
import {
  readWallpaperEngineProject,
  WallpaperEngineImportError,
  WallpaperEngineProject,
  WallpaperEngineProjectType
} from './wallpaperEngine/project';
import {
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

const OUTPUT_PROJECT_FILE_NAME = 'wallpaper.json';
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.m4v']);
const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.apng',
  '.gif',
  '.webp',
  '.avif',
  '.bmp',
  '.svg'
]);

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
  output: {
    directory: string;
    projectFile: string;
  };
  converter: {
    name: string;
    sceneCompatibility: string;
  };
  warnings: string[];
}

interface SceneMediaLayer {
  objectIndex: number;
  objectName: string;
  sourceFile: string;
  type: 'image' | 'video';
  coverage: number;
  effects: string[];
}

interface SceneTextureConversion {
  convert(textureFile: string): Promise<void>;
  failures: Set<string>;
}

export async function importWallpaperEngineProject(
  options: WallpaperEngineImportOptions
): Promise<WallpaperEngineImportResult> {
  const sourceDirectory = path.resolve(options.sourceDirectory);
  const outputDirectory = path.resolve(options.outputDirectory);
  assertSafeDirectories(sourceDirectory, outputDirectory);
  checkCancellation(options);
  reportProgress(options, 'inspect', '正在读取 Wallpaper Engine 工程配置…', 5);

  const sourceStat = await statOrUndefined(sourceDirectory);
  if (!sourceStat?.isDirectory()) {
    throw new WallpaperEngineImportError(`源工程文件夹不存在：${sourceDirectory}`);
  }
  const project = await readWallpaperEngineProject(sourceDirectory);
  const outputStat = await statOrUndefined(outputDirectory);
  if (outputStat && !options.overwrite) {
    throw new WallpaperEngineImportError(`转换目标已存在：${outputDirectory}`);
  }

  const nonce = `${process.pid}-${Date.now()}`;
  const stagingDirectory = path.join(
    path.dirname(outputDirectory),
    `.${path.basename(outputDirectory)}.importing-${nonce}`
  );
  const backupDirectory = path.join(
    path.dirname(outputDirectory),
    `.${path.basename(outputDirectory)}.backup-${nonce}`
  );
  let movedExistingOutput = false;
  let installedOutput = false;

  try {
    await fs.mkdir(path.dirname(outputDirectory), { recursive: true });
    await fs.mkdir(stagingDirectory, { recursive: false });
    const conversion = await convertProject(
      project,
      sourceDirectory,
      stagingDirectory,
      options
    );
    checkCancellation(options);
    reportProgress(options, 'validate', '正在验证转换后的工程…', 15);
    const stagedProjectFile = path.join(stagingDirectory, OUTPUT_PROJECT_FILE_NAME);
    await loadWallpaperProject(stagedProjectFile);

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
      output: {
        directory: outputDirectory,
        projectFile: OUTPUT_PROJECT_FILE_NAME
      },
      converter: {
        name: 'Dynamic Wallpaper Renderer built-in importer',
        sceneCompatibility: project.type === 'Scene'
          ? conversion.sceneCompatibility ?? 'best-effort-media-layers'
          : 'native-media-wrapper'
      },
      warnings: conversion.warnings
    };
    await fs.writeFile(
      path.join(stagingDirectory, 'conversion-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8'
    );

    checkCancellation(options);
    if (outputStat) {
      await fs.rename(outputDirectory, backupDirectory);
      movedExistingOutput = true;
    }
    await fs.rename(stagingDirectory, outputDirectory);
    installedOutput = true;
    if (movedExistingOutput) {
      await fs.rm(backupDirectory, { recursive: true, force: true });
      movedExistingOutput = false;
    }
    reportProgress(options, 'finish', '转换完成。', 10);
    return {
      sourceDirectory,
      outputDirectory,
      projectFile: path.join(outputDirectory, OUTPUT_PROJECT_FILE_NAME),
      reportFile: path.join(outputDirectory, 'conversion-report.json'),
      sourceType: project.type,
      title: project.title,
      warnings: conversion.warnings
    };
  } catch (error) {
    if (movedExistingOutput && !installedOutput) {
      await fs.rename(backupDirectory, outputDirectory).catch(() => undefined);
      movedExistingOutput = false;
    }
    throw error;
  } finally {
    if (!installedOutput) {
      await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (movedExistingOutput) {
      await fs.rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function convertExtractedWallpaperEngineScene(
  options: ExtractedSceneConversionOptions
): Promise<ConversionOutcome> {
  return convertBestEffortScene(
    {
      file: 'scene.json',
      title: options.title,
      type: 'Scene',
      workshopid: options.workshopId
    },
    path.resolve(options.sceneFile),
    path.resolve(options.extractedDirectory),
    path.resolve(options.outputDirectory)
  );
}

async function convertProject(
  project: WallpaperEngineProject,
  sourceDirectory: string,
  stagingDirectory: string,
  options: WallpaperEngineImportOptions
): Promise<ConversionOutcome> {
  if (project.type === 'Web' || project.type === 'Video') {
    reportProgress(options, 'convert', '正在复制工程资源并生成插件配置…', 45);
    await copyDirectoryContents(sourceDirectory, stagingDirectory);
    const entryFile = ensureEntryWithinProject(sourceDirectory, project.file);
    const entryStat = await statOrUndefined(entryFile);
    if (!entryStat?.isFile()) {
      throw new WallpaperEngineImportError(`Wallpaper Engine 入口文件不存在：${project.file}`);
    }
    await fs.writeFile(
      path.join(stagingDirectory, OUTPUT_PROJECT_FILE_NAME),
      createNativeMediaProject(project),
      'utf8'
    );
    return { warnings: [] };
  }

  return convertSceneProject(project, sourceDirectory, stagingDirectory, options);
}

async function convertSceneProject(
  project: WallpaperEngineProject,
  sourceDirectory: string,
  stagingDirectory: string,
  options: WallpaperEngineImportOptions
): Promise<ConversionOutcome> {
  const packageFile = path.join(sourceDirectory, 'scene.pkg');
  const packageStat = await statOrUndefined(packageFile);
  if (!packageStat?.isFile()) {
    throw new WallpaperEngineImportError('Scene 工程缺少 scene.pkg，无法解包。');
  }

  const repkgExecutable = path.join(options.extensionPath, 'tools', 'repkg', 'RePKG.exe');
  const repkgStat = await statOrUndefined(repkgExecutable);
  if (!repkgStat?.isFile()) {
    throw new WallpaperEngineImportError(
      '扩展安装包中缺少内置 RePKG。',
      [`期望位置：${repkgExecutable}`, '请重新安装完整 VSIX。']
    );
  }

  const extractedDirectory = path.join(stagingDirectory, '.wallpaper-engine-extracted');
  await fs.mkdir(extractedDirectory);
  reportProgress(options, 'extract', '正在使用内置 RePKG 解包 scene.pkg…', 25);
  await runRePkg(repkgExecutable, packageFile, extractedDirectory, options);
  checkCancellation(options);

  const extractedScene = await findFile(extractedDirectory, 'scene.json');
  if (!extractedScene) {
    throw new WallpaperEngineImportError('RePKG 已完成，但没有找到 scene.json。');
  }
  reportProgress(options, 'convert', '正在提取可直接渲染的 Scene 媒体图层…', 35);
  const textureConversion = createSceneTextureConversion(
    repkgExecutable,
    extractedDirectory,
    options
  );
  const outcome = await convertBestEffortScene(
    project,
    extractedScene,
    extractedDirectory,
    stagingDirectory,
    textureConversion
  );
  await fs.rm(extractedDirectory, { recursive: true, force: true });
  return outcome;
}

async function convertBestEffortScene(
  project: WallpaperEngineProject,
  sceneFile: string,
  extractedDirectory: string,
  stagingDirectory: string,
  textureConversion?: SceneTextureConversion
): Promise<ConversionOutcome> {
  const scene = await readJsonObject(sceneFile);
  const objects = Array.isArray(scene.objects)
    ? scene.objects.filter(isJsonObject)
    : [];
  const general = isJsonObject(scene.general) ? scene.general : {};
  const projection = isJsonObject(general.orthogonalprojection)
    ? general.orthogonalprojection
    : {};
  const canvasWidth = finiteNumber(projection.width, 1920);
  const canvasHeight = finiteNumber(projection.height, 1080);
  const candidates: SceneMediaLayer[] = [];
  const ignoredKinds = new Map<string, number>();
  const ignoredEffects = new Set<string>();

  for (const [objectIndex, object] of objects.entries()) {
    if (!sceneValueBoolean(object.visible, true)) {
      incrementCount(ignoredKinds, '默认隐藏对象');
      continue;
    }
    const effects = Array.isArray(object.effects)
      ? object.effects
        .filter(isJsonObject)
        .map(effect => typeof effect.file === 'string' ? effect.file : '')
        .filter(Boolean)
      : [];
    for (const effect of effects) {
      ignoredEffects.add(effect);
    }

    if (typeof object.image !== 'string') {
      if (object.particle !== undefined) {
        incrementCount(ignoredKinds, '粒子对象');
      } else if (object.text !== undefined) {
        incrementCount(ignoredKinds, '文本/脚本对象');
      } else if (object.sound !== undefined) {
        incrementCount(ignoredKinds, '声音对象');
      } else {
        incrementCount(ignoredKinds, '分组或其他对象');
      }
      continue;
    }

    const sourceFile = await resolveSceneObjectMedia(
      extractedDirectory,
      object.image,
      textureConversion
    );
    if (!sourceFile) {
      incrementCount(ignoredKinds, '无法解析媒体的图像对象');
      continue;
    }
    const extension = path.extname(sourceFile).toLowerCase();
    const type = VIDEO_EXTENSIONS.has(extension)
      ? 'video'
      : IMAGE_EXTENSIONS.has(extension)
        ? 'image'
        : undefined;
    if (!type) {
      incrementCount(ignoredKinds, '不支持格式的媒体对象');
      continue;
    }

    const size = sceneVector(object.size);
    const coverage = size
      ? Math.max(0, (size[0] / canvasWidth) * (size[1] / canvasHeight))
      : 0;
    candidates.push({
      objectIndex,
      objectName: typeof object.name === 'string' && object.name
        ? object.name
        : `Scene object ${objectIndex + 1}`,
      sourceFile,
      type,
      coverage,
      effects
    });
  }

  if (candidates.length === 0) {
    throw new WallpaperEngineImportError(
      'Scene 已成功解包，但没有找到可由当前渲染器直接使用的图片或视频图层。',
      [
        ...summarizeIgnored(ignoredKinds, ignoredEffects),
        ...summarizeTextureFailures(textureConversion)
      ]
    );
  }

  const fullCanvasCandidates = candidates.filter(candidate => candidate.coverage >= 0.7);
  const selected = (fullCanvasCandidates.length > 0
    ? fullCanvasCandidates
    : [candidates.slice().sort((left, right) => right.coverage - left.coverage)[0]]
  ).slice(0, 16);
  const assetsDirectory = path.join(stagingDirectory, 'assets');
  await fs.mkdir(assetsDirectory);
  const layers: Array<Record<string, unknown>> = [];
  for (const [index, candidate] of selected.entries()) {
    const extension = path.extname(candidate.sourceFile).toLowerCase();
    const outputName = `scene-layer-${String(index + 1).padStart(2, '0')}${extension}`;
    await fs.copyFile(candidate.sourceFile, path.join(assetsDirectory, outputName));
    layers.push({
      id: `scene-${candidate.objectIndex}`,
      type: candidate.type,
      source: `assets/${outputName}`,
      opacity: 1,
      blendMode: 'normal',
      fit: 'cover',
      position: 'center',
      muted: true,
      playbackRate: 1
    });
  }

  const ignoredMediaCount = candidates.length - selected.length;
  if (ignoredMediaCount > 0) {
    ignoredKinds.set('非全屏或超出图层上限的媒体对象', ignoredMediaCount);
  }
  const backgroundColor = sceneColorToHex(general.clearcolor, '#000000');
  await fs.writeFile(
    path.join(stagingDirectory, OUTPUT_PROJECT_FILE_NAME),
    createBestEffortSceneProject(project, layers, backgroundColor),
    'utf8'
  );

  const warnings = [
    `已保留 ${selected.length} 个可直接渲染的 Scene 媒体图层：${selected.map(item => item.objectName).join('、')}。`,
    ...summarizeIgnored(ignoredKinds, ignoredEffects),
    ...summarizeTextureFailures(textureConversion),
    '这是尽可能转换模式：不支持的对象与效果已忽略，不会阻止其余内容加载。',
    '原 Wallpaper Engine 素材版权不因转换而改变；发布前请确认原作者授权。'
  ];
  return {
    sceneCompatibility: 'best-effort-media-layers',
    warnings
  };
}

function createBestEffortSceneProject(
  project: WallpaperEngineProject,
  layers: Array<Record<string, unknown>>,
  backgroundColor: string
): string {
  return `${JSON.stringify({
    version: 1,
    name: `${project.title} (Wallpaper Engine Best-effort Import)`,
    render: {
      layer: 'front',
      surfaceOpacity: 0.72,
      backgroundColor,
      pauseWhenUnfocused: true,
      opaqueEditorForMedia: true
    },
    performance: {
      profile: 'balanced',
      suspendAfterSeconds: 15
    },
    layers,
    effects: {
      overlayOpacity: 0,
      vignette: 0,
      grain: 0,
      scanlines: 0
    }
  }, null, 2)}\n`;
}

function createNativeMediaProject(project: WallpaperEngineProject): string {
  const layerType = project.type === 'Web' ? 'web' : 'video';
  return `${JSON.stringify({
    version: 1,
    name: `${project.title} (Wallpaper Engine Import)`,
    render: {
      layer: 'front',
      surfaceOpacity: 0.72,
      backgroundColor: '#000000',
      pauseWhenUnfocused: true,
      opaqueEditorForMedia: true
    },
    performance: {
      profile: 'balanced',
      suspendAfterSeconds: 15
    },
    layers: [
      {
        id: 'wallpaper-engine-entry',
        type: layerType,
        source: project.file,
        opacity: 1,
        blendMode: 'normal',
        fit: 'cover',
        position: 'center',
        muted: true,
        playbackRate: 1
      }
    ],
    effects: {
      overlayOpacity: 0,
      vignette: 0,
      grain: 0,
      scanlines: 0
    }
  }, null, 2)}\n`;
}

async function copyDirectoryContents(source: string, destination: string): Promise<void> {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await Promise.all(entries.map(entry =>
    fs.cp(
      path.join(source, entry.name),
      path.join(destination, entry.name),
      { recursive: true, force: true }
    )
  ));
}

async function runRePkg(
  executable: string,
  packageFile: string,
  outputDirectory: string,
  options: WallpaperEngineImportOptions,
  disableTextureConversion = true
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess | undefined;
    let stderr = '';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(cancellationTimer);
      error ? reject(error) : resolve();
    };
    const cancellationTimer = setInterval(() => {
      if (options.isCancellationRequested?.()) {
        child?.kill();
        finish(new WallpaperEngineImportError('转换已取消。'));
      }
    }, 100);

    const args = ['extract', '--output', outputDirectory, '--overwrite'];
    if (disableTextureConversion) {
      args.push('--no-tex-convert');
    }
    args.push(packageFile);
    child = execFile(
      executable,
      args,
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, _stdout, processStderr) => {
        stderr += processStderr;
        if (error) {
          finish(new WallpaperEngineImportError(
            'RePKG 解包失败。',
            [stderr.trim() || error.message]
          ));
          return;
        }
        finish();
      }
    );
    child.on('error', error => finish(error));
  });
}

async function findFile(directory: string, filename: string): Promise<string | undefined> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
      return candidate;
    }
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, filename);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

async function resolveSceneObjectMedia(
  extractedDirectory: string,
  modelReference: string,
  textureConversion?: SceneTextureConversion
): Promise<string | undefined> {
  const modelFile = safeExtractedPath(extractedDirectory, modelReference);
  const modelStat = await statOrUndefined(modelFile);
  if (!modelStat?.isFile()) {
    return undefined;
  }
  const model = await readJsonObject(modelFile).catch(() => undefined);
  if (!model || typeof model.material !== 'string') {
    return undefined;
  }
  const materialFile = safeExtractedPath(extractedDirectory, model.material);
  const material = await readJsonObject(materialFile).catch(() => undefined);
  if (!material || !Array.isArray(material.passes)) {
    return undefined;
  }

  const textureReferences = material.passes
    .filter(isJsonObject)
    .flatMap(pass => Array.isArray(pass.textures) ? pass.textures : [])
    .filter((texture): texture is string => typeof texture === 'string' && texture.length > 0);
  const materialDirectory = path.dirname(materialFile);
  for (const textureReference of textureReferences) {
    const directCandidates = [
      path.resolve(materialDirectory, textureReference),
      path.resolve(extractedDirectory, textureReference)
    ];
    for (const directCandidate of directCandidates) {
      const directExtension = path.extname(directCandidate).toLowerCase();
      const mediaBase = directExtension === '.tex'
        ? directCandidate.slice(0, -directExtension.length)
        : directCandidate;
      const existingMedia = await findRenderableMedia(mediaBase);
      if (existingMedia) {
        return existingMedia;
      }

      const textureFile = directExtension === '.tex'
        ? directCandidate
        : `${directCandidate}.tex`;
      if (
        textureConversion
        && (await statOrUndefined(textureFile))?.isFile()
      ) {
        await textureConversion.convert(textureFile);
        const convertedMedia = await findRenderableMedia(mediaBase);
        if (convertedMedia) {
          return convertedMedia;
        }
      }
    }
  }
  return undefined;
}

async function findRenderableMedia(baseFile: string): Promise<string | undefined> {
  const directExtension = path.extname(baseFile).toLowerCase();
  if (
    (VIDEO_EXTENSIONS.has(directExtension) || IMAGE_EXTENSIONS.has(directExtension))
    && (await statOrUndefined(baseFile))?.isFile()
  ) {
    return baseFile;
  }
  for (const extension of [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]) {
    const candidate = `${baseFile}${extension}`;
    if ((await statOrUndefined(candidate))?.isFile()) {
      return candidate;
    }
  }
  return undefined;
}

function createSceneTextureConversion(
  executable: string,
  extractedDirectory: string,
  options: WallpaperEngineImportOptions
): SceneTextureConversion {
  const conversions = new Map<string, Promise<void>>();
  const failures = new Set<string>();
  return {
    failures,
    async convert(textureFile: string): Promise<void> {
      const resolvedTexture = path.resolve(textureFile);
      let conversion = conversions.get(resolvedTexture);
      if (!conversion) {
        conversion = (async () => {
          checkCancellation(options);
          reportProgress(
            options,
            'convert',
            `正在转换 Scene 主体纹理：${path.basename(resolvedTexture)}`
          );
          try {
            await runRePkgTexture(executable, resolvedTexture, options);
          } catch (error) {
            if (options.isCancellationRequested?.()) {
              throw error;
            }
            failures.add(path.relative(extractedDirectory, resolvedTexture));
          }
        })();
        conversions.set(resolvedTexture, conversion);
      }
      await conversion;
    }
  };
}

async function runRePkgTexture(
  executable: string,
  textureFile: string,
  options: WallpaperEngineImportOptions
): Promise<void> {
  await runRePkg(
    executable,
    textureFile,
    path.dirname(textureFile),
    options,
    false
  );
}

function summarizeTextureFailures(
  textureConversion?: SceneTextureConversion
): string[] {
  if (!textureConversion || textureConversion.failures.size === 0) {
    return [];
  }
  return [
    `RePKG 无法转换 ${textureConversion.failures.size} 个候选纹理，已跳过：${[...textureConversion.failures].join('、')}`
  ];
}

function safeExtractedPath(extractedDirectory: string, relativePath: string): string {
  const candidate = path.resolve(extractedDirectory, relativePath.replaceAll('/', path.sep));
  const relative = path.relative(extractedDirectory, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new WallpaperEngineImportError(`Scene 资源路径越出解包目录：${relativePath}`);
  }
  return candidate;
}

async function readJsonObject(filename: string): Promise<Record<string, unknown>> {
  const raw = JSON.parse(stripBom(await fs.readFile(filename, 'utf8'))) as unknown;
  if (!isJsonObject(raw)) {
    throw new WallpaperEngineImportError(`Scene JSON 不是对象：${filename}`);
  }
  return raw;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sceneValue(value: unknown): unknown {
  return isJsonObject(value) && 'value' in value ? value.value : value;
}

function sceneValueBoolean(value: unknown, fallback: boolean): boolean {
  const resolved = sceneValue(value);
  return typeof resolved === 'boolean' ? resolved : fallback;
}

function sceneVector(value: unknown): number[] | undefined {
  const resolved = sceneValue(value);
  if (typeof resolved !== 'string') {
    return undefined;
  }
  const numbers = resolved.trim().split(/\s+/).map(Number);
  return numbers.length >= 2 && numbers.every(Number.isFinite) ? numbers : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function summarizeIgnored(
  ignoredKinds: Map<string, number>,
  ignoredEffects: Set<string>
): string[] {
  const warnings: string[] = [];
  if (ignoredKinds.size > 0) {
    warnings.push(`已忽略：${[...ignoredKinds].map(([name, count]) => `${name} ${count} 个`).join('；')}。`);
  }
  if (ignoredEffects.size > 0) {
    warnings.push(`未复现的 Scene 效果：${[...ignoredEffects].join('、')}。`);
  }
  return warnings;
}

function sceneColorToHex(value: unknown, fallback: string): string {
  const resolved = sceneValue(value);
  if (typeof resolved !== 'string') {
    return fallback;
  }
  const channels = resolved.trim().split(/\s+/).slice(0, 3).map(Number);
  if (channels.length !== 3 || channels.some(channel => !Number.isFinite(channel))) {
    return fallback;
  }
  return `#${channels.map(channel =>
    Math.round(Math.max(0, Math.min(1, channel)) * 255)
      .toString(16)
      .padStart(2, '0')
  ).join('')}`;
}

function ensureEntryWithinProject(sourceDirectory: string, entry: string): string {
  const candidate = path.resolve(sourceDirectory, entry);
  const relative = path.relative(sourceDirectory, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new WallpaperEngineImportError(`入口文件越出了工程目录：${entry}`);
  }
  return candidate;
}

function assertSafeDirectories(sourceDirectory: string, outputDirectory: string): void {
  const samePath = sameWindowsPath(sourceDirectory, outputDirectory);
  const outputRelativeToSource = path.relative(sourceDirectory, outputDirectory);
  const sourceRelativeToOutput = path.relative(outputDirectory, sourceDirectory);
  if (
    samePath
    || (!outputRelativeToSource.startsWith('..') && !path.isAbsolute(outputRelativeToSource))
    || (!sourceRelativeToOutput.startsWith('..') && !path.isAbsolute(sourceRelativeToOutput))
  ) {
    throw new WallpaperEngineImportError(
      '转换目标与源工程不能相同，也不能互相包含。请更换壁纸库目录。'
    );
  }
}

function sameWindowsPath(left: string, right: string): boolean {
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
  if (options.isCancellationRequested?.()) {
    throw new WallpaperEngineImportError('转换已取消。');
  }
}

async function statOrUndefined(candidate: string): Promise<Awaited<ReturnType<typeof fs.stat>> | undefined> {
  try {
    return await fs.stat(candidate);
  } catch {
    return undefined;
  }
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
