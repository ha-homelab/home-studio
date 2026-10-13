// Per-TV decode versions reject late frames; explicit lifecycle clears own disposal.
const tvEntities=model.tv_entities||{};
const tvFrames=new Map();let tvAnchor=null;
function previewTV(anchor=tvAnchor){
  tvAnchor=anchor;
  const preview=$('tvPreview'),image=anchor&&tvFrames.get(anchor.id||Object.keys(tvEntities)[0])?.image;
  if(image)preview.src=image;else preview.removeAttribute('src');
  preview.hidden=!(image&&homeView?.active);
  if(preview.hidden)return;
  preview.style.left=Math.max(8,Math.min(innerWidth-preview.offsetWidth-8,anchor.x+16))+'px';
  preview.style.top=Math.max(8,Math.min(innerHeight-preview.offsetHeight-8,anchor.y+16))+'px';
}
function applyTVFrame(image,render=true,id=Object.keys(tvEntities)[0]){
  if(!Object.hasOwn(tvEntities,id)||image===undefined)return;
  if(!tvFrames.has(id))tvFrames.set(id,{version:0});
  const frame=tvFrames.get(id),screen=objectsById.get(id)?.userData.screen,version=++frame.version;
  if(!screen||typeof image!=='string'||image.length>250000||!image.startsWith('data:image/jpeg;base64,')){
    frame.image=null;previewTV();
    if(!screen)return;
    screen.material.map?.dispose();screen.material.map=null;screen.visible=false;
    if(render)window.renderModel?.();return;
  }
  const texture=new THREE.TextureLoader().load(image,loaded=>{
    if(version!==frame.version||screen!==objectsById.get(id)?.userData.screen){loaded.dispose();return}
    screen.material.map?.dispose();loaded.colorSpace=THREE.SRGBColorSpace;
    screen.material.map=loaded;screen.material.needsUpdate=true;screen.visible=true;
    frame.image=image;previewTV();window.renderModel?.();
  },undefined,()=>{texture.dispose()});
}
