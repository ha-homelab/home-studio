// A screen-sized SVG marker follows the calibrated floor position without GPU resources.
function createVacuumView(container,specs,floorId,THREE,options={}){
  const resolve=typeof resolveVacuumPosition==='function'?resolveVacuumPosition:require('./vacuum-state.js').resolveVacuumPosition;
  const ageText=typeof vacuumAgeText==='function'?vacuumAgeText:require('./vacuum-state.js').vacuumAgeText;
  const layer=document.createElement('div'),entries=[],projected=new THREE.Vector3();
  layer.className='home-vacuum-layer';layer.hidden=true;container.append(layer);
  let states={},connected=false,active=false,disposed=false,timer=null,lastCamera=null,lastRect=null;
  let wall=Date.now(),monotonic=performance.now();
  const clock=()=>{const tick=performance.now();wall=Math.max(Date.now(),wall+Math.max(0,tick-monotonic));monotonic=tick;return wall;};
  for(const spec of (Array.isArray(specs)?specs:[]).slice(0,32)){
    if(!spec||typeof spec.id!=='string'||entries.some(entry=>entry.spec.id===spec.id))continue;
    const marker=document.createElement('button'),caption=document.createElement('span');
    marker.type='button';marker.className='home-vacuum-marker';marker.dataset.vacuumId=spec.id;marker.hidden=true;
    marker.innerHTML='<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="12"/><path d="M6 17h20M11 23h10"/><circle cx="16" cy="11" r="3"/></svg>';
    caption.className='home-vacuum-caption';marker.append(caption);layer.append(marker);
    const click=()=>{if(active&&!document.hidden&&connected&&!disposed)options.onInspect?.(spec.entity_id);};
    marker.addEventListener('click',click);entries.push({spec,marker,caption,click,lastGood:null,result:null});
  }
  function clearTimer(){if(timer!==null){clearTimeout(timer);timer=null;}}
  function refresh(){
    clearTimer();if(disposed)return;
    const now=clock(),visible=active&&!document.hidden;layer.hidden=!visible;
    let next=Infinity;
    for(const entry of entries){
      const {spec,marker,caption}=entry,result=resolve(spec,states,connected,floorId,entry.lastGood,now);
      entry.result=result;entry.lastGood=result.lastGood;
      marker.hidden=!visible||!result.position;marker.disabled=!connected;
      marker.dataset.positionState=result.status;
      if(!result.position)continue;
      const name=typeof spec.name==='string'&&spec.name.trim()?spec.name:'Vacuum';
      const age=ageText(result.ageMs),lastKnown=result.status==='last_known',reported=!result.observationKnown;
      const label=(lastKnown?'Last known · ':reported?'Reported position · ':'')+
        (reported?'Observation time unavailable · Retrieved ':'')+age;
      caption.textContent=lastKnown?'Last known · '+(reported?'retrieved ':'')+age:reported?'Reported position':'';
      caption.hidden=!lastKnown&&!reported;
      marker.title=name+' · '+result.robotState+(result.battery!==null?' · Battery '+result.battery+'%':'')+' · '+label+
        (spec.calibration==='approximate'?' · Approximate calibration':'');
      marker.setAttribute('aria-label',marker.title);
      if(visible){
        // Only update when the visible age unit changes or the original sample expires.
        const unit=result.ageMs<60000?1000:result.ageMs<3600000?60000:result.ageMs<86400000?3600000:86400000;
        next=Math.min(next,unit-result.ageMs%unit,result.expiresAt===null?Infinity:result.expiresAt-now);
      }
    }
    if(lastCamera&&lastRect)render(lastCamera,lastRect);
    if(visible&&Number.isFinite(next))timer=setTimeout(refresh,Math.max(1,next));
  }
  function render(camera,rect){
    lastCamera=camera;lastRect={width:rect.width,height:rect.height};
    if(disposed||layer.hidden)return;
    for(const {marker,result} of entries){
      if(!result?.position||marker.hidden)continue;
      projected.set(result.position.x,.08,result.position.z).project(camera);
      const visible=[projected.x,projected.y,projected.z].every(Number.isFinite)&&Math.abs(projected.x)<=1&&Math.abs(projected.y)<=1&&Math.abs(projected.z)<=1;
      marker.style.visibility=visible?'':'hidden';
      if(visible){marker.style.left=(projected.x+1)*rect.width/2+'px';marker.style.top=(1-projected.y)*rect.height/2+'px';}
    }
  }
  const visibility=()=>refresh(),pagehide=()=>{active=false;clearTimer();layer.hidden=true;},pageshow=()=>options.onResume?.();
  document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',pagehide);window.addEventListener('pageshow',pageshow);
  return {
    update(nextStates,nextConnected,nextActive){if(disposed)return;states=nextStates||{};connected=!!nextConnected;active=!!nextActive;refresh();},render,
    dispose(){if(disposed)return;disposed=true;clearTimer();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',pagehide);window.removeEventListener('pageshow',pageshow);for(const {marker,click} of entries)marker.removeEventListener('click',click);entries.length=0;lastCamera=null;lastRect=null;layer.remove();}
  };
}
if(typeof module!=='undefined')module.exports={createVacuumView};
