import {
  Color,
  HalfFloatType,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget
} from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { RendererEffects, RendererPerformance } from '../src/domain/renderer';
import { RuntimeDiagnostics } from './diagnostics';

export class ThreeHost {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: OrthographicCamera;
  readonly perspectiveCamera: PerspectiveCamera;
  private readonly effectPass?: ShaderPass;
  private readonly effectTarget?: WebGLRenderTarget;
  private readonly animatedPostEffect: boolean;
  private activeCamera: OrthographicCamera | PerspectiveCamera;
  private width = 1;
  private height = 1;
  private pixelRatio = 0;
  private contextLost = false;
  private contextRestoreTimer: number | undefined;
  private readonly onContextLost: (event: Event) => void;
  private readonly onContextRestored: () => void;
  private disposed = false;

  constructor(
    root: HTMLElement,
    backgroundColor: string,
    performanceProfile: RendererPerformance['profile'],
    effects: RendererEffects,
    diagnostics: RuntimeDiagnostics,
    onContextRestoreRequired: () => void
  ) {
    this.canvas = document.createElement('canvas');
    const requestContextRebuild = (): void => {
      if (this.disposed || !this.contextLost) return;
      if (this.contextRestoreTimer !== undefined) {
        window.clearTimeout(this.contextRestoreTimer);
        this.contextRestoreTimer = undefined;
      }
      this.contextLost = false;
      onContextRestoreRequired();
    };
    this.onContextLost = event => {
      event.preventDefault();
      if (this.contextLost || this.disposed) return;
      this.contextLost = true;
      diagnostics.add({
        code: 'webgl-context-lost',
        severity: 'error',
        message: 'WebGL2 上下文已丢失，正在重建场景。'
      });
      this.contextRestoreTimer = window.setTimeout(() => {
        if (!this.contextLost || this.disposed) return;
        diagnostics.add({
          code: 'webgl-context-restore-timeout',
          severity: 'warning',
          message: 'WebGL2 上下文未及时恢复，运行时将主动重建渲染器。'
        });
        requestContextRebuild();
      }, 2_500);
    };
    this.onContextRestored = requestContextRebuild;
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    root.appendChild(this.canvas);
    const postEffectsEnabled = hasPostEffects(effects);
    this.animatedPostEffect = effects.grain > 0;
    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      // The post-effect pipeline renders the scene into a non-MSAA target. Antialiasing
      // the final full-screen backbuffer cannot improve that image and only
      // increases default-framebuffer memory use.
      antialias: performanceProfile !== 'economy' && !postEffectsEnabled,
      powerPreference: performanceProfile === 'economy' ? 'low-power' : 'high-performance',
      premultipliedAlpha: false,
      preserveDrawingBuffer: false
    });
    this.renderer.setClearColor(new Color(backgroundColor), 1);
    this.renderer.outputColorSpace = 'srgb';
    this.renderer.debug.checkShaderErrors = true;
    this.renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
      const programLog = gl.getProgramInfoLog(program) ?? '';
      const vertexLog = gl.getShaderInfoLog(vertexShader) ?? '';
      const fragmentLog = gl.getShaderInfoLog(fragmentShader) ?? '';
      diagnostics.add({
        code: 'webgl-shader-compile-failed',
        severity: 'error',
        message: 'WebGL2 Shader 编译或链接失败；对应材质 Pass 已报告。',
        details: [programLog, vertexLog, fragmentLog].filter(Boolean).join('\n')
      });
    };

    this.camera = new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -10000, 10000);
    this.camera.position.z = 1000;
    this.perspectiveCamera = new PerspectiveCamera(50, 1, 0.01, 10000);
    this.perspectiveCamera.position.z = 1000;
    this.activeCamera = this.camera;

    if (postEffectsEnabled) {
      // This pipeline always has exactly one scene pass followed by one final
      // full-screen pass. EffectComposer allocates two RGBA16F + depth targets
      // for arbitrary ping-pong chains, leaving one of them unused here.
      this.effectTarget = new WebGLRenderTarget(1, 1, {
        type: HalfFloatType,
        depthBuffer: true,
        stencilBuffer: false
      });
      this.effectPass = new ShaderPass({
        uniforms: {
          tDiffuse: { value: null },
          uResolution: { value: new Vector2(1, 1) },
          uTime: { value: 0 },
          uOverlayColor: { value: new Color(effects.overlayColor ?? '#000000') },
          uOverlayOpacity: { value: effects.overlayOpacity },
          uVignette: { value: effects.vignette },
          uGrain: { value: effects.grain },
          uScanlines: { value: effects.scanlines }
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: postEffectFragmentShader(effects)
      });
      this.effectPass.renderToScreen = true;
    }
  }

  resize(width: number, height: number, pixelRatio: number): void {
    const nextWidth = Math.max(1, width);
    const nextHeight = Math.max(1, height);
    const nextPixelRatio = Math.max(0.1, pixelRatio);
    const sizeChanged = nextWidth !== this.width || nextHeight !== this.height;
    const ratioChanged = nextPixelRatio !== this.pixelRatio;
    if (!sizeChanged && !ratioChanged) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.pixelRatio = nextPixelRatio;
    if (ratioChanged) {
      this.renderer.setPixelRatio(this.pixelRatio);
    }
    this.renderer.setSize(this.width, this.height, false);
    this.effectTarget?.setSize(
      this.width * this.pixelRatio,
      this.height * this.pixelRatio
    );
    if (sizeChanged) {
      this.camera.left = -this.width / 2;
      this.camera.right = this.width / 2;
      this.camera.top = this.height / 2;
      this.camera.bottom = -this.height / 2;
      this.camera.updateProjectionMatrix();
      this.perspectiveCamera.aspect = this.width / this.height;
      this.perspectiveCamera.updateProjectionMatrix();
    }
    if (this.effectPass) {
      (this.effectPass.material as ShaderMaterial).uniforms.uResolution.value.set(
        this.width * this.pixelRatio,
        this.height * this.pixelRatio
      );
    }
  }

  render(timeSeconds: number, deltaSeconds: number): void {
    if (this.disposed || this.contextLost) return;
    if (this.effectPass && this.effectTarget) {
      if (this.animatedPostEffect) {
        (this.effectPass.material as ShaderMaterial).uniforms.uTime.value = timeSeconds;
      }
      const previousTarget = this.renderer.getRenderTarget();
      const previousAutoClear = this.renderer.autoClear;
      try {
        this.renderer.autoClear = false;
        this.renderer.setRenderTarget(this.effectTarget);
        this.renderer.clear(
          this.renderer.autoClearColor,
          this.renderer.autoClearDepth,
          this.renderer.autoClearStencil
        );
        this.renderer.render(this.scene, this.activeCamera);
        this.renderer.autoClear = previousAutoClear;
        this.effectPass.render(
          this.renderer,
          this.effectTarget,
          this.effectTarget,
          deltaSeconds,
          false
        );
      } finally {
        this.renderer.autoClear = previousAutoClear;
        this.renderer.setRenderTarget(previousTarget);
      }
    } else {
      this.renderer.render(this.scene, this.activeCamera);
    }
  }

  usePerspective(enabled: boolean): void {
    this.activeCamera = enabled ? this.perspectiveCamera : this.camera;
  }

  viewport(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  dispose(): void {
    this.disposed = true;
    if (this.contextRestoreTimer !== undefined) window.clearTimeout(this.contextRestoreTimer);
    this.contextRestoreTimer = undefined;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.effectPass?.dispose();
    this.effectTarget?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}

function hasPostEffects(effects: RendererEffects): boolean {
  return effects.overlayOpacity > 0
    || effects.vignette > 0
    || effects.grain > 0
    || effects.scanlines > 0;
}

/** Builds only the per-pixel work enabled by the current effect configuration. */
export function postEffectFragmentShader(effects: RendererEffects): string {
  const overlay = effects.overlayOpacity > 0;
  const vignette = effects.vignette > 0;
  const grain = effects.grain > 0;
  const scanlines = effects.scanlines > 0;
  return `
    uniform sampler2D tDiffuse;
    ${grain || scanlines ? 'uniform vec2 uResolution;' : ''}
    ${grain ? 'uniform float uTime;' : ''}
    ${overlay ? 'uniform vec3 uOverlayColor;\nuniform float uOverlayOpacity;' : ''}
    ${vignette ? 'uniform float uVignette;' : ''}
    ${grain ? 'uniform float uGrain;' : ''}
    ${scanlines ? 'uniform float uScanlines;' : ''}
    varying vec2 vUv;
    ${grain ? `
    float hash(vec2 value) {
      return fract(sin(dot(value, vec2(12.9898, 78.233)) + uTime * 17.0) * 43758.5453);
    }
    ` : ''}
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      ${overlay ? 'color.rgb = mix(color.rgb, uOverlayColor, uOverlayOpacity);' : ''}
      ${vignette ? `
      float distanceFromCenter = length(vUv - vec2(0.5)) / 0.70710678;
      color.rgb *= 1.0 - smoothstep(0.35, 1.0, distanceFromCenter) * uVignette;
      ` : ''}
      ${grain ? 'color.rgb += (hash(vUv * uResolution) - 0.5) * uGrain;' : ''}
      ${scanlines ? `
      float scanline = step(0.5, fract(vUv.y * uResolution.y * 0.5));
      color.rgb *= 1.0 - scanline * uScanlines * 0.35;
      ` : ''}
      gl_FragColor = color;
    }
  `;
}
