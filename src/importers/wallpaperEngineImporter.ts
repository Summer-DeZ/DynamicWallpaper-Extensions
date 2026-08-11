import { ChildProcess, execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
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
  kind: 'media';
  objectIndex: number;
  objectName: string;
  sourceFile: string;
  type: 'image' | 'video';
  coverage: number;
  effects: string[];
  layout?: SceneLayerLayout;
  opacity: number;
  blendMode: string;
  rotate: number;
  parallax: number;
  motion: SceneLayerMotion;
  puppet: boolean;
}

interface SceneParticleLayer {
  kind: 'particle';
  objectIndex: number;
  objectName: string;
  sourceFile?: string;
  opacity: number;
  blendMode: string;
  particle: Record<string, unknown>;
}

interface SceneLayerLayout {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SceneLayerMotion {
  type: 'none' | 'sway' | 'water' | 'float' | 'pulse' | 'shake' | 'drift';
  duration: number;
  intensity: number;
  delay: number;
}

interface SceneTransform {
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

interface ResolvedSceneMedia {
  sourceFile: string;
  puppet: boolean;
  blendMode: string;
}

type SceneRenderableLayer = SceneMediaLayer | SceneParticleLayer;

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
          ? conversion.sceneCompatibility ?? 'layered-scene-runtime'
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
  return convertLayeredScene(
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

  // RePKG and some of its .NET dependencies still fail on deeply nested
  // Windows paths. The managed library path is already long, and package
  // entries can add another hundred characters, so extraction must not live
  // below the final wallpaper directory.
  const extractedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dwr-'));
  try {
    reportProgress(options, 'extract', '正在使用内置 RePKG 解包 scene.pkg…', 25);
    await runRePkg(repkgExecutable, packageFile, extractedDirectory, options);
    checkCancellation(options);

    const extractedScene = await findFile(extractedDirectory, 'scene.json');
    if (!extractedScene) {
      throw new WallpaperEngineImportError('RePKG 已完成，但没有找到 scene.json。');
    }
    reportProgress(options, 'convert', '正在解析 Scene 图层、父级变换、效果与粒子…', 35);
    const textureConversion = createSceneTextureConversion(
      repkgExecutable,
      extractedDirectory,
      options
    );
    return await convertLayeredScene(
      project,
      extractedScene,
      extractedDirectory,
      stagingDirectory,
      textureConversion
    );
  } finally {
    await fs.rm(extractedDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function convertLayeredScene(
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
  const sceneGraph = createSceneGraph(objects, canvasWidth, canvasHeight);
  const candidates: SceneRenderableLayer[] = [];
  const ignoredKinds = new Map<string, number>();
  const ignoredEffects = new Set<string>();
  const approximatedEffects = new Set<string>();
  let puppetLayerCount = 0;

  for (const [objectIndex, object] of objects.entries()) {
    if (!sceneGraph.isVisible(object)) {
      incrementCount(ignoredKinds, '默认隐藏对象');
      continue;
    }
    const transform = sceneGraph.transformFor(object);
    const opacity = sceneGraph.opacityFor(object);
    if (opacity <= 0.001) {
      incrementCount(ignoredKinds, '父级或当前对象完全透明');
      continue;
    }
    const effects = Array.isArray(object.effects)
      ? object.effects
        .filter(isJsonObject)
        .map(effect => typeof effect.file === 'string' ? effect.file : '')
        .filter(Boolean)
      : [];

    if (typeof object.particle === 'string') {
      const particle = await resolveSceneParticleLayer(
        extractedDirectory,
        object.particle,
        textureConversion,
        canvasWidth,
        canvasHeight,
        transform
      );
      if (particle) {
        candidates.push({
          kind: 'particle',
          objectIndex,
          objectName: sceneObjectName(object, objectIndex),
          sourceFile: particle.sourceFile,
          opacity,
          blendMode: particle.blendMode,
          particle: particle.settings
        });
      } else {
        incrementCount(ignoredKinds, '无法解析的粒子对象');
      }
      continue;
    }

    if (typeof object.image !== 'string') {
      if (object.text !== undefined) {
        incrementCount(ignoredKinds, '文本对象');
      } else if (object.sound !== undefined) {
        incrementCount(ignoredKinds, '声音对象');
      } else {
        incrementCount(ignoredKinds, '分组或其他对象');
      }
      continue;
    }

    if (isSceneInterfaceObject(object, object.image)) {
      incrementCount(ignoredKinds, '界面控件或不可见装饰');
      continue;
    }

    const resolvedMedia = await resolveSceneObjectMedia(
      extractedDirectory,
      object.image,
      textureConversion
    );
    if (!resolvedMedia) {
      incrementCount(ignoredKinds, '无法解析媒体的图像对象');
      continue;
    }
    const extension = path.extname(resolvedMedia.sourceFile).toLowerCase();
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
    const scaledWidth = size ? Math.abs(size[0] * transform.scaleX) : canvasWidth;
    const scaledHeight = size ? Math.abs(size[1] * transform.scaleY) : canvasHeight;
    const coverage = Math.max(
      0,
      (scaledWidth / canvasWidth) * (scaledHeight / canvasHeight)
    );
    const motion = sceneMotionFor(effects, resolvedMedia.puppet, objectIndex);
    for (const effect of effects) {
      if (isApproximatedSceneEffect(effect)) {
        approximatedEffects.add(effect);
      } else {
        ignoredEffects.add(effect);
      }
    }
    if (resolvedMedia.puppet) {
      puppetLayerCount++;
    }
    candidates.push({
      kind: 'media',
      objectIndex,
      objectName: sceneObjectName(object, objectIndex),
      sourceFile: resolvedMedia.sourceFile,
      type,
      coverage,
      effects,
      layout: sceneLayerLayout(object, transform, canvasWidth, canvasHeight),
      opacity,
      blendMode: resolvedMedia.blendMode,
      rotate: sceneRotation(transform),
      parallax: sceneParallax(object),
      motion,
      puppet: resolvedMedia.puppet
    });
  }

  if (candidates.length === 0) {
    throw new WallpaperEngineImportError(
      'Scene 已成功解包，但没有找到可由当前渲染器使用的视觉图层。',
      [
        ...summarizeIgnored(ignoredKinds, ignoredEffects),
        ...summarizeTextureFailures(textureConversion)
      ]
    );
  }

  const selected = selectSceneLayers(candidates, 64);
  const assetsDirectory = path.join(stagingDirectory, 'assets');
  await fs.mkdir(assetsDirectory);
  const layers: Array<Record<string, unknown>> = [];
  const copiedAssets = new Map<string, string>();
  for (const candidate of selected) {
    let source: string | undefined;
    if (candidate.sourceFile) {
      source = await copySceneAsset(candidate.sourceFile, assetsDirectory, copiedAssets);
    }
    if (candidate.kind === 'particle') {
      layers.push({
        id: `scene-particle-${candidate.objectIndex}`,
        type: 'particle',
        ...(source ? { source } : {}),
        opacity: candidate.opacity,
        blendMode: candidate.blendMode,
        particle: candidate.particle
      });
      continue;
    }
    layers.push({
      id: `scene-${candidate.objectIndex}`,
      type: candidate.type,
      source,
      opacity: candidate.opacity,
      blendMode: candidate.blendMode,
      fit: candidate.layout ? 'fill' : 'cover',
      position: 'center',
      rotate: candidate.rotate,
      parallax: candidate.parallax,
      motion: candidate.motion,
      ...(candidate.layout ? { layout: candidate.layout } : {}),
      muted: true,
      playbackRate: 1
    });
  }

  const ignoredMediaCount = candidates.length - selected.length;
  if (ignoredMediaCount > 0) {
    ignoredKinds.set('超出图层上限的视觉对象', ignoredMediaCount);
  }
  const backgroundColor = sceneColorToHex(general.clearcolor, '#000000');
  await fs.writeFile(
    path.join(stagingDirectory, OUTPUT_PROJECT_FILE_NAME),
    createLayeredSceneProject(
      project,
      layers,
      backgroundColor,
      canvasWidth,
      canvasHeight
    ),
    'utf8'
  );

  const mediaCount = selected.filter(candidate => candidate.kind === 'media').length;
  const particleCount = selected.filter(candidate => candidate.kind === 'particle').length;
  const warnings = [
    `已按原始顺序保留 ${mediaCount} 个媒体图层和 ${particleCount} 个粒子图层。`,
    ...(approximatedEffects.size > 0
      ? [`已近似映射常见 Scene 动效：${[...approximatedEffects].join('、')}。`]
      : []),
    ...(puppetLayerCount > 0
      ? [`检测到 ${puppetLayerCount} 个 Puppet 图层；已保留人物分层和坐标，并使用轻量动态近似，暂未复现原始网格骨骼变形。`]
      : []),
    ...summarizeIgnored(ignoredKinds, ignoredEffects),
    ...summarizeTextureFailures(textureConversion),
    '文字层按兼容策略忽略；不支持的对象与效果不会阻止其余场景加载。',
    '原 Wallpaper Engine 素材版权不因转换而改变；发布前请确认原作者授权。'
  ];
  return {
    sceneCompatibility: 'layered-scene-runtime',
    warnings
  };
}

function createLayeredSceneProject(
  project: WallpaperEngineProject,
  layers: Array<Record<string, unknown>>,
  backgroundColor: string,
  canvasWidth: number,
  canvasHeight: number
): string {
  return `${JSON.stringify({
    version: 1,
    name: `${project.title} (Wallpaper Engine Layered Scene Import)`,
    render: {
      layer: 'front',
      surfaceOpacity: 0.72,
      backgroundColor,
      pauseWhenUnfocused: true,
      opaqueEditorForMedia: true,
      sceneCanvas: {
        width: 1920,
        height: Math.round((1920 * canvasHeight) / canvasWidth)
      }
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
): Promise<ResolvedSceneMedia | undefined> {
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
  const resolvedMaterial = await resolveSceneMaterialMedia(
    extractedDirectory,
    materialFile,
    textureConversion
  );
  if (!resolvedMaterial) {
    return undefined;
  }
  return {
    sourceFile: resolvedMaterial.sourceFile,
    puppet: typeof model.puppet === 'string' && model.puppet.length > 0,
    blendMode: resolvedMaterial.blendMode
  };
}

async function resolveSceneParticleLayer(
  extractedDirectory: string,
  particleReference: string,
  textureConversion: SceneTextureConversion | undefined,
  canvasWidth: number,
  canvasHeight: number,
  transform: SceneTransform
): Promise<{
  sourceFile?: string;
  blendMode: string;
  settings: Record<string, unknown>;
} | undefined> {
  const particleFile = safeExtractedPath(extractedDirectory, particleReference);
  const particle = await readJsonObject(particleFile).catch(() => undefined);
  if (!particle) {
    return undefined;
  }

  const preset = sceneParticlePreset(particleReference);
  const defaults = particlePresetDefaults(preset);
  const emitters = Array.isArray(particle.emitter)
    ? particle.emitter.filter(isJsonObject)
    : [];
  const initializers = Array.isArray(particle.initializer)
    ? particle.initializer.filter(isJsonObject)
    : [];
  const emitter = emitters[0] ?? {};
  const operators = Array.isArray(particle.operator)
    ? particle.operator.filter(isJsonObject)
    : [];
  const renderers = Array.isArray(particle.renderer)
    ? particle.renderer.filter(isJsonObject)
    : [];
  const lifetime = findSceneNamedObject(initializers, 'lifetimerandom');
  const size = findSceneNamedObject(initializers, 'sizerandom');
  const velocity = findSceneNamedObject(initializers, 'velocityrandom');
  const color = findSceneNamedObject(initializers, 'colorrandom');
  const alpha = findSceneNamedObject(initializers, 'alpharandom');
  const direction = sceneVector(emitter.directions) ?? defaults.direction;
  const sizeScale = 1920 / Math.max(1, canvasWidth);
  const particleScale = Math.sqrt(Math.abs(transform.scaleX * transform.scaleY));
  const emitterName = typeof emitter.name === 'string' ? emitter.name.toLowerCase() : '';
  const emitterShape = /box/.test(emitterName)
    ? 'box'
    : /sphere/.test(emitterName)
      ? 'sphere'
      : 'point';
  const emitterDistance = sceneVectorOrScalar(emitter.distancemax);
  const operatorNames = operators
    .map(operator => typeof operator.name === 'string' ? operator.name.toLowerCase() : '');
  const rendererNames = renderers
    .map(renderer => typeof renderer.name === 'string' ? renderer.name.toLowerCase() : '');
  const hasMovement = operatorNames.some(name => /movement|turbulence/.test(name));
  const turbulenceOperator = operators.find(operator => operator.name === 'turbulence');
  const fallbackSpeedMin = hasMovement ? defaults.speedMin : 0;
  const fallbackSpeedMax = hasMovement ? defaults.speedMax : 0;
  const colors = [
    sceneParticleColor(color?.min),
    sceneParticleColor(color?.max)
  ].filter((entry): entry is string => Boolean(entry));

  let sourceFile: string | undefined;
  let blendMode = preset === 'fog' ? 'screen' : 'screen';
  if (typeof particle.material === 'string') {
    const materialFile = safeExtractedPath(extractedDirectory, particle.material);
    const resolvedMaterial = await resolveSceneMaterialMedia(
      extractedDirectory,
      materialFile,
      textureConversion
    );
    sourceFile = resolvedMaterial?.sourceFile;
    blendMode = resolvedMaterial?.blendMode ?? blendMode;
  }

  return {
    sourceFile,
    blendMode,
    settings: {
      preset,
      emitterShape,
      emitterX: roundSceneNumber(transform.originX / canvasWidth),
      emitterY: roundSceneNumber((canvasHeight - transform.originY) / canvasHeight),
      emitterWidth: roundSceneNumber(
        Math.abs(emitterDistance[0] * transform.scaleX * sizeScale * 2)
      ),
      emitterHeight: roundSceneNumber(
        Math.abs(emitterDistance[1] * transform.scaleY * sizeScale * 2)
      ),
      maxCount: Math.round(clampSceneNumber(particle.maxcount, defaults.maxCount, 1, 2000)),
      spawnRate: clampSceneNumber(emitter.rate, defaults.spawnRate, 0.1, 1000),
      lifetimeMin: clampSceneNumber(lifetime?.min, defaults.lifetimeMin, 0.1, 120),
      lifetimeMax: clampSceneNumber(lifetime?.max, defaults.lifetimeMax, 0.1, 120),
      sizeMin: clampSceneNumber(size?.min, defaults.sizeMin, 0.1, 4000)
        * sizeScale * particleScale,
      sizeMax: clampSceneNumber(size?.max, defaults.sizeMax, 0.1, 4000)
        * sizeScale * particleScale,
      speedMin: sceneVectorMagnitude(velocity?.min, fallbackSpeedMin) * sizeScale,
      speedMax: sceneVectorMagnitude(velocity?.max, fallbackSpeedMax) * sizeScale,
      directionX: direction[0] ?? defaults.direction[0],
      directionY: direction[1] ?? defaults.direction[1],
      spread: typeof emitter.name === 'string' && emitter.name.includes('sphere') ? 0.9 : 0.4,
      opacityMin: clampSceneNumber(alpha?.min, defaults.opacityMin, 0, 1),
      opacityMax: clampSceneNumber(alpha?.max, defaults.opacityMax, 0, 1),
      colors: colors.length > 0 ? [...new Set(colors)] : defaults.colors,
      trail: rendererNames.some(name => /rope|trail/.test(name)),
      turbulence: operatorNames.includes('turbulence')
        ? clampSceneNumber(turbulenceOperator?.speedmax, 100, 0, 1000) * sizeScale
        : 0
    }
  };
}

async function resolveSceneMaterialMedia(
  extractedDirectory: string,
  materialFile: string,
  textureConversion?: SceneTextureConversion
): Promise<{ sourceFile: string; blendMode: string } | undefined> {
  const material = await readJsonObject(materialFile).catch(() => undefined);
  if (!material || !Array.isArray(material.passes)) {
    return undefined;
  }
  const passes = material.passes.filter(isJsonObject);
  const blendMode = mapSceneBlendMode(passes[0]?.blending);

  const textureReferences = passes
    .flatMap(pass => Array.isArray(pass.textures) ? pass.textures : [])
    .filter((texture): texture is string => typeof texture === 'string' && texture.length > 0);
  const materialDirectory = path.dirname(materialFile);
  for (const textureReference of textureReferences) {
    const directCandidates = [
      path.resolve(materialDirectory, textureReference),
      path.resolve(extractedDirectory, 'materials', textureReference),
      path.resolve(extractedDirectory, textureReference)
    ];
    for (const directCandidate of directCandidates) {
      const directExtension = path.extname(directCandidate).toLowerCase();
      const mediaBase = directExtension === '.tex'
        ? directCandidate.slice(0, -directExtension.length)
        : directCandidate;
      const existingMedia = await findRenderableMedia(mediaBase);
      if (existingMedia) {
        return { sourceFile: existingMedia, blendMode };
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
          return { sourceFile: convertedMedia, blendMode };
        }
      }
    }
  }
  return undefined;
}

function mapSceneBlendMode(value: unknown): string {
  if (value === 'additive') {
    return 'screen';
  }
  if (value === 'multiply') {
    return 'multiply';
  }
  return 'normal';
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

function selectSceneLayers(
  candidates: SceneRenderableLayer[],
  maximum: number
): SceneRenderableLayer[] {
  if (candidates.length <= maximum) {
    return candidates;
  }
  return candidates
    .map(candidate => ({ candidate, score: sceneLayerScore(candidate) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, maximum)
    .map(entry => entry.candidate)
    .sort((left, right) => left.objectIndex - right.objectIndex);
}

function sceneLayerScore(candidate: SceneRenderableLayer): number {
  if (candidate.kind === 'particle') {
    return 0.8;
  }
  const semanticBoost = /背景|地面|天空|人物|身体|头|body|head|background/i.test(
    candidate.objectName
  ) ? 2 : 0;
  return Math.min(candidate.coverage, 4)
    + semanticBoost
    + (candidate.puppet ? 4 : 0)
    + (candidate.type === 'video' ? 1 : 0);
}

async function copySceneAsset(
  sourceFile: string,
  assetsDirectory: string,
  copiedAssets: Map<string, string>
): Promise<string> {
  const key = path.resolve(sourceFile).toLowerCase();
  const existing = copiedAssets.get(key);
  if (existing) {
    return existing;
  }
  const extension = path.extname(sourceFile).toLowerCase();
  const outputName = `scene-asset-${String(copiedAssets.size + 1).padStart(2, '0')}${extension}`;
  const relativeOutput = `assets/${outputName}`;
  await fs.copyFile(sourceFile, path.join(assetsDirectory, outputName));
  copiedAssets.set(key, relativeOutput);
  return relativeOutput;
}

function sceneObjectName(object: Record<string, unknown>, objectIndex: number): string {
  return typeof object.name === 'string' && object.name
    ? object.name
    : `Scene object ${objectIndex + 1}`;
}

function createSceneGraph(
  objects: Record<string, unknown>[],
  canvasWidth: number,
  canvasHeight: number
): {
  transformFor(object: Record<string, unknown>): SceneTransform;
  isVisible(object: Record<string, unknown>): boolean;
  opacityFor(object: Record<string, unknown>): number;
} {
  const objectsById = new Map<string, Record<string, unknown>>();
  for (const object of objects) {
    const id = sceneValue(object.id);
    if (typeof id === 'number' || typeof id === 'string') {
      objectsById.set(String(id), object);
    }
  }
  const transforms = new Map<Record<string, unknown>, SceneTransform>();
  const visibility = new Map<Record<string, unknown>, boolean>();
  const opacities = new Map<Record<string, unknown>, number>();

  function parentFor(object: Record<string, unknown>): Record<string, unknown> | undefined {
    const parent = sceneValue(object.parent);
    return typeof parent === 'number' || typeof parent === 'string'
      ? objectsById.get(String(parent))
      : undefined;
  }

  function transformFor(
    object: Record<string, unknown>,
    ancestors = new Set<Record<string, unknown>>()
  ): SceneTransform {
    const cached = transforms.get(object);
    if (cached) return cached;
    const parent = parentFor(object);
    const localOrigin = sceneVector(object.origin);
    const localScale = sceneVector(object.scale) ?? [1, 1];
    const localAngles = sceneVector(object.angles) ?? [0, 0, 0];
    let transform: SceneTransform;
    if (!parent || ancestors.has(parent)) {
      transform = {
        originX: localOrigin?.[0] ?? canvasWidth / 2,
        originY: localOrigin?.[1] ?? canvasHeight / 2,
        scaleX: localScale[0] ?? 1,
        scaleY: localScale[1] ?? 1,
        rotation: localAngles[2] ?? 0
      };
    } else {
      ancestors.add(object);
      const parentTransform = transformFor(parent, ancestors);
      ancestors.delete(object);
      const localX = (localOrigin?.[0] ?? 0) * parentTransform.scaleX;
      const localY = (localOrigin?.[1] ?? 0) * parentTransform.scaleY;
      const cosine = Math.cos(parentTransform.rotation);
      const sine = Math.sin(parentTransform.rotation);
      transform = {
        originX: parentTransform.originX + localX * cosine - localY * sine,
        originY: parentTransform.originY + localX * sine + localY * cosine,
        scaleX: parentTransform.scaleX * (localScale[0] ?? 1),
        scaleY: parentTransform.scaleY * (localScale[1] ?? 1),
        rotation: parentTransform.rotation + (localAngles[2] ?? 0)
      };
    }
    transforms.set(object, transform);
    return transform;
  }

  function isVisible(
    object: Record<string, unknown>,
    ancestors = new Set<Record<string, unknown>>()
  ): boolean {
    const cached = visibility.get(object);
    if (cached !== undefined) return cached;
    if (!sceneValueBoolean(object.visible, true)) {
      visibility.set(object, false);
      return false;
    }
    const parent = parentFor(object);
    if (!parent || ancestors.has(parent)) {
      visibility.set(object, true);
      return true;
    }
    ancestors.add(object);
    const result = isVisible(parent, ancestors);
    ancestors.delete(object);
    visibility.set(object, result);
    return result;
  }

  function opacityFor(
    object: Record<string, unknown>,
    ancestors = new Set<Record<string, unknown>>()
  ): number {
    const cached = opacities.get(object);
    if (cached !== undefined) return cached;
    const ownOpacity = sceneOpacity(object);
    const parent = parentFor(object);
    if (!parent || ancestors.has(parent)) {
      opacities.set(object, ownOpacity);
      return ownOpacity;
    }
    ancestors.add(object);
    const result = ownOpacity * opacityFor(parent, ancestors);
    ancestors.delete(object);
    opacities.set(object, result);
    return result;
  }

  return { transformFor, isVisible, opacityFor };
}

function isSceneInterfaceObject(
  object: Record<string, unknown>,
  modelReference: string
): boolean {
  const name = sceneObjectName(object, -1);
  if (
    /holder|container|progress|toggle|button|icon|album\s*cover|audio\s*bars?|clock|text\s*orientation|rounded?\s*corners?|round\s*[lr]|frame|提示框|赞助|设置|控件/i.test(name)
  ) {
    return true;
  }
  return /(?:^|\/)ui(?:\/|$)/i.test(modelReference);
}

function sceneLayerLayout(
  object: Record<string, unknown>,
  transform: SceneTransform,
  canvasWidth: number,
  canvasHeight: number
): SceneLayerLayout | undefined {
  const size = sceneVector(object.size);
  if (!size) {
    return undefined;
  }
  const width = Math.abs(size[0] * transform.scaleX);
  const height = Math.abs(size[1] * transform.scaleY);
  const left = ((transform.originX - width / 2) / canvasWidth) * 100;
  const top = ((canvasHeight - transform.originY - height / 2) / canvasHeight) * 100;
  return {
    left: roundSceneNumber(left),
    top: roundSceneNumber(top),
    width: roundSceneNumber((width / canvasWidth) * 100),
    height: roundSceneNumber((height / canvasHeight) * 100)
  };
}

function sceneOpacity(object: Record<string, unknown>): number {
  const value = sceneNumber(object.alpha)
    ?? sceneNumber(object.opacity)
    ?? 1;
  return Math.max(0, Math.min(1, value));
}

function sceneRotation(transform: SceneTransform): number {
  return roundSceneNumber((-transform.rotation * 180) / Math.PI);
}

function sceneParallax(object: Record<string, unknown>): number {
  const depth = sceneVector(object.parallaxDepth);
  if (!depth) {
    return 0;
  }
  return roundSceneNumber(Math.max(-100, Math.min(100, ((depth[0] + depth[1]) / 2) * 20)));
}

function sceneMotionFor(
  effects: string[],
  puppet: boolean,
  objectIndex: number
): SceneLayerMotion {
  const normalized = effects.join(' ').toLowerCase();
  let type: SceneLayerMotion['type'] = 'none';
  let duration = 8;
  let intensity = 3;
  if (puppet) {
    type = 'sway';
    duration = 10;
    intensity = 5;
  } else if (/waterwaves|waterripple/.test(normalized)) {
    type = 'water';
    duration = 7;
    intensity = 4;
  } else if (/foliagesway/.test(normalized)) {
    type = 'sway';
    duration = 6;
    intensity = 5;
  } else if (/shake/.test(normalized)) {
    type = 'shake';
    duration = 4;
    intensity = 2;
  } else if (/waterflow/.test(normalized)) {
    type = 'drift';
    duration = 12;
    intensity = 4;
  } else if (/depthparallax|geometric_transform/.test(normalized)) {
    type = 'float';
    duration = 9;
    intensity = 3;
  } else if (/opacity|reflection|pulse/.test(normalized)) {
    type = 'pulse';
    duration = 5;
    intensity = 4;
  }
  return {
    type,
    duration,
    intensity,
    delay: roundSceneNumber(-(objectIndex % 7) * 0.37)
  };
}

function isApproximatedSceneEffect(effect: string): boolean {
  return /waterwaves|waterripple|foliagesway|shake|waterflow|depthparallax|geometric_transform|opacity|reflection|pulse/i.test(
    effect
  );
}

function sceneParticlePreset(
  reference: string
): 'ambient' | 'embers' | 'fog' | 'rain' | 'snow' | 'stars' {
  const normalized = reference.toLowerCase();
  if (/fog|smoke|mist|雾/.test(normalized)) return 'fog';
  if (/ember|fire|spark|火|焰/.test(normalized)) return 'embers';
  if (/rain|雨/.test(normalized)) return 'rain';
  if (/snow|雪/.test(normalized)) return 'snow';
  if (/star|trail|meteor|流星|星/.test(normalized)) return 'stars';
  return 'ambient';
}

function particlePresetDefaults(
  preset: 'ambient' | 'embers' | 'fog' | 'rain' | 'snow' | 'stars'
): {
  maxCount: number;
  spawnRate: number;
  lifetimeMin: number;
  lifetimeMax: number;
  sizeMin: number;
  sizeMax: number;
  speedMin: number;
  speedMax: number;
  opacityMin: number;
  opacityMax: number;
  direction: number[];
  colors: string[];
} {
  switch (preset) {
    case 'fog':
      return { maxCount: 12, spawnRate: 1.5, lifetimeMin: 8, lifetimeMax: 16, sizeMin: 600, sizeMax: 1400, speedMin: 8, speedMax: 24, opacityMin: 0.08, opacityMax: 0.22, direction: [1, 0.1], colors: ['#d8d8df'] };
    case 'embers':
      return { maxCount: 48, spawnRate: 10, lifetimeMin: 3, lifetimeMax: 6, sizeMin: 8, sizeMax: 32, speedMin: 20, speedMax: 70, opacityMin: 0.35, opacityMax: 0.95, direction: [0, 1], colors: ['#ff8f66', '#ffda6c'] };
    case 'rain':
      return { maxCount: 240, spawnRate: 100, lifetimeMin: 0.8, lifetimeMax: 1.8, sizeMin: 8, sizeMax: 18, speedMin: 500, speedMax: 900, opacityMin: 0.18, opacityMax: 0.6, direction: [-0.1, -1], colors: ['#b9d8ff'] };
    case 'snow':
      return { maxCount: 180, spawnRate: 35, lifetimeMin: 5, lifetimeMax: 12, sizeMin: 3, sizeMax: 12, speedMin: 15, speedMax: 55, opacityMin: 0.35, opacityMax: 0.95, direction: [0, -1], colors: ['#ffffff', '#dbeaff'] };
    case 'stars':
      return { maxCount: 64, spawnRate: 6, lifetimeMin: 0.7, lifetimeMax: 1.8, sizeMin: 4, sizeMax: 16, speedMin: 240, speedMax: 560, opacityMin: 0.4, opacityMax: 1, direction: [1, -0.35], colors: ['#ffffff', '#9ed6ff'] };
    default:
      return { maxCount: 64, spawnRate: 12, lifetimeMin: 2, lifetimeMax: 6, sizeMin: 3, sizeMax: 14, speedMin: 8, speedMax: 32, opacityMin: 0.2, opacityMax: 0.8, direction: [0, 1], colors: ['#ffffff'] };
  }
}

function findSceneNamedObject(
  values: Record<string, unknown>[],
  name: string
): Record<string, unknown> | undefined {
  return values.find(value => value.name === name);
}

function sceneParticleColor(value: unknown): string | undefined {
  const vector = sceneVector(value);
  if (!vector || vector.length < 3) {
    return undefined;
  }
  const useUnitRange = vector.slice(0, 3).every(channel => channel >= 0 && channel <= 1);
  return `#${vector.slice(0, 3).map(channel =>
    Math.round(Math.max(0, Math.min(255, useUnitRange ? channel * 255 : channel)))
      .toString(16)
      .padStart(2, '0')
  ).join('')}`;
}

function sceneVectorMagnitude(value: unknown, fallback: number): number {
  const direct = sceneNumber(value);
  if (direct !== undefined) {
    return Math.abs(direct);
  }
  const vector = sceneVector(value);
  if (!vector) {
    return fallback;
  }
  return Math.hypot(vector[0] ?? 0, vector[1] ?? 0);
}

function sceneVectorOrScalar(value: unknown): [number, number] {
  const direct = sceneNumber(value);
  if (direct !== undefined) {
    return [Math.abs(direct), Math.abs(direct)];
  }
  const vector = sceneVector(value);
  return [Math.abs(vector?.[0] ?? 0), Math.abs(vector?.[1] ?? vector?.[0] ?? 0)];
}

function clampSceneNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const resolved = sceneNumber(value) ?? fallback;
  return Math.max(minimum, Math.min(maximum, resolved));
}

function sceneNumber(value: unknown): number | undefined {
  const resolved = sceneValue(value);
  if (typeof resolved === 'number' && Number.isFinite(resolved)) {
    return resolved;
  }
  if (typeof resolved === 'string' && resolved.trim()) {
    const parsed = Number(resolved);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function roundSceneNumber(value: number): number {
  return Math.round(value * 100000) / 100000;
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
