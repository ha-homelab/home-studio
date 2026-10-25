// Authored furniture profiles, shared by the offline planner and compiler.
import { CATALOG } from './catalog.js';
import { ValidationError } from './validation.js';
export { CATALOG };
const models = new Map(CATALOG.models.map(model => [model.id, model]));
const styles = new Map(CATALOG.styles.map(style => [style.id, style]));
const COLOR = /^#[0-9a-fA-F]{6}$/;
export const PATTERNS = ['none', 'stripes', 'checks', 'diamonds', 'dots', 'herringbone', 'chevrons'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
export const getCatalogModel = id => models.get(id) || null;
export const getCatalogStyle = id => styles.get(id) || null;
export const supportsCurtain = model => ['curtain_pair_open', 'curtain_pair_closed'].includes(model?.id);
export const supportsFurniturePattern = model => !!model?.parts.some(part => part.shape === 'box' && ['top', 'front'].includes(part.pattern_face));

export function validateFurnitureAppearance(item) {
  const has = key => Object.hasOwn(item, key);
  if (!has('model_id')) {
    if (has('style_id') || has('color') || has('pattern_id') || has('pattern_color')) throw new ValidationError('Choose a furniture model before setting a style, color or pattern.');
    return null;
  }
  const model = getCatalogModel(item.model_id);
  if (!model) throw new ValidationError('Unknown furniture model.');
  if (item.type !== model.type) throw new ValidationError('Furniture model does not match this item type.');
  if (has('style_id') && !getCatalogStyle(item.style_id)) throw new ValidationError('Unknown furniture style.');
  if (has('color') && (typeof item.color !== 'string' || !COLOR.test(item.color))) throw new ValidationError('Furniture color must use #RRGGBB.');
  if (has('pattern_id') && !PATTERNS.some(pattern => pattern.id === item.pattern_id)) throw new ValidationError('Unknown furniture pattern.');
  const patterned = has('pattern_id') && item.pattern_id !== 'none';
  if (has('pattern_color') && !patterned) throw new ValidationError('Choose a furniture pattern before setting its color.');
  if (has('pattern_color') && (typeof item.pattern_color !== 'string' || !COLOR.test(item.pattern_color))) throw new ValidationError('Furniture pattern color must use #RRGGBB.');
  if (patterned && !supportsFurniturePattern(model)) throw new ValidationError('This furniture model does not support patterns.');
  return model;
}

export function createFurnitureItemFields(modelId, styleId) {
  const model = getCatalogModel(modelId);
  if (!model) throw new ValidationError('Unknown furniture model.');
  const fields = { type: model.type, model_id: model.id, style_id: styleId ?? model.default_style,
    dimensions_m: { ...model.dimensions_m }, elevation_m: model.elevation_m };
  validateFurnitureAppearance(fields);
  return fields;
}

function linearColor(hex, opacity = 1) {
  return [1, 3, 5].map(offset => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  }).concat(opacity);
}

export function primitive(part, cutout = false) {
  if (!part || typeof part !== 'object' || !['box', 'cylinder', 'sphere', 'ring', 'cone'].includes(part.shape)) throw new Error('Unknown furniture primitive.');
  for (const key of ['center', 'size', ...(Object.hasOwn(part, 'rotation_deg') ? ['rotation_deg'] : [])]) {
    if (!Array.isArray(part[key]) || part[key].length !== 3 || !part[key].every(Number.isFinite)) throw new Error('Furniture ' + key + ' must contain three finite numbers.');
  }
  if (part.size.some(value => value <= 0)) throw new Error('Furniture primitive sizes must be positive.');
  if (Object.hasOwn(part, 'opacity') && (typeof part.opacity !== 'number' || !Number.isFinite(part.opacity) || part.opacity < 0 || part.opacity > 1)) throw new Error('Furniture opacity must be a finite number from 0 to 1.');
  if (Object.hasOwn(part, 'inner_ratio') && (part.shape !== 'ring' || !Number.isFinite(part.inner_ratio) || part.inner_ratio <= 0 || part.inner_ratio >= 1)) throw new Error('Ring inner_ratio must be between zero and one.');
  if (Object.hasOwn(part, 'pattern_face') && (part.shape !== 'box' || !['top', 'front'].includes(part.pattern_face))) throw new Error('Furniture pattern_face must be top or front on a box.');
  const allowed = {box:['edge','soft','cushion','tailored','joined','flat','canopy','vehicle_shell','molded_shell'],cylinder:['turned','lathed','lathed_fine','rod','soft','canopy','sprig','organic'],sphere:['round','leaf','canopy','coachwork','greenhouse'],ring:['rounded','rounded_fine'],cone:['turned','canopy','grass']};
  if (part.geometry_profile !== undefined) {
    if (!allowed[part.shape].includes(part.geometry_profile)) throw new Error('Unsupported furniture geometry profile.');
  if(['vehicle_shell','molded_shell'].includes(part.geometry_profile)) {
    if(Object.hasOwn(part,'geometry_rings')===Object.hasOwn(part,'geometry_shells'))throw new Error('Vehicle shell requires one ring representation.');
    if(!['smooth','flat'].includes(part.geometry_shading??'smooth'))throw new Error('Invalid vehicle shading.');
    const shells=part.geometry_shells??[part.geometry_rings];
    if(!Array.isArray(shells)||shells.length<1||shells.length>32)throw new Error('Invalid vehicle shell count.');
    let corners=0;
    for(const rings of shells){const sides=Array.isArray(rings?.[0])?rings[0].length:0;
      if(!Array.isArray(rings)||rings.length<2||rings.length>12||![4,6,8,24,32].includes(sides))throw new Error('Invalid vehicle shell rings.');
      for(const ring of rings)if(!Array.isArray(ring)||ring.length!==sides||ring.some(p=>!Array.isArray(p)||p.length!==3||p.some(v=>typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1.000000000001)))throw new Error('Invalid vehicle shell corner.');
      corners+=rings.length*sides;
    }
    if(corners>512)throw new Error('Vehicle shell exceeds corner budget.');
  }
  if(part.geometry_profile==='canopy') {
    if(!['broadleaf','needles'].includes(part.geometry_foliage??'broadleaf'))throw Error('Invalid canopy foliage.');
    if(part.geometry_leaf_count!==undefined&&(!Number.isInteger(part.geometry_leaf_count)||part.geometry_leaf_count<16||part.geometry_leaf_count>500))throw Error('Canopy leaf count must be 16–500.');
    if(part.geometry_dimensions!==undefined&&(!Array.isArray(part.geometry_dimensions)||part.geometry_dimensions.length!==3||part.geometry_dimensions.some(v=>!Number.isFinite(v)||v<=0)))throw Error('Invalid canopy dimensions.');
  }
  if(part.geometry_profile==='organic') {
    const sections=part.geometry_sections;
    if(!Array.isArray(sections)||sections.length<3||sections.length>16)throw Error('Organic profile requires 3–16 sections.');
    for(const [index,section] of sections.entries()) {
      if(!section||typeof section!=='object'||Object.keys(section).sort().join(',')!=='center,radius')throw Error('Invalid organic section.');
      for(const [key,count] of [['center',3],['radius',2]])if(!Array.isArray(section[key])||section[key].length!==count||section[key].some(v=>!Number.isFinite(v)||v < -1||v > 1))throw Error('Invalid organic coordinates.');
      if(index===0||index===sections.length-1){if(section.radius.some(v=>v!==0))throw Error('Organic ends must be closed poles.');}
      else if(section.radius.some(v=>v<=0))throw Error('Organic interior radii must be positive.');
      if(index&&section.center[1]<=sections[index-1].center[1])throw Error('Organic sections must ascend along Y.');
    }
  }
    return refinedPrimitive(part, cutout);
  }
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
  if(cutout && part.pattern_face) faces.splice(part.pattern_face === 'top' ? 2 : 8, 2);
  return triangleMesh(part, vertices, faces);
}

function triangleMesh(part, vertices, faces, vertexNormals = null) {
  const [x, y, z] = part.center;
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
  if (vertexNormals && part.rotation_deg) {
    const [rx,ry,rz]=part.rotation_deg.map(v=>(v%360)*Math.PI/180),cx=Math.cos(rx),sx=Math.sin(rx),cy=Math.cos(ry),sy=Math.sin(ry),cz=Math.cos(rz),sz=Math.sin(rz);
    vertexNormals=vertexNormals.map(([px,py,pz])=>{const y1=py*cx-pz*sx,z1=py*sx+pz*cx,x2=px*cy+z1*sy,z2=-px*sy+z1*cy;return [x2*cz-y1*sz,x2*sz+y1*cz,z2];});
  }
  const expanded = [], normals = [], indices = [];
  for (const face of faces) {
    const [a,b,c] = face.map(i => vertices[i]), u = b.map((v,i) => v-a[i]), v = c.map((n,i) => n-a[i]);
    const normal = [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]], length = Math.sqrt(normal.reduce((sum,n)=>sum+n*n,0));
    if (!Number.isFinite(length) || length === 0) throw new Error('Furniture primitive has a degenerate triangle.');
    for (const [i,point] of [a,b,c].entries()) { indices.push(expanded.length); expanded.push(point); normals.push(vertexNormals ? vertexNormals[face[i]] : normal.map(n => n/length)); }
  }
  return { vertices: expanded, normals, indices };
}

// Profiles are bounded by the exact legacy envelope, including rotated parts.
function refinedPrimitive(part, cutout = false, fit = true) {
  const { shape, geometry_profile: profile, center, size } = part;
  if(profile==='joined'){const {geometry_profile,...legacy}=part;return primitive(legacy,cutout);}
  const vertices = [], normals = [], faces = [];
  const unit = v => { const length = Math.sqrt(v.reduce((sum,x) => sum+x*x,0)); return v.map(x => x/length); };
  const point = (v,n) => { vertices.push(v.map((x,i) => center[i]+x*size[i]/2)); normals.push(unit(n.map((x,i) => x/size[i]))); return vertices.length-1; };
  const quad = (a,b,c,d) => faces.push([a,b,c],[a,c,d]);
  if(profile==='organic') {
    const sections=part.geometry_sections,sides=12,rings=[];
    for(const [index,section] of sections.entries()) {
      const c=section.center,[rx,rz]=section.radius;
      if(index===0||index===sections.length-1){rings.push([point(c,[0,index===0?-1:1,0])]);continue;}
      const ring=[];for(let j=0;j<sides;j++){const a=j*2*Math.PI/sides;ring.push(point([c[0]+rx*Math.cos(a),c[1],c[2]+rz*Math.sin(a)],[Math.cos(a),0,Math.sin(a)]));}rings.push(ring);
    }
    for(let row=0;row<rings.length-1;row++) {
      const low=rings[row],high=rings[row+1];
      for(let j=0;j<sides;j++){const k=(j+1)%sides;if(low.length===1)faces.push([low[0],high[j],high[k]]);else if(high.length===1)faces.push([low[j],high[0],low[k]]);else quad(low[j],high[j],high[k],low[k]);}
    }
  } else if(['vehicle_shell','molded_shell'].includes(profile)) {
    for(const rings of part.geometry_shells??[part.geometry_rings]){const sides=rings[0].length,offset=vertices.length;
      for(const ring of rings)for(const q of ring)point(q,[0,1,0]);
      for(let row=0;row<rings.length-1;row++)for(let j=0;j<sides;j++){const k=(j+1)%sides;quad(offset+row*sides+j,offset+row*sides+k,offset+(row+1)*sides+k,offset+(row+1)*sides+j);}
      const last=offset+(rings.length-1)*sides;for(let j=1;j<sides-1;j++)faces.push([offset,offset+j+1,offset+j],[last,last+j,last+j+1]);
    }
  } else if(profile==='greenhouse') {
    for(const q of [[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1],[-.7,1,-.58],[.7,1,-.58],[.7,1,.35],[-.7,1,.35]])point(q,[0,1,0]);
    faces.push([0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,5,1],[0,4,5],[1,6,2],[1,5,6],[2,7,3],[2,6,7],[3,4,0],[3,7,4]);
  } else if(profile==='grass') {
    for(let blade=0;blade<9;blade++) {
      const angle=blade*2.399963229728653,height=.55+.45*((blade*5)%9)/8,direction=[Math.cos(angle),0,Math.sin(angle)],across=[-Math.sin(angle),0,Math.cos(angle)];
      const origin=[.28*direction[0],-1,.28*direction[2]],start=vertices.length;
      for(const [level,width,lean] of [[0,.10,0],[.65,.065,.25],[1,0,.52]]) {
        if(level===1){const q=origin.map((x,i)=>x+lean*direction[i]);q[1]=-1+2*height;point(q,direction);continue;}
        for(const [side,depth] of [[-1,0],[1,0],[0,.035]]){const q=origin.map((x,i)=>x+lean*direction[i]+side*width*across[i]+depth*direction[i]);q[1]=-1+2*height*level;point(q,direction);}
      }
      faces.push([start,start+2,start+1],[start+3,start+4,start+6],[start+4,start+5,start+6],[start+5,start+3,start+6]);
      for(let j=0;j<3;j++)quad(start+j,start+(j+1)%3,start+3+(j+1)%3,start+3+j);
    }
  } else if(['canopy','sprig'].includes(profile)) {
    // Closed individual leaf blades, not camera-facing images.
    if(profile==='canopy') {
      const sides=8,spans=4;point([0,.94,0],[0,1,0]);point([0,-.94,0],[0,-1,0]);
      for(let row=1;row<spans;row++) {
        const latitude=Math.PI*row/spans,sy=Math.cos(latitude);
        for(let column=0;column<sides;column++) {
          const angle=2*Math.PI*column/sides;let radius=.86*Math.sin(latitude);if(shape==='cone')radius=(part.geometry_foliage==='needles'?.16:.86)*(1-sy)/2;
          let q=[radius*Math.cos(angle),.94*sy,radius*Math.sin(angle)];if(shape==='box')q=q.map(x=>Math.sign(x)*.88*Math.abs(x/.94)**.35);
          point(q,[Math.cos(angle),sy,Math.sin(angle)]);
        }
      }
      for(let column=0;column<sides;column++) {
        const following=(column+1)%sides;faces.push([0,2+following,2+column],[1,2+(spans-2)*sides+column,2+(spans-2)*sides+following]);
        for(let row=0;row<spans-2;row++){const a=2+row*sides+column,b=2+row*sides+following;quad(a,b,b+sides,a+sides);}
      }
    }
    const count=profile==='sprig'?12:(part.geometry_leaf_count??128);
    const needles=profile==='canopy'&&part.geometry_foliage==='needles',samples=count;
    for(let leaf=0;leaf<count;leaf++) {
      const sample=leaf,height=-.94+1.88*((sample*17)%samples)/(samples-1),yaw=sample*2.399963229728653,radial=Math.sqrt(Math.max(0,1-height*height));
      let origin,along,across,normal,halfLength,halfWidth,thickness=.001;
      if(profile==='canopy') {
        let direction=[radial*Math.cos(yaw),height,radial*Math.sin(yaw)];
        if(shape==='box') {
          const dimensions=part.geometry_dimensions||[1,1,1],weights=[0,1,2].flatMap(i=>[dimensions[(i+1)%3]*dimensions[(i+2)%3],dimensions[(i+1)%3]*dimensions[(i+2)%3]]);
          let sample=(leaf+.5)/count*weights.reduce((a,b)=>a+b,0),face=0;while(sample>weights[face]&&face<5){sample-=weights[face];face++;}
          const axis=Math.floor(face/2);normal=[0,0,0];normal[axis]=face%2?1:-1;direction=[0,0,0];direction[axis]=normal[axis];
          direction[(axis+1)%3]=1.94*((leaf*.618033988749895)%1)-.97;direction[(axis+2)%3]=1.94*((leaf*.414213562373095)%1)-.97;
        } else if(shape==='cone') {
          direction=[(1-height)*.5*Math.cos(yaw),height,(1-height)*.5*Math.sin(yaw)];normal=unit([Math.cos(yaw),.5,Math.sin(yaw)]);
        } else normal=unit(direction);
        origin=direction.map(x=>.91*x);
        const tangent=Math.abs(normal[1])<.99?unit([normal[2],0,-normal[0]]):[1,0,0];
        const bitangent=[normal[1]*tangent[2]-normal[2]*tangent[1],normal[2]*tangent[0]-normal[0]*tangent[2],normal[0]*tangent[1]-normal[1]*tangent[0]],tilt=leaf*1.1;
        along=tangent.map((x,i)=>Math.cos(tilt)*x+Math.sin(tilt)*bitangent[i]);across=tangent.map((x,i)=>-Math.sin(tilt)*x+Math.cos(tilt)*bitangent[i]);halfLength=.13;halfWidth=.055;
        if(needles){
          const dimensions=part.geometry_dimensions||[1,1,1],branchRadius=(1-height)*.5,axis=unit([Math.cos(yaw),-.16,Math.sin(yaw)]);
          along=axis;across=[-Math.sin(yaw),0,Math.cos(yaw)];normal=unit([axis[1]*across[2],axis[2]*across[0]-axis[0]*across[2],-axis[1]*across[0]]);
          const physicalRadius=branchRadius*Math.min(dimensions[0],dimensions[2])*.5;
          halfLength=Math.max(.012,.47*physicalRadius);halfWidth=Math.max(.003,.072*physicalRadius);thickness=Math.max(.001,.028*physicalRadius);
          origin=[.51*branchRadius*Math.cos(yaw),.91*height,.51*branchRadius*Math.sin(yaw)];
        }
      } else {
        const radius=.72*radial;origin=[radius*Math.cos(yaw),height,radius*Math.sin(yaw)];along=unit([Math.cos(yaw),.35*Math.sin(leaf*1.7),Math.sin(yaw)]);across=[-Math.sin(yaw),0,Math.cos(yaw)];
        normal=[along[1]*across[2],along[2]*across[0]-along[0]*across[2],-along[1]*across[0]];halfLength=.38;halfWidth=.17;
      }
      const start=vertices.length;
      if(profile==='canopy') {
        const dimensions=part.geometry_dimensions||[1,1,1];
        for(const [u,v,w] of [[-1,0,0],[1,0,0],[0,1,thickness],[0,-1,thickness]])point(origin.map((x,k)=>x+2*(u*halfLength*along[k]+v*halfWidth*across[k]+w*normal[k])/dimensions[k]),normal);
        faces.push([start,start+2,start+1],[start,start+1,start+3],[start,start+3,start+2],[start+1,start+2,start+3]);continue;
      }
      for(let i=0;i<6;i++){const a=2*Math.PI*i/6;point(origin.map((x,k)=>x+halfLength*Math.cos(a)*along[k]+halfWidth*Math.sin(a)*across[k]),normal);}
      for(const side of [1,-1]){const tip=point(origin.map((x,k)=>x+side*.035*normal[k]),normal.map(x=>side*x));for(let i=0;i<6;i++){const a=start+i,b=start+(i+1)%6;faces.push(side>0?[tip,a,b]:[tip,b,a]);}}
      if(profile==='canopy')continue;
      const branchStart=[0,-1,0],branchEnd=origin.map((x,i)=>x-.30*along[i]);
      const direction=unit(branchEnd.map((x,i)=>x-branchStart[i])),tangent=unit([direction[2],0,-direction[0]]);
      const bitangent=[direction[1]*tangent[2],direction[2]*tangent[0]-direction[0]*tangent[2],-direction[1]*tangent[0]],first=vertices.length;
      for(let j=0;j<3;j++){
        const angle=j*2*Math.PI/3,n=tangent.map((x,i)=>Math.cos(angle)*x+Math.sin(angle)*bitangent[i]);point(branchStart.map((x,i)=>x+.012*n[i]),n);
      }
      point(branchEnd,direction);
      for(let j=0;j<3;j++)faces.push([first+j,first+(j+1)%3,first+3]);
      faces.push([first,first+2,first+1]);
    }
  } else if(shape==='box'&&!['soft','cushion','tailored'].includes(profile)) {
    const radius=profile==='edge'?.08:.025,core=1-radius,corners=new Map(),key=(s,a)=>s.join(',')+':'+a;
    for(const sx of [-1,1])for(const sy of [-1,1])for(const sz of [-1,1]) {
      const signs=[sx,sy,sz];for(let axis=0;axis<3;axis++)corners.set(key(signs,axis),point(signs.map((s,i)=>s*(i===axis?1:core)),signs.map((s,i)=>i===axis?s:0)));
    }
    function polygon(ids) {
      const [a,b,c]=ids.slice(0,3).map(i=>vertices[i]),u=b.map((x,i)=>x-a[i]),v=c.map((x,i)=>x-a[i]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
      if(n.reduce((sum,x,i)=>sum+x*ids.reduce((s,j)=>s+vertices[j][i]-center[i],0),0)<0)ids=ids.reverse();
      for(let j=1;j<ids.length-1;j++)faces.push([ids[0],ids[j],ids[j+1]]);
    }
    for(let axis=0;axis<3;axis++) {
      const u=(axis+1)%3,v=(axis+2)%3;
      for(const sign of [-1,1]) {
        if(cutout&&sign===1&&axis===(part.pattern_face==='top'?1:2))continue;
        polygon([[-1,-1],[1,-1],[1,1],[-1,1]].map(([su,sv])=>{const s=[0,0,0];s[axis]=sign;s[u]=su;s[v]=sv;return corners.get(key(s,axis));}));
      }
    }
    for(let axis=0;axis<3;axis++) {
      const u=(axis+1)%3,v=(axis+2)%3;
      for(const su of [-1,1])for(const sv of [-1,1])polygon([[-1,u],[1,u],[1,v],[-1,v]].map(([sign,face])=>{const s=[0,0,0];s[axis]=sign;s[u]=su;s[v]=sv;return corners.get(key(s,face));}));
    }
    for(const sx of [-1,1])for(const sy of [-1,1])for(const sz of [-1,1])polygon([0,1,2].map(axis=>corners.get(key([sx,sy,sz],axis))));
  } else if (shape === 'box') {
    const radius = ['cushion','tailored'].includes(profile) ? .45 : profile === 'soft' ? .34 : profile === 'edge' ? .08 : .025, core = 1-radius;
    const coordinates=profile==='cushion'?[-1,-core,0,core,1]:[-1,-core,core,1],stride=coordinates.length;
    for (let axis=0;axis<3;axis++) {
      const u=(axis+1)%3,v=(axis+2)%3;
      for (const sign of [-1,1]) {
        const start=vertices.length;
        for (const a of coordinates) for (const b of coordinates) {
          const raw=[0,0,0];raw[axis]=sign;raw[u]=a;raw[v]=b;
          const inner=raw.map(x=>Math.max(-core,Math.min(core,x))), normal=unit(raw.map((x,i)=>x-inner[i]));
          const q=inner.map((x,i)=>x+radius*normal[i]);
          if(profile==='cushion'){const dome=Math.max(0,1-(a/core)**2)*Math.max(0,1-(b/core)**2);q[axis]-=sign*.16*(1-dome)*(1-Math.max(Math.abs(a),Math.abs(b)));}
          point(q,normal);
        }
        for (let i=0;i<stride-1;i++) for(let j=0;j<stride-1;j++) {
          if(cutout&&i===1&&j===1&&sign===1&&axis===(part.pattern_face==='top'?1:2)) continue;
          const a=start+i*stride+j,b=start+(i+1)*stride+j,c=b+1,d=a+1;
          if(sign>0)quad(a,b,c,d);else quad(a,d,c,b);
        }
      }
    }
  } else if(shape==='cone') {
    const sides=16,n=angle=>[Math.cos(angle),.5,Math.sin(angle)];
    for(let i=0;i<sides;i++) {
      const a=2*Math.PI*i/sides,b=2*Math.PI*((i+1)%sides)/sides;
      const top=point([0,1,0],n((2*Math.PI*i/sides+2*Math.PI*(i+1)/sides)/2));
      let first=point([Math.cos(a),-1,Math.sin(a)],n(a)),following=point([Math.cos(b),-1,Math.sin(b)],n(b));
      faces.push([top,following,first]);
      const c=point([0,-1,0],[0,-1,0]);first=point([Math.cos(a),-1,Math.sin(a)],[0,-1,0]);following=point([Math.cos(b),-1,Math.sin(b)],[0,-1,0]);faces.push([c,first,following]);
    }
  } else if (shape==='sphere') {
    const sides=12,spans=6;
    point([0,1,profile==='leaf'?.72:0],[0,1,0]);point([0,-1,profile==='leaf'?-.72:0],[0,-1,0]);
    for(let j=1;j<spans;j++) {
      const latitude=Math.PI*j/spans,sy=Math.cos(latitude),radial=shape==='cone'?(1-sy)/2:Math.sin(latitude);
      for(let i=0;i<sides;i++) {
        const angle=2*Math.PI*i/sides,q=[radial*Math.cos(angle),sy,radial*Math.sin(angle)];
        if(profile==='coachwork')for(let k=0;k<3;k++)q[k]=Math.sign(q[k])*Math.abs(q[k])**.55;
        if(profile==='leaf'){
          // Keep a thin cross-section; the blade's bend provides its depth.
          q[0]*=.65+.35*Math.sin(latitude);
          q[2]=.72*sy+.22*(1-sy*sy)+.025*q[2];
        }
        point(q,[q[0],shape==='cone'?.5*radial:sy,q[2]]);
      }
    }
    for(let i=0;i<sides;i++) {
      const following=(i+1)%sides;
      faces.push([0,2+following,2+i],[1,2+(spans-2)*sides+i,2+(spans-2)*sides+following]);
      for(let j=0;j<spans-2;j++){const a=2+j*sides+i,b=2+j*sides+following;quad(a,b,b+sides,a+sides);}
    }
  } else if(shape==='cylinder') {
    const sides=profile==='lathed_fine'?32:profile==='lathed'?16:12,rim=profile==='rod'?0:profile==='soft'?.12:.035,rings=profile==='rod'?[[-1,1],[1,1]]:[[-1,1-rim],[-1+rim,1],[1-rim,1],[1,1-rim]];
    for(const [row,[height,radius]] of rings.entries())for(let i=0;i<sides;i++) {
      const a=2*Math.PI*i/sides,ny=profile==='rod'?0:row===0?-1:row===3?1:0;
      point([radius*Math.cos(a),height,radius*Math.sin(a)],[Math.cos(a),ny,Math.sin(a)]);
    }
    for(let row=0;row<rings.length-1;row++)for(let i=0;i<sides;i++){const a=row*sides+i,b=row*sides+(i+1)%sides;quad(a,a+sides,b+sides,b);}
    for(const [height,sign] of [[-1,-1],[1,1]]) {
      const c=point([0,height,0],[0,sign,0]),start=vertices.length;
      for(let i=0;i<sides;i++){const a=2*Math.PI*i/sides;point([(1-rim)*Math.cos(a),height,(1-rim)*Math.sin(a)],[0,sign,0]);}
      for(let i=0;i<sides;i++){const a=start+i,b=start+(i+1)%sides;faces.push(sign>0?[c,b,a]:[c,a,b]);}
    }
  } else {
    const sides=profile==='rounded_fine'?32:12,spans=4,ratio=part.inner_ratio??.72,major=(1+ratio)/2,minor=(1-ratio)/2;
    for(let i=0;i<sides;i++) {
      const a=2*Math.PI*i/sides;
      for(let j=0;j<spans;j++) {
        const b=2*Math.PI*j/spans,radius=major+minor*Math.cos(b);
        point([radius*Math.cos(a),Math.sin(b),radius*Math.sin(a)],[Math.cos(b)*Math.cos(a)/minor,Math.sin(b),Math.cos(b)*Math.sin(a)/minor]);
      }
    }
    for(let i=0;i<sides;i++)for(let j=0;j<spans;j++){const a=i*spans+j,b=((i+1)%sides)*spans+j;quad(a,a-j+(j+1)%spans,b-j+(j+1)%spans,b);}
  }
  if(['cushion','organic'].includes(profile)) {
    const keys=vertices.map(p=>p.map(v=>Math.round(v*1e12)/1e12).join(',')),accum=new Map(keys.map(k=>[k,[0,0,0]]));
    for(const face of faces) {
      const [a,b,c]=face.map(i=>vertices[i]),u=b.map((x,i)=>x-a[i]),v=c.map((x,i)=>x-a[i]);
      const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
      for(const index of face)for(let axis=0;axis<3;axis++)accum.get(keys[index])[axis]+=normal[axis];
    }
    for(let i=0;i<normals.length;i++)normals[i]=unit(accum.get(keys[i]));
  }
  if(['cushion','tailored'].includes(profile)) {
    const thin=part.size.indexOf(Math.min(...part.size)),u=(thin+1)%3,v=(thin+2)%3;
    const start=vertices.length,steps=32,crossSteps=4,core=.55,radius=.45;
    for(let i=0;i<steps;i++) {
      const corner=Math.floor(i/8),angle=corner*Math.PI/2+(i%8)*Math.PI/16;
      const sx=[0,3].includes(corner)?1:-1,sy=[0,1].includes(corner)?1:-1;
      const cu=sx*core+radius*Math.cos(angle),cv=sy*core+radius*Math.sin(angle);
      for(let j=0;j<crossSteps;j++) {
        const around=j*2*Math.PI/crossSteps,q=[0,0,0],n=[0,0,0];
        q[u]=cu+.012*Math.cos(around)*Math.cos(angle);q[v]=cv+.012*Math.cos(around)*Math.sin(angle);q[thin]=.012*Math.sin(around);
        n[u]=Math.cos(around)*Math.cos(angle);n[v]=Math.cos(around)*Math.sin(angle);n[thin]=Math.sin(around);point(q,n);
      }
    }
    for(let i=0;i<steps;i++)for(let j=0;j<crossSteps;j++) {
      const a=start+i*crossSteps+j,b=start+((i+1)%steps)*crossSteps+j;
      quad(a,b,start+((i+1)%steps)*crossSteps+(j+1)%crossSteps,start+i*crossSteps+(j+1)%crossSteps);
    }
  }
  const mesh=triangleMesh(part,vertices,faces,['canopy','sprig','greenhouse','grass','vehicle_shell','molded_shell','leaf'].includes(profile)?null:normals);
  if (fit) {
    fitProfileMesh(part,mesh);
    if(['organic','leaf'].includes(profile)||['vehicle_shell','molded_shell'].includes(profile)&&part.geometry_shading!=='flat')creaseNormals(mesh);
    // Authored precision removes libm residue before exact tuple indexing.
    for (const key of ['vertices','normals']) mesh[key]=mesh[key].map(point=>point.map(value=>Math.round(value*1e12)/1e12));
  }
  return mesh;
}

function creaseNormals(mesh) {
  // Explicit 60-degree boundaries prevent inward normals at sharp ankle folds.
  const keys=mesh.vertices.map(p=>p.map(x=>Math.round(x*1e12)/1e12).join(',')),adjacent=new Map(keys.map(k=>[k,new Set()])),faces=[],units=[];
  for(let start=0;start<keys.length;start+=3) {
    const [a,b,c]=mesh.vertices.slice(start,start+3),u=b.map((x,i)=>x-a[i]),v=c.map((x,i)=>x-a[i]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.sqrt(n.reduce((s,x)=>s+x*x,0)),face=faces.length;
    faces.push(n);units.push(n.map(x=>x/length));for(const key of keys.slice(start,start+3))adjacent.get(key).add(face);
  }
  mesh.normals=keys.map((key,index)=>{
    const reference=units[Math.floor(index/3)],n=[0,0,0];
    for(const face of [...adjacent.get(key)].sort((a,b)=>a-b))if(reference.reduce((s,x,i)=>s+x*units[face][i],0)>=.5-1e-10)for(let i=0;i<3;i++)n[i]+=faces[face][i];
    const length=Math.sqrt(n.reduce((s,x)=>s+x*x,0));return n.map(x=>x/length);
  });
}

function fitProfileMesh(part,mesh,reference=mesh) {
  const oldPart={...part};delete oldPart.geometry_profile;
  const legacy=primitive(oldPart),bounds=m=>[0,1,2].map(i=>[Math.min(...m.vertices.map(p=>p[i])),Math.max(...m.vertices.map(p=>p[i]))]);
  const oldBounds=bounds(legacy),newBounds=bounds(reference),scales=oldBounds.map(([a,b],i)=>(b-a)/(newBounds[i][1]-newBounds[i][0]));
  mesh.vertices=mesh.vertices.map(p=>p.map((x,i)=>oldBounds[i][0]+(x-newBounds[i][0])*scales[i]));
  mesh.normals=mesh.normals.map(n=>{const v=n.map((x,i)=>x/scales[i]),length=Math.sqrt(v.reduce((sum,x)=>sum+x*x,0));return v.map(x=>x/length);});
  return mesh;
}

function chartUV(mesh,dimensions) {
  const scale=['width','height','depth'].map(k=>dimensions[k]),uv=[];
  const grain=['wood','rough_wood'].includes(mesh.surface_finish),extent=grain?[0,1,2].map(i=>(Math.max(...mesh.vertices.map(p=>p[i]))-Math.min(...mesh.vertices.map(p=>p[i])))*scale[i]):null;
  for(let start=0;start<mesh.vertices.length;start+=3) {
    const [a,b,c]=mesh.vertices.slice(start,start+3),[u,v]=[b,c].map(p=>p.map((x,i)=>x*scale[i]-a[i]*scale[i]));
    const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    // Resolve mathematically tied diagonal charts identically across libm.
    const magnitude=Math.max(...normal.map(Math.abs));
    const dominant=normal.findIndex(value=>Math.abs(value)>=magnitude*(1-1e-8));
    let axes=[[2,1],[0,2],[0,1]][dominant];
    if(grain&&extent[axes[1]]>extent[axes[0]]*(1+1e-8))axes=[axes[1],axes[0]];
    for(const p of [a,b,c])uv.push(axes.map(i=>p[i]*scale[i]));
  }
  mesh.uv=uv;
}

// Exact tuple equality preserves normal, UV and material seams.
function compactMesh(mesh) {
  const seen=new Map(),vertices=[],normals=[],uv=[],indices=[];
  for(const old of mesh.indices){const key=JSON.stringify([...mesh.vertices[old],...mesh.normals[old],...mesh.uv[old]]);if(!seen.has(key)){seen.set(key,vertices.length);vertices.push(mesh.vertices[old]);normals.push(mesh.normals[old]);uv.push(mesh.uv[old]);}indices.push(seen.get(key));}
  Object.assign(mesh,{vertices,normals,uv,indices});
}

// Split convex polygons at a line. The pieces share edges, never coplanar area.
function clipPolygon(polygon, a, b, inside) {
  const distance = point => (b[0]-a[0])*(point[1]-a[1]) - (b[1]-a[1])*(point[0]-a[0]);
  const clipped = [];
  for (let i = 0; i < polygon.length; i++) {
    const start = polygon[i], end = polygon[(i+1)%polygon.length], da = distance(start), db = distance(end);
    const first = inside ? da >= 0 : da <= 0, second = inside ? db >= 0 : db <= 0;
    if (first) clipped.push(start);
    if (first !== second) clipped.push(start.map((value, axis) => value + (end[axis]-value)*da/(da-db)));
  }
  return clipped;
}

function patternSurface(part, pattern) {
  const originalPart=part;
  if(part.geometry_profile){const radius=part.geometry_profile==='joined'?0:['cushion','tailored'].includes(part.geometry_profile)?.45:part.geometry_profile==='soft'?.34:part.geometry_profile==='edge'?.08:.025,axis=part.pattern_face==='top'?1:2;part={...part,size:part.size.map((v,i)=>i===axis?v:v*(1-radius))};}
  const background = { vertices: [], faces: [] }, accent = { vertices: [], faces: [] };
  const rectangle = (left, bottom, right, top) => [[left,bottom],[right,bottom],[right,top],[left,top]];
  const columns = pattern === 'stripes' ? 6 : pattern === 'diamonds' || pattern === 'dots' ? 3 : 4;
  const rows = pattern === 'stripes' ? 1 : pattern === 'dots' ? 2 : pattern === 'diamonds' ? 3 : 4;
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    let motif;
    if (pattern === 'stripes' || pattern === 'checks') motif = (column + (pattern === 'checks' ? row : 0)) % 2 ? [] : rectangle(0,0,1,1);
    else if (pattern === 'diamonds') motif = [[.5,0],[1,.5],[.5,1],[0,.5]];
    else if (pattern === 'dots') motif = Array.from({ length: 8 }, (_, index) => {
      const angle = index*Math.PI/4;
      return [.5+.38*Math.cos(angle), .5+.38*Math.sin(angle)];
    });
    else if (pattern === 'herringbone') {
      // Interlocking 2:1 planks, split at tile boundaries without adding seams.
      const phase = ((column-row)%4+4)%4;
      motif = rectangle(phase === 1 ? 0 : .09, phase === 2 ? 0 : .09, phase === 0 ? 1 : .91, phase === 3 ? 1 : .91);
    } else {
      motif = [[-.3,0],[0,-.3],[1.3,1],[1,1.3]];
      if (column%2) motif = motif.map(([u,v]) => [1-u,v]).reverse();
    }
    const emit = (polygon, target) => {
      for (let i = 1; i < polygon.length-1; i++) {
        const points = [polygon[0], polygon[i], polygon[i+1]];
        const [a,b,c] = points;
        if ((b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]) <= 1e-12) continue;
        const offset = target.vertices.length;
        for (const [u,v] of points) {
          const px = ((column+u)/columns-.5)*part.size[0]+part.center[0];
          target.vertices.push(part.pattern_face === 'top'
            ? [px, part.center[1]+part.size[1]/2, (.5-(row+v)/rows)*part.size[2]+part.center[2]]
            : [px, ((row+v)/rows-.5)*part.size[1]+part.center[1], part.center[2]+part.size[2]/2]);
        }
        target.faces.push([offset,offset+1,offset+2]);
      }
    };
    let remaining = rectangle(0,0,1,1);
    for (let i = 0; i < motif.length; i++) {
      const a = motif[i], b = motif[(i+1)%motif.length];
      emit(clipPolygon(remaining, a, b, false), background);
      remaining = clipPolygon(remaining, a, b, true);
    }
    emit(remaining, motif.length ? accent : background);
  }
  const meshes=[background, accent].map(mesh => triangleMesh(part, mesh.vertices, mesh.faces));
  if(originalPart.geometry_profile){const reference=refinedPrimitive(originalPart,false,false);return meshes.map(mesh=>fitProfileMesh(originalPart,mesh,reference));}
  return meshes;
}

function appendMesh(target, source) {
  const offset = target.vertices.length;
  target.vertices.push(...source.vertices);
  target.normals.push(...source.normals);
  target.indices.push(...source.indices.map(index => index+offset));
}

export function buildFurnitureAsset(item) {
  const model = validateFurnitureAppearance(item);
  if (!model) return null;
  const style = getCatalogStyle(item.style_id ?? model.default_style), materials = {};
  const pattern = item.pattern_id && item.pattern_id !== 'none' ? item.pattern_id : null;
  const patternedMesh = { name: 'pattern', vertices: [], normals: [], indices: [], kind: 'inventory' };
  const curtainPatterns = [];
  const meshes = model.parts.map((part, index) => {
    const color = (part.material === 'body' && item.color ? item.color : style.materials[part.material] || part.material).toLowerCase();
    const opacity = part.opacity ?? 1;
    // Authored optical parts must not alias opaque parts with the same RGB.
    const material = 'furniture_' + color.slice(1) + (opacity < 1 ? '_' + model.id + '_part_' + index : '');
    materials[material] = linearColor(color, opacity);
    const fabric = supportsCurtain(model) && ['body', 'accent'].includes(part.material);
    const tags = fabric ? { curtain_fabric: true, curtain_panel: part.center[0] < 0 ? 'left' : 'right' } : {};
    const mesh = { name: 'part_' + index, ...primitive(part, !!(pattern && part.pattern_face)), surface_finish: part.surface_finish || 'painted', material_family: part.surface_finish || 'painted', material, kind: 'inventory', ...tags };
    if (pattern && part.pattern_face) {
      const [background, accent] = patternSurface(part, pattern);
      appendMesh(mesh, background);
      if (fabric) curtainPatterns.push({ name: 'pattern_' + index, ...accent, kind: 'inventory', ...tags });
      else appendMesh(patternedMesh, accent);
    }
    return mesh;
  });
  if (pattern) {
    const color = (item.pattern_color || style.materials.accent).toLowerCase();
    patternedMesh.material = 'furniture_' + color.slice(1);
    materials[patternedMesh.material] = linearColor(color);
    if (patternedMesh.vertices.length) meshes.push(patternedMesh);
    for (const mesh of curtainPatterns) meshes.push({ ...mesh, material: patternedMesh.material });
  }
  const patternFinish=model.parts.find(part=>part.pattern_face)?.surface_finish||'painted';
  for(const mesh of meshes){if(!mesh.surface_finish){mesh.surface_finish=patternFinish;mesh.material_family=patternFinish;}chartUV(mesh,item.dimensions_m||model.dimensions_m);if(model.parts.some(p=>p.geometry_profile))compactMesh(mesh);}
  return { meshes, materials };
}
