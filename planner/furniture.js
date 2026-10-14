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

function primitive(part) {
  const [x, y, z] = part.center, [w, h, d] = part.size;
  let vertices, faces;
  if (part.shape === 'box') {
    vertices = [-1, 1].flatMap(sign => [[x-w/2, y+sign*h/2, z-d/2], [x+w/2, y+sign*h/2, z-d/2], [x+w/2, y+sign*h/2, z+d/2], [x-w/2, y+sign*h/2, z+d/2]]);
    faces = [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,5,1],[0,4,5],[1,6,2],[1,5,6],[2,7,3],[2,6,7],[3,4,0],[3,7,4]];
  } else {
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
  }
  const expanded = [], normals = [], indices = [];
  for (const face of faces) {
    const [a,b,c] = face.map(i => vertices[i]), u = b.map((v,i) => v-a[i]), v = c.map((n,i) => n-a[i]);
    const normal = [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]], length = Math.hypot(...normal);
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
