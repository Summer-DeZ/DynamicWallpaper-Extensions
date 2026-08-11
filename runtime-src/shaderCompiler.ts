import preprocess from '@shaderfrog/glsl-parser/preprocessor';
import {
  AdditiveBlending,
  AlwaysDepth,
  BackSide,
  CustomBlending,
  DoubleSide,
  DstAlphaFactor,
  DstColorFactor,
  FrontSide,
  GLSL3,
  GreaterDepth,
  GreaterEqualDepth,
  LessDepth,
  LessEqualDepth,
  NoBlending,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RawShaderMaterial,
  SrcAlphaFactor,
  type Side,
  Uniform,
  Vector2,
  Vector3,
  Vector4,
  ZeroFactor
} from 'three';
import { AssetLoader, asRecord, numberValue, vectorValue } from './assets';
import { RuntimeDiagnostics } from './diagnostics';

export interface MaterialPassDefinition {
  shader?: string;
  blending?: string;
  cullmode?: string;
  depthtest?: string;
  depthwrite?: boolean | string;
  combos?: Record<string, number | boolean>;
  constantshadervalues?: Record<string, unknown>;
  textures?: Array<string | null>;
}

export interface RuntimeShaderUniforms {
  [name: string]: Uniform;
}

export class WallpaperShaderCompiler {
  constructor(
    private readonly assets: AssetLoader,
    private readonly diagnostics: RuntimeDiagnostics
  ) {}

  async materialForPass(
    pass: MaterialPassDefinition,
    resource?: string,
    isolateUnknown = false
  ): Promise<RawShaderMaterial> {
    const uniforms = await this.createUniforms(pass, resource);
    let vertexShader = DEFAULT_VERTEX_SHADER;
    let fragmentShader = DEFAULT_FRAGMENT_SHADER;
    const shader = pass.shader?.replace(/\\/g, '/');
    if (shader && !isBuiltInImageShader(shader)) {
      const [vertex, fragment] = await Promise.all([
        this.tryLoadShader(`${shader}.vert`, 'vertex'),
        this.tryLoadShader(`${shader}.frag`, 'fragment')
      ]);
      if (isolateUnknown && (!vertex || !fragment)) {
        throw new Error(`自定义 Shader 缺少可转换的 GLSL 源码：${shader}`);
      }
      if (vertex) vertexShader = vertex;
      if (fragment) fragmentShader = fragment;
    }
    const defines = Object.fromEntries(
      Object.entries(pass.combos ?? {}).map(([name, value]) => [name, value === true ? 1 : value])
    );
    try {
      vertexShader = translateShader(vertexShader, 'vertex', defines);
      fragmentShader = translateShader(fragmentShader, 'fragment', defines);
    } catch (error) {
      this.diagnostics.add({
        code: 'shader-translation-failed',
        severity: 'error',
        message: `Shader 转换失败：${shader ?? 'genericimage'}`,
        resource,
        details: error instanceof Error ? error.message : String(error)
      });
      if (isolateUnknown) throw error;
      vertexShader = DEFAULT_VERTEX_SHADER;
      fragmentShader = DEFAULT_FRAGMENT_SHADER;
    }

    const material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader,
      uniforms,
      transparent: pass.blending !== 'normal' && pass.blending !== 'disabled',
      depthWrite: pass.depthwrite === true || pass.depthwrite === 'enabled',
      depthTest: pass.depthtest !== 'disabled',
      side: sideFor(pass.cullmode)
    });
    applyBlend(material, pass.blending);
    applyDepth(material, pass.depthtest);
    return material;
  }

  private async createUniforms(
    pass: MaterialPassDefinition,
    owner?: string
  ): Promise<RuntimeShaderUniforms> {
    const uniforms: RuntimeShaderUniforms = {
      g_Texture0: new Uniform(null),
      u_Texture: new Uniform(null),
      g_Time: new Uniform(0),
      u_Time: new Uniform(0),
      g_TexelSize: new Uniform(new Vector4(1, 1, 1, 1)),
      g_Resolution: new Uniform(new Vector2(1920, 1080)),
      g_PointerPosition: new Uniform(new Vector2(0.5, 0.5)),
      g_AudioSpectrum16: new Uniform(new Float32Array(16))
    };
    for (const [name, raw] of Object.entries(pass.constantshadervalues ?? {})) {
      uniforms[name] = new Uniform(uniformValue(raw));
    }
    await Promise.all((pass.textures ?? []).map(async (texturePath, index) => {
      if (!texturePath) return;
      const texture = await this.assets.texture(
        texturePath,
        !/normal|mask|flow|phase/i.test(texturePath),
        owner
      );
      uniforms[`g_Texture${index}`] = new Uniform(texture);
      if (index === 0) uniforms.u_Texture = new Uniform(texture);
    }));
    return uniforms;
  }

  private async tryLoadShader(shaderPath: string, stage: 'vertex' | 'fragment'): Promise<string | undefined> {
    const candidates = [
      shaderPath,
      `shaders/${shaderPath}`,
      shaderPath.replace(/^materials\//, 'shaders/')
    ];
    for (const candidate of candidates) {
      try {
        return await expandIncludes(await this.assets.text(candidate), this.assets, candidate);
      } catch {
        // Try the next source layout.
      }
    }
    this.diagnostics.add({
      code: 'shader-source-missing',
      severity: 'warning',
      message: `${stage === 'vertex' ? '顶点' : '片元'} Shader 源码不存在，使用通用材质。`,
      resource: shaderPath
    });
    return undefined;
  }
}

export function translateShader(
  source: string,
  stage: 'vertex' | 'fragment',
  defines: Record<string, number | boolean> = {}
): string {
  const withoutVersion = source.replace(/^\s*#version[^\n]*\n/, '');
  let output = preprocess(withoutVersion, {
    preserveComments: true,
    defines: Object.fromEntries(
      Object.entries({ GLSL: 1, GLSL330: 1, ...defines }).map(([key, value]) => [key, String(Number(value))])
    )
  });
  output = output
    .replace(/\battribute\b/g, 'in')
    .replace(/\btexture2D\s*\(/g, 'texture(')
    .replace(/\btexSample2D\s*\(/g, 'texture(')
    .replace(/\bCAST2\s*\(/g, 'vec2(')
    .replace(/\bCAST3\s*\(/g, 'vec3(')
    .replace(/\bCAST4\s*\(/g, 'vec4(')
    .replace(/\bCAST3X3\s*\(/g, 'mat3(');
  if (stage === 'vertex') {
    output = output.replace(/\bvarying\b/g, 'out');
  } else {
    output = output.replace(/\bvarying\b/g, 'in');
    if (/\bgl_FragColor\b/.test(output)) {
      output = `out vec4 dwr_FragColor;\n${output.replace(/\bgl_FragColor\b/g, 'dwr_FragColor')}`;
    }
  }
  if (!/\bprecision\s+(?:lowp|mediump|highp)\s+float\s*;/.test(output)) {
    output = `precision highp float;\nprecision highp int;\n${output}`;
  }
  return output;
}

async function expandIncludes(source: string, assets: AssetLoader, owner: string): Promise<string> {
  const matches = [...source.matchAll(/^\s*#include\s+["<]([^">]+)[">]\s*$/gm)];
  let expanded = source;
  for (const match of matches) {
    const includePath = resolveRelative(owner, match[1]);
    const includeSource = await assets.text(includePath);
    expanded = expanded.replace(match[0], await expandIncludes(includeSource, assets, includePath));
  }
  return expanded;
}

function resolveRelative(owner: string, relative: string): string {
  const segments = owner.replace(/\\/g, '/').split('/');
  segments.pop();
  for (const segment of relative.replace(/\\/g, '/').split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '.') segments.push(segment);
  }
  return segments.join('/');
}

function uniformValue(value: unknown): unknown {
  const unwrapped = value && typeof value === 'object' && !Array.isArray(value)
    ? asRecord(value).value ?? value
    : value;
  if (typeof unwrapped === 'number' || typeof unwrapped === 'boolean') return unwrapped;
  const vector = vectorValue(unwrapped, 4, Number.NaN).filter(Number.isFinite);
  if (vector.length === 2) return new Vector2(vector[0], vector[1]);
  if (vector.length === 3) return new Vector3(vector[0], vector[1], vector[2]);
  if (vector.length >= 4) return new Vector4(vector[0], vector[1], vector[2], vector[3]);
  return numberValue(unwrapped, 0);
}

function isBuiltInImageShader(shader: string): boolean {
  return /^(?:genericimage\d*|generic|sprite|particle)$/i.test(shader);
}

function sideFor(cullMode: string | undefined): Side {
  if (cullMode === 'front') return BackSide;
  if (cullMode === 'back') return FrontSide;
  return DoubleSide;
}

function applyDepth(material: RawShaderMaterial, depthTest: string | undefined): void {
  if (depthTest === 'always') material.depthFunc = AlwaysDepth;
  else if (depthTest === 'greater') material.depthFunc = GreaterDepth;
  else if (depthTest === 'greaterequal') material.depthFunc = GreaterEqualDepth;
  else if (depthTest === 'lessequal') material.depthFunc = LessEqualDepth;
  else material.depthFunc = LessDepth;
}

function applyBlend(material: RawShaderMaterial, blending: string | undefined): void {
  switch (blending) {
    case 'disabled':
    case 'normal':
      material.blending = NoBlending;
      break;
    case 'additive':
    case 'add':
      material.blending = AdditiveBlending;
      break;
    case 'multiply':
      material.blending = CustomBlending;
      material.blendSrc = DstColorFactor;
      material.blendDst = ZeroFactor;
      break;
    case 'screen':
      material.blending = CustomBlending;
      material.blendSrc = OneFactor;
      material.blendDst = OneMinusSrcAlphaFactor;
      break;
    case 'translucent':
    default:
      material.blending = NormalBlending;
      material.blendSrc = SrcAlphaFactor;
      material.blendDst = OneMinusSrcAlphaFactor;
      break;
  }
  material.blendSrcAlpha = OneFactor;
  material.blendDstAlpha = OneMinusSrcAlphaFactor;
  if (blending === 'premultiplied') {
    material.blending = CustomBlending;
    material.blendSrc = OneFactor;
    material.blendDst = OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = OneFactor;
    material.blendDstAlpha = OneMinusSrcAlphaFactor;
  }
  if (blending === 'modulate-alpha') {
    material.blending = CustomBlending;
    material.blendSrc = DstAlphaFactor;
    material.blendDst = OneMinusSrcAlphaFactor;
  }
}

const DEFAULT_VERTEX_SHADER = `
in vec3 position;
in vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec2 v_TexCoord;
void main() {
  v_TexCoord = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const DEFAULT_FRAGMENT_SHADER = `
in vec2 v_TexCoord;
uniform sampler2D g_Texture0;
out vec4 dwr_FragColor;
void main() {
  dwr_FragColor = texture(g_Texture0, v_TexCoord);
}`;
