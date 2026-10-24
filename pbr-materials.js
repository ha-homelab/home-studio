// PBR channels share authored UVs. Family microdetail uses metres, never color.
const PBR_TEXTURE_CHANNELS = Object.freeze(['albedo_texture','normal_texture','roughness_texture','metalness_texture','ao_texture']);
const PBR_DETAIL_PROFILES = Object.freeze({"feather":[0.08,0.00005,2,28,0.16],"fur":[0.04,0.00008,2,20,0.12],"fabric":[0.025,9e-05,8,8,0.18],"leather":[0.04,0.00016,3,4,0.2],"wood":[0.16,0.00012,2,18,0.14],"rough_wood":[0.16,0.0003,2,18,0.2],"stone":[0.18,0.00045,4,3,0.2],"polished_stone":[0.18,2.5e-05,4,3,0.08],"painted":[0.04,1.5e-05,7,8,0.06],"matte_paint":[0.04,2.5e-05,7,8,0.09],"plastic":[0.04,8e-06,7,8,0.04],"rubber":[0.04,3.5e-05,7,8,0.08],"brushed_metal":[0.08,2e-05,2,24,0.18],"metal":[0.08,8e-06,2,24,0.08],"matte_metal":[0.08,1.2e-05,7,8,0.08],"paper":[0.04,1.5e-05,7,8,0.08],"soil":[0.18,0.0007,4,3,0.15],"foliage":[0.08,3e-05,2,12,0.1]});
function pbrDetailPixels(family, size=128) {
  const profile=Object.hasOwn(PBR_DETAIL_PROFILES,family)?PBR_DETAIL_PROFILES[family]:null; if(!profile)return null;
  const [period,relief,fx,fy,variance]=profile,normal=new Uint8Array(size*size*3),roughness=new Uint8Array(size*size*3),tau=2*Math.PI;
  const byte=x=>Math.max(0,Math.min(255,Math.floor(x+.5)));
  for(let row=0;row<size;row++)for(let col=0;col<size;col++) {
    const x=(col+.5)/size,y=1-(row+.5)/size,a=tau*fx*x,b=tau*fy*y,c=tau*(3*x+2*y),d=tau*(7*x-5*y);
    const h=.6*Math.sin(a)*Math.sin(b)+.25*Math.sin(c)+.15*Math.sin(d);
    const dx=relief/period*tau*(.6*fx*Math.cos(a)*Math.sin(b)+.75*Math.cos(c)+1.05*Math.cos(d));
    const dy=relief/period*tau*(.6*fy*Math.sin(a)*Math.cos(b)+.5*Math.cos(c)-.75*Math.cos(d));
    const length=Math.sqrt(dx*dx+dy*dy+1),i=(row*size+col)*3;
    normal.set([-dx,-dy,1].map(v=>byte((v/length*.5+.5)*255)),i);
    roughness.set([255,byte(255*(1-variance*(h*.5+.5))),255],i);
  }
  return {normal_texture:normal,roughness_texture:roughness};
}
export function createPBRDetails(THREE) {
  const cache=new Map(),scaled=new Map();let disposed=false,anisotropy=1;
  return {
    get(family,scale=1) {
      if(disposed)return {};
      if(!cache.has(family)) {
        const channels={},pixels=pbrDetailPixels(family);
        for(const [key,data] of Object.entries(pixels||{})) {
          // DataTexture is RGBA on WebGL2: explicit alpha avoids legacy RGB upload.
          const rgba=new Uint8Array(128*128*4);
          for(let i=0;i<128*128;i++){rgba.set(data.subarray(i*3,i*3+3),i*4);rgba[i*4+3]=255}
          const texture=new THREE.DataTexture(rgba,128,128,THREE.RGBAFormat);
          texture.flipY=true;texture.colorSpace=THREE.NoColorSpace;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
          texture.generateMipmaps=true;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.magFilter=THREE.LinearFilter;
          texture.repeat.setScalar(1/PBR_DETAIL_PROFILES[family][0]);texture.anisotropy=anisotropy;texture.needsUpdate=true;channels[key]=texture;
        }
        cache.set(family,channels);
      }
      if(scale===1)return cache.get(family);
      if(!Number.isFinite(scale)||scale<=0||scale>4096)return {};
      const key=family+'|'+scale;
      if(!scaled.has(key)){const channels={};for(const [name,base] of Object.entries(cache.get(family))){const texture=base.clone();texture.repeat.multiplyScalar(scale);channels[name]=texture}scaled.set(key,channels)}
      return scaled.get(key);
    },
    configure(value){anisotropy=value;for(const channels of [...cache.values(),...scaled.values()])for(const texture of Object.values(channels)){texture.anisotropy=value;texture.needsUpdate=true}},
    releaseGPU(){for(const channels of [...cache.values(),...scaled.values()])for(const texture of Object.values(channels)){texture.dispose();texture.needsUpdate=true}},
    dispose(){this.releaseGPU();disposed=true;cache.clear();scaled.clear()},
    get count(){return [...cache.values()].reduce((n,c)=>n+Object.keys(c).length,0)}
  };
}
export function applyMaterialPBR(THREE,material,mapped) {
  if(!mapped)return material;
  const channels=mapped.channels||{albedo_texture:mapped.texture};
  if(channels.albedo_texture){material.map=channels.albedo_texture;if(!mapped.albedoTint)material.color.setRGB(1,1,1)}
  if(material.isMeshStandardMaterial) {
    for(const [key,property] of [['normal_texture','normalMap'],['roughness_texture','roughnessMap'],['metalness_texture','metalnessMap'],['ao_texture','aoMap']])if(channels[key])material[property]=channels[key];
    if(material.normalMap)material.normalScale.setScalar(mapped.normalScale??1);
    if(material.aoMap)material.aoMapIntensity=mapped.aoStrength??1;
  }
  material.userData.albedoTint=!!mapped.albedoTint;
  material.needsUpdate=true;return material;
}

// Decorative instanced geometry provides a metric scale for its shared charts.
// Preserve any owner's shader callback; no extra sampler or dynamic loop.
export function installInstanceMaterialUV(material) {
  if(material.userData.instanceMaterialUV)return;
  material.userData.instanceMaterialUV=true;
  const previous=material.onBeforeCompile,previousKey=material.customProgramCacheKey.bind(material);
  material.onBeforeCompile=function(shader,renderer){
    previous.call(this,shader,renderer);
    shader.vertexShader='#ifdef USE_INSTANCING\nattribute vec2 materialUVScale;\n#endif\n'+shader.vertexShader;
    const lines=['#ifdef USE_INSTANCING'];
    for(const [define,varying] of [['USE_MAP','vMapUv'],['USE_NORMALMAP','vNormalMapUv'],['USE_ROUGHNESSMAP','vRoughnessMapUv'],['USE_METALNESSMAP','vMetalnessMapUv'],['USE_AOMAP','vAoMapUv']])lines.push('#ifdef '+define,varying+' *= materialUVScale;','#endif');
    lines.push('#endif');shader.vertexShader=shader.vertexShader.replace('#include <uv_vertex>','#include <uv_vertex>\n'+lines.join('\n'));
  };
  material.customProgramCacheKey=()=>previousKey()+'|instance-metric-uv-v1';material.needsUpdate=true;
}
