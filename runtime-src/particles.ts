import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  NormalBlending,
  Points,
  ShaderMaterial,
  Texture,
  Vector3
} from 'three';
import type { ParticleSettings } from '../src/domain/renderer';

interface ParticleState {
  position: Vector3;
  velocity: Vector3;
  color: Color;
  age: number;
  lifetime: number;
  size: number;
  opacity: number;
}

export class ParticleEmitter {
  readonly object: Points;
  private readonly states: ParticleState[] = [];
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly opacities: Float32Array;
  private readonly geometry: BufferGeometry;
  private readonly positionAttribute: BufferAttribute;
  private readonly colorAttribute: BufferAttribute;
  private readonly sizeAttribute: BufferAttribute;
  private readonly opacityAttribute: BufferAttribute;
  private readonly frequentlyUpdatedAttributes: BufferAttribute[];
  private readonly spawnUpdatedAttributes: BufferAttribute[];
  private readonly palette: Color[];
  private readonly maximum: number;
  private spawnBudget = 0;
  private paused = false;
  private randomState: number;

  constructor(
    private readonly settings: ParticleSettings,
    sprite?: Texture,
    seed = 0x5eed1234
  ) {
    this.maximum = Math.max(1, Math.floor(settings.maxCount));
    this.positions = new Float32Array(this.maximum * 3);
    this.colors = new Float32Array(this.maximum * 3);
    this.sizes = new Float32Array(this.maximum);
    this.opacities = new Float32Array(this.maximum);
    this.geometry = new BufferGeometry();
    this.positionAttribute = dynamicAttribute(this.positions, 3);
    this.colorAttribute = dynamicAttribute(this.colors, 3);
    this.sizeAttribute = dynamicAttribute(this.sizes, 1);
    this.opacityAttribute = dynamicAttribute(this.opacities, 1);
    this.frequentlyUpdatedAttributes = [this.positionAttribute, this.opacityAttribute];
    this.spawnUpdatedAttributes = [this.colorAttribute, this.sizeAttribute];
    this.geometry.setAttribute('position', this.positionAttribute);
    this.geometry.setAttribute('particleColor', this.colorAttribute);
    this.geometry.setAttribute('particleSize', this.sizeAttribute);
    this.geometry.setAttribute('particleOpacity', this.opacityAttribute);
    this.geometry.setDrawRange(0, 0);
    this.randomState = seed >>> 0;
    this.palette = settings.colors.length > 0
      ? settings.colors.map(value => new Color(value))
      : [new Color('#ffffff')];

    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: settings.preset === 'embers' || settings.preset === 'stars'
        ? AdditiveBlending
        : NormalBlending,
      uniforms: {
        uSprite: { value: sprite ?? null },
        uHasSprite: { value: sprite ? 1 : 0 }
      },
      vertexShader: `
        attribute vec3 particleColor;
        attribute float particleSize;
        attribute float particleOpacity;
        varying vec3 vColor;
        varying float vOpacity;
        void main() {
          vColor = particleColor;
          vOpacity = particleOpacity;
          vec4 view = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, particleSize);
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: `
        uniform sampler2D uSprite;
        uniform int uHasSprite;
        varying vec3 vColor;
        varying float vOpacity;
        void main() {
          vec2 centered = gl_PointCoord - vec2(0.5);
          float radial = 1.0 - smoothstep(0.25, 0.5, length(centered));
          if (radial <= 0.0 || vOpacity <= 0.0) discard;
          vec4 texel = uHasSprite == 1 ? texture2D(uSprite, gl_PointCoord) : vec4(1.0);
          float alpha = texel.a * vOpacity * radial;
          if (alpha <= 0.0) discard;
          gl_FragColor = vec4(texel.rgb * vColor, alpha);
        }
      `
    });
    this.object = new Points(this.geometry, material);
    this.object.frustumCulled = false;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  update(deltaSeconds: number, viewportWidth: number, viewportHeight: number): void {
    if (this.paused || deltaSeconds <= 0) return;
    let populationChanged = false;
    this.spawnBudget += deltaSeconds * this.settings.spawnRate;
    while (this.spawnBudget >= 1 && this.states.length < this.maximum) {
      this.spawn(viewportWidth, viewportHeight);
      this.spawnBudget -= 1;
      populationChanged = true;
    }

    for (let index = this.states.length - 1; index >= 0; index--) {
      const particle = this.states[index];
      particle.age += deltaSeconds;
      if (particle.age >= particle.lifetime) {
        const replacement = this.states.pop();
        if (replacement && index < this.states.length) this.states[index] = replacement;
        populationChanged = true;
        continue;
      }
      if (this.settings.turbulence > 0) {
        particle.velocity.x += this.between(-1, 1) * this.settings.turbulence * deltaSeconds;
        particle.velocity.y += this.between(-1, 1) * this.settings.turbulence * deltaSeconds;
      }
      particle.position.addScaledVector(particle.velocity, deltaSeconds);
    }
    this.writeAttributes(populationChanged);
  }

  dispose(): void {
    this.geometry.dispose();
    const material = this.object.material;
    if (Array.isArray(material)) material.forEach(item => item.dispose());
    else material.dispose();
  }

  private spawn(width: number, height: number): void {
    const life = this.between(this.settings.lifetimeMin, this.settings.lifetimeMax);
    const centerX = (this.settings.emitterX - 0.5) * width;
    const centerY = (0.5 - this.settings.emitterY) * height;
    let x = centerX;
    let y = centerY;
    if (this.settings.emitterShape === 'viewport') {
      x = this.between(-width / 2, width / 2);
      y = this.between(-height / 2, height / 2);
    } else if (this.settings.emitterShape === 'box') {
      x += this.between(-this.settings.emitterWidth / 2, this.settings.emitterWidth / 2);
      y += this.between(-this.settings.emitterHeight / 2, this.settings.emitterHeight / 2);
    } else if (this.settings.emitterShape === 'sphere') {
      const angle = this.between(0, Math.PI * 2);
      const radius = Math.sqrt(this.random());
      x += Math.cos(angle) * this.settings.emitterWidth * radius / 2;
      y += Math.sin(angle) * this.settings.emitterHeight * radius / 2;
    }
    const direction = Math.atan2(this.settings.directionY, this.settings.directionX)
      + this.between(-this.settings.spread, this.settings.spread);
    const speed = this.between(this.settings.speedMin, this.settings.speedMax);
    const color = this.palette[Math.floor(this.random() * this.palette.length)] ?? this.palette[0];
    this.states.push({
      position: new Vector3(x, y, 0),
      velocity: new Vector3(Math.cos(direction) * speed, -Math.sin(direction) * speed, 0),
      color,
      age: 0,
      lifetime: life,
      size: this.between(this.settings.sizeMin, this.settings.sizeMax),
      opacity: this.between(this.settings.opacityMin, this.settings.opacityMax)
    });
  }

  private writeAttributes(populationChanged: boolean): void {
    for (let index = 0; index < this.states.length; index++) {
      const state = this.states[index];
      const offset = index * 3;
      this.positions[offset] = state.position.x;
      this.positions[offset + 1] = state.position.y;
      this.positions[offset + 2] = state.position.z;
      if (populationChanged) {
        this.colors[offset] = state.color.r;
        this.colors[offset + 1] = state.color.g;
        this.colors[offset + 2] = state.color.b;
        this.sizes[index] = state.size;
      }
      const progress = state.age / state.lifetime;
      const fade = Math.min(1, progress * 6, (1 - progress) * 4);
      this.opacities[index] = state.opacity * Math.max(0, fade);
    }
    if (this.states.length > 0) {
      this.markActivePrefixForUpload(this.frequentlyUpdatedAttributes);
      // Color and size are immutable during a particle's lifetime. Uploading
      // them on every simulation frame doubled the dynamic GPU traffic for a
      // stable population; they only need a new prefix after spawn/removal.
      if (populationChanged) this.markActivePrefixForUpload(this.spawnUpdatedAttributes);
    }
    this.geometry.setDrawRange(0, this.states.length);
  }

  private markActivePrefixForUpload(attributes: readonly BufferAttribute[]): void {
    for (const attribute of attributes) {
      // BufferAttribute otherwise uploads the complete maxCount allocation on
      // every frame. Only the active prefix is consumed by the draw range.
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, this.states.length * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }

  private between(minimum: number, maximum: number): number {
    return minimum + this.random() * Math.max(0, maximum - minimum);
  }

  private random(): number {
    let value = this.randomState;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.randomState = value >>> 0;
    return this.randomState / 0x100000000;
  }
}

function dynamicAttribute(array: Float32Array, itemSize: number): BufferAttribute {
  const attribute = new BufferAttribute(array, itemSize);
  attribute.setUsage(DynamicDrawUsage);
  return attribute;
}
