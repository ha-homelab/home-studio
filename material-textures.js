// Optional, build-validated albedo only. No URLs, material cloning or render loop.
// The host owns materials; this owner retains decoded pixels across GPU loss.
function createMaterialTextures(THREE, definitions) {
  const maps = new Map(), images = new Set(), owned = new Set();
  let disposed = false;
  const specs = [], unique = new Map();
  try {
    if (definitions !== undefined) {
      if (!definitions || Array.isArray(definitions) || typeof definitions !== 'object') throw Error('Invalid textures');
      const entries = Object.entries(definitions);
      if (entries.length > 8) throw Error('Too many textures');
      let total = 0;
      for (const [id, spec] of entries) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || !spec ||
            Object.keys(spec).sort().join() !== 'data_uri,height,mime_type,width' ||
            spec.mime_type !== 'image/png' || spec.width !== 256 || spec.height !== 256) throw Error('Invalid texture');
        const uri = spec.data_uri, prefix = 'data:image/png;base64,';
        if (typeof uri !== 'string' || !uri.startsWith(prefix) || uri.length > prefix.length + 131072) throw Error('Invalid texture URI');
        const encoded = uri.slice(prefix.length);
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw Error('Invalid base64');
        const bytes = atob(encoded);
        total += bytes.length;
        if (bytes.length < 45 || bytes.length > 98304 || total > 524288 || btoa(bytes) !== encoded ||
            bytes.slice(0, 8) !== '\x89PNG\r\n\x1a\n' || bytes.slice(12, 16) !== 'IHDR') throw Error('Invalid PNG');
        const integer = offset => ((bytes.charCodeAt(offset) * 16777216) + (bytes.charCodeAt(offset + 1) << 16) +
          (bytes.charCodeAt(offset + 2) << 8) + bytes.charCodeAt(offset + 3));
        if (integer(8) !== 13 || integer(16) !== 256 || integer(20) !== 256 || bytes.charCodeAt(24) !== 8 ||
            ![2, 3].includes(bytes.charCodeAt(25))) throw Error('Unsupported PNG');
        specs.push([id, uri]);
      }
    }
  } catch { specs.length = 0; }
  const ready = Promise.all(specs.map(([id, uri]) => {
    if (!unique.has(uri)) unique.set(uri, new Promise(resolve => {
      const image = new Image(); images.add(image);
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true; clearTimeout(deadline);
        image.onload = image.onerror = null; resolve(value);
      };
      // Optional color detail must not hold the initial inventory indefinitely.
      const deadline = setTimeout(() => { finish(null); image.src = ''; }, 5000);
      image.onerror = () => finish(null);
      image.onload = () => {
        if (settled) return;
        if (disposed || image.naturalWidth !== 256 || image.naturalHeight !== 256) return finish(null);
        const texture = new THREE.Texture(image);
        owned.add(texture);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = 1; texture.needsUpdate = true;
        finish(texture);
      };
      image.src = uri;
    }));
    return unique.get(uri).then(texture => { if (texture && !disposed) maps.set(id, texture); });
  })).then(() => !disposed && maps.size > 0);
  return {
    ready,
    get(part, dimensions) {
      const texture = maps.get(part.albedo_texture), uv = part.uv, axes = part.uv_dimensions;
      if (disposed || !texture || !Array.isArray(uv) || uv.length !== part.vertices.length ||
          axes !== undefined && (!Array.isArray(axes) || axes.length !== 2 || axes[0] === axes[1] ||
            axes.some(axis => !['width', 'height', 'depth'].includes(axis)))) return null;
      const scale = axes ? axes.map(axis => dimensions[axis]) : [1, 1], values = [];
      if (scale.some(value => !Number.isFinite(value) || value <= 0)) return null;
      for (const pair of uv) {
        if (!Array.isArray(pair) || pair.length !== 2) return null;
        for (let i = 0; i < 2; i++) {
          const value = pair[i] * scale[i];
          if (!Number.isFinite(pair[i]) || !Number.isFinite(value) || Math.abs(value) > 4096) return null;
          values.push(value);
        }
      }
      return {texture, uv: values};
    },
    releaseGPU() { if (!disposed) for (const texture of owned) { texture.dispose(); texture.needsUpdate = true; } },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const texture of owned) texture.dispose();
      owned.clear();
      maps.clear();
      // Resolve pending loads too; no rebuild can outlive page teardown.
      for (const image of images) { image.onerror?.(); image.src = ''; }
      images.clear();
    },
    get count() { return new Set(maps.values()).size; },
  };
}

function inventoryMaterialBatches(asset, dimensions, materials, textures) {
  const batches = new Map();
  for (const part of asset.meshes) {
    const mapped = materials[part.material]?.[3] === 1 ? textures.get(part, dimensions) : null;
    const key = part.material + '|' + (part.curtain_fabric ? part.curtain_panel : 'fixed') + '|' + (mapped?.texture.uuid || '');
    let batch = batches.get(key);
    if (!batch) {
      batch = {material:part.material, curtainFabric:part.curtain_fabric === true, curtainPanel:part.curtain_panel,
        vertices:[], normals:[], indices:[], uv:[], texture:mapped?.texture};
      batches.set(key, batch);
    }
    const offset = batch.vertices.length / 3;
    batch.vertices.push(...part.vertices.flat()); batch.normals.push(...part.normals.flat());
    batch.indices.push(...part.indices.map(index => index + offset));
    if (mapped) batch.uv.push(...mapped.uv);
  }
  return [...batches.values()];
}
