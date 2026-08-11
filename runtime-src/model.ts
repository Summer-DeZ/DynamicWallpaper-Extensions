import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  MeshBasicMaterial,
  Skeleton,
  SkinnedMesh,
  Texture,
  Uint16BufferAttribute,
  Vector2,
  Vector3,
  Vector4
} from 'three';

export interface MdlContainer {
  magic: 'MDLV';
  version: number;
  byteLength: number;
  referencedResources: string[];
  chunks: MdlChunk[];
  raw: ArrayBuffer;
}

export interface MdlChunk {
  tag: string;
  offset: number;
  byteLength: number;
  data: Uint8Array;
}

export interface PuppetBoneDefinition {
  name: string;
  parent: number;
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  constraint?: {
    type: 'spring' | 'rope' | 'hinge';
    stiffness: number;
    damping: number;
    minimumAngle?: number;
    maximumAngle?: number;
  };
}

export interface PuppetGeometryDefinition {
  positions: number[];
  uvs: number[];
  indices: number[];
  boneIndices: number[];
  boneWeights: number[];
  bones: PuppetBoneDefinition[];
  morphTargets?: Array<{ name: string; positions: number[] }>;
}

interface BonePhysicsState {
  velocity: Vector3;
}

export function parseMdlContainer(buffer: ArrayBuffer): MdlContainer {
  if (buffer.byteLength < 12) throw new Error('MDL 文件过短。');
  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder('ascii').decode(bytes.subarray(0, 4));
  if (magic !== 'MDLV') throw new Error(`不支持的 MDL 魔数：${magic}`);
  const versionText = new TextDecoder('ascii').decode(bytes.subarray(4, 8));
  const version = Number.parseInt(versionText, 10);
  if (!Number.isFinite(version)) throw new Error(`无法识别 MDL 版本：${versionText}`);
  return {
    magic: 'MDLV',
    version,
    byteLength: buffer.byteLength,
    referencedResources: extractResourceStrings(bytes),
    chunks: parseChunks(bytes),
    raw: buffer
  };
}

export function decodePuppetGeometry(container: MdlContainer): PuppetGeometryDefinition | undefined {
  for (const chunk of container.chunks) {
    if (!/JSON|PUPP|MESH|DATA|RAW/i.test(chunk.tag)) continue;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(chunk.data);
    for (const candidate of jsonCandidates(text)) {
      try {
        const parsed = JSON.parse(candidate) as Partial<PuppetGeometryDefinition>;
        if (!Array.isArray(parsed.positions) || !Array.isArray(parsed.uvs)
          || !Array.isArray(parsed.indices) || !Array.isArray(parsed.boneIndices)
          || !Array.isArray(parsed.boneWeights) || !Array.isArray(parsed.bones)) continue;
        const definition = parsed as PuppetGeometryDefinition;
        validatePuppetGeometry(definition);
        return definition;
      } catch {
        // Preserve the chunk and continue looking for a supported geometry payload.
      }
    }
  }
  return undefined;
}

export class PuppetMeshRuntime {
  readonly mesh: SkinnedMesh;
  private readonly bones: Bone[];
  private readonly physics: BonePhysicsState[];
  private readonly constrainedBoneIndices: number[];
  private readonly boneWorld = new Vector3();
  private readonly endWorld = new Vector3();
  private paused = false;

  constructor(definition: PuppetGeometryDefinition, texture?: Texture) {
    validatePuppetGeometry(definition);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(definition.positions), 3));
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(definition.uvs), 2));
    geometry.setAttribute(
      'skinIndex',
      new Uint16BufferAttribute(new Uint16Array(definition.boneIndices), 4)
    );
    geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array(definition.boneWeights), 4));
    geometry.setIndex(definition.indices);
    for (const morph of definition.morphTargets ?? []) {
      geometry.morphAttributes.position ??= [];
      const attribute = new BufferAttribute(new Float32Array(morph.positions), 3);
      attribute.name = morph.name;
      geometry.morphAttributes.position.push(attribute);
    }

    this.bones = definition.bones.map(item => {
      const bone = new Bone();
      bone.name = item.name;
      bone.position.fromArray(item.position);
      if (item.rotation) bone.rotation.set(...item.rotation);
      if (item.scale) bone.scale.fromArray(item.scale);
      return bone;
    });
    definition.bones.forEach((item, index) => {
      if (item.parent >= 0) this.bones[item.parent]?.add(this.bones[index]);
    });
    const roots = definition.bones
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.parent < 0)
      .map(({ index }) => this.bones[index]);
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false
    });
    this.mesh = new SkinnedMesh(geometry, material);
    for (const root of roots) this.mesh.add(root);
    this.mesh.bind(new Skeleton(this.bones));
    this.physics = this.bones.map(() => ({ velocity: new Vector3() }));
    this.constrainedBoneIndices = definition.bones
      .map((bone, index) => bone.constraint ? index : -1)
      .filter(index => index >= 0);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  hasActivePhysics(): boolean {
    return this.constrainedBoneIndices.length > 0;
  }

  updatePhysics(deltaSeconds: number, definitions: readonly PuppetBoneDefinition[]): void {
    if (this.paused || deltaSeconds <= 0) return;
    for (const index of this.constrainedBoneIndices) {
      const definition = definitions[index];
      const constraint = definition.constraint;
      const bone = this.bones[index];
      const state = this.physics[index];
      if (!constraint || !bone || !state) continue;
      const stiffness = Math.max(0, constraint.stiffness);
      const damping = Math.min(1, Math.max(0, constraint.damping));
      const force = stiffness * deltaSeconds;
      state.velocity.x += (definition.position[0] - bone.position.x) * force;
      state.velocity.y += (definition.position[1] - bone.position.y) * force;
      state.velocity.z += (definition.position[2] - bone.position.z) * force;
      state.velocity.multiplyScalar(Math.pow(1 - damping, deltaSeconds * 60));
      bone.position.addScaledVector(state.velocity, deltaSeconds);
      if (constraint.minimumAngle !== undefined || constraint.maximumAngle !== undefined) {
        bone.rotation.z = Math.min(
          constraint.maximumAngle ?? Number.POSITIVE_INFINITY,
          Math.max(constraint.minimumAngle ?? Number.NEGATIVE_INFINITY, bone.rotation.z)
        );
      }
    }
  }

  solveIk(chain: readonly number[], target: Vector2, iterations = 8): void {
    const end = this.bones[chain[chain.length - 1]];
    if (!end) return;
    for (let iteration = 0; iteration < iterations; iteration++) {
      for (let chainIndex = chain.length - 2; chainIndex >= 0; chainIndex--) {
        const bone = this.bones[chain[chainIndex]];
        if (!bone) continue;
        bone.getWorldPosition(this.boneWorld);
        end.getWorldPosition(this.endWorld);
        const endX = this.endWorld.x - this.boneWorld.x;
        const endY = this.endWorld.y - this.boneWorld.y;
        const targetX = target.x - this.boneWorld.x;
        const targetY = target.y - this.boneWorld.y;
        if (endX * endX + endY * endY < 0.000001
          || targetX * targetX + targetY * targetY < 0.000001) continue;
        bone.rotation.z += Math.atan2(
          endX * targetY - endY * targetX,
          endX * targetX + endY * targetY
        );
        bone.updateMatrixWorld(true);
      }
    }
  }

  setMorphWeight(name: string, value: number): void {
    const dictionary = this.mesh.morphTargetDictionary;
    const influences = this.mesh.morphTargetInfluences;
    const index = dictionary?.[name];
    if (index !== undefined && influences) influences[index] = Math.min(1, Math.max(0, value));
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    const materials = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
    materials.forEach(material => material.dispose());
  }
}

function extractResourceStrings(bytes: Uint8Array): string[] {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const resources = new Set<string>();
  let start = 0;
  for (let index = 0; index <= bytes.length; index++) {
    const terminator = index === bytes.length || bytes[index] === 0;
    if (!terminator) continue;
    if (index - start >= 5) {
      const value = decoder.decode(bytes.subarray(start, index));
      if (/^[\p{L}\p{N} _./\\-]+\.(?:json|tex|png|jpe?g|mp4|webm|frag|vert)$/iu.test(value)) {
        resources.add(value.replace(/\\/g, '/'));
      }
    }
    start = index + 1;
  }
  return [...resources];
}

function parseChunks(bytes: Uint8Array): MdlChunk[] {
  const chunks: MdlChunk[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const tag = new TextDecoder('ascii').decode(bytes.subarray(offset, offset + 4));
    const length = view.getUint32(offset + 4, true);
    if (!/^[\x20-\x7e]{4}$/.test(tag) || length > bytes.length - offset - 8) break;
    chunks.push({ tag, offset, byteLength: length, data: bytes.slice(offset + 8, offset + 8 + length) });
    offset += 8 + length;
  }
  if (offset < bytes.length) {
    chunks.push({ tag: 'RAW ', offset, byteLength: bytes.length - offset, data: bytes.slice(offset) });
  }
  return chunks;
}

function jsonCandidates(value: string): string[] {
  const candidates: string[] = [];
  for (let start = value.indexOf('{'); start >= 0; start = value.indexOf('{', start + 1)) {
    let depth = 0;
    let string = false;
    let escaped = false;
    for (let index = start; index < value.length; index++) {
      const character = value[index];
      if (string) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') string = false;
      } else if (character === '"') string = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        candidates.push(value.slice(start, index + 1));
        break;
      }
    }
  }
  return candidates;
}

function validatePuppetGeometry(definition: PuppetGeometryDefinition): void {
  if (definition.positions.length % 3 !== 0) throw new Error('Puppet position 数据长度无效。');
  const vertices = definition.positions.length / 3;
  if (definition.uvs.length !== vertices * 2) throw new Error('Puppet UV 数量与顶点不匹配。');
  if (definition.boneIndices.length !== vertices * 4) {
    throw new Error('Puppet bone index 数量与顶点不匹配。');
  }
  if (definition.boneWeights.length !== vertices * 4) {
    throw new Error('Puppet bone weight 数量与顶点不匹配。');
  }
  if (definition.indices.some(index => index < 0 || index >= vertices)) {
    throw new Error('Puppet index 越界。');
  }
  const weight = new Vector4();
  for (let index = 0; index < definition.boneWeights.length; index += 4) {
    weight.fromArray(definition.boneWeights, index);
    const total = weight.x + weight.y + weight.z + weight.w;
    if (total <= 0) definition.boneWeights[index] = 1;
  }
}
