// Screen-space marker motion never requests a scene render or reads layout.
function createMarkerMotion(){
  const markers=new Map(),moving=new Set(),reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const timeConstant=80,settleAfter=320,maxLag=24,epsilon=.25;
  let frame=0,suspended=false,disposed=false;
  const blocked=()=>document.hidden||suspended||reduced?.matches;
  function paint(marker){
    const style=marker.element.style,transform=`translate3d(${marker.x}px,${marker.y}px,0) translate(-50%,-50%)`;
    if(style.left!=='0px')style.left='0px';
    if(style.top!=='0px')style.top='0px';
    if(style.transform!==transform)style.transform=transform;
  }
  function advance(marker,now){
    const dx=marker.targetX-marker.x,dy=marker.targetY-marker.y;
    if(now-marker.changedAt>=settleAfter||Math.hypot(dx,dy)<=epsilon){
      marker.x=marker.targetX;marker.y=marker.targetY;
    }else{
      const alpha=-Math.expm1(-Math.max(0,now-marker.updatedAt)/timeConstant);
      marker.x+=dx*alpha;marker.y+=dy*alpha;
      if(Math.hypot(marker.targetX-marker.x,marker.targetY-marker.y)<=epsilon){
        marker.x=marker.targetX;marker.y=marker.targetY;
      }
    }
    marker.updatedAt=now;
    return marker.x===marker.targetX&&marker.y===marker.targetY;
  }
  function schedule(){
    if(moving.size&&!frame)frame=requestAnimationFrame(tick);
    else if(!moving.size&&frame){cancelAnimationFrame(frame);frame=0;}
  }
  function tick(){
    frame=0;
    if(disposed||blocked()){reset();return;}
    // A preceding WebGL callback can outlast this frame's RAF timestamp.
    // Use the same clock as target() so a late draw cannot rewind damping.
    const now=performance.now();
    for(const marker of moving){
      if(marker.element.isConnected===false){moving.delete(marker);markers.delete(marker.element);continue;}
      if(marker.element.hidden){
        marker.x=marker.targetX;marker.y=marker.targetY;
        moving.delete(marker);markers.delete(marker.element);
      }else if(advance(marker,now))moving.delete(marker);
      paint(marker);
    }
    schedule();
  }
  function reset(){
    if(frame)cancelAnimationFrame(frame);
    frame=0;moving.clear();
    for(const marker of markers.values()){
      marker.x=marker.targetX;marker.y=marker.targetY;
      if(marker.element.isConnected!==false)paint(marker);
    }
    markers.clear();
  }
  function target(element,x,y){
    if(disposed||!element?.style||!Number.isFinite(x)||!Number.isFinite(y))return;
    let marker=markers.get(element);
    if(element.isConnected===false){
      if(marker)moving.delete(marker);
      markers.delete(element);schedule();return;
    }
    const now=performance.now();
    if(blocked()||element.hidden){
      if(marker)moving.delete(marker);
      markers.delete(element);paint({element,x,y});schedule();return;
    }
    if(!marker){
      marker={element,x,y,targetX:x,targetY:y,changedAt:now,updatedAt:now};
      markers.set(element,marker);paint(marker);return;
    }
    if(marker.targetX===x&&marker.targetY===y)return;
    // Integrate the previous target up to this retargeting time, independently
    // of how many animation frames happened between camera draws.
    advance(marker,now);
    marker.targetX=x;marker.targetY=y;marker.changedAt=now;
    const dx=marker.x-x,dy=marker.y-y,distance=Math.hypot(dx,dy);
    if(distance>maxLag){marker.x=x+dx*maxLag/distance;marker.y=y+dy*maxLag/distance;}
    if(Math.hypot(marker.x-x,marker.y-y)<=epsilon){marker.x=x;marker.y=y;moving.delete(marker);}
    else moving.add(marker);
    paint(marker);schedule();
  }
  const visibility=()=>{if(document.hidden)reset();};
  const pagehide=()=>{suspended=true;reset();};
  const pageshow=()=>{suspended=false;reset();};
  const preference=()=>reset();
  document.addEventListener('visibilitychange',visibility);
  window.addEventListener('pagehide',pagehide);
  window.addEventListener('pageshow',pageshow);
  reduced?.addEventListener('change',preference);
  return {target,reset,dispose(){
    if(disposed)return;
    disposed=true;reset();
    document.removeEventListener('visibilitychange',visibility);
    window.removeEventListener('pagehide',pagehide);
    window.removeEventListener('pageshow',pageshow);
    reduced?.removeEventListener('change',preference);
  }};
}
if(typeof module!=='undefined')module.exports={createMarkerMotion};
