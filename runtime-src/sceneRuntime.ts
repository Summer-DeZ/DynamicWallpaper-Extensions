import {
  CanvasTexture,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  RawShaderMaterial,
  Texture,
  Vector3,
  VideoTexture
} from 'three';
import type {
  JsonValue,
  SceneRuntimeManifest
} from '../src/domain/runtime';
import type { ParticleSettings, RendererConfiguration } from '../src/domain/renderer';
import { AssetLoader, asRecord, numberValue, unwrapValue, vectorValue } from './assets';
import { WallpaperAudioManager } from './audio';
import { RuntimeDiagnostics } from './diagnostics';
import { LayerEffectPipeline } from './effectPipeline';
import type { RuntimeLifecycleParticipant } from './lifecycle';
import {
  decodePuppetGeometry,
  parseMdlContainer,
  PuppetMeshRuntime,
  type PuppetBoneDefinition
} from './model';
import { ParticleEmitter } from './particles';
import {
  SceneScriptRuntime,
  type SceneScriptBatchBinding,
  type SceneScriptFrameState
} from './sceneScript';
import { originToLocalPosition } from './sceneTransform';
import { MaterialPassDefinition, WallpaperShaderCompiler } from './shaderCompiler';
import { ThreeHost } from './threeHost';
import { TimelineEngine, type TimelineKeyframe, type TimelineTrack } from './timeline';

interface ScriptBindingState {
  id: string;
  property: string;
  value: JsonValue;
  source: string;
  registered: boolean;
}

interface SceneNodeState {
  id: string;
  name: string;
  raw: Record<string, JsonValue>;
  object: Object3D;
  renderOrder: number;
  opacity: number;
  loadState: 'unloaded' | 'loading' | 'loaded' | 'failed';
  visualSize?: [number, number];
  visual?: Mesh;
  material?: Material;
  texture?: Texture;
  particle?: ParticleEmitter;
  pipeline?: LayerEffectPipeline;
  audio?: HTMLAudioElement;
  textCanvas?: HTMLCanvasElement;
  textTexture?: CanvasTexture;
  puppet?: PuppetMeshRuntime;
  puppetBones?: PuppetBoneDefinition[];
  videoTextures: VideoTexture[];
  scriptBindings: ScriptBindingState[];
  timelineBindings: Array<{ property: string; track: TimelineTrack<JsonValue> }>;
}

interface ActiveScriptBinding {
  node: SceneNodeState;
  binding: ScriptBindingState;
  input: SceneScriptBatchBinding;
}

export class WallpaperEngineSceneRuntime implements RuntimeLifecycleParticipant {
  private readonly host: ThreeHost;
  private readonly assets: AssetLoader;
  private readonly shaderCompiler: WallpaperShaderCompiler;
  private readonly scripts: SceneScriptRuntime;
  private readonly audio: WallpaperAudioManager;
  private readonly sceneRoot = new Group();
  private readonly nodes = new Map<string, SceneNodeState>();
  private readonly nodeList: SceneNodeState[] = [];
  private readonly timelines = new TimelineEngine();
  private readonly worldScale = new Vector3();
  private readonly animatedHostEffects: boolean;
  private readonly sceneWidth: number;
  private readonly sceneHeight: number;
  private readonly scriptFrame: SceneScriptFrameState;
  private readonly activeScriptBindings: ActiveScriptBinding[] = [];
  private readonly scriptBatchInputs: SceneScriptBatchBinding[] = [];
  private userProperties: Record<string, JsonValue>;
  private pointer = { x: 0, y: 0, buttons: 0 };
  private paused = false;
  private viewportWidth = 1;
  private viewportHeight = 1;
  private deferredLoadScheduled = false;
  private scriptInitializationScheduled = false;
  private scriptRegistrationScheduled = false;
  private scriptsReady = false;
  private unloadedVisualCount = 0;
  private visualQueueDirty = true;
  private visualActivityDirty = true;
  private renderInvalidated = true;
  private disposed = false;

  constructor(
    configuration: RendererConfiguration,
    private readonly manifest: SceneRuntimeManifest,
    root: HTMLElement,
    private readonly diagnostics: RuntimeDiagnostics,
    userProperties: Record<string, JsonValue>,
    onContextRestoreRequired: () => void,
    private readonly onFrameRequested: () => void = () => undefined
  ) {
    const general = asRecord(manifest.scene.general);
    const projection = asRecord(general.orthogonalprojection);
    this.sceneWidth = numberValue(projection.width, 1920);
    this.sceneHeight = numberValue(projection.height, 1080);
    this.animatedHostEffects = configuration.effects.grain > 0;
    this.userProperties = { ...userProperties };
    this.scriptFrame = {
      time: 0,
      delta: 0,
      canvasSize: [this.sceneWidth, this.sceneHeight],
      pointer: [0, 0],
      pointerDown: false,
      audioSpectrum16: [],
      userProperties: this.userProperties
    };
    this.assets = new AssetLoader(
      manifest.assetRootUri,
      diagnostics,
      manifest.resources,
      () => {
        if (this.disposed || this.paused) return;
        this.renderInvalidated = true;
        this.onFrameRequested();
      }
    );
    this.shaderCompiler = new WallpaperShaderCompiler(this.assets, diagnostics);
    this.scripts = new SceneScriptRuntime(diagnostics);
    this.audio = new WallpaperAudioManager(diagnostics);
    this.host = new ThreeHost(
      root,
      sceneColor(general.clearcolor, configuration.backgroundColor),
      configuration.performance.profile,
      configuration.effects,
      diagnostics,
      onContextRestoreRequired
    );
    this.host.scene.add(this.sceneRoot);
  }

  async initialize(): Promise<void> {
    const rawObjects = Array.isArray(this.manifest.scene.objects)
      ? this.manifest.scene.objects.map(asRecord)
      : [];
    for (const [index, raw] of rawObjects.entries()) {
      const id = String(raw.id ?? index);
      const object = new Group();
      object.name = typeof raw.name === 'string' ? raw.name : `Scene object ${id}`;
      const state: SceneNodeState = {
        id,
        name: object.name,
        raw,
        object,
        renderOrder: index,
        opacity: 1,
        loadState: hasLoadableResource(raw) ? 'unloaded' : 'loaded',
        videoTextures: [],
        scriptBindings: [],
        timelineBindings: []
      };
      this.nodes.set(id, state);
      this.nodeList.push(state);
      if (state.loadState === 'unloaded') this.unloadedVisualCount++;
      this.registerScripts(state);
      state.timelineBindings = extractTimelineBindings(raw, id);
      state.timelineBindings.forEach(binding => this.timelines.register(binding.track));
    }

    for (const state of this.nodeList) {
      const parentId = state.raw.parent === undefined ? undefined : String(state.raw.parent);
      const parent = parentId ? this.nodes.get(parentId)?.object : undefined;
      (parent ?? this.sceneRoot).add(state.object);
      this.applyNodeProperties(state);
    }
    const initial = this.pendingVisibleNodes();
    for (const state of initial) {
      await this.ensureVisual(state);
      if (state.visual || state.particle) break;
    }
    if (!this.nodeList.some(node => node.visual || node.particle)) {
      throw new Error('Scene 中没有成功创建的视觉节点。');
    }
    this.queueVisibleVisuals();
    this.queueScriptInitialization();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.visualActivityDirty = true;
    this.nodeList.forEach(node => {
      node.particle?.setPaused(paused);
      node.puppet?.setPaused(paused);
    });
    this.syncVisualActivity();
    void this.audio.setPaused(paused);
    if (!paused) {
      this.renderInvalidated = true;
      this.visualQueueDirty = true;
      this.queueVisibleVisuals();
      this.queueScriptInitialization();
      this.queueScriptRegistrations();
    }
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.host.resize(width, height, pixelRatio);
    const scale = Math.max(width / this.sceneWidth, height / this.sceneHeight);
    this.sceneRoot.scale.setScalar(scale);
    this.sceneRoot.updateMatrixWorld(true);
    this.nodeList.forEach(node => this.resizeNodePipeline(node, true));
    this.renderInvalidated = true;
  }

  update(timeSeconds: number, deltaSeconds: number): void {
    const sceneFrameRequired = this.renderInvalidated || this.hasNonVideoFrameUpdates();
    const videoFrameAvailable = this.hasAvailableVideoFrame();
    if (!sceneFrameRequired && !videoFrameAvailable) return;
    if (!this.paused) {
      const audioSpectrum16 = this.audio.spectrum16();
      this.scriptFrame.time = timeSeconds;
      this.scriptFrame.delta = deltaSeconds;
      this.scriptFrame.pointer[0] = this.pointer.x;
      this.scriptFrame.pointer[1] = this.pointer.y;
      this.scriptFrame.pointerDown = this.pointer.buttons !== 0;
      this.scriptFrame.audioSpectrum16 = audioSpectrum16;
      this.scriptFrame.userProperties = this.userProperties;
      for (const node of this.nodeList) {
        for (const binding of node.timelineBindings) {
          const value = this.timelines.advance(binding.track, deltaSeconds);
          if (value !== undefined) this.applyScriptValue(node, binding.property, value);
        }
      }
      for (const activeBinding of this.activeScriptBindings) {
        activeBinding.input.value = activeBinding.binding.value;
      }
      const scriptValues = this.scriptsReady
        ? this.scripts.updateBatch(
            this.scriptBatchInputs,
            this.scriptFrame
          )
        : {};
      for (const { node, binding } of this.activeScriptBindings) {
        const value = Object.prototype.hasOwnProperty.call(scriptValues, binding.id)
          ? scriptValues[binding.id]
          : binding.value;
        if (jsonValuesEqual(binding.value, value)) continue;
        binding.value = value;
        this.applyScriptValue(node, binding.property, value);
      }
      this.syncVisualActivity();
      for (const node of this.nodeList) {
        const renderable = isEffectivelyRenderable(node);
        if (!renderable) continue;
        node.particle?.update(deltaSeconds, this.sceneWidth, this.sceneHeight);
        if (node.puppet && node.puppetBones) node.puppet.updatePhysics(deltaSeconds, node.puppetBones);
        if (node.pipeline && node.videoTextures.some(texture =>
          this.assets.videoTextureHasNewFrame(texture)
        )) node.pipeline.invalidate();
        node.pipeline?.render(timeSeconds);
        updateMaterialUniforms(node.material, timeSeconds, this.pointer, audioSpectrum16);
      }
      if (this.scriptsReady) this.applyScriptCommands();
      this.queueVisibleVisuals();
    }
    // Fallback video gates need a lightweight RAF poll, but unchanged decoded
    // frames do not justify another WebGL scene draw.
    if (sceneFrameRequired || videoFrameAvailable) {
      this.host.render(timeSeconds, deltaSeconds);
      this.renderInvalidated = false;
      this.consumeAvailableVideoFrames();
    }
  }

  needsFrameUpdates(): boolean {
    if (this.disposed || this.paused) return false;
    return this.renderInvalidated
      || this.hasNonVideoFrameUpdates()
      || this.hasAvailableVideoFrame()
      || this.hasVideoTextureRequiringPolling();
  }

  private hasNonVideoFrameUpdates(): boolean {
    if (this.animatedHostEffects) return true;
    // SceneScript and timeline bindings may reveal a currently hidden node, so
    // they remain simulation drivers even while their target is not drawable.
    if (this.nodeList.some(node =>
      node.scriptBindings.length > 0 || node.timelineBindings.length > 0
    )) return true;
    for (const node of this.nodeList) {
      if (!isEffectivelyRenderable(node)) continue;
      if (node.particle || node.puppet?.hasActivePhysics()) return true;
      if (materialNeedsFrameUpdates(node.material)) return true;
      if (node.pipeline?.needsFrameUpdates()) return true;
    }
    return false;
  }

  needsPointerUpdates(): boolean {
    if (this.disposed || this.paused) return false;
    if (this.nodeList.some(node => node.scriptBindings.length > 0)) return true;
    return this.nodeList.some(node =>
      isEffectivelyRenderable(node) && materialUsesPointer(node.material)
    );
  }

  private hasAvailableVideoFrame(): boolean {
    return this.nodeList.some(node =>
      isEffectivelyRenderable(node)
      && node.videoTextures.some(texture => this.assets.videoTextureHasNewFrame(texture))
    );
  }

  private hasVideoTextureRequiringPolling(): boolean {
    return this.nodeList.some(node =>
      isEffectivelyRenderable(node)
      && node.videoTextures.some(texture => this.assets.videoTextureRequiresPolling(texture))
    );
  }

  private consumeAvailableVideoFrames(): void {
    const consumed = new Set<VideoTexture>();
    for (const node of this.nodeList) {
      if (!isEffectivelyRenderable(node)) continue;
      for (const texture of node.videoTextures) {
        if (consumed.has(texture)) continue;
        consumed.add(texture);
        if (this.assets.videoTextureHasNewFrame(texture)) {
          this.assets.consumeVideoTextureFrame(texture);
        }
      }
    }
  }

  updatePointer(x: number, y: number, buttons: number): void {
    const scale = Math.max(
      this.viewportWidth / this.sceneWidth,
      this.viewportHeight / this.sceneHeight
    );
    const nextX = (x - this.viewportWidth / 2) / scale + this.sceneWidth / 2;
    const nextY = this.sceneHeight / 2 - (y - this.viewportHeight / 2) / scale;
    const changed = nextX !== this.pointer.x || nextY !== this.pointer.y || buttons !== this.pointer.buttons;
    this.pointer.x = nextX;
    this.pointer.y = nextY;
    this.pointer.buttons = buttons;
    if (changed && this.needsPointerUpdates()) this.renderInvalidated = true;
  }

  updateProperties(values: Record<string, unknown>): void {
    this.userProperties = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, value as JsonValue])
    );
    this.scriptFrame.userProperties = this.userProperties;
    this.renderInvalidated = true;
    this.visualActivityDirty = true;
    this.nodeList.forEach(node => this.applyNodeProperties(node));
    this.syncVisualActivity();
    this.queueVisibleVisuals();
  }

  dispose(): void {
    this.disposed = true;
    for (const node of this.nodeList) this.releaseNodeVisual(node);
    this.nodes.clear();
    this.nodeList.length = 0;
    this.activeScriptBindings.length = 0;
    this.scriptBatchInputs.length = 0;
    this.scripts.dispose();
    this.audio.dispose();
    this.assets.dispose();
    this.host.dispose();
  }

  private async createVisual(state: SceneNodeState, renderOrder: number): Promise<void> {
    const raw = state.raw;
    if (typeof raw.image === 'string') {
      await this.createImageNode(state, raw.image, renderOrder);
      return;
    }
    if (typeof raw.particle === 'string') {
      await this.createParticleNode(state, raw.particle, renderOrder);
      return;
    }
    if (raw.text !== undefined) {
      this.createTextNode(state, renderOrder);
      return;
    }
    if (typeof raw.sound === 'string') {
      state.audio = this.audio.add(this.assets.resolve(raw.sound), {
        loop: booleanValue(raw.loop, true),
        volume: numberValue(resolveBoundValue(raw.volume, this.userProperties), 1)
      });
    }
  }

  private async createImageNode(state: SceneNodeState, modelPath: string, renderOrder: number): Promise<void> {
    const model = asRecord(await this.assets.json(modelPath));
    const materialPath = typeof model.material === 'string' ? model.material : undefined;
    if (!materialPath) throw new Error(`模型缺少 material：${modelPath}`);
    const materialDefinition = asRecord(await this.assets.json(materialPath));
    const rawPass = Array.isArray(materialDefinition.passes)
      ? asRecord(materialDefinition.passes[0])
      : materialDefinition;
    const pass = normalizeMaterialPass(rawPass);
    const textureReference = pass.textures?.find(value => typeof value === 'string');
    let texture: Texture | undefined;
    if (textureReference) texture = await this.assets.texture(textureReference, true, materialPath);
    const material = await this.shaderCompiler.materialForPass(pass, materialPath);
    setShaderResolution(material, this.sceneWidth, this.sceneHeight);
    if (texture) {
      if (material.uniforms.g_Texture0) material.uniforms.g_Texture0.value = texture;
      if (material.uniforms.u_Texture) material.uniforms.u_Texture.value = texture;
    }
    const size = vectorValue(resolveBoundValue(state.raw.size, this.userProperties), 2, 1);
    const width = size[0] || numberValue(model.width, 1);
    const height = size[1] || numberValue(model.height, 1);
    const mesh = new Mesh(new PlaneGeometry(width, height), material);
    mesh.renderOrder = renderOrder;
    // Wallpaper Engine custom vertex shaders can move geometry outside the
    // source plane. Built-in image shaders do not, so those meshes can safely
    // use Three's camera-frustum rejection instead of drawing off-screen.
    mesh.frustumCulled = materialPassSupportsFrustumCulling(pass.shader);
    state.object.add(mesh);
    state.visual = mesh;
    state.material = material;
    state.texture = texture;
    state.visualSize = [width, height];

    if (typeof model.puppet === 'string') {
      try {
        const container = parseMdlContainer(await this.assets.buffer(model.puppet));
        const geometry = decodePuppetGeometry(container);
        if (geometry) {
          const puppet = new PuppetMeshRuntime(geometry, texture);
          puppet.mesh.renderOrder = renderOrder;
          state.object.remove(mesh);
          mesh.geometry.dispose();
          material.dispose();
          state.object.add(puppet.mesh);
          state.visual = puppet.mesh;
          state.material = Array.isArray(puppet.mesh.material) ? puppet.mesh.material[0] : puppet.mesh.material;
          state.puppet = puppet;
          state.puppetBones = geometry.bones;
          this.diagnostics.add({
            code: 'puppet-container-loaded', severity: 'info',
            message: `已加载 Puppet MDLV${container.version} 网格、骨骼、权重和 Blend Shape。`,
            resource: model.puppet, nodeId: state.id
          });
        } else {
          this.diagnostics.add({
            code: 'puppet-chunks-preserved', severity: 'warning',
            message: `Puppet MDLV${container.version} 的 ${container.chunks.length} 个 chunk 已保留，但当前未发现可解码网格；节点保留基础图像。`,
            resource: model.puppet, nodeId: state.id
          });
        }
      } catch (error) {
        this.diagnostics.add({
          code: 'puppet-container-failed',
          severity: 'error',
          message: `Puppet 容器解析失败：${model.puppet}`,
          resource: model.puppet,
          nodeId: state.id,
          details: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const effects = Array.isArray(state.raw.effects) ? state.raw.effects : [];
    if (texture && effects.length > 0) {
      state.pipeline = await LayerEffectPipeline.create(
        this.host.renderer,
        texture,
        effects,
        1,
        1,
        this.assets,
        this.shaderCompiler,
        this.diagnostics
      );
      const output = state.pipeline?.outputTexture();
      if (output) {
        setMaterialMainTexture(state.material, output);
      }
      this.resizeNodePipeline(state);
    }
    this.refreshNodeVideoTextures(state);
  }

  private async createParticleNode(state: SceneNodeState, path: string, renderOrder: number): Promise<void> {
    const raw = asRecord(await this.assets.json(path));
    const settings = particleSettings(raw, state.name);
    let sprite: Texture | undefined;
    if (typeof raw.material === 'string') {
      try {
        const material = asRecord(await this.assets.json(raw.material));
        const pass = Array.isArray(material.passes) ? asRecord(material.passes[0]) : material;
        const texture = Array.isArray(pass.textures)
          ? pass.textures.find(value => typeof value === 'string')
          : undefined;
        if (typeof texture === 'string') sprite = await this.assets.texture(texture, true, raw.material);
      } catch (error) {
        this.diagnostics.add({
          code: 'particle-material-failed',
          severity: 'warning',
          message: `粒子材质未加载，将使用程序纹理：${path}`,
          resource: path,
          details: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const emitter = new ParticleEmitter(settings, sprite, hashString(state.id));
    emitter.object.renderOrder = renderOrder;
    state.object.add(emitter.object);
    state.particle = emitter;
    state.texture = sprite;
    this.refreshNodeVideoTextures(state);
  }

  private createTextNode(state: SceneNodeState, renderOrder: number): void {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 512;
    const texture = new CanvasTexture(canvas);
    const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
    const size = vectorValue(resolveBoundValue(state.raw.size, this.userProperties), 2, 1);
    const mesh = new Mesh(new PlaneGeometry(size[0] || 800, size[1] || 200), material);
    mesh.renderOrder = renderOrder;
    state.object.add(mesh);
    state.visual = mesh;
    state.material = material;
    state.textCanvas = canvas;
    state.textTexture = texture;
    state.visualSize = [size[0] || 800, size[1] || 200];
    this.drawText(state, String(resolveBoundValue(state.raw.text, this.userProperties) ?? ''));
  }

  private drawText(state: SceneNodeState, text: string): void {
    const canvas = state.textCanvas;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = sceneColor(resolveBoundValue(state.raw.color, this.userProperties), '#ffffff');
    const fontSize = numberValue(resolveBoundValue(state.raw.fontsize, this.userProperties), 128);
    context.font = `${fontSize}px ${typeof state.raw.font === 'string' ? state.raw.font : 'sans-serif'}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const y = canvas.height / 2 + (index - (lines.length - 1) / 2) * fontSize * 1.2;
      context.fillText(line, canvas.width / 2, y, canvas.width);
    });
    if (state.textTexture) state.textTexture.needsUpdate = true;
  }

  private registerScripts(state: SceneNodeState): void {
    for (const [property, rawValue] of Object.entries(state.raw)) {
      const binding = asRecord(rawValue);
      if (typeof binding.script !== 'string') continue;
      const id = `${state.id}:${property}`;
      const value = binding.value ?? null;
      state.scriptBindings.push({
        id,
        property,
        value,
        source: binding.script,
        registered: false
      });
    }
  }

  private applyNodeProperties(state: SceneNodeState): void {
    const origin = vectorValue(resolveBoundValue(state.raw.origin, this.userProperties), 3, 0);
    const scale = vectorValue(resolveBoundValue(state.raw.scale, this.userProperties), 3, 1);
    const angles = vectorValue(resolveBoundValue(state.raw.angles, this.userProperties), 3, 0);
    state.object.position.set(...this.localPosition(state, origin));
    state.object.scale.set(scale[0], scale[1], scale[2]);
    state.object.rotation.set(
      angles[0] * Math.PI / 180,
      angles[1] * Math.PI / 180,
      angles[2] * Math.PI / 180
    );
    this.setNodeVisibility(
      state,
      booleanValue(resolveBoundValue(state.raw.visible, this.userProperties), true)
    );
    const alpha = numberValue(resolveBoundValue(state.raw.alpha, this.userProperties), 1);
    this.setNodeOpacity(state, alpha);
    if (state.textCanvas) {
      this.drawText(state, String(resolveBoundValue(state.raw.text, this.userProperties) ?? ''));
    }
  }

  private applyScriptValue(state: SceneNodeState, property: string, value: JsonValue): void {
    if (property === 'origin') {
      const origin = objectVector(value, 3);
      state.object.position.set(...this.localPosition(state, origin));
    } else if (property === 'scale') {
      const scale = objectVector(value, 3, 1);
      state.object.scale.set(scale[0], scale[1], scale[2]);
    } else if (property === 'angles') {
      const angles = objectVector(value, 3);
      state.object.rotation.set(...angles.map(item => item * Math.PI / 180) as [number, number, number]);
    } else if (property === 'alpha') {
      this.setNodeOpacity(state, numberValue(value, 1));
    } else if (property === 'visible') {
      this.setNodeVisibility(state, Boolean(value));
    } else if (property === 'text') {
      this.drawText(state, String(value ?? ''));
    }
  }

  private applyScriptCommands(): void {
    for (const command of this.scripts.drainCommands()) {
      const node = command.target === 'thisLayer'
        ? undefined
        : this.nodeList.find(item => item.name === command.target || item.id === command.target);
      if (!node) continue;
      if (command.action === 'play') void node.audio?.play().catch(() => undefined);
      else if (command.action === 'pause') node.audio?.pause();
      else if (command.action === 'stop' && node.audio) {
        node.audio.pause();
        node.audio.currentTime = 0;
      } else if (command.action === 'setVisibility') this.setNodeVisibility(node, Boolean(command.args[0]));
      else if (command.action === 'setOpacity') this.setNodeOpacity(node, numberValue(command.args[0], 1));
    }
  }

  private localPosition(state: SceneNodeState, origin: readonly number[]): [number, number, number] {
    return originToLocalPosition(
      origin,
      this.sceneWidth,
      this.sceneHeight,
      state.object.parent !== this.sceneRoot
    );
  }

  private syncVisualActivity(): void {
    if (!this.visualActivityDirty) return;
    this.visualActivityDirty = false;
    const activity = new Map<VideoTexture, boolean>();
    for (const node of this.nodeList) {
      const active = !this.paused && isEffectivelyRenderable(node);
      for (const texture of node.videoTextures) {
        activity.set(texture, active || activity.get(texture) === true);
      }
    }
    for (const [texture, active] of activity) {
      this.assets.setTextureActive(texture, active);
    }
  }

  private refreshNodeVideoTextures(state: SceneNodeState): void {
    const textures = new Set<VideoTexture>();
    addVideoTextures(textures, state.texture);
    if (state.material instanceof RawShaderMaterial) {
      for (const uniform of Object.values(state.material.uniforms)) {
        addVideoTextures(textures, uniform.value);
      }
    } else if (state.material instanceof MeshBasicMaterial) {
      addVideoTextures(textures, state.material.map);
    }
    for (const texture of state.pipeline?.videoTextures() ?? []) textures.add(texture);
    state.videoTextures = [...textures];
    this.visualActivityDirty = true;
  }

  private async ensureVisual(state: SceneNodeState): Promise<void> {
    if (state.loadState !== 'unloaded' || this.disposed) return;
    state.loadState = 'loading';
    this.unloadedVisualCount = Math.max(0, this.unloadedVisualCount - 1);
    try {
      await this.createVisual(state, state.renderOrder);
      if (this.disposed) {
        this.releaseNodeVisual(state);
        state.loadState = 'failed';
        return;
      }
      this.applyNodeProperties(state);
      state.loadState = 'loaded';
      this.renderInvalidated = true;
      this.visualActivityDirty = true;
      this.syncVisualActivity();
      this.onFrameRequested();
    } catch (error) {
      this.releaseNodeVisual(state);
      state.loadState = 'failed';
      if (this.disposed) return;
      this.diagnostics.add({
        code: 'scene-node-isolated',
        severity: 'error',
        message: `Scene 节点已隔离：${state.name}`,
        nodeId: state.id,
        details: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private pendingVisibleNodes(): SceneNodeState[] {
    return this.nodeList
      .filter(state => state.loadState === 'unloaded' && isEffectivelyRenderable(state))
      .sort((left, right) => visualPriority(right.raw) - visualPriority(left.raw)
        || left.renderOrder - right.renderOrder);
  }

  private queueVisibleVisuals(): void {
    if (this.disposed || this.paused || this.deferredLoadScheduled
      || this.unloadedVisualCount === 0 || !this.visualQueueDirty) return;
    this.visualQueueDirty = false;
    const next = this.pendingVisibleNodes()[0];
    if (!next) return;
    this.deferredLoadScheduled = true;
    scheduleIdle(async () => {
      if (this.disposed) {
        this.deferredLoadScheduled = false;
        return;
      }
      if (this.paused) {
        this.deferredLoadScheduled = false;
        this.visualQueueDirty = true;
        return;
      }
      await this.ensureVisual(next);
      this.deferredLoadScheduled = false;
      this.visualQueueDirty = true;
      this.queueVisibleVisuals();
    });
  }

  private resizeNodePipeline(state: SceneNodeState, worldMatricesCurrent = false): void {
    if (!state.pipeline || !state.visualSize) return;
    if (!worldMatricesCurrent) state.object.updateWorldMatrix(true, false);
    const worldScale = state.object.getWorldScale(this.worldScale);
    state.pipeline.resize(
      Math.max(1, Math.min(this.viewportWidth, Math.round(state.visualSize[0] * Math.abs(worldScale.x)))),
      Math.max(1, Math.min(this.viewportHeight, Math.round(state.visualSize[1] * Math.abs(worldScale.y))))
    );
  }

  private queueScriptInitialization(): void {
    if (this.disposed || this.paused || this.scriptInitializationScheduled || this.scriptsReady) return;
    if (!this.nodeList.some(node => node.scriptBindings.length > 0)) return;
    this.scriptInitializationScheduled = true;
    scheduleIdle(async () => {
      if (this.disposed || this.paused) {
        this.scriptInitializationScheduled = false;
        return;
      }
      try {
        await this.scripts.initialize();
        if (this.disposed || this.paused) {
          this.scripts.dispose();
          return;
        }
        this.scriptsReady = true;
      } catch (error) {
        if (!this.disposed) {
          this.diagnostics.add({
            code: 'scene-script-runtime-failed',
            severity: 'error',
            message: 'SceneScript 运行时初始化失败；场景视觉层继续运行。',
            details: error instanceof Error ? error.message : String(error)
          });
        }
      } finally {
        this.scriptInitializationScheduled = false;
      }
      if (this.scriptsReady) this.queueScriptRegistrations();
    });
  }

  private queueScriptRegistrations(): void {
    if (this.disposed || this.paused || !this.scriptsReady || this.scriptRegistrationScheduled) return;
    const pending = this.nodeList.flatMap(node => node.scriptBindings
      .filter(binding => !binding.registered)
      .map(binding => ({ node, binding })));
    if (pending.length === 0) return;
    this.scriptRegistrationScheduled = true;
    scheduleIdle(() => {
      this.scriptRegistrationScheduled = false;
      if (this.disposed || this.paused || !this.scriptsReady) return;
      for (const { node, binding } of pending.slice(0, 2)) {
        this.scripts.register(binding.id, binding.source, binding.value);
        binding.registered = true;
        const input = { id: binding.id, value: binding.value };
        this.activeScriptBindings.push({ node, binding, input });
        this.scriptBatchInputs.push(input);
      }
      this.queueScriptRegistrations();
    });
  }

  private setNodeVisibility(state: SceneNodeState, visible: boolean): void {
    if (state.object.visible === visible) return;
    state.object.visible = visible;
    this.visualQueueDirty = true;
    this.visualActivityDirty = true;
    this.renderInvalidated = true;
  }

  private setNodeOpacity(state: SceneNodeState, opacity: number): void {
    const wasDrawable = state.opacity > 0.001;
    state.opacity = opacity;
    setMaterialOpacity(state.material, opacity);
    const drawable = opacity > 0.001;
    if (state.visual) state.visual.visible = drawable;
    if (state.particle) state.particle.object.visible = drawable;
    if (wasDrawable !== drawable) {
      this.visualQueueDirty = true;
      this.visualActivityDirty = true;
    }
    this.renderInvalidated = true;
  }

  private releaseNodeVisual(state: SceneNodeState): void {
    if (state.visual) state.object.remove(state.visual);
    if (state.particle) state.object.remove(state.particle.object);
    state.pipeline?.dispose();
    state.particle?.dispose();
    state.puppet?.dispose();
    if (state.audio) {
      state.audio.pause();
      state.audio.removeAttribute('src');
    }
    state.textTexture?.dispose();
    if (!state.puppet) {
      state.visual?.geometry.dispose();
      state.material?.dispose();
    }
    state.pipeline = undefined;
    state.particle = undefined;
    state.puppet = undefined;
    state.audio = undefined;
    state.textTexture = undefined;
    state.textCanvas = undefined;
    state.visual = undefined;
    state.material = undefined;
    state.texture = undefined;
    state.videoTextures.length = 0;
    this.visualActivityDirty = true;
  }
}

function hasLoadableResource(raw: Record<string, JsonValue>): boolean {
  return typeof raw.image === 'string'
    || typeof raw.particle === 'string'
    || raw.text !== undefined
    || typeof raw.sound === 'string';
}

function visualPriority(raw: Record<string, JsonValue>): number {
  const size = vectorValue(unwrapValue(raw.size), 2, 1);
  const area = Math.max(1, size[0]) * Math.max(1, size[1]);
  if (typeof raw.image === 'string') return area + 1_000_000_000;
  if (raw.text !== undefined) return area + 100_000_000;
  if (typeof raw.particle === 'string') return 10_000_000;
  return 1;
}

function scheduleIdle(callback: () => void | Promise<void>): void {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => void callback(), { timeout: 250 });
  } else {
    window.setTimeout(() => void callback(), 16);
  }
}

export function isEffectivelyVisible(object: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

export function isEffectivelyRenderable(state: { object: Object3D; opacity: number }): boolean {
  return isEffectivelyVisible(state.object)
    && state.opacity > 0.001;
}

export function materialPassSupportsFrustumCulling(shader: string | undefined): boolean {
  if (!shader) return true;
  const normalized = shader.replace(/\\/g, '/').split('/').pop() ?? shader;
  return /^(?:genericimage\d*|generic|sprite|particle)$/i.test(normalized);
}

export function materialNeedsFrameUpdates(material: Material | undefined): boolean {
  if (!(material instanceof RawShaderMaterial)) return false;
  const dynamicUniforms = ['g_Time', 'u_Time', 'g_AudioSpectrum16'];
  return dynamicUniforms.some(name =>
    shaderUsesUniform(material.vertexShader, name)
    || shaderUsesUniform(material.fragmentShader, name)
  );
}

export function materialUsesPointer(material: Material | undefined): boolean {
  return material instanceof RawShaderMaterial
    && (shaderUsesUniform(material.vertexShader, 'g_PointerPosition')
      || shaderUsesUniform(material.fragmentShader, 'g_PointerPosition'));
}

function shaderUsesUniform(shader: string, name: string): boolean {
  const declarations = new RegExp(`\\buniform\\s+[^;]*\\b${name}\\b[^;]*;`, 'g');
  return new RegExp(`\\b${name}\\b`).test(shader.replace(declarations, ''));
}

function addVideoTextures(target: Set<VideoTexture>, value: unknown): void {
  if (value instanceof VideoTexture) {
    target.add(value);
  } else if (Array.isArray(value)) {
    value.forEach(item => addVideoTextures(target, item));
  }
}

export function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftEntries = Object.entries(left);
    const rightObject = right as Record<string, JsonValue>;
    return leftEntries.length === Object.keys(rightObject).length
      && leftEntries.every(([key, value]) =>
        Object.prototype.hasOwnProperty.call(rightObject, key)
        && jsonValuesEqual(value, rightObject[key])
      );
  }
  return false;
}

function extractTimelineBindings(
  raw: Record<string, JsonValue>,
  nodeId: string
): Array<{ property: string; track: TimelineTrack<JsonValue> }> {
  const sources = [raw.timeline, raw.animation, raw.animations];
  const entries: Array<[string, Record<string, JsonValue>]> = [];
  for (const source of sources) {
    if (Array.isArray(source)) {
      source.map(asRecord).forEach((entry, index) => {
        const property = String(entry.property ?? entry.name ?? `track-${index}`);
        entries.push([property, entry]);
      });
    } else if (source && typeof source === 'object') {
      for (const [property, value] of Object.entries(source)) entries.push([property, asRecord(value)]);
    }
  }
  return entries.flatMap(([property, definition], index) => {
    const frames = Array.isArray(definition.keyframes)
      ? definition.keyframes
      : Array.isArray(definition.frames)
        ? definition.frames
        : [];
    const keyframes: TimelineKeyframe<JsonValue>[] = frames.map((value, frameIndex) => {
      const frame = asRecord(value);
      const curve = Array.isArray(frame.curve) && frame.curve.length >= 4
        ? frame.curve.slice(0, 4).map(value => numberValue(value, 0)) as [number, number, number, number]
        : undefined;
      const easingName = typeof frame.easing === 'string' ? frame.easing : undefined;
      const easing = curve ?? (
        easingName === 'linear' || easingName === 'ease-in' || easingName === 'ease-out' || easingName === 'ease-in-out'
          ? easingName
          : undefined
      );
      return {
        time: numberValue(frame.time ?? frame.frame ?? frame.at, frameIndex),
        value: (frame.value ?? frame.target ?? null) as JsonValue,
        easing
      };
    });
    if (keyframes.length === 0) return [];
    const maximumTime = Math.max(...keyframes.map(frame => frame.time), 0.000001);
    const rawMode = String(definition.mode ?? definition.repeat ?? 'loop').toLowerCase();
    const mode = rawMode === 'mirror' || rawMode === 'bounce' || rawMode === 'pingpong'
      ? 'mirror'
      : rawMode === 'single' || rawMode === 'once' || rawMode === 'none'
        ? 'single'
        : 'loop';
    return [{
      property,
      track: {
        id: `${nodeId}:${property}:${index}`,
        duration: numberValue(definition.duration, maximumTime),
        mode,
        startPaused: definition.startPaused === true || definition.paused === true,
        keyframes
      }
    }];
  });
}

function normalizeMaterialPass(raw: Record<string, JsonValue>): MaterialPassDefinition {
  return {
    shader: typeof raw.shader === 'string' ? raw.shader : undefined,
    blending: typeof raw.blending === 'string' ? raw.blending : undefined,
    cullmode: typeof raw.cullmode === 'string' ? raw.cullmode : undefined,
    depthtest: typeof raw.depthtest === 'string' ? raw.depthtest : undefined,
    depthwrite: typeof raw.depthwrite === 'boolean' || typeof raw.depthwrite === 'string'
      ? raw.depthwrite
      : undefined,
    combos: numberBooleanRecord(raw.combos),
    constantshadervalues: asRecord(raw.constantshadervalues),
    textures: Array.isArray(raw.textures)
      ? raw.textures.map(value => typeof value === 'string' ? value : null)
      : []
  };
}

function resolveBoundValue(
  value: JsonValue | undefined,
  properties: Record<string, JsonValue>
): JsonValue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const binding = value as Record<string, JsonValue>;
  const user = binding.user;
  if (typeof user === 'string' && properties[user] !== undefined) return properties[user];
  if (user && typeof user === 'object' && !Array.isArray(user)) {
    const userBinding = user as Record<string, JsonValue>;
    const name = typeof userBinding.name === 'string' ? userBinding.name : undefined;
    if (name && properties[name] !== undefined) {
      const condition = userBinding.condition;
      if (condition === undefined || String(properties[name]) === String(condition)) {
        return true;
      }
      return false;
    }
  }
  return unwrapValue(value);
}

function particleSettings(raw: Record<string, JsonValue>, name: string): ParticleSettings {
  const emitters = Array.isArray(raw.emitter) ? raw.emitter.map(asRecord) : [];
  const initializers = Array.isArray(raw.initializer) ? raw.initializer.map(asRecord) : [];
  const operators = Array.isArray(raw.operator) ? raw.operator.map(asRecord) : [];
  const emitter = emitters[0] ?? {};
  const lifetime = findNamed(initializers, 'lifetime');
  const size = findNamed(initializers, 'size');
  const velocity = findNamed(initializers, 'velocity');
  const alpha = findNamed(initializers, 'alpha');
  const color = findNamed(initializers, 'color');
  const direction = vectorValue(emitter.directions, 3, 0);
  const velocityMin = vectorValue(velocity?.min, 3, 0);
  const velocityMax = vectorValue(velocity?.max, 3, 0);
  const normalizedName = `${name} ${String(raw.material ?? '')}`.toLowerCase();
  const preset: ParticleSettings['preset'] = /fog|mist|smoke|雾/.test(normalizedName)
    ? 'fog'
    : /rain|雨/.test(normalizedName)
      ? 'rain'
      : /snow|雪/.test(normalizedName)
        ? 'snow'
        : /ember|fire|spark|火/.test(normalizedName)
          ? 'embers'
          : /star|meteor|星/.test(normalizedName)
            ? 'stars'
            : 'ambient';
  const rendererNames = Array.isArray(raw.renderer)
    ? raw.renderer.map(item => String(asRecord(item).name ?? ''))
    : [];
  return {
    preset,
    emitterShape: /box/.test(String(emitter.name ?? ''))
      ? 'box'
      : /sphere/.test(String(emitter.name ?? ''))
        ? 'sphere'
        : 'viewport',
    emitterX: 0.5,
    emitterY: 0.5,
    emitterWidth: numberValue(emitter.distancemax, 1920) * 2,
    emitterHeight: numberValue(emitter.distancemax, 1080) * 2,
    maxCount: Math.max(1, Math.round(numberValue(raw.maxcount, 64))),
    spawnRate: numberValue(emitter.rate, 12),
    lifetimeMin: numberValue(lifetime?.min, 2),
    lifetimeMax: numberValue(lifetime?.max, 5),
    sizeMin: numberValue(size?.min, 3),
    sizeMax: numberValue(size?.max, 12),
    speedMin: Math.hypot(...velocityMin),
    speedMax: Math.hypot(...velocityMax),
    directionX: direction[0],
    directionY: direction[1],
    spread: Math.PI,
    opacityMin: numberValue(alpha?.min, 0.2),
    opacityMax: numberValue(alpha?.max, 0.9),
    colors: [sceneColor(color?.min, '#ffffff'), sceneColor(color?.max, '#ffffff')],
    trail: rendererNames.some(value => /trail|rope/i.test(value)),
    turbulence: operators.some(value => /turbulence/i.test(String(value.name ?? ''))) ? 12 : 0
  };
}

function findNamed(items: Record<string, JsonValue>[], pattern: string): Record<string, JsonValue> | undefined {
  return items.find(item => String(item.name ?? '').toLowerCase().includes(pattern));
}

function updateMaterialUniforms(
  material: Material | undefined,
  time: number,
  pointer: { x: number; y: number },
  audio: number[]
): void {
  if (!(material instanceof RawShaderMaterial)) return;
  if (material.uniforms.g_Time) material.uniforms.g_Time.value = time;
  if (material.uniforms.u_Time) material.uniforms.u_Time.value = time;
  if (material.uniforms.g_PointerPosition) material.uniforms.g_PointerPosition.value.set(pointer.x, pointer.y);
  if (material.uniforms.g_AudioSpectrum16) {
    const spectrum = material.uniforms.g_AudioSpectrum16.value;
    if (spectrum instanceof Float32Array) spectrum.set(audio);
    else material.uniforms.g_AudioSpectrum16.value = audio;
  }
}

function setShaderResolution(material: RawShaderMaterial, width: number, height: number): void {
  const resolution = material.uniforms.g_Resolution?.value;
  if (resolution && typeof resolution.set === 'function') resolution.set(width, height);
  const texelSize = material.uniforms.g_TexelSize?.value;
  if (texelSize && typeof texelSize.set === 'function') {
    texelSize.set(1 / width, 1 / height, width, height);
  }
}

function setMaterialOpacity(material: Material | undefined, opacity: number): void {
  if (!material) return;
  material.transparent = opacity < 1 || material.transparent;
  material.opacity = opacity;
  if (material instanceof RawShaderMaterial) {
    if (material.uniforms.g_Alpha) material.uniforms.g_Alpha.value = opacity;
    if (material.uniforms.u_Opacity) material.uniforms.u_Opacity.value = opacity;
  }
}

function setMaterialMainTexture(material: Material | undefined, texture: Texture): void {
  if (material instanceof RawShaderMaterial) {
    if (material.uniforms.g_Texture0) material.uniforms.g_Texture0.value = texture;
    if (material.uniforms.u_Texture) material.uniforms.u_Texture.value = texture;
  } else if (material instanceof MeshBasicMaterial) {
    material.map = texture;
  }
}

function sceneColor(value: unknown, fallback: string): string {
  if (typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value)) return value;
  const vector = vectorValue(value, 3, Number.NaN);
  if (vector.every(Number.isFinite)) {
    const components = vector.map(component => component <= 1 ? component * 255 : component);
    return `rgb(${components.map(component => Math.round(component)).join(',')})`;
  }
  return fallback;
}

function objectVector(value: JsonValue, size: number, fallback = 0): number[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, JsonValue>;
    return ['x', 'y', 'z', 'w'].slice(0, size).map(key => numberValue(object[key], fallback));
  }
  return vectorValue(value, size, fallback);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberBooleanRecord(value: unknown): Record<string, number | boolean> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).filter((entry): entry is [string, number | boolean] =>
      typeof entry[1] === 'number' || typeof entry[1] === 'boolean'
    )
  );
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
