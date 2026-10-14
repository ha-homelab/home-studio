// Original low-poly furniture, shared by the offline planner and compiler.
import { CATALOG } from './catalog.js';
export { CATALOG };
const models = new Map(CATALOG.models.map(model => [model.id, model]));
const styles = new Map(CATALOG.styles.map(style => [style.id, style]));
const COLOR = /^#[0-9a-fA-F]{6}$/;
export const getCatalogModel = id => models.get(id) || null;
export const getCatalogStyle = id => styles.get(id) || null;

export function validateFurnitureAppearance(item) {
  const has = key => Object.hasOwn(item, key);
  if (!has('model_id')) {
    if (has('style_id') || has('color')) throw new Error('Choose a furniture model before setting a style or color.');
    return null;
  }
  const model = getCatalogModel(item.model_id);
  if (!model) throw new Error('Unknown furniture model.');
  if (item.type !== model.type) throw new Error('Furniture model does not match this item type.');
  if (has('style_id') && !getCatalogStyle(item.style_id)) throw new Error('Unknown furniture style.');
  if (has('color') && (typeof item.color !== 'string' || !COLOR.test(item.color))) throw new Error('Furniture color must use #RRGGBB.');
  return model;
}

export function createFurnitureItemFields(modelId, styleId) {
  const model = getCatalogModel(modelId);
  if (!model) throw new Error('Unknown furniture model.');
  const fields = { type: model.type, model_id: model.id, style_id: styleId ?? model.default_style,
    dimensions_m: { ...model.dimensions_m }, elevation_m: model.elevation_m };
  validateFurnitureAppearance(fields);
  return fields;
}

function linearColor(hex) {
  return [1, 3, 5].map(offset => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  }).concat(1);
}

export function primitive(part) {
  if (!part || typeof part !== 'object' || !['box', 'cylinder', 'sphere', 'ring', 'cone'].includes(part.shape)) throw new Error('Unknown furniture primitive.');
  for (const key of ['center', 'size', ...(Object.hasOwn(part, 'rotation_deg') ? ['rotation_deg'] : [])]) {
    if (!Array.isArray(part[key]) || part[key].length !== 3 || !part[key].every(Number.isFinite)) throw new Error('Furniture ' + key + ' must contain three finite numbers.');
  }
  if (part.size.some(value => value <= 0)) throw new Error('Furniture primitive sizes must be positive.');
  if (Object.hasOwn(part, 'inner_ratio') && (part.shape !== 'ring' || !Number.isFinite(part.inner_ratio) || part.inner_ratio <= 0 || part.inner_ratio >= 1)) throw new Error('Ring inner_ratio must be between zero and one.');
  const [x, y, z] = part.center, [w, h, d] = part.size;
  let vertices, faces;
  if (part.shape === 'box') {
    vertices = [-1, 1].flatMap(sign => [[x-w/2, y+sign*h/2, z-d/2], [x+w/2, y+sign*h/2, z-d/2], [x+w/2, y+sign*h/2, z+d/2], [x-w/2, y+sign*h/2, z+d/2]]);
    faces = [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,5,1],[0,4,5],[1,6,2],[1,5,6],[2,7,3],[2,6,7],[3,4,0],[3,7,4]];
  } else if (part.shape === 'cylinder') {
    const sides = 12;
    vertices = [[x,y-h/2,z],[x,y+h/2,z]];
    for (let i = 0; i < sides; i++) {
      const angle = 2*Math.PI*i/sides, px = x+w/2*Math.cos(angle), pz = z+d/2*Math.sin(angle);
      vertices.push([px,y-h/2,pz],[px,y+h/2,pz]);
    }
    faces = [];
    for (let i = 0; i < sides; i++) {
      const bottom = 2+2*i, next = 2+2*((i+1)%sides);
      faces.push([0,bottom,next],[1,next+1,bottom+1],[bottom,bottom+1,next+1],[bottom,next+1,next]);
    }
  } else if (part.shape === 'cone') {
    const sides = 12;
    vertices = [[x,y-h/2,z], [x,y+h/2,z]];
    for (let i = 0; i < sides; i++) {
      const angle = 2*Math.PI*i/sides;
      vertices.push([x+w/2*Math.cos(angle), y-h/2, z+d/2*Math.sin(angle)]);
    }
    faces = [];
    for (let i = 0; i < sides; i++) {
      const bottom = 2+i, next = 2+(i+1)%sides;
      faces.push([0,bottom,next], [1,next,bottom]);
    }
  } else if (part.shape === 'sphere') {
    const sides = 8, spans = 4;
    vertices = [[x,y+h/2,z],[x,y-h/2,z]];
    for (let j = 1; j < spans; j++) {
      const latitude = Math.PI*j/spans;
      for (let i = 0; i < sides; i++) {
        const angle = 2*Math.PI*i/sides;
        vertices.push([x+w/2*Math.sin(latitude)*Math.cos(angle), y+h/2*Math.cos(latitude), z+d/2*Math.sin(latitude)*Math.sin(angle)]);
      }
    }
    faces = [];
    for (let i = 0; i < sides; i++) {
      const next = (i+1)%sides;
      faces.push([0,2+next,2+i],[1,2+(spans-2)*sides+i,2+(spans-2)*sides+next]);
      for (let j = 0; j < spans-2; j++) {
        const top = 2+j*sides+i, following = 2+j*sides+next;
        faces.push([top,following,following+sides],[top,following+sides,top+sides]);
      }
    }
  } else {
    const sides = 12, ratio = part.inner_ratio ?? .72;
    vertices = [];
    for (let i = 0; i < sides; i++) {
      const angle = 2*Math.PI*i/sides, px = w/2*Math.cos(angle), pz = d/2*Math.sin(angle);
      vertices.push([x+px,y-h/2,z+pz],[x+px,y+h/2,z+pz],
        [x+ratio*px,y-h/2,z+ratio*pz],[x+ratio*px,y+h/2,z+ratio*pz]);
    }
    faces = [];
    for (let i = 0; i < sides; i++) {
      const a = 4*i, b = 4*((i+1)%sides);
      faces.push([a,a+1,b+1],[a,b+1,b], [a+2,b+3,a+3],[a+2,b+2,b+3],
        [a+1,a+3,b+3],[a+1,b+3,b+1], [a,b+2,a+2],[a,b,b+2]);
    }
  }
  if (part.rotation_deg) {
    // Rotate offsets around the part center, first X, then Y, then Z.
    const [rx, ry, rz] = part.rotation_deg.map(value => (value % 360)*Math.PI/180);
    const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
    vertices = vertices.map(point => {
      const [px, py, pz] = point.map((value, axis) => value-part.center[axis]);
      const y1 = py*cx-pz*sx, z1 = py*sx+pz*cx, x2 = px*cy+z1*sy, z2 = -px*sy+z1*cy;
      return [x+x2*cz-y1*sz, y+x2*sz+y1*cz, z+z2];
    });
  }
  const expanded = [], normals = [], indices = [];
  for (const face of faces) {
    const [a,b,c] = face.map(i => vertices[i]), u = b.map((v,i) => v-a[i]), v = c.map((n,i) => n-a[i]);
    const normal = [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]], length = Math.hypot(...normal);
    if (!Number.isFinite(length) || length === 0) throw new Error('Furniture primitive has a degenerate triangle.');
    for (const point of [a,b,c]) { indices.push(expanded.length); expanded.push(point); normals.push(normal.map(n => n/length)); }
  }
  return { vertices: expanded, normals, indices };
}

export function buildFurnitureAsset(item) {
  const model = validateFurnitureAppearance(item);
  if (!model) return null;
  const style = getCatalogStyle(item.style_id ?? model.default_style), materials = {};
  const meshes = model.parts.map((part, index) => {
    const color = (part.material === 'body' && item.color ? item.color : style.materials[part.material] || part.material).toLowerCase();
    const material = 'furniture_' + color.slice(1);
    materials[material] = linearColor(color);
    return { name: 'part_' + index, ...primitive(part), material, kind: 'inventory' };
  });
  return { meshes, materials };
}
