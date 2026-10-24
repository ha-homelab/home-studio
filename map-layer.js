// Optional geographic context. All tiles share the viewer's scene and renderer.
const homeMapMath = (() => {
  const radius=6378137, circumference=2*Math.PI*radius, maxLatitude=85.05112878;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  function validConfig(value){
    if(!value||typeof value.enabled!=='boolean')return null;
    for(const name of ['latitude','longitude','model_x','model_z','north_deg'])if(typeof value[name]!=='number'||!Number.isFinite(value[name]))return null;
    if(Math.abs(value.latitude)>85||Math.abs(value.longitude)>180||Math.abs(value.model_x)>10000||Math.abs(value.model_z)>10000||value.north_deg<0||value.north_deg>360)return null;
    return Object.fromEntries(['enabled','latitude','longitude','model_x','model_z','north_deg'].map(key=>[key,value[key]]));
  }
  function project(latitude,longitude){return [(longitude+180)/360, (1-Math.asinh(Math.tan(clamp(latitude,-maxLatitude,maxLatitude)*Math.PI/180))/Math.PI)/2];}
  function unproject(x,y){return {longitude:((x*360)%360+360)%360-180,latitude:Math.atan(Math.sinh(Math.PI*(1-2*clamp(y,0,1))))*180/Math.PI};}
  function transform(config){
    const [x,y]=project(config.latitude,config.longitude),scale=circumference*Math.cos(config.latitude*Math.PI/180),angle=config.north_deg*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
    return {scale,toWorld:(u,v)=>{const dx=(u-x)*scale,dz=(v-y)*scale;return [config.model_x+dx*c+dz*s,config.model_z-dx*s+dz*c];},
      toMap:(wx,wz)=>{const dx=wx-config.model_x,dz=wz-config.model_z;return [x+(dx*c-dz*s)/scale,y+(dx*s+dz*c)/scale];}};
  }
  function tiles(config,bounds,pixels){
    const t=transform(config),corners=bounds.map(p=>t.toMap(...p)),span=Math.max(...corners.map(p=>p[0]))-Math.min(...corners.map(p=>p[0]));
    let z=clamp(Math.floor(Math.log2(Math.max(1,pixels)/(256*Math.max(span,1e-12)))),3,19),result;
    do{
      const n=2**z,minX=Math.floor(Math.min(...corners.map(p=>p[0]))*n),maxX=Math.floor(Math.max(...corners.map(p=>p[0]))*n),
        minY=clamp(Math.floor(Math.min(...corners.map(p=>p[1]))*n),0,n-1),maxY=clamp(Math.floor(Math.max(...corners.map(p=>p[1]))*n),0,n-1);
      result=[];
      if((maxX-minX+1)*(maxY-minY+1)<=36)for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++)result.push({z,x:((x%n)+n)%n,y,worldX:x,key:`${z}/${((x%n)+n)%n}/${y}`});
    }while(!result.length&&--z>=0);
    const center=corners.reduce((a,p)=>[a[0]+p[0]/4,a[1]+p[1]/4],[0,0]);
    return result.sort((a,b)=>Math.hypot((a.worldX+.5)/2**a.z-center[0],(a.y+.5)/2**a.z-center[1])-Math.hypot((b.worldX+.5)/2**b.z-center[0],(b.y+.5)/2**b.z-center[1]));
  }
  return {validConfig,project,unproject,transform,tiles};
})();
function createHomeMapLayer(THREE,scene,options={}) {
  const group=new THREE.Group(),tileGroup=new THREE.Group(),footprint=new THREE.Group(),cache=new Map(),ray=new THREE.Raycaster(),plane=new THREE.Plane(new THREE.Vector3(0,1,0),-(options.elevation??-.08));
  group.name='home-geographic-map';group.visible=false;group.add(tileGroup,footprint);scene.add(group);
  const floor=options.elevation??-.08,outlineMaterial=new THREE.LineBasicMaterial({color:0x5ad9ff,depthTest:false,transparent:true,opacity:.95});
  for(const polygon of options.polygons||[]){
    if(polygon.length<3)continue;
    const geometry=new THREE.BufferGeometry().setFromPoints([...polygon,polygon[0]].map(p=>new THREE.Vector3(p[0],floor+.02,p[1])));
    const line=new THREE.Line(geometry,outlineMaterial);line.renderOrder=5;footprint.add(line);
  }
  const marker=new THREE.Mesh(new THREE.RingGeometry(.55,.85,24),new THREE.MeshBasicMaterial({color:0x5ad9ff,depthTest:false,side:THREE.DoubleSide}));
  const markerOutline=new THREE.Mesh(new THREE.RingGeometry(.48,1.08,24),new THREE.MeshBasicMaterial({color:0x102833,depthTest:false,side:THREE.DoubleSide}));
  marker.rotation.x=markerOutline.rotation.x=-Math.PI/2;marker.renderOrder=6;markerOutline.renderOrder=5;group.add(markerOutline,marker);
  let config=null,disposed=false,active=false,revision=0,desired=[],inflight=0,clock=0,lastStatus='',lastFrame=null;
  const textureLoader=options.loadTexture||((url)=>new Promise((resolve,reject)=>new THREE.TextureLoader().load(url,resolve,undefined,reject)));
  function status(){
    const ready=desired.filter(d=>cache.get(d.key)?.texture).length,failed=desired.some(d=>cache.get(d.key)?.failed);
    const message=failed?(ready?'Some map tiles are unavailable. Retry map to reload them.':'Map unavailable. Home controls are still available.'):inflight&&ready<desired.length?'Loading map…':'';
    if(message!==lastStatus){lastStatus=message;options.onStatus?.(message,failed);}
  }
  function remove(entry){entry.mesh?.geometry.dispose();entry.mesh?.material.dispose();if(entry.mesh)tileGroup.remove(entry.mesh);entry.texture?.dispose();cache.delete(entry.key);}
  function trim(){
    const wanted=new Set(desired.map(d=>d.key));
    for(const entry of [...cache.values()].filter(e=>!wanted.has(e.key)&&!e.loading).sort((a,b)=>a.used-b.used)){
      if(cache.size<=48)break;remove(entry);
    }
  }
  function place(entry,tile){
    if(entry.mesh&&entry.worldX===tile.worldX){entry.mesh.visible=true;entry.used=++clock;return;}
    entry.worldX=tile.worldX;
    const t=homeMapMath.transform(config),n=2**tile.z,points=[[tile.worldX/n,tile.y/n],[tile.worldX/n,(tile.y+1)/n],[(tile.worldX+1)/n,(tile.y+1)/n],[(tile.worldX+1)/n,tile.y/n]],vertices=[];
    for(const [u,v] of points){const [x,z]=t.toWorld(u,v);vertices.push(x,floor,z);}
    if(!entry.mesh){
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,1,0,0,1,0,1,1],2));geometry.setIndex([0,1,2,0,2,3]);
      const material=new THREE.MeshBasicMaterial({map:entry.texture,side:THREE.DoubleSide,depthWrite:true,toneMapped:false});
      entry.mesh=new THREE.Mesh(geometry,material);entry.mesh.frustumCulled=false;tileGroup.add(entry.mesh);
    }else{entry.mesh.geometry.getAttribute('position').set(vertices);entry.mesh.geometry.getAttribute('position').needsUpdate=true;}
    entry.mesh.visible=true;entry.used=++clock;
  }
  function pump(){
    if(disposed||!active||!config?.enabled)return;
    for(const tile of desired){
      if(inflight>=4)break;
      let entry=cache.get(tile.key);
      if(entry&&(entry.loading||entry.texture||entry.failed))continue;
      if(!entry){entry={key:tile.key,used:++clock};cache.set(tile.key,entry);}
      entry.loading=true;inflight++;
      const generation=revision;
      Promise.resolve().then(()=>options.requestTile({z:tile.z,x:tile.x,y:tile.y})).then(result=>{
        if(disposed||generation!==revision)return null;
        if(typeof result?.data_url!=='string'||!/^data:image\/(png|jpeg|webp);base64,/.test(result.data_url)||result.data_url.length>2e6)throw Error('Invalid map tile');
        return textureLoader(result.data_url);
      }).then(texture=>{
        if(!texture)return;
        if(disposed||generation!==revision){texture.dispose();return;}
        texture.colorSpace=THREE.SRGBColorSpace;texture.generateMipmaps=false;texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;
        entry.texture=texture;entry.failed=false;
      }).catch(()=>{if(!disposed&&generation===revision){entry.failed=true;}}).finally(()=>{
        entry.loading=false;inflight--;
        if(disposed)return;
        trim();pump();status();options.onChange?.();
      });
    }
    trim();status();
  }
  function pointAt(camera,x,y){ray.setFromCamera(new THREE.Vector2(x,y),camera);const hit=new THREE.Vector3();return ray.ray.intersectPlane(plane,hit)?hit:null;}
  function setConfig(value){
    config=homeMapMath.validConfig(value);desired=[];lastFrame=null;
    // Geographic tile pixels do not change when the model anchor rotates/moves.
    // Keep their requests and textures; only rebuild their world placement.
    if(config?.enabled){for(const entry of cache.values())entry.worldX=undefined;}
    else{revision++;for(const entry of [...cache.values()])remove(entry);}
    group.visible=active&&!!config?.enabled;
  }
  function render(camera,rect,{visible=true,coarse=false,editing=false}={}){
    active=visible;group.visible=active&&!!config?.enabled;if(!group.visible)return;
    footprint.visible=coarse||editing;marker.visible=markerOutline.visible=coarse;
    const bounds=[[-1,-1],[-1,1],[1,1],[1,-1]].map(p=>pointAt(camera,...p)).filter(Boolean).map(p=>[p.x,p.z]);
    if(bounds.length!==4)return;
    const span=Math.hypot(bounds[0][0]-bounds[3][0],bounds[0][1]-bounds[3][1]);
    marker.position.set(config.model_x,floor+.04,config.model_z);marker.scale.setScalar(Math.max(1,span/Math.max(rect.width,1)*7));markerOutline.position.copy(marker.position);markerOutline.scale.copy(marker.scale);
    const tiles=homeMapMath.tiles(config,bounds,rect.width),frame=tiles.map(t=>t.key+':'+t.worldX).join('|');
    desired=tiles;
    if(frame!==lastFrame){lastFrame=frame;for(const entry of cache.values())if(entry.mesh)entry.mesh.visible=false;}
    for(const tile of tiles){const entry=cache.get(tile.key);if(entry?.texture)place(entry,tile);}
    pump();
  }
  return {get object(){return group;},setConfig,render,pointAt,setActive(value){active=value;group.visible=value&&!!config?.enabled;},
    clearFailures(){for(const entry of [...cache.values()])if(entry.failed)remove(entry);pump();},
    get config(){return config;},get stats(){return {cached:cache.size,inflight,visible:desired.length,loaded:[...cache.values()].filter(e=>e.texture).length};},
    releaseGPU(){for(const entry of cache.values())if(entry.texture){entry.texture.dispose();entry.texture.needsUpdate=true;}},
    dispose(){disposed=true;revision++;for(const entry of [...cache.values()])remove(entry);footprint.children.forEach(line=>line.geometry.dispose());outlineMaterial.dispose();marker.geometry.dispose();marker.material.dispose();markerOutline.geometry.dispose();markerOutline.material.dispose();scene.remove(group);}};
}
