export function createStarterProject(): string {
  return `${JSON.stringify({
    version: 1,
    name: 'My Dynamic Wallpaper',
    render: {
      layer: 'front',
      surfaceOpacity: 0.72,
      backgroundColor: '#05080d',
      pauseWhenUnfocused: true,
      opaqueEditorForMedia: true
    },
    performance: {
      profile: 'balanced',
      suspendAfterSeconds: 15
    },
    layers: [
      {
        id: 'animated-gradient',
        type: 'gradient',
        colors: ['#071426', '#123b55', '#241447', '#071426'],
        angle: 135,
        animationDuration: 18,
        opacity: 1,
        blendMode: 'normal',
        scale: 1.08,
        rotate: 0,
        parallax: 6,
        filters: {
          blur: 0,
          brightness: 0.8,
          contrast: 1.1,
          saturation: 1.2,
          hueRotate: 0,
          grayscale: 0
        }
      }
    ],
    effects: {
      overlayColor: '#02060c',
      overlayOpacity: 0.08,
      vignette: 0.35,
      grain: 0.04,
      scanlines: 0
    }
  }, null, 2)}\n`;
}
