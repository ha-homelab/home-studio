// Read-only appliance indicators. Missing or restored data must never imply OK.
function resolveApplianceStatus(item,spec,states,connected,translate=value=>value){
  const reading=states[item.entity_id];
  const valid=connected&&item.entity_id===spec.entity_id&&item.room===spec.room&&
    reading&&!reading.restored&&['on','off'].includes(reading.state)&&
    (spec.kind!=='smoke'||!reading.device_class||reading.device_class==='smoke');
  if(!valid)return {tone:'unknown',text:translate(connected?'Unavailable':'Disconnected'),running:false};
  const running=reading.state==='on';
  if(spec.kind==='cooktop')return {tone:running?'active':'idle',text:translate(running?'Cooktop on':'Cooktop off'),running};
  const battery=states[spec.battery_entity_id],value=Number(battery?.state);
  const charge=battery&&!battery.restored&&battery.unit==='%'&&String(battery.state??'').trim()&&
    Number.isFinite(value)&&value>=0&&value<=100?Math.round(value)+'%':translate('Battery —');
  return {tone:running?'alarm':'ok',text:translate(running?'SMOKE ALARM':'OK')+' · '+charge,running:false};
}

function createCooktopFlames(spec){
  const el=document.createElement('div');el.className='cooktop-flames';el.hidden=true;
  el.setAttribute('aria-hidden','true');
  for(const burner of (spec.burners||[]).slice(0,8)){
    if(!Array.isArray(burner)||burner.length!==4||!burner.every(Number.isFinite)||Math.abs(burner[0])>.5||burner[1]<0||burner[1]>1||Math.abs(burner[2])>.5||burner[3]<=0||burner[3]>.5)continue;
    const flame=document.createElement('span');flame.className='cooktop-flame';
    flame.burner=burner;
    flame.innerHTML='<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="24" fill="none" stroke="#1699ff" stroke-width="13" opacity=".22"/><g class="gas-jets"><circle cx="32" cy="32" r="23" fill="none" stroke="#38bfff" stroke-width="9" stroke-dasharray="2 5"/><circle cx="32" cy="32" r="21" fill="none" stroke="#c0f5ff" stroke-width="3" stroke-dasharray="1.5 5"/></g></svg>';
    el.append(flame);
  }
  return el;
}

function positionCooktopFlames(el,object,camera,rect,THREE){
  if(!object){el.hidden=true;return;}
  if(el.hidden)return;
  const project=(x,y,z)=>{
    const p=object.localToWorld(new THREE.Vector3(x,y,z)).project(camera);
    return {x:(p.x+1)*rect.width/2,y:(1-p.y)*rect.height/2};
  };
  [...el.children].forEach(flame=>{
    const [x,y,z,r]=flame.burner,p=project(x,y,z),u=project(x+r,y,z),v=project(x,y,z+r);
    if(![p.x,p.y,u.x,u.y,v.x,v.y].every(Number.isFinite)){flame.style.visibility='hidden';return;}
    flame.style.visibility='';
    const a=(u.x-p.x)/32,b=(u.y-p.y)/32,c=(v.x-p.x)/32,d=(v.y-p.y)/32;
    flame.style.transform=`matrix(${a},${b},${c},${d},${p.x-32*(a+c)},${p.y-32*(b+d)})`;
  });
}

function resolveOvenStatus(spec,states,connected,translate=value=>value){
  const reading=states[spec.oven_entity_id];
  if(!connected||!reading||reading.restored||!['running','ready','paused'].includes(reading.state))return {running:false,text:translate('Oven unavailable')};
  return {running:reading.state==='running',text:translate(reading.state==='running'?'Oven on':reading.state==='paused'?'Oven paused':'Oven off')};
}

function positionOvenGlow(el,object,camera,rect,THREE){
  if(!object){el.hidden=true;return;}
  if(el.hidden)return;
  const front=new THREE.Vector3(0,0,1).transformDirection(object.matrixWorld);
  const towardCamera=camera.position.clone().sub(object.getWorldPosition(new THREE.Vector3()));
  el.style.visibility=front.dot(towardCamera)>0?'visible':'hidden';
  const project=(x,y)=>{
    const p=object.localToWorld(new THREE.Vector3(x,y,.501)).project(camera);
    return {x:(p.x+1)*rect.width/2,y:(1-p.y)*rect.height/2};
  };
  const p=project(-.38,.67),u=project(.38,.67),v=project(-.38,.19);
  if(![p.x,p.y,u.x,u.y,v.x,v.y].every(Number.isFinite)){el.style.visibility='hidden';return;}
  el.style.transform=`matrix(${(u.x-p.x)/64},${(u.y-p.y)/64},${(v.x-p.x)/64},${(v.y-p.y)/64},${p.x},${p.y})`;
}

if(typeof module!=='undefined')module.exports={resolveApplianceStatus,createCooktopFlames,positionCooktopFlames,resolveOvenStatus,positionOvenGlow};
