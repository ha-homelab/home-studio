// Execute the real startup/render/resize functions with a deterministic renderer.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const candidate=fs.readFileSync(path.join(__dirname,'../viewer.js'),'utf8');
function exercise(source,embedded,{hidden=false,initialRoom=null,failRender=false}={}){
 const errors=[],loadError={style:{}},calls=[],sizes=[],box={width:hidden?0:800,height:hidden?0:600};
 const c=vm.createContext({embedded,window:{},homeView:null,renderCount:0,scene:{},model:{initial_room:initialRoom},camera:{updateProjectionMatrix(){}},console:{error(e){errors.push(e.message)}},updateWallOutlines(){},updateEditorCamera(){},$(id){return id==='loadError'?loadError:{getBoundingClientRect:()=>box}},renderer:{setSize(w,h){sizes.push([w,h])},render(){calls.push('editor')}},focusRoom(id){c.focused=id;c.window.renderModel()},rebuildInventoryView(){c.window.renderModel()}});
 const declaration=source.match(/^let initialViewReady=.*;$/m)?.[0]||'';
 const render=source.split('\n').find(l=>l.startsWith('function render(){'));
 const resize=source.split('\n').find(l=>l.startsWith("let viewSize='';")).split(';const observer=')[0]+';';
 const report=source.split('\n').find(l=>l.startsWith('function report3DError('))||'';
 vm.runInContext([declaration,report,render,resize].join('\n'),c);
 c.window.resizeModel(); // Existing initial resize before __HOME_JS__.
 c.homeView={active:false,setActive(value){this.active=value},render(){if(failRender)throw Error('first draw failed');calls.push('home');c.renderCount++}};
 const bootstrap=source.split('\n').find(l=>l.startsWith('rebuildInventoryView();if(embedded)')).split('window.floorplan=')[0];
 vm.runInContext(bootstrap+'this.completed=true;',c);
 return {c,calls,sizes,box,errors,loadError};
}
const embedded=exercise(candidate,true);assert.deepEqual(embedded.calls,['home']);assert.deepEqual(embedded.sizes,[[800,600]]);
embedded.c.window.resizeModel();assert.deepEqual(embedded.calls,['home'],'Unchanged ResizeObserver callback must not duplicate draw');
embedded.c.homeView.setActive(false);embedded.c.window.resizeModel();assert.deepEqual(embedded.calls,['home','editor']);
embedded.c.homeView.setActive(true);embedded.c.window.resizeModel();assert.deepEqual(embedded.calls,['home','editor','home']);
embedded.box.width=1000;embedded.c.window.resizeModel();assert.equal(embedded.calls.length,4,'Subsequent resize still draws');
embedded.c.window.renderModel();assert.equal(embedded.calls.length,5,'Subsequent explicit/context-restored render still draws');
const failed=exercise(candidate,true,{failRender:true});assert.deepEqual(failed.errors,['first draw failed']);assert.equal(failed.loadError.style.display,'block');assert.match(failed.loadError.textContent,/first draw failed/);assert.equal(failed.c.completed,true,'First-draw failure must not abort bootstrap');
const hidden=exercise(candidate,true,{hidden:true});assert.deepEqual(hidden.calls,[]);hidden.box.width=800;hidden.box.height=600;hidden.c.window.resizeModel();assert.deepEqual(hidden.calls,['home']);
for(const initialRoom of [null,'L']){
 const b=exercise(candidate,false,{initialRoom});assert.deepEqual(b.calls,initialRoom?['editor','editor','editor']:['editor','editor']);assert.deepEqual(b.sizes,[[800,600]]);assert.equal(b.c.focused,initialRoom||undefined);
}
console.log(JSON.stringify({status:'PASS',candidateEmbeddedInitialModes:['home'],checks:['actual source render/resize/bootstrap execution','one initial correctly-sized Home draw','no duplicate unchanged resize','Home/editor switching preserved','later resize and explicit render preserved','hidden initial element draws when visible','standalone and initial_room selection retain editor rendering','first draw throw reports existing fallback without aborting bootstrap']},null,2));
