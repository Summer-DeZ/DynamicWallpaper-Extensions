import {
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  Scene,
  Texture,
  VideoTexture,
  Vector2,
  Vector4,
  WebGLRenderer,
  WebGLRenderTarget
} from 'three';
import { AssetLoader, asRecord } from './assets';
import { RuntimeDiagnostics } from './diagnostics';
import {
  MaterialPassDefinition,
  WallpaperShaderCompiler
} from './shaderCompiler';

interface EffectPassState {
  material: RawShaderMaterial;
  targetName?: string;
  target: WebGLRenderTarget;
}

export class LayerEffectPipeline {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, -1, 1);
  private readonly quad = new Mesh(new PlaneGeometry(2, 2));
  private readonly targets: [WebGLRenderTarget | undefined, WebGLRenderTarget | undefined] = [
    undefined,
    undefined
  ];
  private readonly ownedTargets = new Set<WebGLRenderTarget>();
  private readonly passes: EffectPassState[] = [];
  private readonly namedTargets = new Map<string, Texture>();
  private readonly resolution = new Vector2();
  private readonly texelSize = new Vector4();
  private readonly sourceTextures: Texture[] = [];
  private readonly videoSources: VideoTexture[] = [];
  private sourceTextureVersions: number[] = [];
  private animated = false;
  private dirty = true;
  private settleFramesRemaining = 1;
  private width: number;
  private height: number;

  private constructor(
    private readonly renderer: WebGLRenderer,
    private readonly input: Texture,
    width: number,
    height: number
  ) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.trackSourceTexture(input);
    // A primary VideoTexture publishes a new Texture.version from Chromium's
    // video-frame callback. Re-running the whole chain on every display RAF
    // would render a 30 FPS source up to 60 times. Older video elements without
    // frame callbacks retain the conservative continuously-animated behavior.
    this.animated = isVideoTexture(input) && !hasVideoFrameNotifications(input);
    this.scene.add(this.quad);
  }

  static async create(
    renderer: WebGLRenderer,
    input: Texture,
    effects: readonly unknown[],
    width: number,
    height: number,
    assets: AssetLoader,
    compiler: WallpaperShaderCompiler,
    diagnostics: RuntimeDiagnostics
  ): Promise<LayerEffectPipeline | undefined> {
    const pipeline = new LayerEffectPipeline(renderer, input, width, height);
    for (const rawEffect of effects) {
      const effect = asRecord(rawEffect);
      if (!isVisible(effect.visible)) continue;
      const effectFile = typeof effect.file === 'string' ? effect.file : undefined;
      if (!effectFile) continue;
      try {
        const definition = asRecord(await assets.json(effectFile));
        const overrides = Array.isArray(effect.passes) ? effect.passes.map(asRecord) : [];
        const passes = Array.isArray(definition.passes) ? definition.passes.map(asRecord) : [];
        for (const [index, rawPass] of passes.entries()) {
          const materialPath = typeof rawPass.material === 'string' ? rawPass.material : undefined;
          try {
            if (!materialPath) throw new Error('Pass 未声明 material。');
            const materialDefinition = asRecord(await assets.json(materialPath));
            const basePass = Array.isArray(materialDefinition.passes)
              ? asRecord(materialDefinition.passes[0])
              : materialDefinition;
            const override = overrides[index] ?? {};
            const pass: MaterialPassDefinition = {
              ...basePass,
              combos: {
                ...recordNumberBoolean(basePass.combos),
                ...recordNumberBoolean(override.combos)
              },
              constantshadervalues: {
                ...asRecord(basePass.constantshadervalues),
                ...asRecord(override.constantshadervalues)
              },
              textures: mergeTextures(basePass.textures, override.textures)
            };
            const material = await compiler.materialForPass(pass, materialPath, true);
            pipeline.animated = pipeline.animated || materialUsesTime(material);
            pipeline.collectMaterialTextures(material);
            const targetName = typeof rawPass.target === 'string' ? rawPass.target : undefined;
            pipeline.passes.push({
              material,
              targetName,
              // Named outputs must survive later ping-pong passes. Reusing one
              // of the two transient targets made later passes overwrite the
              // texture while it was still bound by name.
              target: targetName
                ? pipeline.createTarget()
                : pipeline.transientTarget()
            });
          } catch (error) {
            diagnostics.add({
              code: 'effect-pass-isolated',
              severity: 'error',
              message: `效果 Pass 已隔离：${effectFile}#${index}`,
              resource: materialPath ?? effectFile,
              details: error instanceof Error ? error.message : String(error)
            });
          }
        }
      } catch (error) {
        diagnostics.add({
          code: 'effect-isolated',
          severity: 'error',
          message: `效果已隔离：${effectFile}`,
          resource: effectFile,
          details: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (pipeline.passes.length === 0) {
      pipeline.dispose();
      return undefined;
    }
    pipeline.animated = pipeline.animated || hasTemporalNamedTargetFeedback(pipeline.passes);
    if (hasSelfNamedTargetReference(pipeline.passes)) pipeline.settleFramesRemaining = 2;
    pipeline.captureSourceTextureVersions();
    pipeline.updateResolutionUniforms();
    return pipeline;
  }

  outputTexture(): Texture {
    return this.passes[this.passes.length - 1].target.texture;
  }

  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, width);
    const nextHeight = Math.max(1, height);
    if (nextWidth === this.width && nextHeight === this.height) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.ownedTargets.forEach(target => target.setSize(this.width, this.height));
    this.updateResolutionUniforms();
    this.settleFramesRemaining = 1;
    this.dirty = true;
  }

  needsFrameUpdates(): boolean {
    return this.dirty || this.animated || this.sourceTexturesChanged();
  }

  invalidate(): void {
    this.dirty = true;
  }

  videoTextures(): readonly VideoTexture[] {
    return this.videoSources;
  }

  render(timeSeconds: number): void {
    if (!this.needsFrameUpdates()) return;
    const previousTarget = this.renderer.getRenderTarget();
    const previousAutoClear = this.renderer.autoClear;
    // Every pass already performs an explicit clear. Leaving WebGLRenderer's
    // automatic clear enabled clears the same color attachment a second time
    // immediately before the full-screen draw.
    this.renderer.autoClear = false;
    let previous = this.input;
    try {
      for (const pass of this.passes) {
        const target = pass.target;
        setUniform(pass.material, 'g_Texture0', previous);
        setUniform(pass.material, 'u_Texture', previous);
        setUniform(pass.material, 'g_Time', timeSeconds);
        setUniform(pass.material, 'u_Time', timeSeconds);
        for (const [name, texture] of this.namedTargets) {
          // Sampling from the texture currently attached for drawing is an
          // invalid WebGL feedback loop. Self-referential named passes get a
          // null input instead of poisoning the whole frame.
          setUniform(pass.material, name, texture === target.texture ? null : texture);
        }
        this.quad.material = pass.material;
        this.renderer.setRenderTarget(target);
        this.renderer.clear();
        this.renderer.render(this.scene, this.camera);
        previous = target.texture;
        if (pass.targetName) this.namedTargets.set(pass.targetName, previous);
      }
      this.settleFramesRemaining = Math.max(0, this.settleFramesRemaining - 1);
      this.dirty = this.settleFramesRemaining > 0;
      this.captureSourceTextureVersions();
    } finally {
      // A shader/driver exception must not leave the main scene rendering into
      // an off-screen layer target on subsequent frames.
      this.renderer.autoClear = previousAutoClear;
      this.renderer.setRenderTarget(previousTarget);
    }
  }

  dispose(): void {
    this.quad.geometry.dispose();
    this.passes.forEach(pass => pass.material.dispose());
    this.ownedTargets.forEach(target => target.dispose());
    this.ownedTargets.clear();
    this.namedTargets.clear();
  }

  private createTarget(): WebGLRenderTarget {
    const target = new WebGLRenderTarget(this.width, this.height, {
      depthBuffer: false,
      stencilBuffer: false
    });
    this.ownedTargets.add(target);
    return target;
  }

  private transientTarget(): WebGLRenderTarget {
    const previousTarget = this.passes[this.passes.length - 1]?.target;
    const first = this.targets[0] ??= this.createTarget();
    if (previousTarget !== first) return first;
    return this.targets[1] ??= this.createTarget();
  }

  private collectMaterialTextures(material: RawShaderMaterial): void {
    for (const uniform of Object.values(material.uniforms)) {
      for (const texture of texturesIn(uniform.value)) {
        this.trackSourceTexture(texture);
        this.animated = this.animated || (
          isVideoTexture(texture) && !hasVideoFrameNotifications(texture)
        );
      }
    }
  }

  private trackSourceTexture(texture: Texture): void {
    if (!this.sourceTextures.includes(texture)) this.sourceTextures.push(texture);
    if (isVideoTexture(texture) && !this.videoSources.includes(texture)) {
      this.videoSources.push(texture);
    }
  }

  private captureSourceTextureVersions(): void {
    this.sourceTextureVersions = this.sourceTextures.map(texture => texture.version);
  }

  private sourceTexturesChanged(): boolean {
    return this.sourceTextures.some(
      (texture, index) => texture.version !== this.sourceTextureVersions[index]
    );
  }

  private updateResolutionUniforms(): void {
    this.resolution.set(this.width, this.height);
    this.texelSize.set(1 / this.width, 1 / this.height, this.width, this.height);
    for (const pass of this.passes) {
      setUniform(pass.material, 'g_Resolution', this.resolution);
      setUniform(pass.material, 'u_Resolution', this.resolution);
      setUniform(pass.material, 'g_TexelSize', this.texelSize);
    }
  }
}

function setUniform(material: RawShaderMaterial, name: string, value: unknown): void {
  if (material.uniforms[name]) material.uniforms[name].value = value;
}

function mergeTextures(base: unknown, override: unknown): Array<string | null> {
  const baseValues = Array.isArray(base) ? base.map(stringOrNull) : [];
  const overrideValues = Array.isArray(override) ? override.map(stringOrNull) : [];
  const size = Math.max(baseValues.length, overrideValues.length);
  return Array.from({ length: size }, (_, index) => overrideValues[index] ?? baseValues[index] ?? null);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function recordNumberBoolean(value: unknown): Record<string, number | boolean> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).filter((entry): entry is [string, number | boolean] =>
      typeof entry[1] === 'number' || typeof entry[1] === 'boolean'
    )
  );
}

function isVisible(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const object = asRecord(value);
  return typeof object.value === 'boolean' ? object.value : true;
}

function materialUsesTime(material: RawShaderMaterial): boolean {
  return shaderUsesUniform(material.vertexShader, 'g_Time')
    || shaderUsesUniform(material.vertexShader, 'u_Time')
    || shaderUsesUniform(material.fragmentShader, 'g_Time')
    || shaderUsesUniform(material.fragmentShader, 'u_Time');
}

function shaderUsesUniform(shader: string, name: string): boolean {
  const declarations = new RegExp(`\\buniform\\s+[^;]*\\b${name}\\b[^;]*;`, 'g');
  return new RegExp(`\\b${name}\\b`).test(shader.replace(declarations, ''));
}

function hasTemporalNamedTargetFeedback(passes: readonly EffectPassState[]): boolean {
  const producers = new Map<string, number[]>();
  passes.forEach((pass, index) => {
    if (!pass.targetName) return;
    const indices = producers.get(pass.targetName) ?? [];
    indices.push(index);
    producers.set(pass.targetName, indices);
  });
  return passes.some((pass, consumerIndex) => [...producers].some(([name, indices]) => {
    if (!pass.material.uniforms[name]) return false;
    // An earlier producer supplies current-frame data. Without one, a later
    // producer's retained texture is intentionally a previous-frame input.
    if (indices.some(index => index < consumerIndex)) return false;
    return indices.some(index => index > consumerIndex);
  }));
}

function hasSelfNamedTargetReference(passes: readonly EffectPassState[]): boolean {
  return passes.some(pass => Boolean(
    pass.targetName && pass.material.uniforms[pass.targetName]
  ));
}

function texturesIn(value: unknown): Texture[] {
  if (isTexture(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(texturesIn);
  return [];
}

function isTexture(value: unknown): value is Texture {
  return Boolean(value && typeof value === 'object' && (value as Texture).isTexture);
}

function isVideoTexture(texture: Texture): texture is VideoTexture {
  return texture instanceof VideoTexture || Boolean((texture as VideoTexture).isVideoTexture);
}

function hasVideoFrameNotifications(texture: Texture): boolean {
  const source = texture.image as { requestVideoFrameCallback?: unknown } | undefined;
  return typeof source?.requestVideoFrameCallback === 'function';
}
