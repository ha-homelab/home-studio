// Bounded pointer-motion rendering. The scene stays on the default
// framebuffer so its per-material tone mapping and transparency are unchanged.
export function createInteractionRenderer(THREE, renderer, pixels = 62500) {
  if (!Number.isFinite(pixels) || pixels <= 0) throw new Error('Invalid interaction pixel budget');
  const size = new THREE.Vector2(), viewport = new THREE.Vector4();
  const copyCamera = new THREE.Camera(), copyScene = new THREE.Scene();
  copyScene.name = 'interaction-copy';
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const material = new THREE.RawShaderMaterial({
    uniforms: { source: { value: null }, outputSize: { value: new THREE.Vector2() } },
    vertexShader: 'precision highp float;attribute vec3 position;void main(){gl_Position=vec4(position,1.0);}',
    // All multisample locations in one destination pixel sample its center.
    // Interpolated UVs would filter the already-resolved scene a second time.
    fragmentShader: 'precision highp float;uniform sampler2D source;uniform vec2 outputSize;void main(){vec2 sampleUV=(floor(gl_FragCoord.xy)+vec2(0.5))/outputSize;gl_FragColor=texture2D(source,sampleUV);}',
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
  });
  const quad = new THREE.Mesh(geometry, material); quad.frustumCulled = false; copyScene.add(quad);
  let texture = null, prepared = false, disposed = false;
  function prepare() {
    if (disposed) return false;
    renderer.getDrawingBufferSize(size);
    if (size.x < 1 || size.y < 1) return false;
    const scale = Math.min(1, Math.sqrt(pixels / Math.max(1, size.x * size.y)));
    const width = Math.max(1, Math.floor(size.x * scale)), height = Math.max(1, Math.floor(size.y * scale));
    if (!texture || texture.image.width !== width || texture.image.height !== height) {
      texture?.dispose();
      texture = new THREE.FramebufferTexture(width, height);
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.colorSpace = THREE.NoColorSpace;
      texture.generateMipmaps = false;
      material.uniforms.source.value = texture;
      renderer.initTexture(texture);
    }
    if (!prepared) { renderer.compile(copyScene, copyCamera); prepared = true; }
    return true;
  }
  function draw(scene, camera, interacting) {
    // Unexpected targets/scissors keep the existing direct rendering path.
    if (disposed || renderer.getRenderTarget() || renderer.getScissorTest()) { renderer.render(scene, camera); return; }
    const ready = prepare();
    if (!interacting || !ready) { renderer.render(scene, camera); return; }
    renderer.getViewport(viewport);
    const ratio = renderer.getPixelRatio(), autoReset = renderer.info.autoReset, autoClear = renderer.autoClear;
    if (viewport.x !== 0 || viewport.y !== 0 || Math.floor(viewport.z * ratio) !== size.x || Math.floor(viewport.w * ratio) !== size.y) {
      renderer.render(scene, camera); return;
    }
    // Three rounds setViewport but floors it when returning from shadow maps.
    // Stay inside the interval where both conversions select the same pixel.
    const logicalPixels = pixels => (pixels + .25) / ratio;
    try {
      renderer.setViewport(0, 0, logicalPixels(texture.image.width), logicalPixels(texture.image.height));
      renderer.render(scene, camera);
      renderer.copyFramebufferToTexture(texture);
      material.uniforms.outputSize.value.copy(size);
      // A fractional DPR makes Three round the logical viewport, while the
      // actual drawing buffer is floored. Fit the copy to valid pixels exactly.
      renderer.setViewport(0, 0, logicalPixels(size.x), logicalPixels(size.y));
      // Include the copy draw in real renderer statistics without erasing the
      // scene's counts. The next ordinary frame uses its original reset policy.
      renderer.info.autoReset = false;
      renderer.autoClear = false;
      renderer.render(copyScene, copyCamera);
    } finally {
      renderer.setViewport(viewport);
      renderer.info.autoReset = autoReset;
      renderer.autoClear = autoClear;
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    texture?.dispose(); geometry.dispose(); material.dispose();
    texture = null; material.uniforms.source.value = null;
  }
  return { draw, dispose };
}
