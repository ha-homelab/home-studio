import * as THREE from 'data:text/javascript;base64,__THREE_B64__';
__LIGHT_STATE_JS__
__ROOM_LIGHTING_JS__
const model=JSON.parse(document.getElementById('modelData').textContent),$=id=>document.getElementById(id);
// Display names can change without changing saved room IDs or device bindings.
const roomCode=id=>model.room_display_ids?.[id]||id;
const roomName=id=>model.room_display_names?.[id]||model.rooms.find(r=>r.id===id)?.name||id;
const embedded=window.__HOME_FLOORPLAN_EMBED__===true;let bridge=null,haStates={},haConnected=false,entityOptions='';
const planBounds=model.bounds_m, planCenter=planBounds?[(planBounds.min_x+planBounds.max_x)/2,(planBounds.min_z+planBounds.max_z)/2]:model.editor_view?.center_xz||[0,0];
const planRadius=planBounds?Math.max(8,model.ceiling_height_m*2,Math.hypot(planBounds.max_x-planBounds.min_x,planBounds.max_z-planBounds.min_z)*1.6):model.editor_view?.radius||8;
if(model.site_features===false){
  document.querySelector('header p').textContent='Your measured home · editable placements';
  document.querySelector('.measure').textContent=`Units: metres · Ceiling ${model.ceiling_height_m.toFixed(2)} m`;
  document.querySelector('aside .note').textContent='Geometry follows your project. Verify measurements, openings and device bindings on site.';
  $('heightCaption').textContent=`Full-height walls and windows · ceiling ${model.ceiling_height_m.toFixed(2)} m.`;
  for(const link of document.querySelectorAll('a.download'))if(link.getAttribute('href')?.endsWith('.usdz'))link.hidden=true;
    if(!Object.keys(model.room_activity||{}).length)$('homeToggleActivity').hidden=true;
}

if(!model.next_floor){$('otherFloor').hidden=true;$('homeOtherFloor').hidden=true;}
if(embedded){document.querySelector('aside').inert=true;$('storageNote').textContent='Shared placements are saved in Home Assistant. The panel header shows save errors. Export JSON before reloading if saving fails. Model downloads contain the last built geometry.'}
const KEY=(model.storage_key||model.id)+'-inventory-v1';let items=model.inventory||[],editing=null;
function setEditorStatus(text){$('status').textContent=text}
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
function validateInventoryItems(list){if(!Array.isArray(list)||list.length>2000)throw Error('Inventory must contain an items array with at most 2,000 objects.');const ids=new Set();return list.map(it=>{if(!it||typeof it.id!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(it.id)||ids.has(it.id))throw Error('Every object needs a unique string ID.');ids.add(it.id);if(typeof it.name!=='string'||!it.name.trim()||!Object.hasOwn(presets,it.type)||!model.rooms.some(r=>r.id===it.room))throw Error('Object name, type or room is invalid.');for(const k of ['x','y','z'])if(!Number.isFinite(it.position_m?.[k]))throw Error('Coordinates must be finite numbers.');for(const k of ['width','depth','height'])if(!Number.isFinite(it.dimensions_m?.[k])||it.dimensions_m[k]<=0)throw Error('Dimensions must be positive finite numbers.');if(!Number.isFinite(it.rotation_deg))throw Error('Rotation must be a finite number.');return it})}
try{items=validateInventoryItems(items)}catch(e){items=[];setEditorStatus('Stored inventory could not be read. Import a valid backup JSON.')}
const inventoryNodes=new Map(),objectsById=new Map();
let renderer,scene,camera,objectGroup,root,hemisphere,sun,ground,grid,homeView=null,radius=planRadius,azimuth=.57,polar=.48,target=new THREE.Vector3(planCenter[0],planBounds?model.ceiling_height_m/2:0,planCenter[1]),clipping=new THREE.Plane(new THREE.Vector3(0,-1,0),20),renderCount=0;
function invalidateShadows(){scene?.traverse(o=>{if(o.shadow){o.shadow.autoUpdate=false;o.shadow.needsUpdate=true}})}
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
  if(wallOutlines){wallOutlines.traverse(o=>{o.geometry?.dispose();o.material?.dispose()});root.remove(wallOutlines);}
  wallOutlines=new THREE.Group();wallOutlines.name='Visible wall boundaries';
  // Draw after the translucent wall fill, while opaque furniture still occludes.
  wallOutlines.renderOrder=1;
  const geometry=positions=>new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  for(const [atBase,color,glow] of [[true,0x387bff,.22],[false,0x81fff0,.42]]){
    const edges=[],halo=[];
    for(const [a,b] of wallBoundarySegments(model.meshes,wallOutlineHeight,atBase)){
      const dx=b[0]-a[0],dz=b[2]-a[2],length=Math.hypot(dx,dz);
      if(length<1e-6)continue;
      const nx=-dz/length*.03,nz=dx/length*.03,y=a[1]+.008;
      edges.push(a[0],y,a[2],b[0],y,b[2]);
      const p=[a[0]+nx,y,a[2]+nz],q=[b[0]+nx,y,b[2]+nz],r=[b[0]-nx,y,b[2]-nz],s=[a[0]-nx,y,a[2]-nz];
      halo.push(...p,...q,...r,...p,...r,...s);
    }
    wallOutlines.add(new THREE.Mesh(geometry(halo),new THREE.MeshBasicMaterial({color,transparent:true,opacity:glow,depthWrite:false,toneMapped:false,side:THREE.DoubleSide,forceSinglePass:true})));
    const line=new THREE.LineSegments(geometry(edges),new THREE.LineBasicMaterial({color,transparent:true,opacity:1,depthWrite:false,toneMapped:false}));
    line.renderOrder=1;wallOutlines.add(line);
  }
  root.add(wallOutlines);
}
try{
scene=new THREE.Scene();scene.background=new THREE.Color('#e7e8df');camera=new THREE.PerspectiveCamera(42,1,.1,Math.max(150,planRadius*5));
renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.localClippingEnabled=true;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.95;$('view3d').prepend(renderer.domElement);
hemisphere=new THREE.HemisphereLight(0xffffff,0xa6aaa1,1.8);scene.add(hemisphere);sun=new THREE.DirectionalLight(0xfff9ee,2.3);sun.position.set(-7,22,12);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-16,right:16,top:22,bottom:-22,near:1,far:65});sun.shadow.normalBias=.035;sun.target.position.set(planCenter[0],planBounds?model.ceiling_height_m/2:0,planCenter[1]);scene.add(sun,sun.target);
if(planBounds){const scale=Math.max(1,planRadius/32);sun.position.copy(sun.target.position).add(new THREE.Vector3(-7,22,12).multiplyScalar(scale));Object.assign(sun.shadow.camera,{left:-planRadius,right:planRadius,top:planRadius,bottom:-planRadius,far:Math.max(65,planRadius*4)});sun.shadow.camera.updateProjectionMatrix();}
root=new THREE.Group();objectGroup=new THREE.Group();scene.add(root,objectGroup);buildLowerFloorContext();
for(const m of model.meshes){const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(m.vertices.flat(),3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(m.normals.flat(),3));geometry.setIndex(m.indices);const col=model.materials[m.material];const mat=new THREE.MeshStandardMaterial({color:m.kind==='walls'?0xb2d8d2:m.kind==='frames'?0x9abfcb:new THREE.Color(...col.slice(0,3)),roughness:.8,emissive:m.kind==='walls'?0x315d59:m.kind==='frames'?0x18333d:m.kind==='vehicles'?0x10181b:0,metalness:m.material==='steel'||m.kind==='vehicles'?.35:0,transparent:m.kind==='walls'||col[3]<1,opacity:m.kind==='walls'?.16:col[3],depthWrite:m.kind!=='walls',forceSinglePass:m.kind==='walls',side:THREE.DoubleSide});if(m.kind==='walls')mat.onBeforeCompile=applyWallSheen;if(['walls','frames','doors','windows'].includes(m.kind)){mat.clippingPlanes=[clipping];mat.clipShadows=false}const mesh=new THREE.Mesh(geometry,mat);mesh.name=m.name;mesh.userData.category=m.kind;mesh.castShadow=col[3]===1;mesh.receiveShadow=true;root.add(mesh)}
ground=new THREE.Mesh(new THREE.PlaneGeometry(Math.max(60,planRadius*2),Math.max(65,planRadius*2)),new THREE.MeshStandardMaterial({color:'#dfe3d8',roughness:1}));ground.rotation.x=-Math.PI/2;ground.position.set(planCenter[0],-1.97,planCenter[1]);ground.receiveShadow=true;scene.add(ground);grid=new THREE.GridHelper(44,44,0xc0cabe,0xd0d7cb);grid.position.set(planCenter[0],-1.96,planCenter[1]);scene.add(grid);
renderer.domElement.addEventListener('webglcontextrestored',()=>{invalidateShadows();render()});
function updateEditorCamera(){camera.position.set(target.x+radius*Math.sin(polar)*Math.sin(azimuth),target.y+radius*Math.cos(polar),target.z+radius*Math.sin(polar)*Math.cos(azimuth));camera.lookAt(target)}
function render(){updateWallOutlines();if(homeView?.active){homeView.render();return}updateEditorCamera();renderer.render(scene,camera);renderCount++}window.renderModel=render;
let viewSize='';const resize=()=>{const b=$(homeView?.active?'homeStage':'view3d').getBoundingClientRect(),size=[homeView?.active,b.width,b.height].join();if(b.width&&b.height&&size!==viewSize){viewSize=size;renderer.setSize(b.width,b.height,false);camera.aspect=b.width/b.height;camera.updateProjectionMatrix();render()}};window.resizeModel=resize;const observer=new ResizeObserver(resize);observer.observe($('view3d'));observer.observe($('homeStage'));
let drag=null;renderer.domElement.addEventListener('contextmenu',e=>e.preventDefault());renderer.domElement.addEventListener('pointerdown',e=>{if(homeView?.active)return;drag={x:e.clientX,y:e.clientY,button:e.button};renderer.domElement.setPointerCapture(e.pointerId)});renderer.domElement.addEventListener('pointermove',e=>{if(homeView?.active||!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(drag.button===2||e.shiftKey){const scale=radius*.0018;target.x-=dx*scale*Math.cos(azimuth);target.z+=dx*scale*Math.sin(azimuth);target.x-=dy*scale*Math.sin(azimuth);target.z-=dy*scale*Math.cos(azimuth)}else{azimuth-=dx*.006;polar=Math.max(.02,Math.min(1.46,polar+dy*.006))}drag.x=e.clientX;drag.y=e.clientY;render()});renderer.domElement.addEventListener('pointerup',()=>drag=null);renderer.domElement.addEventListener('pointercancel',()=>drag=null);renderer.domElement.addEventListener('wheel',e=>{if(homeView?.active)return;e.preventDefault();radius=Math.max(3,Math.min(Math.max(65,planRadius*2),radius*Math.exp(e.deltaY*.001)));render()},{passive:false});
$('resetView').onclick=()=>{$('focusRoom').value='';target.set(planCenter[0],planBounds?model.ceiling_height_m/2:0,planCenter[1]);radius=planRadius;azimuth=.57;polar=.48;render()};$('topView').onclick=()=>{if($('focusRoom').value)focusRoom($('focusRoom').value);else{target.set(planCenter[0],planBounds?model.ceiling_height_m/2:0,planCenter[1]);radius=planRadius*.91}polar=.001;azimuth=0;render()};$('zoomIn').onclick=()=>{radius=Math.max(3,radius/1.15);render()};$('zoomOut').onclick=()=>{radius=Math.min(Math.max(65,planRadius*2),radius*1.15);render()};
$('cutaway').onchange=()=>{const cutaway=$('cutaway').checked;clipping.constant=cutaway?1.15:20;$('heightCaption').textContent=cutaway?'Walls and windows cut at 1.15 m · exports keep full height.':'Full-height walls and windows · ceiling '+model.ceiling_height_m.toFixed(2)+' m.';render()};for(const k of ['fixtures','stairs'])$(k).onchange=()=>{root.children.filter(m=>m.userData.category===k).forEach(m=>m.visible=$(k).checked);invalidateShadows();render()};resize();
}catch(e){$('loadError').style.display='block';$('loadError').textContent='3D view could not start: '+e.message+'. Plan placement and JSON export are still available.';console.error(e)}
function showMode(plan){$('view3d').style.display=plan?'none':'block';$('planPane').style.display=plan?'block':'none';$('modePlan').classList.toggle('active',plan);$('mode3d').classList.toggle('active',!plan)}$('mode3d').onclick=()=>showMode(false);$('modePlan').onclick=()=>showMode(true);
function focusRoom(id){const room=model.rooms.find(room=>room.id===id);if(!room){$('resetView').click();return}const view=model.room_views?.[id]||{};const points=room.polygon.map(([x,z])=>[xm(x),zm(z)]),xs=points.map(p=>p[0]),zs=points.map(p=>p[1]);target.set((Math.min(...xs)+Math.max(...xs))/2,planBounds?model.ceiling_height_m/2:.45,(Math.min(...zs)+Math.max(...zs))/2);radius=Math.max(5,planBounds?model.ceiling_height_m*2:0,Math.hypot(Math.max(...xs)-Math.min(...xs),Math.max(...zs)-Math.min(...zs))*1.45);azimuth=view.azimuth_rad??-.16;polar=view.polar_rad??.74;$('room').value=id;$('focusRoom').value=id;showMode(false);window.renderModel?.()}
$('focusRoom').onchange=()=>focusRoom($('focusRoom').value);
function rebuildInventoryView(){
for(const id of Object.keys(tvEntities))applyTVFrame(null,false,id);inventoryNodes.clear();objectsById.clear();
$('pins').replaceChildren();$('items').replaceChildren();$('count').textContent=items.length;
if(objectGroup){while(objectGroup.children.length){const o=objectGroup.children[0];o.traverse(child=>{child.geometry?.dispose();child.material?.dispose()});objectGroup.remove(o)}}
for(const [index,it] of items.entries()){
const x=xp(it.position_m.x),z=zp(it.position_m.z);const g=svgEl('g',{'data-item-id':it.id});g.append(svgEl('circle',{cx:x,cy:z,r:18,fill:'#b16e31',stroke:'white','stroke-width':3}),svgEl('text',{x,y:z+6,fill:'white','font-size':17,'text-anchor':'middle','font-family':'system-ui'},String(index+1)));g.addEventListener('click',e=>{e.stopPropagation();editInventoryItem(it)});$('pins').append(g);const nodes={pin:g};inventoryNodes.set(it.id,nodes);
const li=document.createElement('li'),label=document.createElement('span');label.textContent=(index+1)+'. '+it.name;const sub=document.createElement('small');sub.textContent=roomCode(it.room)+(it.entity_id?' · '+it.entity_id:'');label.append(document.createElement('br'),sub);const ed=document.createElement('button');ed.textContent='Edit';ed.onclick=()=>editInventoryItem(it);const del=document.createElement('button');del.textContent='×';del.setAttribute('aria-label','Remove '+it.name);del.onclick=()=>{items=items.filter(v=>v.id!==it.id);if(editing===it.id)cancelInventoryEdit();persistInventory();rebuildInventoryView()};if(embedded&&it.entity_id){if(it.entity_id.startsWith('cover.')){const control=document.createElement('button');control.textContent='Open controls';control.onclick=()=>bridge?.postMessage({type:'more_info',entity_id:it.entity_id});li.append(control)}const live=document.createElement('small');live.dataset.stateFor=it.id;nodes.state=live;label.append(document.createElement('br'),live);if(['light','switch','input_boolean','fan'].includes(it.entity_id.split('.')[0])){const toggle=document.createElement('button');toggle.textContent='Toggle';toggle.dataset.toggleFor=it.id;nodes.toggle=toggle;toggle.setAttribute('aria-label','Toggle '+it.name);toggle.onclick=()=>bridge?.postMessage({type:'toggle',entity_id:it.entity_id});li.append(toggle)}}li.append(label,ed,del);$('items').append(li);
if(objectGroup){
const size=it.dimensions_m,asset=model.object_assets?.[it.id];let o;
if(asset){
o=new THREE.Group();const batches={};
for(const part of asset.meshes){const batch=batches[part.material]??={vertices:[],normals:[],indices:[]};const offset=batch.vertices.length/3;batch.vertices.push(...part.vertices.flat());batch.normals.push(...part.normals.flat());batch.indices.push(...part.indices.map(i=>i+offset))}
for(const [material,batch] of Object.entries(batches)){const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(batch.vertices,3));geo.setAttribute('normal',new THREE.Float32BufferAttribute(batch.normals,3));geo.setIndex(batch.indices);const col=model.materials[material];const mat=new THREE.MeshStandardMaterial({color:new THREE.Color(...col.slice(0,3)),roughness:.8,transparent:col[3]<1,opacity:col[3],depthWrite:col[3]===1,side:THREE.DoubleSide});const child=new THREE.Mesh(geo,mat);child.castShadow=col[3]===1;child.receiveShadow=true;child.userData.curtainFabric=!!model.cover_windows?.[it.id] && /curtain|safety_mesh/.test(material);o.add(child)}
if(tvEntities[it.id]&&it.entity_id===tvEntities[it.id]){const screen=new THREE.Mesh(new THREE.PlaneGeometry(.968,.948),new THREE.MeshBasicMaterial({toneMapped:false}));screen.position.set(0,.515,.393);screen.visible=false;o.userData.screen=screen;o.add(screen)}
o.scale.set(size.width,size.height,size.depth);o.position.set(it.position_m.x,it.position_m.y,it.position_m.z);
}else{const geo=new THREE.BoxGeometry(size.width,size.height,size.depth);const mat=new THREE.MeshStandardMaterial({color:it.type==='tv'?0x273239:0xb87637,roughness:.7});o=new THREE.Mesh(geo,mat);o.position.set(it.position_m.x,it.position_m.y+size.height/2,it.position_m.z);o.castShadow=true;o.receiveShadow=true}
o.rotation.y=it.rotation_deg*Math.PI/180;o.userData.id=it.id;objectGroup.add(o);objectsById.set(it.id,o)}
}homeView?.rebuildControls();refreshEntityPresentation();}
function persistInventory(){if(embedded){if(bridge)bridge.postMessage({type:'save',items});else setEditorStatus('Not connected. Export JSON to keep your edits.');return}try{localStorage.setItem(KEY,JSON.stringify(items))}catch(e){setEditorStatus('Storage unavailable: export JSON to keep these objects.')}}
function cancelInventoryEdit(){editing=null;$('addItem').textContent='Add object';$('cancelEdit').style.display='none';$('name').value='';$('entity').value='';$('notes').value=''}$('cancelEdit').onclick=cancelInventoryEdit;
function editInventoryItem(it){editing=it.id;$('name').value=it.name;$('kind').value=it.type;$('room').value=it.room;for(const k of ['x','y','z'])$(k).value=it.position_m[k];for(const [f,k] of [['w','width'],['d','depth'],['h','height']])$(f).value=it.dimensions_m[k];$('rotation').value=it.rotation_deg;$('entity').value=it.entity_id||'';$('notes').value=it.notes||'';$('addItem').textContent='Save changes';$('cancelEdit').style.display='block';drawCursor();setEditorStatus('Editing '+it.name)}
$('itemForm').onsubmit=e=>{e.preventDefault();const it={id:editing||('item_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7)),name:$('name').value.trim(),type:$('kind').value,room:$('room').value,position_m:{x:+$('x').value,y:+$('y').value,z:+$('z').value},dimensions_m:{width:+$('w').value,depth:+$('d').value,height:+$('h').value},rotation_deg:+$('rotation').value,entity_id:$('entity').value.trim(),notes:$('notes').value.trim()};try{validateInventoryItems([it])}catch(e){setEditorStatus(e.message);return}if(editing)items=items.map(x=>x.id===editing?it:x);else items.push(it);persistInventory();rebuildInventoryView();cancelInventoryEdit();setEditorStatus((embedded?'Updated ':'Saved ')+it.name+(embedded?'. Check the panel header for save status.':'. Export JSON when finished.'))};
function exportInventoryJson(){const file={schema_version:1,model:model.id,units:'metres',up_axis:'Y',coordinate_system:model.origin,items};const blob=new Blob([JSON.stringify(file,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=model.id+'-inventory.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setEditorStatus('Inventory exported. Keep this JSON as a placement backup.')} $('export').onclick=exportInventoryJson;
$('import').onclick=()=>$('importFile').click();$('importFile').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>5_000_000)throw Error('File is too large.');const incoming=JSON.parse(await file.text());if(incoming.schema_version!==1||incoming.model!==model.id||incoming.units!=='metres')throw Error('Expected an inventory for '+model.id+' in metres, schema version 1.');const list=validateInventoryItems(incoming.items);const merged=new Map(items.map(it=>[it.id,it]));list.forEach(it=>merged.set(it.id,it));items=validateInventoryItems([...merged.values()]);persistInventory();cancelInventoryEdit();rebuildInventoryView();setEditorStatus('Imported '+list.length+' objects; matching IDs were updated.')}catch(err){setEditorStatus('Import failed: '+err.message)}finally{e.target.value=''}};
function refreshEntityPresentation(){
for(const [id,entity] of Object.entries(tvEntities))if(!haConnected||haStates[entity]?.restored||!['on','playing','paused','idle','buffering'].includes(haStates[entity]?.state))applyTVFrame(null,false,id);
if(embedded)for(const it of items){if(!it.entity_id)continue;const state=haStates[it.entity_id],available=haConnected&&state&&!['unavailable','unknown'].includes(state.state);const entityOn=state?.state==='on'||it.entity_id.startsWith('media_player.')&&['playing','paused','idle','buffering'].includes(state?.state);const color=!available?0x8b9197:entityOn?(it.type==='tv'?0x8eb7d6:0xfff4e2):0x58838b;
const nodes=inventoryNodes.get(it.id),label=nodes?.state;if(label)label.textContent=!haConnected?'Disconnected':state?state.state+(state.unit?' '+state.unit:''):'Entity not found';
const toggle=nodes?.toggle;if(toggle)toggle.disabled=!available||!['on','off'].includes(state.state);
const appearance=resolveLightAppearance(state),isLight=['chandelier','lamp'].includes(it.type)||it.entity_id.startsWith('light.');
const object=objectsById.get(it.id);if(object)object.traverse(child=>{if(child.material?.emissive){if(isLight){child.material.emissive.setRGB(...appearance.rgb.map(c=>c/255),THREE.SRGBColorSpace);child.material.emissiveIntensity=available?.3*appearance.brightness:0}else{child.material.emissive.setHex(color);child.material.emissiveIntensity=available&&entityOn?.3:.08}}});
nodes?.pin.querySelector('circle')?.setAttribute('fill','#'+color.toString(16).padStart(6,'0'));
}homeView?.refreshControls();window.renderModel?.();
}
__HOME_JS__
if(embedded){
$('otherFloor').onclick=e=>{if(bridge){e.preventDefault();if(model.next_floor?.id)bridge.postMessage({type:'floor',floor:model.next_floor.id})}};
for(const link of document.querySelectorAll('a[download]'))link.onclick=e=>{e.preventDefault();bridge?.postMessage({type:'export',format:link.getAttribute('href').split('.').pop()})};
window.addEventListener('message',function init(event){if(event.source!==parent||event.data?.type!=='home-floorplan:init'||!event.ports[0]||bridge)return;
try{items=validateInventoryItems(event.data.items)}catch(error){setEditorStatus('Cannot load saved inventory: '+error.message);return}
bridge=event.ports[0];homeView?.applyViewPreferences(event.data.preferences||{});bridge.onmessage=event=>{if(event.data?.type==='camera_frames'){applyCameraFrames(event.data.frames);return}if(event.data?.type==='tv_frame'){applyTVFrame(event.data.image,true,event.data.item_id);return}if(event.data?.type==='command_result'){homeView.handleCommandResult(event.data);return}if(event.data?.type!=='states')return;haStates=event.data.states;haConnected=event.data.connected;if(!haConnected)applyCameraFrames();const options=Object.entries(haStates).map(([id,state])=>[id,state.name]);const key=JSON.stringify(options);if(key!==entityOptions){entityOptions=key;$('haEntities').replaceChildren(...options.map(([id,name])=>{const option=document.createElement('option');option.value=id;option.label=name;return option}))}refreshEntityPresentation()};
bridge.postMessage({type:'model_config',...Object.fromEntries(['tv_entities','camera_entities','room_activity','receiver_activity','assumed_activity'].map(key=>[key,model[key]]))});
document.querySelector('aside').inert=false;rebuildInventoryView();setEditorStatus('Connected. Select an entity from the list to bind an object.');window.removeEventListener('message',init);
});
}
rebuildInventoryView();if(embedded)homeView.setActive(true);else if(model.initial_room)focusRoom(model.initial_room);window.floorplan={model,get homeMode(){return homeView.active},get illuminated(){return homeView.illuminated},get items(){return items},get renderCount(){return renderCount},get meshCount(){return root?.children.length||0},get objectCount(){return objectGroup?.children.length||0},get translucentObjectMeshCount(){let n=0;objectGroup?.traverse(o=>{if(o.isMesh&&o.material.transparent&&o.material.opacity<1&&!o.material.depthWrite)n++});return n},get objectMeshCount(){let n=0;objectGroup?.traverse(o=>{if(o.isMesh)n++});return n}};
