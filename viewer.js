import * as THREE from 'data:text/javascript;base64,__THREE_B64__';
__LIGHT_STATE_JS__
__ROOM_LIGHTING_JS__
__RENDER_CAPACITY_JS__
__INTERACTION_RENDER_JS__
__VIEWER_I18N_JS__
const viewerI18n=createViewerI18n(__VIEWER_I18N_DATA__),vt=(key,params)=>viewerI18n.t(key,params);
viewerI18n.init();
const model=JSON.parse(document.getElementById('modelData').textContent),$=id=>document.getElementById(id);
// Display names can change without changing saved room IDs or device bindings.
const roomCode=id=>model.room_display_ids?.[id]||id;
const roomName=id=>model.room_display_names?.[id]||model.rooms.find(r=>r.id===id)?.name||id;
function viewerStateLabel(state){const labels={on:'On',off:'Off',open:'Open',closed:'Closed',opening:'Opening',closing:'Closing',unavailable:'Unavailable'};return Object.hasOwn(labels,state)?vt(labels[state]):state}
const embedded=window.__HOME_FLOORPLAN_EMBED__===true;let bridge=null,haStates={},haConnected=false,entityOptions='',entityCatalog=null;
const planBounds=model.bounds_m, planCenter=planBounds?[(planBounds.min_x+planBounds.max_x)/2,(planBounds.min_z+planBounds.max_z)/2]:model.editor_view?.center_xz||[0,0];
const planRadius=planBounds?Math.max(8,model.ceiling_height_m*2,Math.hypot(planBounds.max_x-planBounds.min_x,planBounds.max_z-planBounds.min_z)*1.6):model.editor_view?.radius||8;
if(model.site_features===false){
  document.querySelector('header p').textContent='Your measured home · editable placements';
  document.querySelector('.measure').textContent=`Units: metres · Ceiling ${model.ceiling_height_m.toFixed(2)} m`;
  document.querySelector('aside .note').textContent='Geometry follows your project. Verify measurements, openings and device bindings on site.';
  $('heightCaption').textContent=vt('Full-height walls and windows · ceiling {height} m.',{height:model.ceiling_height_m.toFixed(2)});
  for(const link of document.querySelectorAll('a.download'))if(link.getAttribute('href')?.endsWith('.usdz'))link.hidden=true;
    if(!Object.keys(model.room_activity||{}).length)$('homeToggleActivity').hidden=true;
}

if(!model.next_floor){$('otherFloor').hidden=true;$('homeOtherFloor').hidden=true;}
if(embedded){document.querySelector('aside').inert=true;$('storageNote').textContent='Shared placements are saved in Home Assistant. The panel header shows save errors. Export JSON before reloading if saving fails. Model downloads contain the last built geometry.'}
const KEY=(model.storage_key||model.id)+'-inventory-v1';let items=model.inventory||[],editing=null;
let editorStatus=null;
function setEditorStatus(text,params){editorStatus={text,params};$('status').textContent=vt(text,params)}
try{const saved=embedded?null:localStorage.getItem(KEY);if(saved)items=JSON.parse(saved)}catch(e){setEditorStatus('Browser storage unavailable. Export JSON to keep your work.')}
const interpolate=(v,a)=>{let pair=a.slice(0,2);for(let i=0;i<a.length-1;i++){pair=a.slice(i,i+2);if(v<=pair[1][0])break}return pair[0][1]+(v-pair[0][0])*(pair[1][1]-pair[0][1])/(pair[1][0]-pair[0][0])};
const xm=p=>interpolate(p,model.calibration.x_anchors),zm=p=>interpolate(p,model.calibration.z_anchors),xp=m=>interpolate(m,model.calibration.x_anchors.map(a=>[a[1],a[0]])),zp=m=>interpolate(m,model.calibration.z_anchors.map(a=>[a[1],a[0]]));
function inPoly(x,z,p){let c=false;for(let i=0,j=p.length-1;i<p.length;j=i++){if((p[i][1]>z)!=(p[j][1]>z)&&x<(p[j][0]-p[i][0])*(z-p[i][1])/(p[j][1]-p[i][1])+p[i][0])c=!c}return c}
function svgEl(name,attrs,text){const e=document.createElementNS('http://www.w3.org/2000/svg',name);Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,v));if(text)e.textContent=text;return e}
for(const r of model.rooms){const o=document.createElement('option');o.value=r.id;o.textContent=roomCode(r.id)+' · '+roomName(r.id);$('room').append(o);$('focusRoom').append(o.cloneNode(true));const g=svgEl('g',{'pointer-events':'none'});g.append(svgEl('rect',{x:r.label[0]-25,y:r.label[1]-22,width:50,height:31,rx:5,fill:'#244b4d'}),svgEl('text',{x:r.label[0],y:r.label[1],fill:'white','font-size':19,'font-family':'system-ui','text-anchor':'middle'},roomCode(r.id)));$('roomLabels').append(g)}
$('plan').addEventListener('click',e=>{const p=new DOMPoint(e.clientX,e.clientY).matrixTransform($('plan').getScreenCTM().inverse());$('x').value=xm(p.x).toFixed(3);$('z').value=zm(p.y).toFixed(3);const r=model.rooms.find(r=>inPoly(p.x,p.y,r.polygon));if(r)$('room').value=r.id;drawCursor();setEditorStatus('Position selected. Set the object name and dimensions.')});
function drawCursor(){$('cursorPin').replaceChildren();if($('x').value===''||$('z').value==='')return;$('cursorPin').append(svgEl('circle',{cx:xp(+$('x').value),cy:zp(+$('z').value),r:18,fill:'none',stroke:'#b06c2a','stroke-width':4,'pointer-events':'none'}))}
['x','z'].forEach(id=>$(id).addEventListener('input',drawCursor));
const presets={chandelier:[.6,.6,.4,2.3],lamp:[.3,.3,1.5,0],tv:[1.2,.07,.7,1],appliance:[.6,.6,.85,0],furniture:[1.5,.7,.8,0],switch:[.08,.035,.12,1.05],outlet:[.08,.035,.12,.25],sensor:[.08,.05,.08,2.1]};
$('kind').addEventListener('change',()=>{['w','d','h','y'].forEach((id,i)=>$(id).value=presets[$('kind').value][i])});
// Catalog fields are inert metadata. The compiler owns model/style membership.
function inventoryAppearance(item, type = item?.type) {
  if (!item || item.type !== type) return {};
  if (['style_id', 'color', 'pattern_id', 'pattern_color'].some(key => Object.hasOwn(item, key)) && !Object.hasOwn(item, 'model_id')) throw Error('A finish or color requires a furniture model.');
  const result = {};
  for (const key of ['model_id', 'style_id', 'pattern_id']) if (Object.hasOwn(item, key)) {
    if (typeof item[key] !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(item[key])) throw Error('Invalid furniture ' + key + '.');
    result[key] = item[key];
  }
  if (Object.hasOwn(item, 'pattern_color') && (!item.pattern_id || item.pattern_id === 'none')) throw Error('A pattern color requires a pattern.');
  for (const key of ['color', 'pattern_color']) if (Object.hasOwn(item, key)) {
    if (typeof item[key] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(item[key])) throw Error('Invalid furniture color.');
    result[key] = item[key];
  }
  return result;
}
function validateImportedAppearance(list) {
  const originals = new Map((model.inventory || []).map(item => [item.id, item]));
  for (const item of list) {
    if (!item.model_id) continue;
    const original = originals.get(item.id);
    if (!original || ['model_id', 'style_id', 'color', 'pattern_id', 'pattern_color'].some(key => (item[key] || '').toLowerCase() !== (original[key] || '').toLowerCase())) {
      throw Error('Change furniture designs and finishes in the planner, then rebuild and install the project. Inventory imports update placements only.');
    }
  }
  return list;
}
let appearanceRefreshNotice = '';
function reconcileStoredAppearance(list) {
  const originals = new Map((model.inventory || []).map(item => [item.id, item]));
  let changed = false;
  const restored = list.map(item => {
    if (!item.model_id) return item;
    const appearance = inventoryAppearance(originals.get(item.id), item.type);
    if (JSON.stringify(appearance) === JSON.stringify(inventoryAppearance(item))) return item;
    changed = true;
    const updated = { ...item };
    for (const key of ['model_id', 'style_id', 'color', 'pattern_id', 'pattern_color']) delete updated[key];
    return Object.assign(updated, appearance);
  });
  appearanceRefreshNotice = changed ? 'Furniture appearances refreshed from the rebuilt project. Saved placements and device bindings were kept.' : '';
  if (appearanceRefreshNotice) setEditorStatus(appearanceRefreshNotice);
  return restored;
}
function validateInventoryItems(list){if(!Array.isArray(list)||list.length>2000)throw Error('Inventory must contain an items array with at most 2,000 objects.');const ids=new Set();return list.map(it=>{if(!it||typeof it.id!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(it.id)||ids.has(it.id))throw Error('Every object needs a unique string ID.');ids.add(it.id);if(typeof it.name!=='string'||!it.name.trim()||!Object.hasOwn(presets,it.type)||!model.rooms.some(r=>r.id===it.room))throw Error('Object name, type or room is invalid.');for(const k of ['x','y','z'])if(!Number.isFinite(it.position_m?.[k]))throw Error('Coordinates must be finite numbers.');for(const k of ['width','depth','height'])if(!Number.isFinite(it.dimensions_m?.[k])||it.dimensions_m[k]<=0)throw Error('Dimensions must be positive finite numbers.');if(!Number.isFinite(it.rotation_deg))throw Error('Rotation must be a finite number.');inventoryAppearance(it);return it})}
try{items=reconcileStoredAppearance(validateInventoryItems(items))}catch(e){items=[];setEditorStatus('Stored inventory could not be read. Import a valid backup JSON.')}
const inventoryNodes=new Map(),objectsById=new Map();
let renderer,scene,camera,objectGroup,root,hemisphere,sun,ground,grid,homeView=null,radius=planRadius,azimuth=.57,polar=.48,target=new THREE.Vector3(planCenter[0],planBounds?model.ceiling_height_m/2:0,planCenter[1]),clipping=new THREE.Plane(new THREE.Vector3(0,-1,0),20),renderCount=0;
// Defer embedded drawing to the next frame.
let initialViewReady=!embedded,failed3D=false;
// Software WebGL runs fragment shaders on the CPU. Bound its canvas and shadows;
// controls remain sharp HTML and every fixture keeps its lighting and interaction.
let renderProfile={pixels:2000000,pointShadows:8,pointShadowSize:512,sunShadowSize:2048,diffuseLighting:false};
// Apple's legacy software rasterizer spends seconds interpreting PBR fragments.
// Diffuse materials keep room-constrained colored light, opacity and emissive
// surfaces, with matte highlights and unfiltered shadows on reduced diffuse paths.
// On the existing Apple software profile, wall fill is an unlit diagram tint.
// Geometry, transparency, cutaway and cast shadows remain unchanged.
function createSceneMaterial(options,kind){if(!renderProfile.diffuseLighting)return new THREE.MeshStandardMaterial(options);const {roughness,metalness,...shared}=options;if(kind==='walls'){const {emissive,emissiveIntensity,...unlit}=shared;return new THREE.MeshBasicMaterial(unlit)}return new THREE.MeshLambertMaterial(shared)}
// The software Editor is a layout diagram. Keep the original Home materials
// and lazily retain one unlit mate for each supported static floor/background.
function createEditorFloorMaterials(THREE, group, ground, profile) {
  const entries = [], meshes = new Set();
  let homeActive = null, disposed = false;
  function supported(material, initial = false) {
    if (!material?.isMeshLambertMaterial || material.transparent || material.opacity !== 1 ||
        material.vertexColors || material.wireframe || material.alphaTest || material.alphaHash ||
        ![THREE.NormalBlending,THREE.NoBlending].includes(material.blending) || !material.depthWrite || !material.depthTest ||
        !material.color || ![material.color.r,material.color.g,material.color.b].every(Number.isFinite) ||
        material.emissive && (material.emissive.r || material.emissive.g || material.emissive.b) ||
        Object.values(material).some(value => value?.isTexture) || Object.keys(material.userData || {}).length) return false;
    for (const key in material.defines || {}) return false;
    return !initial || (material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile &&
      material.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey &&
      material.onBeforeRender === THREE.Material.prototype.onBeforeRender);
  }
  function meshCallbacksSupported(mesh) {
    return mesh.onBeforeRender === THREE.Object3D.prototype.onBeforeRender &&
      mesh.onAfterRender === THREE.Object3D.prototype.onAfterRender &&
      mesh.onBeforeShadow === THREE.Object3D.prototype.onBeforeShadow &&
      mesh.onAfterShadow === THREE.Object3D.prototype.onAfterShadow;
  }
  function callbacks(material) {return [material.onBeforeCompile,material.customProgramCacheKey,material.onBeforeRender]}
  function stillOwned(entry) {
    entry.owned &&= meshCallbacksSupported(entry.mesh) && callbacks(entry.home).every((value,index) => value === entry.callbacks[index]);
    return entry.owned;
  }
  function register(mesh) {
    if (!profile.diffuseLighting || !mesh?.isMesh || mesh.isSkinnedMesh || mesh.isInstancedMesh || mesh.isBatchedMesh ||
        meshes.has(mesh) || !meshCallbacksSupported(mesh) || !supported(mesh.material, true)) return;
    meshes.add(mesh); entries.push({mesh,home:mesh.material,flat:null,owned:true,callbacks:callbacks(mesh.material)});
  }
  group?.traverse(mesh => {if (mesh.userData.category === 'floors') register(mesh)});
  register(ground);
  function releaseGPU() {
    const materials = new Set();
    for (const entry of entries) {materials.add(entry.home); if (entry.flat) materials.add(entry.flat)}
    for (const material of materials) material.dispose();
  }
  return {
    setHomeActive(value) {
      if (disposed || homeActive === value) return;
      homeActive = value;
      for (const entry of entries) {
        const {mesh,home} = entry;
        if (mesh.material !== home && (!entry.flat || mesh.material !== entry.flat)) continue;
        if (value || !stillOwned(entry) || !supported(home)) {mesh.material = home; continue}
        entry.flat ??= new THREE.MeshBasicMaterial();
        THREE.Material.prototype.copy.call(entry.flat,home);
        entry.flat.color.copy(home.color);entry.flat.fog=home.fog;
        // Preserve the actual clipping plane identities used by the viewer.
        entry.flat.clippingPlanes=home.clippingPlanes;
        entry.flat.needsUpdate=true;mesh.material=entry.flat;
      }
    },
    attachLighting(attach) {
      for (const entry of entries) stillOwned(entry);
      attach();
      for (const entry of entries) if (entry.owned && entry.mesh.material === entry.home) entry.callbacks=callbacks(entry.home);
    },
    releaseGPU,
    dispose() {
      if (disposed) return;
      for (const entry of entries) if (entry.flat && entry.mesh.material === entry.flat) entry.mesh.material=entry.home;
      releaseGPU();entries.length=0;meshes.clear();disposed=true;
    }
  };
}
// Static opaque floors can share the clipped frame shader without changing
// their visible half-space. The far plane is outside every original vertex;
// it is independent of the user cutaway and never clips shadow passes.
function applyStaticMeshClipping(source,material){if(['walls','frames','doors','windows'].includes(source.kind)){material.clippingPlanes=[clipping];material.clipShadows=false;return}if(!renderProfile.diffuseLighting||source.kind!=='floors'||material.transparent||material.side!==THREE.DoubleSide||!source.vertices?.length)return;let extent=1;for(const vertex of source.vertices){if(!Array.isArray(vertex)||vertex.length!==3||!vertex.every(value=>Number.isFinite(value)&&Number.isFinite(Math.fround(value))))return;for(const value of vertex)extent=Math.max(extent,Math.abs(value))}const far=extent*4;if(!Number.isFinite(Math.fround(far)))return;material.clippingPlanes=[new THREE.Plane(new THREE.Vector3(0,-1,0),far)];material.clipShadows=false}
function selectRenderProfile(gl){const capacity=getRenderCapacity(gl);const profile=capacity.reduced?{pixels:capacity.diffuseLighting?62500:250000,pointShadows:2,pointShadowSize:128,sunShadowSize:512,diffuseLighting:capacity.diffuseLighting}:{pixels:2000000,pointShadows:8,pointShadowSize:512,sunShadowSize:2048,diffuseLighting:false};if(capacity.rasterProbe)profile.rasterProbe=capacity.rasterProbe;return profile}
let renderRequest=0,renderDelay=0,renderSuspended=false,renderLost=false;
let interactionRenderer=null,interactionPointer=null,coalesceMotion=false;
let cancelEditorGesture=()=>{};
let editorFloorMaterials=null;
function cancelRender(){if(renderRequest)cancelAnimationFrame(renderRequest);if(renderDelay)clearTimeout(renderDelay);renderRequest=renderDelay=0}
// Paint the first moved-pointer frame immediately. Subsequent software frames
// share a fixed deadline; further input never postpones it. Apple diffuse
// motion uses its last successful draw time, bounded to 64–250 ms, per gesture.
// Other software keeps 64 ms. Non-motion updates
// and pointer release bypass this delay and still use the ordinary next frame.
function requestRender(motion=false){if(renderSuspended||renderLost||document.hidden)return;if(!motion&&renderDelay){clearTimeout(renderDelay);renderDelay=0}if(renderRequest||renderDelay)return;if(motion&&coalesceMotion&&interactionPointer?.moved&&interactionPointer.painted){renderDelay=setTimeout(()=>{renderDelay=0;requestRender()},renderProfile.diffuseLighting?interactionPointer.frameDelay??64:64);return}renderRequest=requestAnimationFrame(()=>{renderRequest=0;try{window.renderModel?.()}catch(error){report3DError(error)}})}
function renderPixelRatio(width,height){return Math.min(Number.isFinite(devicePixelRatio)&&devicePixelRatio>0?devicePixelRatio:1,2,Math.sqrt(renderProfile.pixels/Math.max(1,width*height)))}
function invalidateShadows(){scene?.traverse(o=>{if(o.shadow){o.shadow.autoUpdate=false;o.shadow.needsUpdate=true}})}
// Accept only complete rectangular prisms, including the compiler's rotated walls.
// Unrecognized geometry keeps its original shape; an AABB would fill real openings.
function wallPrism(mesh,preferredAxis){
  if(mesh.kind!=='walls'||mesh.indices.length!==36||mesh.vertices.length>36)return null;
  const epsilon=1e-6,unique=[];
  for(const p of mesh.vertices){
    if(p.length!==3||!p.every(Number.isFinite))return null;
    if(!unique.some(q=>p.every((v,i)=>Math.abs(v-q[i])<epsilon)))unique.push(p);
  }
  if(unique.length!==8)return null;
  const bottom=Math.min(...unique.map(p=>p[1])),top=Math.max(...unique.map(p=>p[1]));
  if(top-bottom<epsilon||unique.some(p=>Math.min(Math.abs(p[1]-bottom),Math.abs(p[1]-top))>epsilon))return null;
  const footprint=unique.filter(p=>Math.abs(p[1]-bottom)<epsilon);
  if(footprint.length!==4)return null;
  const center=[0,1,2].map(i=>unique.reduce((sum,p)=>sum+p[i],0)/8);
  footprint.sort((a,b)=>Math.atan2(a[2]-center[2],a[0]-center[0])-Math.atan2(b[2]-center[2],b[0]-center[0]));
  let axis=preferredAxis;
  if(!axis){
    const edges=footprint.map((p,i)=>{const q=footprint[(i+1)%4];return[q[0]-p[0],q[2]-p[2]]});
    axis=edges.reduce((a,b)=>Math.hypot(...a)>Math.hypot(...b)?a:b);
    const length=Math.hypot(...axis);if(length<epsilon)return null;
    axis=axis.map(v=>v/length);
  }
  const local=mesh.vertices.map(p=>[(p[0]-center[0])*axis[0]+(p[2]-center[2])*axis[1],p[1]-center[1],-(p[0]-center[0])*axis[1]+(p[2]-center[2])*axis[0]]);
  const half=[0,1,2].map(i=>Math.max(...local.map(p=>Math.abs(p[i]))));
  if(half.some(v=>v<epsilon)||local.some(p=>p.some((v,i)=>Math.abs(Math.abs(v)-half[i])>epsilon)))return null;
  // Six complete faces, each split along a diagonal. Reject missing/duplicate faces.
  const faces=new Map();
  for(let i=0;i<36;i+=3){
    const ids=mesh.indices.slice(i,i+3);
    if(ids.some(j=>!Number.isInteger(j)||j<0||j>=local.length))return null;
    const tri=ids.map(j=>local[j]);
    const plane=[0,1,2].find(j=>tri.every(p=>Math.abs(p[j]-tri[0][j])<epsilon));
    if(plane===undefined)return null;
    const corners=tri.map(p=>p.map(v=>v>0?1:0).join(''));
    if(new Set(corners).size!==3)return null;
    const key=plane+':'+(tri[0][plane]>0?1:0),face=faces.get(key)||[];
    face.push(corners);faces.set(key,face);
  }
  if(faces.size!==6)return null;
  for(const face of faces.values()){
    if(face.length!==2||new Set(face.flat()).size!==4)return null;
    const shared=face[0].filter(p=>face[1].includes(p));
    if(shared.length!==2||[0,1,2].filter(i=>shared[0][i]!==shared[1][i]).length!==2)return null;
  }
  return {center,axis,length:half[0]*2,depth:half[2]*2,bottom,top};
}
// Opening endpoints retain the authored wall direction even when a full-height
// passage leaves only piers narrower than the wall thickness.
function wallCenterlineAxes(meshes,openings){
  const longest=new Map(),axes=new Map();
  for(const mesh of meshes){
    const shape=mesh.wall_id&&wallPrism(mesh);
    if(shape&&(!longest.has(mesh.wall_id)||shape.length>longest.get(mesh.wall_id).length))longest.set(mesh.wall_id,shape);
  }
  for(const [id,shape] of longest)axes.set(id,shape.axis);
  for(const opening of openings||[]){
    const a=opening.start_m,b=opening.end_m;
    if(!opening.wall_id||!a||!b||a.length!==2||b.length!==2||![...a,...b].every(Number.isFinite))continue;
    const dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz);
    if(length>1e-6)axes.set(opening.wall_id,[dx/length,dz/length]);
  }
  return axes;
}
// Round across thickness, while keeping longitudinal ends and elevations exact.
// The original solid is contained in this profile: joins cannot open up, and
// jambs/lintels never expand into the width or height of a door or window.
function roundedWallData(shape,limit){
  const {center,axis,length,depth,bottom}=shape,top=Math.min(shape.top,limit);
  const data={vertices:[],normals:[],indices:[]};
  if(top<=bottom+1e-6)return data;
  const swell=Math.min(.075,depth*.32),rise=Math.min(.9,(top-bottom)*.4),profile=[];
  for(const [side,upper,start] of [[1,1,0],[-1,1,Math.PI/2],[-1,0,Math.PI],[1,0,Math.PI*1.5]]){
    for(let step=0;step<=3;step++){
      const angle=start+step*Math.PI/6,c=Math.cos(angle),s=Math.sin(angle),normalLength=Math.hypot(c/swell,s/rise);
      profile.push({z:side*depth/2+swell*c,y:(upper?top-rise:bottom+rise)+rise*s,nz:c/swell/normalLength,ny:s/rise/normalLength});
    }
  }
  const vertex=(u,p,normal)=>{
    data.vertices.push([center[0]+axis[0]*u-axis[1]*p.z,p.y,center[2]+axis[1]*u+axis[0]*p.z]);
    data.normals.push(normal);
    return data.vertices.length-1;
  };
  const count=profile.length;
  for(const u of [-length/2,length/2])for(const p of profile)vertex(u,p,[-axis[1]*p.nz,p.ny,axis[0]*p.nz]);
  for(let i=0;i<count;i++){const j=(i+1)%count;data.indices.push(i,count+i,count+j,i,count+j,j)}
  for(const sign of [-1,1]){
    const normal=[sign*axis[0],0,sign*axis[1]],cap=vertex(sign*length/2,{z:0,y:(bottom+top)/2},normal),offset=data.vertices.length;
    for(const p of profile)vertex(sign*length/2,p,normal);
    for(let i=0;i<count;i++){const a=offset+i,b=offset+(i+1)%count;data.indices.push(cap,sign<0?a:b,sign<0?b:a)}
  }
  return data;
}
function wallDisplayGeometry(source,shape,limit){
  const display=roundedWallData(shape,limit),offset=source.vertices.length,geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([...source.vertices,...display.vertices].flat(),3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute([...source.normals,...display.normals].flat(),3));
  geometry.setIndex([...source.indices,...display.indices.map(i=>i+offset)]);
  geometry.userData.wallShadowCount=source.indices.length;
  geometry.userData.wallDisplayCount=display.indices.length;
  geometry.setDrawRange(source.indices.length,display.indices.length);
  return geometry;
}
const roundedWalls=[];
// Detach the old renderer's GPU disposal listeners before context restoration.
// Hidden scene objects and inactive wall variants still retain CPU geometry.
function releaseViewerGeometryGPU(){const geometries=new Set();scene?.traverse(object=>{if(object.geometry)geometries.add(object.geometry)});for(const wall of roundedWalls)for(const geometry of wall.cache.values())geometries.add(geometry);for(const geometry of geometries)geometry.dispose()}
// Shadow targets and loaded TV maps have the same per-context disposal ownership.
function releaseViewerTextureGPU(){const targets=new Set(),textures=new Set();scene?.traverse(object=>{for(const target of [object.shadow?.map,object.shadow?.mapPass])if(target)targets.add(target)});for(const target of targets)target.dispose();for(const id of Object.keys(tvEntities)){const map=objectsById.get(id)?.userData.screen?.material.map;if(map)textures.add(map)}for(const texture of textures){texture.dispose();texture.needsUpdate=true}}
function updateRoundedWallGeometry(limit){
  for(const wall of roundedWalls){
    const key=Math.min(wall.shape.top,limit);
    let geometry=wall.cache.get(key);
    if(!geometry){
      geometry=wallDisplayGeometry(wall.source,wall.shape,limit);
      // Full height, editor cutaway and Home are the only three active variants.
      // Keep the same bound if a future view introduces another clipping height.
      if(wall.cache.size===3){const oldest=wall.cache.keys().next().value;wall.cache.get(oldest).dispose();wall.cache.delete(oldest)}
      wall.cache.set(key,geometry);
    }
    wall.mesh.geometry=geometry;
  }
}
function beginWallShadow(_renderer,_object,_camera,_shadowCamera,geometry){geometry.setDrawRange(0,geometry.userData.wallShadowCount)}
function endWallShadow(_renderer,_object,_camera,_shadowCamera,geometry){geometry.setDrawRange(geometry.userData.wallShadowCount,geometry.userData.wallDisplayCount)}
// Intersect wall sides with their visible top or base, including the cutaway.
// Ignore coplanar face triangles so their triangulation never becomes a diagonal.
function wallBoundarySegments(meshes,limit,atBase=false){
  const segments=new Map(),epsilon=1e-6;
  const key=p=>p.map(v=>Math.round(v/epsilon)).join(',');
  for(const mesh of meshes){
    if(mesh.kind!=='walls')continue;
    let bottom=Infinity,top=-Infinity;
    for(const p of mesh.vertices){bottom=Math.min(bottom,p[1]);top=Math.max(top,p[1]);}
    const visibleTop=Math.min(top,limit);
    if(visibleTop<=bottom+epsilon)continue;
    const height=atBase?bottom:visibleTop;
    for(let i=0;i<mesh.indices.length;i+=3){
      const triangle=mesh.indices.slice(i,i+3).map(index=>mesh.vertices[index]);
      if(triangle.every(p=>Math.abs(p[1]-height)<epsilon))continue;
      const points=new Map();
      for(let j=0;j<3;j++){
        const a=triangle[j],b=triangle[(j+1)%3],da=a[1]-height,db=b[1]-height;
        if(Math.abs(da)<epsilon){const p=[a[0],height,a[2]];points.set(key(p),p);}
        if((da < -epsilon && db > epsilon)||(da > epsilon && db < -epsilon)){
          const t=da/(da-db),p=[a[0]+t*(b[0]-a[0]),height,a[2]+t*(b[2]-a[2])];points.set(key(p),p);
        }
      }
      if(points.size!==2)continue;
      const pair=[...points.values()];
      segments.set(pair.map(key).sort().join('|'),pair);
    }
  }
  return [...segments.values()];
}
let wallOutlines,wallOutlineHeight;
// The four contour materials have fixed roles. Keep their programs when only
// cutaway geometry changes; fresh objects retain the original transparent order.
const wallOutlineMaterials=[];
function releaseWallOutlineMaterials(dispose=false){for(const material of wallOutlineMaterials)material?.dispose();if(dispose)wallOutlineMaterials.length=0}
let lowerFloorContext;
function buildLowerFloorContext(){
  const data=model.lower_floor_context;
  if(!data?.lines?.length)return;
  const group=new THREE.Group();group.name='Lower floor context';group.visible=false;
  const geometry=values=>new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(values,3));
  group.add(new THREE.Mesh(geometry(data.surfaces),new THREE.MeshBasicMaterial({color:0x729aa7,transparent:true,opacity:.055,depthWrite:false,toneMapped:false,side:THREE.DoubleSide,forceSinglePass:true})));
  group.add(new THREE.LineSegments(geometry(data.lines),new THREE.LineBasicMaterial({color:0x729fb3,transparent:true,opacity:.3,depthWrite:false,toneMapped:false})));
  // Separate from interactive architecture: no lights, hit targets or camera fit.
  group.renderOrder=-2;scene.add(group);lowerFloorContext=group;
}
function updateWallOutlines(){
  if(!root||wallOutlineHeight===clipping.constant)return;
  wallOutlineHeight=clipping.constant;
  updateRoundedWallGeometry(wallOutlineHeight);
  if(wallOutlines){wallOutlines.traverse(o=>{o.geometry?.dispose()});root.remove(wallOutlines);}
  wallOutlines=new THREE.Group();wallOutlines.name='Visible wall boundaries';
  // Draw after the translucent wall fill, while opaque furniture still occludes.
  wallOutlines.renderOrder=1;
  const geometry=positions=>new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  for(const [atBase,color,glow] of [[true,0x387bff,.22],[false,0x81fff0,.42]]){
    const slot=atBase?0:2,edges=[],halo=[];
    for(const [a,b] of wallBoundarySegments(model.meshes,wallOutlineHeight,atBase)){
      const dx=b[0]-a[0],dz=b[2]-a[2],length=Math.hypot(dx,dz);
      if(length<1e-6)continue;
      const nx=-dz/length*.03,nz=dx/length*.03,y=a[1]+.008;
      edges.push(a[0],y,a[2],b[0],y,b[2]);
      const p=[a[0]+nx,y,a[2]+nz],q=[b[0]+nx,y,b[2]+nz],r=[b[0]-nx,y,b[2]-nz],s=[a[0]-nx,y,a[2]-nz];
      halo.push(...p,...q,...r,...p,...r,...s);
    }
    wallOutlines.add(new THREE.Mesh(geometry(halo),wallOutlineMaterials[slot]??=new THREE.MeshBasicMaterial({color,transparent:true,opacity:glow,depthWrite:false,toneMapped:false,side:THREE.DoubleSide,forceSinglePass:true})));
    const line=new THREE.LineSegments(geometry(edges),wallOutlineMaterials[slot+1]??=new THREE.LineBasicMaterial({color,transparent:true,opacity:1,depthWrite:false,toneMapped:false}));
    line.renderOrder=1;wallOutlines.add(line);
  }
  root.add(wallOutlines);
}
const wallSheenMotion=createWallSheenMotion();
function drawScene(camera){if(renderSuspended||renderLost||document.hidden)return;wallSheenMotion.beforeRender();try{const pointer=interactionPointer,started=renderProfile.diffuseLighting&&pointer?.moved?performance.now():null;if(renderProfile.diffuseLighting){interactionRenderer??=createInteractionRenderer(THREE,renderer,31250);interactionRenderer.draw(scene,camera,pointer?.moved===true)}else renderer.render(scene,camera);if(pointer?.moved&&interactionPointer===pointer){pointer.painted=true;if(started!==null){const elapsed=performance.now()-started;pointer.frameDelay=Number.isFinite(elapsed)?Math.min(250,Math.max(64,elapsed)):64}}}finally{wallSheenMotion.afterRender()}}
// Keep the recovery controls outside both view modes. A failed renderer stays
// paused until reload; editing or saving the 2D plan must not retry that draw.
function report3DError(e){failed3D=true;initialViewReady=false;cancelRender();$('loadError').style.display='block';$('mode3d').disabled=true;$('openHome').disabled=true;console.error(e)}
$('recoverPlan').onclick=()=>{homeView?.setActive(false);showMode(true);$('loadError').style.display='none';setEditorStatus('3D view could not start. Plan editing and JSON export are still available.');$('modePlan').focus();};
try{
scene=new THREE.Scene();scene.background=new THREE.Color('#e7e8df');camera=new THREE.PerspectiveCamera(42,1,.1,Math.max(150,planRadius*5));
renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.localClippingEnabled=true;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.95;$('view3d').prepend(renderer.domElement);
renderProfile=selectRenderProfile(renderer.getContext());if(renderProfile.diffuseLighting)renderer.shadowMap.type=THREE.BasicShadowMap;
// Capacity is cached for this context. Motion scheduling is independent of
// material quality: software PBR still draws directly at its full resolution.
coalesceMotion=getRenderCapacity(renderer.getContext()).reduced;
hemisphere=new THREE.HemisphereLight(0xffffff,0xa6aaa1,1.8);scene.add(hemisphere);sun=new THREE.DirectionalLight(0xfff9ee,2.3);sun.position.set(-7,22,12);sun.castShadow=true;sun.shadow.mapSize.set(renderProfile.sunShadowSize,renderProfile.sunShadowSize);Object.assign(sun.shadow.camera,{left:-16,right:16,top:22,bottom:-22,near:1,far:65});sun.shadow.normalBias=.035;sun.target.position.set(planCenter[0],planBounds?model.ceiling_height_m/2:0,planCenter[1]);scene.add(sun,sun.target);
if(planBounds){const scale=Math.max(1,planRadius/32);sun.position.copy(sun.target.position).add(new THREE.Vector3(-7,22,12).multiplyScalar(scale));Object.assign(sun.shadow.camera,{left:-planRadius,right:planRadius,top:planRadius,bottom:-planRadius,far:Math.max(65,planRadius*4)});sun.shadow.camera.updateProjectionMatrix();}
root=new THREE.Group();objectGroup=new THREE.Group();scene.add(root,objectGroup);buildLowerFloorContext();
// A wall_id shares one centerline, even when a short pier is narrower than its depth.
const wallAxes=wallCenterlineAxes(model.meshes,model.openings);
for(const m of model.meshes){
const candidate=wallPrism(m,wallAxes.get(m.wall_id));
// Legacy square blocks have no reliable longitudinal direction; keep them intact.
const shape=candidate&&(m.wall_id||candidate.length>=candidate.depth*1.25)?candidate:null;
const geometry=shape?wallDisplayGeometry(m,shape,clipping.constant):new THREE.BufferGeometry();
if(!shape){geometry.setAttribute('position',new THREE.Float32BufferAttribute(m.vertices.flat(),3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(m.normals.flat(),3));geometry.setIndex(m.indices)}
const col=model.materials[m.material];const mat=createSceneMaterial({color:m.kind==='walls'?0xb2d8d2:m.kind==='frames'?0x9abfcb:new THREE.Color(...col.slice(0,3)),roughness:.8,emissive:m.kind==='walls'?0x315d59:m.kind==='frames'?0x18333d:m.kind==='vehicles'?0x10181b:0,metalness:m.material==='steel'||m.kind==='vehicles'?.35:0,transparent:m.kind==='walls'||col[3]<1,opacity:m.kind==='walls'?.16:col[3],depthWrite:m.kind!=='walls',forceSinglePass:m.kind==='walls',side:THREE.DoubleSide},m.kind);if(m.kind==='walls'&&!mat.isMeshBasicMaterial)mat.onBeforeCompile=applyWallSheen;applyStaticMeshClipping(m,mat);const mesh=new THREE.Mesh(geometry,mat);mesh.name=m.name;mesh.userData.category=m.kind;mesh.castShadow=col[3]===1;mesh.receiveShadow=true;
if(shape){
  // The same draw uses the exact original 12 triangles for all shadow passes.
  // Three reads drawRange after onBeforeShadow; no buffers or materials change.
  mesh.onBeforeShadow=beginWallShadow;mesh.onAfterShadow=endWallShadow;
  roundedWalls.push({mesh,source:m,shape,cache:new Map([[Math.min(shape.top,clipping.constant),geometry]])});
}
const glassPasses=createStaticGlassPasses(THREE,mesh,renderProfile.diffuseLighting);root.add(mesh);if(glassPasses)root.add(glassPasses.front)}
// Apply the same backdrop policy before a standalone Editor's first render.
ground=new THREE.Mesh(new THREE.PlaneGeometry(Math.max(60,planRadius*2),Math.max(65,planRadius*2)),createSceneMaterial({color:'#dfe3d8',roughness:1}));ground.rotation.x=-Math.PI/2;ground.position.set(planCenter[0],-1.97,planCenter[1]);ground.receiveShadow=true;ground.visible=!renderProfile.diffuseLighting;scene.add(ground);grid=new THREE.GridHelper(44,44,0xc0cabe,0xd0d7cb);grid.position.set(planCenter[0],-1.96,planCenter[1]);scene.add(grid);
editorFloorMaterials=createEditorFloorMaterials(THREE,root,ground,renderProfile);editorFloorMaterials.setHomeActive(embedded);
renderer.domElement.addEventListener('webglcontextlost',event=>{event.preventDefault();renderLost=true;cancelRender();releaseViewerGeometryGPU();releaseViewerTextureGPU();releaseWallOutlineMaterials();editorFloorMaterials?.releaseGPU();interactionPointer=null;interactionRenderer?.dispose();interactionRenderer=null;releaseStaticGlassPasses();homeView?.releaseGPU?.();});
renderer.domElement.addEventListener('webglcontextrestored',()=>{renderLost=false;invalidateShadows();const before=renderCount;window.resizeModel?.();if(renderCount===before)requestRender()});
function updateEditorCamera(){camera.position.set(target.x+radius*Math.sin(polar)*Math.sin(azimuth),target.y+radius*Math.cos(polar),target.z+radius*Math.sin(polar)*Math.cos(azimuth));camera.lookAt(target)}
function render(){if(!initialViewReady||renderSuspended||renderLost||document.hidden)return;const before=renderCount;updateWallOutlines();if(homeView?.active)homeView.render();else{updateEditorCamera();drawScene(camera);renderCount++}if(renderCount>before)cancelRender()}window.renderModel=render;window.requestModelRender=requestRender;
let viewSize='';const resize=()=>{if(!initialViewReady||renderSuspended||renderLost||document.hidden)return;if(renderDelay)requestRender();const b=$(homeView?.active?'homeStage':'view3d').getBoundingClientRect(),ratio=renderPixelRatio(b.width,b.height),size=[homeView?.active,b.width,b.height,ratio].join();if(b.width&&b.height&&size!==viewSize){viewSize=size;renderer.setDrawingBufferSize(b.width,b.height,ratio);camera.aspect=b.width/b.height;camera.updateProjectionMatrix();render()}};window.resizeModel=resize;const observer=new ResizeObserver(resize);observer.observe($('view3d'));observer.observe($('homeStage'));
document.addEventListener('visibilitychange',()=>{if(document.hidden){interactionPointer=null;cancelRender()}else{const before=renderCount;resize();if(renderCount===before)requestRender()}});
window.addEventListener('pagehide',event=>{renderSuspended=true;cancelRender();interactionPointer=null;if(!event.persisted){observer.disconnect();interactionRenderer?.dispose();interactionRenderer=null;homeView?.dispose?.();disposeStaticGlassPasses();releaseWallOutlineMaterials(true);editorFloorMaterials?.dispose();renderer.dispose();renderer.forceContextLoss();}});
// A resize can already paint the resumed state. Initial pageshow also needs
// no extra frame after boot painted; leave any pending live-state request intact.
window.addEventListener('pageshow',event=>{const resumed=renderSuspended||event.persisted,before=renderCount;renderSuspended=false;resize();if(renderCount===before&&(resumed||renderCount===0))requestRender()});
if(coalesceMotion){
renderer.domElement.addEventListener('pointerdown',event=>{if(!renderLost&&!renderSuspended&&[0,2].includes(event.button)&&!interactionPointer)interactionPointer={id:event.pointerId,x:event.clientX,y:event.clientY,moved:false}});
renderer.domElement.addEventListener('pointermove',event=>{if(interactionPointer?.id===event.pointerId&&Math.hypot(event.clientX-interactionPointer.x,event.clientY-interactionPointer.y)>6)interactionPointer.moved=true});
for(const type of ['pointerup','pointercancel','lostpointercapture'])renderer.domElement.addEventListener(type,event=>{if(interactionPointer?.id!==event.pointerId)return;const redraw=interactionPointer.moved;interactionPointer=null;if(redraw)requestRender()});
}
let drag=null;
cancelEditorGesture=()=>{const previous=drag;drag=null;if(previous&&renderer.domElement.hasPointerCapture(previous.id))renderer.domElement.releasePointerCapture(previous.id);};
renderer.domElement.addEventListener('contextmenu',e=>e.preventDefault());
renderer.domElement.addEventListener('pointerdown',e=>{if(homeView?.active||drag||e.isPrimary===false||renderLost||renderSuspended||document.hidden)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,button:e.button};renderer.domElement.setPointerCapture(e.pointerId)});
renderer.domElement.addEventListener('pointermove',e=>{if(homeView?.active||!drag||drag.id!==e.pointerId)return;if(e.buttons===0){cancelEditorGesture();return;}const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(drag.button===2||e.shiftKey){const scale=radius*.0018;target.x-=dx*scale*Math.cos(azimuth);target.z+=dx*scale*Math.sin(azimuth);target.x-=dy*scale*Math.sin(azimuth);target.z-=dy*scale*Math.cos(azimuth)}else{azimuth-=dx*.006;polar=Math.max(.02,Math.min(1.46,polar+dy*.006))}drag.x=e.clientX;drag.y=e.clientY;requestRender(true)});
for(const type of ['pointerup','pointercancel','lostpointercapture'])renderer.domElement.addEventListener(type,e=>{if(drag?.id===e.pointerId)cancelEditorGesture();});
renderer.domElement.addEventListener('webglcontextlost',()=>cancelEditorGesture());
document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelEditorGesture();});
window.addEventListener('pagehide',()=>cancelEditorGesture());
renderer.domElement.addEventListener('wheel',e=>{if(homeView?.active)return;e.preventDefault();radius=Math.max(3,Math.min(Math.max(65,planRadius*2),radius*Math.exp(e.deltaY*.001)));requestRender()},{passive:false});
$('resetView').onclick=()=>{$('focusRoom').value='';target.set(planCenter[0],planBounds?model.ceiling_height_m/2:0,planCenter[1]);radius=planRadius;azimuth=.57;polar=.48;render()};$('topView').onclick=()=>{if($('focusRoom').value)focusRoom($('focusRoom').value);else{target.set(planCenter[0],planBounds?model.ceiling_height_m/2:0,planCenter[1]);radius=planRadius*.91}polar=.001;azimuth=0;render()};$('zoomIn').onclick=()=>{radius=Math.max(3,radius/1.15);render()};$('zoomOut').onclick=()=>{radius=Math.min(Math.max(65,planRadius*2),radius*1.15);render()};
$('cutaway').onchange=()=>{const cutaway=$('cutaway').checked;clipping.constant=cutaway?1.15:20;updateHeightCaption();render()};for(const k of ['fixtures','stairs'])$(k).onchange=()=>{root.children.filter(m=>m.userData.category===k).forEach(m=>m.visible=$(k).checked);invalidateShadows();render()};resize();
}catch(e){report3DError(e)}
function showMode(plan){cancelEditorGesture();$('view3d').style.display=plan?'none':'block';$('planPane').style.display=plan?'block':'none';$('modePlan').classList.toggle('active',plan);$('mode3d').classList.toggle('active',!plan)}$('mode3d').onclick=()=>showMode(false);$('modePlan').onclick=()=>showMode(true);
function focusRoom(id){const room=model.rooms.find(room=>room.id===id);if(!room){$('resetView').click();return}$('room').value=id;$('focusRoom').value=id;if(failed3D){showMode(true);return}const view=model.room_views?.[id]||{};const points=room.polygon.map(([x,z])=>[xm(x),zm(z)]),xs=points.map(p=>p[0]),zs=points.map(p=>p[1]);target.set((Math.min(...xs)+Math.max(...xs))/2,planBounds?model.ceiling_height_m/2:.45,(Math.min(...zs)+Math.max(...zs))/2);radius=Math.max(5,planBounds?model.ceiling_height_m*2:0,Math.hypot(Math.max(...xs)-Math.min(...xs),Math.max(...zs)-Math.min(...zs))*1.45);azimuth=view.azimuth_rad??-.16;polar=view.polar_rad??.74;showMode(false);window.renderModel?.()}
$('focusRoom').onchange=()=>focusRoom($('focusRoom').value);
function rebuildInventoryView(){
for(const id of Object.keys(tvEntities))applyTVFrame(null,false,id);inventoryNodes.clear();objectsById.clear();
$('pins').replaceChildren();$('items').replaceChildren();$('count').textContent=items.length;
if(objectGroup){while(objectGroup.children.length){const o=objectGroup.children[0];o.traverse(child=>{child.geometry?.dispose();child.material?.dispose()});objectGroup.remove(o)}}
for(const [index,it] of items.entries()){
const x=xp(it.position_m.x),z=zp(it.position_m.z);const g=svgEl('g',{'data-item-id':it.id});g.append(svgEl('circle',{cx:x,cy:z,r:18,fill:'#b16e31',stroke:'white','stroke-width':3}),svgEl('text',{x,y:z+6,fill:'white','font-size':17,'text-anchor':'middle','font-family':'system-ui'},String(index+1)));g.addEventListener('click',e=>{e.stopPropagation();editInventoryItem(it)});$('pins').append(g);const nodes={pin:g};inventoryNodes.set(it.id,nodes);
const li=document.createElement('li'),label=document.createElement('span');label.textContent=(index+1)+'. '+it.name;const sub=document.createElement('small');sub.textContent=roomCode(it.room)+(it.entity_id?' · '+it.entity_id:'');label.append(document.createElement('br'),sub);const ed=document.createElement('button');ed.textContent=vt('Edit');nodes.edit=ed;ed.onclick=()=>editInventoryItem(it);const del=document.createElement('button');del.textContent='×';del.setAttribute('aria-label',vt('Remove {name}',{name:it.name}));nodes.remove=del;del.onclick=()=>{items=items.filter(v=>v.id!==it.id);if(editing===it.id)cancelInventoryEdit();persistInventory();rebuildInventoryView()};if(embedded&&it.entity_id){const control=document.createElement('button');control.textContent=vt('Details');control.dataset.detailsFor=it.id;control.setAttribute('aria-label',vt('Details')+': '+it.name);nodes.control=control;control.onclick=()=>{if(bridge&&haConnected&&haStates[it.entity_id])bridge.postMessage({type:'more_info',entity_id:it.entity_id})};li.append(control);const live=document.createElement('small');live.dataset.stateFor=it.id;nodes.state=live;label.append(document.createElement('br'),live);if(['light','switch','input_boolean','fan'].includes(it.entity_id.split('.')[0])){const toggle=document.createElement('button');toggle.textContent=vt('Toggle');toggle.dataset.toggleFor=it.id;nodes.toggle=toggle;toggle.setAttribute('aria-label',vt('Toggle {name}',{name:it.name}));toggle.onclick=()=>bridge?.postMessage({type:'toggle',entity_id:it.entity_id});li.append(toggle)}}li.append(label,ed,del);$('items').append(li);
if(objectGroup){
const size=it.dimensions_m,candidate=model.object_assets?.[it.id],asset=candidate?.model_id&&candidate.model_id!==it.model_id?null:candidate;let o;
if(asset){
o=new THREE.Group();const batches={};
for(const part of asset.meshes){const batch=batches[part.material]??={vertices:[],normals:[],indices:[]};const offset=batch.vertices.length/3;batch.vertices.push(...part.vertices.flat());batch.normals.push(...part.normals.flat());batch.indices.push(...part.indices.map(i=>i+offset))}
for(const [material,batch] of Object.entries(batches)){const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(batch.vertices,3));geo.setAttribute('normal',new THREE.Float32BufferAttribute(batch.normals,3));geo.setIndex(batch.indices);const col=model.materials[material];const mat=createSceneMaterial({color:new THREE.Color(...col.slice(0,3)),roughness:.8,transparent:col[3]<1,opacity:col[3],depthWrite:col[3]===1,side:THREE.DoubleSide});const child=new THREE.Mesh(geo,mat);child.castShadow=col[3]===1;child.receiveShadow=true;child.userData.curtainFabric=!!model.cover_windows?.[it.id] && /curtain|safety_mesh/.test(material);o.add(child)}
if(tvEntities[it.id]&&it.entity_id===tvEntities[it.id]){const screen=new THREE.Mesh(new THREE.PlaneGeometry(.968,.948),new THREE.MeshBasicMaterial({toneMapped:false}));screen.position.set(0,.515,.393);screen.visible=false;o.userData.screen=screen;o.add(screen)}
o.scale.set(size.width,size.height,size.depth);o.position.set(it.position_m.x,it.position_m.y,it.position_m.z);
}else{const geo=new THREE.BoxGeometry(size.width,size.height,size.depth);const mat=createSceneMaterial({color:it.type==='tv'?0x273239:0xb87637,roughness:.7});o=new THREE.Mesh(geo,mat);o.position.set(it.position_m.x,it.position_m.y+size.height/2,it.position_m.z);o.castShadow=true;o.receiveShadow=true;registerFallbackBoxProgram(THREE,o,renderProfile.diffuseLighting)}
o.rotation.y=it.rotation_deg*Math.PI/180;o.userData.id=it.id;objectGroup.add(o);objectsById.set(it.id,o)}
}homeView?.rebuildControls();refreshEntityPresentation();}
function persistInventory(){if(embedded){if(bridge)bridge.postMessage({type:'save',items});else setEditorStatus('Not connected. Export JSON to keep your edits.');return}try{localStorage.setItem(KEY,JSON.stringify(items))}catch(e){setEditorStatus('Browser storage unavailable. Export JSON to keep your work.')}}
function refreshEntityOptions(){
  const query=$('entity').value.trim().toLowerCase();
  const options=(entityCatalog||Object.entries(haStates).map(([id,state])=>[id,state.name])).filter(([id,name])=>!query||id.includes(query)||String(name).toLowerCase().includes(query)).slice(0,80);
  const key=JSON.stringify(options);if(key===entityOptions)return;entityOptions=key;
  $('haEntities').replaceChildren(...options.map(([id,name])=>{const option=document.createElement('option');option.value=id;option.label=name;return option}));
}
$('entity').addEventListener('input',refreshEntityOptions);
$('entity').addEventListener('focus',refreshEntityOptions);
const entityGuidance=document.createElement('small');entityGuidance.id='entityGuidance';$('entity').insertAdjacentElement('afterend',entityGuidance);$('entity').setAttribute('aria-describedby','entityGuidance');
const bindingGuidance='Bind any Home Assistant entity. Lights, switches and fans keep quick toggles; Details opens native controls. Sensors show readings, media players show artwork and controls, and other entities open Details. Offline previews do not control devices.';
entityGuidance.textContent=vt(bindingGuidance);
function cancelInventoryEdit(){editing=null;$('addItem').textContent=vt('Add object');$('cancelEdit').style.display='none';$('name').value='';$('entity').value='';$('notes').value=''}$('cancelEdit').onclick=cancelInventoryEdit;
function editInventoryItem(it){editing=it.id;$('name').value=it.name;$('kind').value=it.type;$('room').value=it.room;for(const k of ['x','y','z'])$(k).value=it.position_m[k];for(const [f,k] of [['w','width'],['d','depth'],['h','height']])$(f).value=it.dimensions_m[k];$('rotation').value=it.rotation_deg;$('entity').value=it.entity_id||'';$('notes').value=it.notes||'';$('addItem').textContent=vt('Save changes');$('cancelEdit').style.display='block';drawCursor();setEditorStatus('Editing {name}',{name:it.name})}
$('itemForm').onsubmit=e=>{e.preventDefault();const it={...inventoryAppearance(items.find(item=>item.id===editing),$('kind').value),id:editing||('item_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7)),name:$('name').value.trim(),type:$('kind').value,room:$('room').value,position_m:{x:+$('x').value,y:+$('y').value,z:+$('z').value},dimensions_m:{width:+$('w').value,depth:+$('d').value,height:+$('h').value},rotation_deg:+$('rotation').value,entity_id:$('entity').value.trim(),notes:$('notes').value.trim()};try{validateInventoryItems([it])}catch(e){setEditorStatus(e.message);return}if(editing)items=items.map(x=>x.id===editing?it:x);else items.push(it);persistInventory();rebuildInventoryView();cancelInventoryEdit();setEditorStatus(embedded?'Updated {name}. Check the panel header for save status.':'Saved {name}. Export JSON when finished.',{name:it.name})};
function exportInventoryJson(){const file={schema_version:1,model:model.id,units:'metres',up_axis:'Y',coordinate_system:model.origin,items};const blob=new Blob([JSON.stringify(file,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=model.id+'-inventory.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setEditorStatus('Inventory exported. Keep this JSON as a placement backup.')} $('export').onclick=exportInventoryJson;
$('import').onclick=()=>$('importFile').click();$('importFile').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>5_000_000)throw Error('File is too large.');const incoming=JSON.parse(await file.text());if(incoming.schema_version!==1||incoming.model!==model.id||incoming.units!=='metres')throw Error('Expected an inventory for '+model.id+' in metres, schema version 1.');const list=validateImportedAppearance(validateInventoryItems(incoming.items));const merged=new Map(items.map(it=>[it.id,it]));list.forEach(it=>merged.set(it.id,it));items=validateInventoryItems([...merged.values()]);persistInventory();cancelInventoryEdit();rebuildInventoryView();setEditorStatus('Imported {count} objects; matching IDs were updated.',{count:list.length})}catch(err){setEditorStatus('Import failed: {error}',{error:err.message})}finally{e.target.value=''}};
function refreshEntityPresentation(){
for(const [id,entity] of Object.entries(tvEntities))if(!haConnected||haStates[entity]?.restored||!['on','playing','paused','idle','buffering'].includes(haStates[entity]?.state))applyTVFrame(null,false,id);
if(embedded)for(const it of items){if(!it.entity_id)continue;const state=haStates[it.entity_id],available=haConnected&&state&&!state.restored&&!['unavailable','unknown'].includes(state.state);const entityOn=state?.state==='on'||it.entity_id.startsWith('media_player.')&&['playing','paused','idle','buffering'].includes(state?.state);const color=!available?0x8b9197:entityOn?(it.type==='tv'?0x8eb7d6:0xfff4e2):0x58838b;
const nodes=inventoryNodes.get(it.id),label=nodes?.state;if(label)label.textContent=!haConnected?vt('Disconnected'):state?state.restored?vt('Restored state'):viewerStateLabel(state.state)+(state.unit?' '+state.unit:''):vt('Entity not found');
if(nodes?.control)nodes.control.disabled=!haConnected||!state;
const toggle=nodes?.toggle;if(toggle)toggle.disabled=!available||!['on','off'].includes(state.state);
const appearance=resolveLightAppearance(state),isLight=['chandelier','lamp'].includes(it.type)||it.entity_id.startsWith('light.');
const object=objectsById.get(it.id);if(object)object.traverse(child=>{if(child.material?.emissive){if(isLight){child.material.emissive.setRGB(...appearance.rgb.map(c=>c/255),THREE.SRGBColorSpace);child.material.emissiveIntensity=available?.3*appearance.brightness:0}else{child.material.emissive.setHex(color);child.material.emissiveIntensity=available&&entityOn?.3:.08}}});
nodes?.pin.querySelector('circle')?.setAttribute('fill','#'+color.toString(16).padStart(6,'0'));
}homeView?.refreshControls();window.requestModelRender?.();
}
function updateHeightCaption(){
  $('heightCaption').textContent=$('cutaway').checked?vt('Walls and windows cut at 1.15 m · exports keep full height.'):vt('Full-height walls and windows · ceiling {height} m.',{height:model.ceiling_height_m.toFixed(2)});
}
function refreshViewerLanguage(refreshStates=true){
  entityGuidance.textContent=vt(bindingGuidance);
  $('addItem').textContent=vt(editing?'Save changes':'Add object');
  if(model.site_features===false)document.querySelector('.measure').textContent=vt('Units: metres')+' · '+model.ceiling_height_m.toFixed(2)+' m';
  updateHeightCaption();
  if(!embedded&&model.next_floor){const link=$('otherFloor'),url=new URL(link.getAttribute('href'),location.href);url.searchParams.set('lang',viewerI18n.locale);link.href=url.href;}
  if(editorStatus)$('status').textContent=vt(editorStatus.text,editorStatus.params);
  for(const it of items){const nodes=inventoryNodes.get(it.id);if(!nodes)continue;
    nodes.edit.textContent=vt('Edit');nodes.remove.setAttribute('aria-label',vt('Remove {name}',{name:it.name}));
    if(nodes.control){nodes.control.textContent=vt('Details');nodes.control.setAttribute('aria-label',vt('Details')+': '+it.name);}
    if(nodes.toggle){nodes.toggle.textContent=vt('Toggle');nodes.toggle.setAttribute('aria-label',vt('Toggle {name}',{name:it.name}));}
  }
  homeView?.refreshLanguage();if(refreshStates)refreshEntityPresentation();
}
viewerI18n.onChange(({locale,source})=>{refreshViewerLanguage();if(source==='user')bridge?.postMessage({type:'view_preferences',language:locale});});
__HOME_JS__
if(embedded){
$('otherFloor').onclick=e=>{if(bridge){e.preventDefault();if(model.next_floor?.id)bridge.postMessage({type:'floor',floor:model.next_floor.id})}};
for(const link of document.querySelectorAll('a[download]'))link.onclick=e=>{e.preventDefault();bridge?.postMessage({type:'export',format:link.getAttribute('href').split('.').pop()})};
function inventorySnapshot(list){return JSON.stringify(list,(_,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)):value)}
window.addEventListener('message',function init(event){if(event.source!==parent||event.data?.type!=='home-floorplan:init'||!event.ports[0]||bridge)return;
let inventoryChanged=false;try{const incoming=reconcileStoredAppearance(validateInventoryItems(event.data.items));inventoryChanged=inventorySnapshot(incoming)!==inventorySnapshot(items);if(inventoryChanged)items=incoming}catch(error){setEditorStatus('Cannot load saved inventory: '+error.message);return}
bridge=event.ports[0];homeView?.applyViewPreferences(event.data.preferences||{});
bridge.onmessage=event=>{
  const message=event.data;
  if(message?.type==='dismiss_overlays'){homeView?.dismissOverlays();return}
  if(message?.type==='view_preferences'){homeView?.applyViewPreferences(message);return}
  if(message?.type==='camera_frames'){applyCameraFrames(message.frames);return}
  if(message?.type==='media_artwork'){window.applyMediaArtwork?.(message.artwork);return}
  if(message?.type==='tv_frame'){applyTVFrame(message.image,true,message.item_id);return}
  if(message?.type==='command_result'){window.handleMediaCommandResult?.(message);homeView?.handleCommandResult(message);return}
  if(message?.type==='entity_catalog'){
    entityCatalog=(Array.isArray(message.entities)?message.entities:[]).slice(0,20000).filter(row=>Array.isArray(row)&&typeof row[0]==='string'&&/^[a-z_]+\.[a-z0-9_]{1,137}$/.test(row[0])).map(([id,name])=>[id,typeof name==='string'?name.slice(0,200):id]);
    refreshEntityOptions();return;
  }
  if(message?.type!=='states')return;
  haStates=message.states;haConnected=message.connected;
  if(!haConnected)applyCameraFrames();
  if(!entityCatalog)refreshEntityOptions(); // Compatibility with earlier hosts.
  refreshEntityPresentation();
};
// Declare only entity references already present in this model. Hosts use them for
// telemetry, room activity and guard dependencies beyond the editable bindings.
const stateEntities=new Set();let scanned=0;
function collectStateEntities(value,depth=0){
  if(depth>20||++scanned>100000||stateEntities.size>=2000)return;
  if(typeof value==='string'&&/^[a-z_]+\.[a-z0-9_]{1,137}$/.test(value))stateEntities.add(value);
  else if(value&&typeof value==='object')for(const child of Object.values(value))collectStateEntities(child,depth+1);
}
for(const key of ['tv_entities','camera_entities','room_activity','receiver_activity','assumed_activity','motion_sources','motion_zones','telemetry','power_labels'])collectStateEntities(model[key]);
bridge.postMessage({type:'model_config',model_id:model.id,state_entities:[...stateEntities],...Object.fromEntries(['tv_entities','camera_entities','room_activity','receiver_activity','assumed_activity'].map(key=>[key,model[key]]))});
document.querySelector('aside').inert=false;if(inventoryChanged)rebuildInventoryView();setEditorStatus(appearanceRefreshNotice || 'Connected. Select an entity from the list to bind an object.');window.removeEventListener('message',init);
});
}
refreshViewerLanguage(false);
rebuildInventoryView();if(embedded){homeView?.setActive(true);requestAnimationFrame(()=>{initialViewReady=!failed3D;try{window.resizeModel?.();}catch(e){report3DError(e);}})}else if(model.initial_room)focusRoom(model.initial_room);window.floorplan={model,get locale(){return viewerI18n.locale},get homeMode(){return homeView?.active??false},get illuminated(){return homeView?.illuminated??[]},get items(){return items},get renderCount(){return renderCount},get meshCount(){return root?.children.length||0},get objectCount(){return objectGroup?.children.length||0},get translucentObjectMeshCount(){let n=0;objectGroup?.traverse(o=>{if(o.isMesh&&o.material.transparent&&o.material.opacity<1&&!o.material.depthWrite)n++});return n},get objectMeshCount(){let n=0;objectGroup?.traverse(o=>{if(o.isMesh)n++});return n}};
