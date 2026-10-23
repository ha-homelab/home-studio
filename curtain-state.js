// HA position convention: 0 closed, 100 open. Targets are never observations.
function deriveCurtainStatus(entity, states, now=Date.now()) {
  const cover=entity?.cover||{},guard=states[cover.guard];
  const motorAvailable=!cover.restored&&(['open','closed','opening','closing'].includes(entity?.state)||
    entity?.state==='unknown'&&(cover.supported_features&15)!==0);
  const poweredOff=guard?.state==='off';
  const turnedOn=Date.parse(cover.power_on_at);
  const seconds=Number.isFinite(turnedOn)?Math.max(0,Math.ceil((turnedOn+(cover.boot_seconds||50)*1000-now)/1000)):0;
  const statePredatesPowerOn=Number.isFinite(turnedOn)&&!(Date.parse(entity?.last_updated)>=turnedOn);
  const ready=motorAvailable&&!poweredOff&&!seconds&&!statePredatesPowerOn;
  const current=cover.current_position;
  // HA may retain current_position through reconnection; this is a reported
  // number, never proof of a fresh motor packet or physical calibration.
  const reported=ready&&Number.isFinite(current)&&current>=0&&current<=100;
  const remembered=cover.last_known?.position;
  const position=reported?current:Number.isFinite(remembered)&&remembered>=0&&remembered<=100?remembered:null;
  const checked=Date.parse(cover.position_checked_at);
  const userChecked=!poweredOff&&Number.isFinite(checked)&&(!Number.isFinite(turnedOn)||checked>=turnedOn);
  return {position:Number.isFinite(position)?position:null,ready,seconds,poweredOff,remembered:!reported,
    checkedAt:userChecked?cover.position_checked_at:null,
    accuracy:userChecked?'User check recorded':Number.isFinite(turnedOn)||poweredOff?'Position accuracy unverified after power loss':'Position accuracy not physically verified',
    description:seconds?`Starting · ${seconds}s`:poweredOff?'Power off':!ready?(Number.isFinite(turnedOn)?'0s · Waiting for device':'Waiting for device'):!reported?'Position not reported':null,
    canPowerOn:!seconds&&poweredOff,
    action:!ready?null:['opening','closing'].includes(entity.state)?'stop_cover':entity.state==='closed'||position===0?'open_cover':entity.state==='open'||position>0?'close_cover':null};
}

// Catalog fabric is tagged by panel, independently of palette or pattern.
// Both single-direction and split curtains retain one fixed rail.
function updateCatalogCurtainFabric(object,spec,position,lo,hi){
  if(!['left','right','pair'].includes(spec.mode)||!Number.isFinite(lo)||!Number.isFinite(hi)||hi-lo<.001)return null;
  const fabrics=object.children.filter(mesh=>mesh.isMesh&&mesh.userData.curtainFabric&&['left','right'].includes(mesh.userData.curtainPanel));
  const bounds=object.userData.catalogCurtainBounds??=(()=>{
    const result={left:[Infinity,-Infinity],right:[Infinity,-Infinity]};
    for(const mesh of fabrics){
      const source=mesh.userData.restVertices??=mesh.geometry.attributes.position.array.slice(),range=result[mesh.userData.curtainPanel];
      for(let i=0;i<source.length;i+=3){range[0]=Math.min(range[0],source[i]);range[1]=Math.max(range[1],source[i]);}
    }
    return result;
  })();
  const span=hi-lo,openness=position/100,pack=span*(spec.mode==='pair'?.1:.18);
  let anchor=null;
  for(const mesh of fabrics){
    const attribute=mesh.geometry.attributes.position,source=mesh.userData.restVertices,[a,b]=bounds[mesh.userData.curtainPanel];
    if(!(b>a))continue;
    const right=mesh.userData.curtainPanel==='right';
    for(let i=0;i<source.length;i+=3){
      const u=(source[i]-a)/(b-a),whole=(right?.5:0)+u*.5,closed=lo+whole*span;
      const open=spec.mode==='pair'?(right?hi-pack+u*pack:lo+u*pack):(spec.mode==='right'?hi-pack:lo)+whole*pack;
      attribute.array[i]=closed+(open-closed)*openness;
    }
    attribute.needsUpdate=true;mesh.geometry.computeBoundingBox();mesh.geometry.computeBoundingSphere();mesh.geometry.computeVertexNormals();
    anchor=mesh.geometry.boundingBox.getCenter(new THREE.Vector3());
  }
  if(anchor){object.updateMatrixWorld(true);return object.localToWorld(anchor);}
  return null;
}

// Deform fabric only. Rails remain fixed, even when the user has moved/rotated an object.
function updateCurtainFabric(object, item, spec, position, openings, original) {
  if(!object||!spec||!Number.isFinite(position)||position<0||position>100)return null;
  const reference=original||item,angle=reference.rotation_deg*Math.PI/180;
  const xs=openings.filter(o=>spec.openings.includes(o.id)).flatMap(o=>{
    const [x0,z0,x1,z1]=o.rect;
    const points=spec.mode&&o.start_m&&o.end_m?[o.start_m,o.end_m]:[[xm(x0),zm(z0)],[xm(x1),zm(z1)]];
    return points.map(([x,z])=>(x-reference.position_m.x)*Math.cos(angle)-(z-reference.position_m.z)*Math.sin(angle));
  });
  if(!xs.length)return null;
  let lo=Math.min(...xs)/reference.dimensions_m.width,hi=Math.max(...xs)/reference.dimensions_m.width;
  if(spec.mode)return updateCatalogCurtainFabric(object,spec,position,lo,hi);
  const split=spec.openings.length>1, pair=spec.paired===true;
  const gatheredRight=(lo+hi)<0;
  if(pair){if(gatheredRight)lo=(lo+hi)/2;else hi=(lo+hi)/2;}
  const openness=position/100;
  let anchor=null;
  for(const mesh of object.children){
    if(!mesh.isMesh||!mesh.userData.curtainFabric)continue;
    const attribute=mesh.geometry.attributes.position;
    const source=mesh.userData.restVertices??=attribute.array.slice();
    const bounds=mesh.userData.fabricBounds??=(()=>{let a=Infinity,b=-Infinity;for(let i=0;i<source.length;i+=3){a=Math.min(a,source[i]);b=Math.max(b,source[i]);}return [a,b]})();
    const [a,b]=bounds,span=hi-lo,pack=split?span*.10:Math.min(b-a,span*.18);
    for(let i=0;i<source.length;i+=3){
      const x=source[i];let closed,open;
      if(split){
        const side=x<0?-1:1;
        // Split assets consist of two gathered fabric panels.
        const t=side<0?(x-a)/(Math.abs(a)-.35):(x-.35)/(b-.35);
        const u=Math.max(0,Math.min(1,t));
        closed=side<0?lo+u*span/2:(lo+hi)/2+u*span/2;
        open=side<0?lo+u*pack:hi-pack+u*pack;
      }else{
        const u=(x-a)/(b-a);closed=lo+u*span;
        open=gatheredRight?hi-pack+u*pack:lo+u*pack;
      }
      attribute.array[i]=closed+(open-closed)*openness;
    }
    attribute.needsUpdate=true;mesh.geometry.computeBoundingBox();mesh.geometry.computeBoundingSphere();mesh.geometry.computeVertexNormals();
    const bb=mesh.geometry.boundingBox;
    anchor=bb.getCenter(new THREE.Vector3());
    // The configured fabric half keeps paired controls on separate panels.
    if(split)anchor.x=spec.anchor_side==='right'?hi-(span/4*(1-openness)+pack/2*openness):lo+(span/4*(1-openness)+pack/2*openness);
  }
  if(anchor){object.updateMatrixWorld(true);return object.localToWorld(anchor);}
  return null;
}

if(typeof module!=='undefined')module.exports={deriveCurtainStatus};
