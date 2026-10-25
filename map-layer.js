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
  const metric=(v,limit=1000)=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=limit;
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const area=p=>p.reduce((sum,a,i)=>{const b=p[(i+1)%p.length];return sum+a[0]*b[1]-b[0]*a[1];},0);
  const onEdge=(p,a,b)=>Math.abs(cross(a,b,p))<1e-8&&p.every((v,i)=>v>=Math.min(a[i],b[i])-1e-8&&v<=Math.max(a[i],b[i])+1e-8);
  const intersects=(a,b,c,d)=>cross(a,b,c)*cross(a,b,d)<-1e-16&&cross(c,d,a)*cross(c,d,b)<-1e-16;
  function polygons(value){
    if(!Array.isArray(value)||!value.length||value.length>16||value.reduce((n,p)=>n+(Array.isArray(p)?p.length:513),0)>512)return null;
    for(const p of value){
      if(!Array.isArray(p)||p.length<3||p.length>256||p.some(v=>!Array.isArray(v)||v.length!==2||!v.every(n=>metric(n,10000)))||Math.abs(area(p))<1e-8)return null;
      for(let i=0;i<p.length;i++)for(let j=i+1;j<p.length;j++){
        if(p[i][0]===p[j][0]&&p[i][1]===p[j][1])return null;
        if(j===i+1||i===0&&j===p.length-1)continue;
        const a=p[i],b=p[(i+1)%p.length],c=p[j],d=p[(j+1)%p.length];
        if(intersects(a,b,c,d)||onEdge(a,c,d)||onEdge(b,c,d)||onEdge(c,a,b)||onEdge(d,a,b))return null;
      }
    }
    return value.map(p=>p.map(v=>v.slice()));
  }
  function exterior(value){
    const valid=polygons(value);if(!valid)return [];
    const points=valid.flat(),edges=new Map(),out=new Map();
    for(let p of valid){
      if(area(p)<0)p=p.slice().reverse();
      for(let i=0;i<p.length;i++){
        const a=p[i],b=p[(i+1)%p.length],cuts=points.filter(v=>onEdge(v,a,b));
        cuts.sort((v,w)=>(v[0]-w[0])*(b[0]-a[0])+(v[1]-w[1])*(b[1]-a[1]));
        for(let j=1;j<cuts.length;j++){
          const start=cuts[j-1].join(','),end=cuts[j].join(',');if(start===end)continue;
          const key=start+'|'+end,reverse=end+'|'+start;
          if(edges.has(key))return [];if(edges.has(reverse))edges.delete(reverse);else edges.set(key,[cuts[j-1],cuts[j]]);
        }
      }
    }
    const boundary=[...edges.values()];
    for(let i=0;i<boundary.length;i++){
      const [a,b]=boundary[i],key=a.join(',');if(out.has(key))return [];out.set(key,b);
      for(let j=i+1;j<boundary.length;j++)if(intersects(a,b,...boundary[j]))return [];
    }
    const result=[];
    while(out.size){
      const start=out.keys().next().value,p=[];let key=start;
      do{const b=out.get(key);if(!b)return [];p.push(key.split(',').map(Number));out.delete(key);key=b.join(',');}while(key!==start);
      if(area(p)>0)result.push(p);
    }
    // Disconnected rooms may be separated by walls, not separate buildings.
    return result.length===1?result:[];
  }
  function context(model,rooms=[]){
    const site=model.site_context||{},ground=metric(site.ground_elevation_m)?site.ground_elevation_m:metric(model.environment?.elevation)?model.environment.elevation:metric(model.elevation_m)?-model.elevation_m:0;
    let low=Math.min(0,ground);const lower=model.lower_floor_context;
    const include=y=>{if(metric(y))low=Math.min(low,y);};
    for(const mesh of model.meshes||[])if(mesh.kind==='floors')for(const p of mesh.vertices||[])include(p[1]);
    for(const values of [lower?.surfaces,lower?.lines])if(Array.isArray(values))for(let i=1;i<values.length;i+=3)include(values[i]);
    include(lower?.elevation_m);
    const roof=site.roof_outline,shape=metric(roof?.elevation_m)&&polygons(roof?.polygons_m);
    return {elevation:low-.08,polygons:shape||exterior(rooms),outlineElevation:shape?roof.elevation_m:low-.06};
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
  return {validConfig,project,unproject,transform,tiles,context};
})();
function createHomeMapLayer(THREE,scene,options={}) {
  const group=new THREE.Group(),tileGroup=new THREE.Group(),footprint=new THREE.Group(),cache=new Map(),ray=new THREE.Raycaster(),plane=new THREE.Plane(new THREE.Vector3(0,1,0),-(options.elevation??-.08));
  group.name='home-geographic-map';group.visible=false;group.add(tileGroup,footprint);scene.add(group);
  const floor=options.elevation??-.08,outlineMaterial=new THREE.LineBasicMaterial({color:0x5ad9ff,depthTest:true,depthWrite:false,transparent:true,opacity:.8});
  for(const polygon of options.polygons||[]){
    if(polygon.length<3)continue;
    const geometry=new THREE.BufferGeometry().setFromPoints([...polygon,polygon[0]].map(p=>new THREE.Vector3(p[0],options.outlineElevation??floor+.02,p[1])));
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
  function render(camera,rect,{visible=true,coarse=false,editing=false,transition=false}={}){
    active=visible;group.visible=active&&!!config?.enabled;if(!group.visible)return;
    footprint.visible=coarse||editing||transition;marker.visible=markerOutline.visible=coarse;
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
