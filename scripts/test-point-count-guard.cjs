// Actual-source CPU oracle; rendered pixels and cold-driver cost need browser validation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'room-lighting.js'),'utf8');
(async()=>{
  const THREE=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'vendor/three.module.min.js')).toString('base64'));
  assert.equal(THREE.REVISION,'169','Review the stock shadow-prefix contract when upgrading Three');
  const context=vm.createContext({});vm.runInContext(source,context);
  let transitions=0,checkedRuns=0,checkedSelections=0;
  for(const count of [6,24]) for(const prefix of [0,1,2,8]) {
    const rooms=Array.from({length:count},(_,i)=>({id:'r'+i,polygon:[[i*4,0],[i*4+4,0],[i*4+4,4],[i*4,4]]}));
    const controller=context.createRoomLighting(THREE,rooms,count*3,[],{packed:true,maxFragmentUniforms:1024});
    const mesh=x=>{const m=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshLambertMaterial());m.position.set(x,1,2);m.userData.category='floors';return m;};
    const near=mesh(2),far=mesh((count-1)*4+2),unbounded=mesh(8),dynamic=mesh(2);
    const group=new THREE.Group();group.add(near,far,unbounded);controller.attach(group,true,{staticGeometry:true});
    controller.attach(unbounded,true);controller.attach(dynamic,true);
    const meshes=[near,far,unbounded,dynamic];
    const compile=m=>{const s={uniforms:{},vertexShader:THREE.ShaderLib.lambert.vertexShader,fragmentShader:THREE.ShaderLib.lambert.fragmentShader};m.material.onBeforeCompile(s);return s;};
    const shaders=meshes.map(compile),uniforms=shaders.map(s=>s.uniforms),storage=uniforms.map(u=>u.homeLightRuns.value);
    const keys=meshes.map(m=>m.material.customProgramCacheKey()),versions=meshes.map(m=>m.material.version);
    const shader=shaders[0].fragmentShader;
    const block=shader.slice(shader.indexOf('#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )'),shader.indexOf('#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )'));
    // This is the complete unwrapped point block emitted by the pinned base.
    // Neither shadow samplers, point math, visibility gates nor addition order change.
    assert.equal(crypto.createHash('sha256').update(block).digest('hex'),'585514270225a26c2437214ab8ede6c6ad980c2ff7a65eaf1a314d82c9335086');
    assert.doesNotMatch(block,/homePointLightingRequired/);
    const helper=shader.match(/float homePointTransmission\(int room\) \{([\s\S]*?)\n    \}/)[1];
    const transmission=new Function('room','homeLitRooms','homeRoomNearby','homeRoomDistance','homeRoomTransmission',helper.replace(/\bint index\b/,'const index'));
    const stockLoop=block.match(/#pragma unroll_loop_start\s+for \( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i \+\+ \) \{([\s\S]*?)\}\s+#pragma unroll_loop_end/)[1];
    const directCall='if (directLight.visible) RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
    const replaceMath=(text,visit)=>{
      const first=text.indexOf('pointLight = pointLights[ i ];'),last=text.indexOf(directCall,first)+directCall.length;
      assert(first>=0&&last>first);return text.slice(0,first)+visit+text.slice(last);
    };
    // Expand constant shadow slots like Three, then execute their actual gates.
    const shadowControl=Array.from({length:prefix},(_,i)=>replaceMath(stockLoop,'visit(i);').replace(/\bi\b/g,String(i))).join('\n');
    const selectShadows=new Function('homePointRooms','homePointTransmission','visit',shadowControl);
    const start=block.indexOf('for ( int homeRun = 0;'),opening=block.indexOf('{',start);
    let depth=1,end=opening+1;for(;depth;end++){if(block[end]==='{')depth++;if(block[end]==='}')depth--;assert(end<block.length);}
    const runControl=replaceMath(block.slice(start,end),'visit(i);').replace(/\b(?:int|float|ivec4)\b/g,'let');
    const selectRuns=new Function('homeLightRuns','homeLightRunCount','NUM_POINT_LIGHTS','NUM_POINT_LIGHT_SHADOWS','homePointTransmission','visit','min','max',runControl);
    const points=Array.from({length:count*3},(_,i)=>{const light=new THREE.PointLight(0xffeedd,1,7,2);light.position.set(Math.floor(i/3)*4+2,2,2);light.castShadow=i<prefix;return {light,item:{room:'r'+Math.floor(i/3)}};});
    const roomId=new Map(rooms.map((r,i)=>[r.id,i+1]));
    function oracle(index,ordered){
      const selected=[];let start=0;
      while(start<ordered.length){let end=start+1,id=roomId.get(ordered[start].item.room)||0;while(end<ordered.length&&(roomId.get(ordered[end].item.room)||0)===id)end++;
        // The two static boxes lie strictly within their respective rooms.
        if(index>=2||!id||id===(index===0?1:count))selected.push([start,end,id,0]);start=end;
      }
      return selected;
    }
    const check=inactive=>{
      controller.update(points);assert.equal(uniforms[0].homePointLightingRequired.value,!inactive);
      const ordered=points.filter(p=>p.light.visible).sort((a,b)=>Number(b.light.castShadow)-Number(a.light.castShadow));
      const ids=ordered.map(p=>roomId.get(p.item.room)||0),lit=rooms.map(r=>ordered.some(p=>p.item.room===r.id&&p.light.intensity>0));
      for(let index=0;index<meshes.length;index++){
        const u=uniforms[index],expected=oracle(index,ordered);assert.equal(u.homeLightRuns.value,storage[index]);
        assert.deepEqual(Array.from(u.homePointRooms.value).slice(0,ids.length),ids);
        assert.deepEqual(Array.from(u.homeLitRooms.value),lit.map(Number));
        assert.equal(u.homeLightRunCount.value,inactive?0:expected.length);
        assert.deepEqual(Array.from(u.homeLightRuns.value.slice(0,expected.length*4)),expected.flat(),'Even inactive run records retain their original contents');
        assert.equal(meshes[index].material.customProgramCacheKey(),keys[index]);assert.equal(meshes[index].material.version,versions[index]);
        assert.equal(compile(meshes[index]).fragmentShader,shaders[index].fragmentShader);
        const forbidden=()=>assert.fail('A proven-zero state cannot evaluate room distance or attenuation');
        const lookup=id=>transmission(id,u.homeLitRooms.value,inactive?forbidden:()=>true,inactive?forbidden:()=>0,inactive?forbidden:()=>1);
        const visited=[];selectShadows(u.homePointRooms.value,lookup,i=>visited.push(i));
        const records=Array.from({length:u.homeLightRunCount.value},(_,i)=>{const [x,y,z,w]=u.homeLightRuns.value.slice(i*4,i*4+4);return{x,y,z,w};});
        const protectedRecords=new Proxy(records,{get:(array,key)=>{assert(Number.isInteger(Number(key))&&Number(key)>=0&&Number(key)<array.length,'No inactive record may be read');return array[key];}});
        selectRuns(protectedRecords,records.length,ordered.length,prefix,lookup,i=>visited.push(i),Math.min,Math.max);
        const receives=i=>ids[i]===0||lit[ids[i]-1];
        const expectedVisits=inactive?[]:[...ids.flatMap((_,i)=>i<prefix&&receives(i)?[i]:[]),...expected.flatMap(([a,b])=>Array.from({length:b-a},(_,i)=>a+i).filter(i=>i>=prefix&&receives(i)))];
        assert.deepEqual(visited,expectedVisits);checkedSelections+=visited.length;checkedRuns+=expected.length;
      }
      transitions++;
    };
    check(false);points.forEach(p=>p.light.intensity=0);check(true);check(true);
    controller.environment(.75,[]);check(true);assert.equal(uniforms[0].homeDaylight.value,.75);
    for(const intensity of [Number.MIN_VALUE,-1,NaN,Infinity]){points[0].light.intensity=intensity;check(false);points[0].light.intensity=0;check(true);}
    for(const mutate of [p=>p.light.color.r=NaN,p=>p.light.position.x=Infinity,p=>p.light.distance=-1,p=>p.light.decay=NaN,p=>p.item.room='unknown']){
      const p=points[0],saved={color:p.light.color.r,x:p.light.position.x,distance:p.light.distance,decay:p.light.decay,room:p.item.room};
      mutate(p);check(false);p.light.color.r=saved.color;p.light.position.x=saved.x;p.light.distance=saved.distance;p.light.decay=saved.decay;p.item.room=saved.room;check(true);
    }
    // Invisible malformed input cannot make the visible known-zero set active.
    points.at(-1).light.visible=false;points.at(-1).light.intensity=NaN;check(true);
    points.at(-1).light.visible=true;check(false);points.at(-1).light.intensity=0;check(true);
    points.forEach(p=>p.light.intensity=1);check(false);
    controller.attach(group,false,{staticGeometry:true});controller.update(points);assert(!compile(near).fragmentShader.includes('homePointLightingRequired'));
    controller.attach(group,true,{staticGeometry:true});controller.update(points);assert.equal(compile(near).fragmentShader,shaders[0].fragmentShader);
    points.forEach(p=>p.light.visible=false);controller.update(points);for(const u of uniforms)assert.equal(u.homeLightRunCount.value,0);
  }
  console.log(JSON.stringify({status:'PASS',transitions,checkedRuns,checkedSelections,capacities:[18,72],shadowPrefixes:[0,1,2,8],pointBlockByteIdenticalToPinnedBase:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});
