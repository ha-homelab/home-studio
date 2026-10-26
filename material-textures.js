// Explicit per-part semantics override legacy palette names; never infer from RGB.
// Artistic starting values, not measured material properties.
export const MATERIAL_SURFACE_PROFILES = Object.freeze({"feather":[0.75,0],"fur":[0.96,0],"fabric":[0.92,0],"leather":[0.5,0],"plastic":[0.48,0],"painted":[0.48,0],"wood":[0.58,0],"ceramic":[0.24,0],"glass":[0.12,0],"rubber":[0.95,0],"stone":[0.88,0],"metal":[0.3,0.75],"brushed_metal":[0.4,0.75],"matte_metal":[0.5,0.75],"polished_metal":[0.3,0.9],"mirror":[0.06,0.9],"matte_paint":[0.85,0],"rough_wood":[0.85,0],"polished_stone":[0.35,0],"paper":[0.85,0],"foliage":[0.75,0],"soil":[1,0],"car_paint":[0.25,0.15],"solar_cell":[0.25,0.25],"light_diffuser":[0.4,0]});
const MATERIAL_SURFACE_FINISHES = Object.freeze(Object.keys(MATERIAL_SURFACE_PROFILES));
function materialSurfaceFinish(value) {
  if (value !== undefined && !MATERIAL_SURFACE_FINISHES.includes(value)) throw Error("Invalid material surface finish");
  return value;
}

// One decoded image per URI, one GPU texture per color-space role. No URLs.
function createMaterialTextures(THREE, definitions, model) {
  const maps=new Map(),images=new Set(),owned=new Set(),unique=new Map(),specs=[];
  const details=typeof createPBRDetails==='function'?createPBRDetails(THREE):null;
  const channels=typeof PBR_TEXTURE_CHANNELS!=='undefined'?PBR_TEXTURE_CHANNELS:['albedo_texture'];
  let disposed=false,anisotropy=1,maxSize=1024,decodedPixels=0;
  const uses=new Map(),uriRoles=new Map(),reservedFamilies=new Set();
  for(const part of [...(model?.meshes||[]),...Object.values(model?.object_assets||{}).flatMap(a=>a.meshes)])for(const key of channels)if(part[key]) {
    if(!uses.has(part[key]))uses.set(part[key],new Set());uses.get(part[key]).add(key==='albedo_texture');
  }
  try {
    const entries=Object.entries(definitions||{}),payloads=new Map();
    if(definitions!==undefined&&(!definitions||Array.isArray(definitions)||typeof definitions!=='object')||entries.length>128)throw Error('Invalid textures');
    for(const [id,spec] of entries) {
      if(!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)||!spec||Object.keys(spec).sort().join()!=='data_uri,height,mime_type,width'||
          spec.mime_type!=='image/png'||![128,256,512,1024].includes(spec.width)||spec.height!==spec.width)throw Error('Invalid texture');
      const uri=spec.data_uri,prefix='data:image/png;base64,';
      if(typeof uri!=='string'||!uri.startsWith(prefix)||uri.length>prefix.length+1398104)throw Error('Invalid texture URI');
      const encoded=uri.slice(prefix.length);
      if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw Error('Invalid base64');
      const bytes=atob(encoded),integer=o=>bytes.charCodeAt(o)*16777216+(bytes.charCodeAt(o+1)<<16)+(bytes.charCodeAt(o+2)<<8)+bytes.charCodeAt(o+3);
      if(bytes.length<45||bytes.length>1048576||btoa(bytes)!==encoded||bytes.slice(0,8)!=='\x89PNG\r\n\x1a\n'||bytes.slice(12,16)!=='IHDR'||
          integer(8)!==13||integer(16)!==spec.width||integer(20)!==spec.height||bytes.charCodeAt(24)!==8||![2,3].includes(bytes.charCodeAt(25)))throw Error('Invalid PNG');
      if(!payloads.has(uri))payloads.set(uri,{bytes:bytes.length,pixels:spec.width*spec.height,roles:new Set()});
      for(const role of uses.get(id)||(!model?[true]:[]))payloads.get(uri).roles.add(role);
      specs.push([id,spec]);
    }
    if([...payloads.values()].reduce((n,p)=>n+p.bytes,0)>8388608)throw Error('Texture byte budget');
    for(const [uri,payload] of payloads){if(!payload.roles.size)payload.roles.add(false);uriRoles.set(uri,payload.roles)}
    decodedPixels=[...payloads.values()].reduce((n,p)=>n+p.pixels*p.roles.size,0);
    const families=new Set([...(model?.meshes||[]),...Object.values(model?.object_assets||{}).flatMap(a=>a.meshes)].map(p=>p.material_family).filter(f=>typeof PBR_DETAIL_PROFILES!=='undefined'&&Object.hasOwn(PBR_DETAIL_PROFILES,f)));
    for(const family of families)reservedFamilies.add(family);
    if(decodedPixels+families.size*128*128*3>12582912)throw Error('Texture pixel budget');
  }catch{specs.length=0;decodedPixels=0}
  function familyFor(family,scale=1) {
    if(typeof PBR_DETAIL_PROFILES==='undefined'||!Object.hasOwn(PBR_DETAIL_PROFILES,family))return {};
    if(!reservedFamilies.has(family)){if(decodedPixels+(reservedFamilies.size+1)*128*128*3>12582912)return {};reservedFamilies.add(family)}
    return details?.get(family,scale)||{};
  }
  function textureFor(entry,color) {
    if(entry.textures.has(color))return entry.textures.get(color);
    const roles=uriRoles.get(entry.uri);if(roles&&!roles.has(color)){if(decodedPixels+entry.size*entry.size+reservedFamilies.size*128*128*3>12582912)return null;roles.add(color);decodedPixels+=entry.size*entry.size}
    let pixels=entry.image;
    if(entry.size>maxSize&&typeof document!=='undefined') {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=maxSize;
      canvas.getContext('2d').drawImage(pixels,0,0,maxSize,maxSize);pixels=canvas;
    }
    const texture=new THREE.Texture(pixels);owned.add(texture);entry.textures.set(color,texture);
    texture.colorSpace=color?THREE.SRGBColorSpace:THREE.NoColorSpace;
    texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=anisotropy;texture.needsUpdate=true;return texture;
  }
  const ready=Promise.all(specs.map(([id,spec])=>{
    const uri=spec.data_uri;
    if(!unique.has(uri))unique.set(uri,new Promise(resolve=>{
      const image=new Image();images.add(image);let settled=false;
      const finish=value=>{if(settled)return;settled=true;clearTimeout(deadline);image.onload=image.onerror=null;resolve(value)};
      const deadline=setTimeout(()=>{finish(null);image.src=''},5000);
      image.onerror=()=>finish(null);image.onload=()=>{
        if(settled)return;if(disposed||image.naturalWidth!==spec.width||image.naturalHeight!==spec.height)return finish(null);
        finish({image,uri,size:spec.width,textures:new Map()});
      };image.src=uri;
    }));
    return unique.get(uri).then(entry=>{if(entry&&!disposed){maps.set(id,entry);for(const role of uses.get(id)||(!model?[true]:[]))textureFor(entry,role)}});
  })).then(()=>!disposed&&maps.size>0);
  return {
    ready,
    configure(renderer,profile={}) {
      anisotropy=Math.min(profile.pixels<=250000?2:4,renderer.capabilities.getMaxAnisotropy());maxSize=profile.pixels<=250000?256:1024;
      for(const entry of new Set(maps.values()))for(const [role,texture] of [...entry.textures]) {
        // Released old GPU state is no longer referenced by materials (called before build).
        texture.dispose();owned.delete(texture);entry.textures.delete(role);textureFor(entry,role);
      }
      details?.configure(anisotropy);
    },
    get(part,dimensions={width:1,height:1,depth:1}) {
      if(disposed)return null;
      for(const [key,max] of [['normal_scale',2],['ao_strength',1]])if(part[key]!==undefined&&(!Number.isFinite(part[key])||part[key]<0||part[key]>max))return null;
      const resolved={};
      for(const key of channels){const entry=maps.get(part[key]);if(entry){const texture=textureFor(entry,key==='albedo_texture');if(texture)resolved[key]=texture}}
      const generic=familyFor(part.material_family,part.material_uv_scale??1);
      for(const [key,texture] of Object.entries(generic))if(!resolved[key])resolved[key]=texture;
      if(!Object.keys(resolved).length)return null;
      const uv=part.uv,axes=part.uv_dimensions;
      if(!Array.isArray(uv)||uv.length!==part.vertices.length||axes!==undefined&&(!Array.isArray(axes)||axes.length!==2||axes[0]===axes[1]||axes.some(a=>!['width','height','depth'].includes(a))))return null;
      const scale=axes?axes.map(a=>dimensions[a]):[1,1],values=[];
      if(scale.some(v=>!Number.isFinite(v)||v<=0))return null;
      for(const pair of uv){if(!Array.isArray(pair)||pair.length!==2)return null;for(let i=0;i<2;i++){const v=pair[i]*scale[i];if(!Number.isFinite(pair[i])||!Number.isFinite(v)||Math.abs(v)>4096)return null;values.push(v)}}
      return {texture:resolved.albedo_texture,channels:resolved,uv:values,normalScale:part.normal_scale??1,aoStrength:part.ao_strength??1,albedoTint:part.albedo_tint===true||resolved.albedo_texture?.userData?.tintable===true};
    },
    family(family){return {channels:familyFor(family)}},
    releaseGPU(){if(!disposed){for(const texture of owned){texture.dispose();texture.needsUpdate=true}details?.releaseGPU()}},
    dispose(){if(disposed)return;disposed=true;for(const texture of owned)texture.dispose();owned.clear();maps.clear();details?.dispose();for(const image of images){image.onerror?.();image.src=''}images.clear()},
    get count(){return owned.size+(details?.count||0)},
    get decodedPixels(){return decodedPixels+(details?.count||0)*128*128}
  };
}

// Preserve explicit producer UVs when a rounded/cutaway wall adds vertices.
// Each added vertex uses the affine UV plane of the nearest facing source
// triangle. Original shadow vertices retain their exact UVs. No new texture,
// shader, render loop or geometry displacement is created here.
function staticMaterialUV(source, geometry, uv) {
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
  if (positions.count === source.vertices.length) return uv;
  if (positions.count < source.vertices.length || !normals || normals.count !== positions.count) return null;
  const sub = (a,b) => a.map((v,i)=>v-b[i]), dot = (a,b) => a.reduce((sum,v,i)=>sum+v*b[i],0);
  const triangles = [];
  for (let i=0;i<source.indices.length;i+=3) {
    const ids=source.indices.slice(i,i+3),a=source.vertices[ids[0]],u=sub(source.vertices[ids[1]],a),v=sub(source.vertices[ids[2]],a);
    const uu=dot(u,u),uvv=dot(u,v),vv=dot(v,v),det=uu*vv-uvv*uvv;
    if (det<=1e-16) continue;
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.sqrt(dot(n,n));
    const authored=source.normals[ids[0]],sign=dot(n,authored)<0?-1:1;
    triangles.push({ids,a,u,v,uu,uvv,vv,det,n:n.map(x=>x*sign/length)});
  }
  const result=uv.slice();
  for(let i=source.vertices.length;i<positions.count;i++) {
    const p=[positions.getX(i),positions.getY(i),positions.getZ(i)],n=[normals.getX(i),normals.getY(i),normals.getZ(i)];
    let best=Infinity,pair=null;
    for(const t of triangles) {
      const d=sub(p,t.a),du=dot(d,t.u),dv=dot(d,t.v),s=(du*t.vv-dv*t.uvv)/t.det,r=(dv*t.uu-du*t.uvv)/t.det;
      const outside=Math.max(0,-s)+Math.max(0,-r)+Math.max(0,s+r-1),distance=dot(d,t.n);
      const score=(1-dot(n,t.n))*1000+outside*outside+distance*distance;
      if(score<best) {best=score;pair=[0,1].map(axis=>uv[t.ids[0]*2+axis]*(1-s-r)+uv[t.ids[1]*2+axis]*s+uv[t.ids[2]*2+axis]*r)}
    }
    if(!pair||pair.some(value=>!Number.isFinite(value)||Math.abs(value)>4096)) return null;
    result.push(...pair);
  }
  return result;
}

function inventoryMaterialBatches(asset, dimensions, materials, textures) {
  const batches = new Map();
  for (const part of asset.meshes) {
    const mapped = textures.get(part, dimensions);
    const surfaceFinish = materialSurfaceFinish(part.surface_finish);
    // A moving rotor cannot share geometry with its stationary housing, even
    // when both use the same finish and cached texture channels.
    const fanRotor = !!asset.device_animation?.rotor && part.fan_rotor === true;
    const key = (surfaceFinish || '') + '|' + part.material + '|' + (fanRotor ? 'fan_rotor' : part.curtain_fabric ? part.curtain_panel : 'fixed') + '|' + JSON.stringify([Object.entries(mapped?.channels||{}).map(([k,t])=>[k,t.uuid]),mapped?.normalScale,mapped?.aoStrength,mapped?.albedoTint]);
    let batch = batches.get(key);
    if (!batch) {
      batch = {material:part.material, surfaceFinish, fanRotor, curtainFabric:part.curtain_fabric === true, curtainPanel:part.curtain_panel,
        vertices:[], normals:[], indices:[], uv:[], texture:mapped?.texture, mapped};
      batches.set(key, batch);
    }
    const offset = batch.vertices.length / 3;
    batch.vertices.push(...part.vertices.flat()); batch.normals.push(...part.normals.flat());
    batch.indices.push(...part.indices.map(index => index + offset));
    if (mapped) batch.uv.push(...mapped.uv);
  }
  return [...batches.values()];
}
