// Generated viewer acceptance with fictional devices and a local, credential-free parent.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http'),{spawnSync}=require('node:child_process'),{chromium}=require('playwright');
const {browserLaunchOptions}=require('./browser-stability-diagnostics.cjs');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'home-family-'));
(async()=>{
 let browser,server;
 try{
  const project=JSON.parse(fs.readFileSync(path.join(root,'planner/example-home.json'),'utf8'));
  const template=project.floors[0].items[0];
  project.floors[0].items=[['lamp','light.desk','lamp'],['temperature','sensor.temperature','sensor']].map(([id,entity_id,type],i)=>({...template,id,name:id,entity_id,type,position_m:{x:1+i,y:.2,z:1},dimensions_m:{width:.2,height:.2,depth:.2}}));
  fs.writeFileSync(path.join(temporary,'project.json'),JSON.stringify(project));
  const built=spawnSync(process.env.PYTHON||'python3',['scripts/build-planner-project.py','--project',path.join(temporary,'project.json'),'--output',path.join(temporary,'build')],{cwd:root,encoding:'utf8'});
  assert.equal(built.status,0,built.stderr||built.stdout);
  const plain=fs.readFileSync(path.join(temporary,'build/main/index.html'),'utf8');
  const embedded=plain.replace('<head>','<head><script>window.__HOME_FLOORPLAN_EMBED__=true;</script>');
  server=http.createServer((request,response)=>{
   response.setHeader('Content-Type','text/html');
   response.end(request.url==='/offline'?plain:'<!doctype html><style>body{margin:0}iframe{width:100%;height:100vh;border:0}</style>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch(browserLaunchOptions('chromium',true));
  const page=await browser.newPage({viewport:{width:1200,height:850}}),errors=[];
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(String(error)));
  await page.addInitScript(()=>{
   window.tourDownloadAttempts=0;window.tourCaptureAttempts=0;
   const click=HTMLAnchorElement.prototype.click;
   HTMLAnchorElement.prototype.click=function(...args){if(this.download)tourDownloadAttempts++;return click.apply(this,args);};
   const capture=HTMLCanvasElement.prototype.captureStream;
   if(capture)HTMLCanvasElement.prototype.captureStream=function(...args){tourCaptureAttempts++;return capture.apply(this,args);};
  });
  await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
  async function mount(canEdit){
   await page.goto(origin);
   await page.evaluate(({html,canEdit})=>{const frame=document.createElement('iframe');frame.sandbox=canEdit?'allow-scripts allow-downloads allow-forms':'allow-scripts';frame.srcdoc=html;document.body.append(frame);},{html:embedded,canEdit});
   const frame=page.frameLocator('iframe');await frame.locator('#homeRoom').waitFor();
   await page.evaluate(({items,canEdit})=>{
    const channel=new MessageChannel();window.messages=[];window.channel=channel.port1;channel.port1.onmessage=event=>{
     if(event.data.type==='map_request'&&event.data.action==='get'){
      channel.port1.postMessage({type:'map_result',request_id:event.data.request_id,success:true,result:{revision:0,configured:false,config:null,reference:null}});return;
     }
     messages.push(event.data);
    };
    document.querySelector('iframe').contentWindow.postMessage({type:'home-floorplan:init',can_edit:canEdit,items},'*',[channel.port2]);
   },{items:project.floors[0].items,canEdit});
   await page.waitForFunction(()=>messages.some(message=>message.type==='model_config'));
   await page.evaluate(()=>channel.postMessage({type:'states',connected:true,states:{'light.desk':{state:'off',can_control:true},'sensor.temperature':{state:'21',unit:'°C',can_control:false}}}));
   await frame.locator('[data-home-device="lamp"]').waitFor();
   return frame;
  }
  async function openTour(frame){
   await frame.locator('#homeCameraTour').click();
   const tour=frame.locator('.camera-tour-host:not([hidden])');
   await tour.getByRole('button',{name:'Save current view',exact:true}).click();
   const duration=tour.locator('input[type="number"]');await duration.fill('0.25');await duration.press('Tab');
   return tour;
  }
  let frame=await mount(false);
  assert.equal(await frame.locator('#editLayout').isVisible(),false);
  assert.equal(await frame.locator('aside').isVisible(),false);
  assert.equal(await frame.locator('aside').evaluate(node=>node.inert),true);
  assert.equal(await frame.locator('.home-room-label:visible').count(),0,'overview starts with fewer labels');
  await frame.locator('#homeRoomLabels').click();assert.equal(await frame.locator('.home-room-label:visible').count(),project.floors[0].rooms.length);
  await frame.locator('#homeDeviceFilter').selectOption('controls');
  assert.equal(await frame.locator('[data-home-device="temperature"]').isVisible(),false);
  assert.equal(await frame.locator('[data-home-device="lamp"]').isVisible(),true);
  await frame.locator('#homeDeviceFilter').selectOption('all');
  let tour=await openTour(frame);
  assert.equal(await tour.getByRole('button',{name:'Export route',exact:true}).isDisabled(),true);
  assert.equal(await tour.getByRole('button',{name:'Record video',exact:true}).isDisabled(),true);
  assert.equal(await tour.getByRole('button',{name:'Import route',exact:true}).isEnabled(),true);
  assert.equal(await tour.getByText('You can create and play tours here. Your Home Assistant access does not allow route or video downloads.',{exact:true}).count(),1);
  // Forced clicks also reach the action guards without requesting a blocked download.
  await tour.getByRole('button',{name:'Export route',exact:true}).dispatchEvent('click');
  await tour.getByRole('button',{name:'Record video',exact:true}).dispatchEvent('click');
  await tour.getByRole('button',{name:'Play',exact:true}).click();
  await tour.locator('.camera-tour-status').filter({hasText:'Tour finished'}).waitFor();
  assert.deepEqual(await frame.locator('#homeView').evaluate(()=>[tourDownloadAttempts,tourCaptureAttempts]),[0,0]);
  await tour.getByRole('button',{name:'Close camera tour',exact:true}).click();
  assert.equal(await frame.locator('[data-home-device="temperature"]').isVisible(),true);
  // Hidden editing buttons and arbitrary preference messages cannot release this mode.
  await frame.locator('#editLayout').evaluate(button=>button.click());
  await frame.locator('#export').evaluate(button=>button.click());
  await frame.locator('#itemForm').evaluate(form=>form.dispatchEvent(new Event('submit',{cancelable:true})));
  await page.evaluate(()=>channel.postMessage({type:'view_preferences',can_edit:true,editLocked:false}));
  assert.equal(await frame.locator('#homeView').evaluate(()=>window.floorplan.canEdit),false);
  assert.equal(await frame.locator('#homeView').evaluate(()=>window.floorplan.homeMode),true);
  assert.equal(await frame.locator('#homeView').evaluate(()=>window.floorplan.items.length),2);
  assert.equal(await page.evaluate(()=>messages.filter(message=>['save','export'].includes(message.type)).length),0);
  await frame.locator('[data-home-device="lamp"]').click();
  await page.waitForFunction(()=>messages.some(message=>message.type==='toggle'));
  await page.evaluate(()=>channel.postMessage({type:'states',connected:true,states:{'light.desk':{state:'on',can_control:false},'sensor.temperature':{state:'21',unit:'°C',can_control:false}}}));
  await frame.locator('[data-home-device="lamp"]').waitFor({state:'visible'});
  await frame.locator('[data-home-device="lamp"][data-state="on"]').waitFor();
  assert.equal(await frame.locator('[data-home-device="lamp"]').isDisabled(),true,'readable devices can lack control permission');
  await frame.locator('[data-home-details="lamp"]').click();
  await page.waitForFunction(()=>messages.some(message=>message.type==='more_info'));
  frame=await mount(true);
  tour=await openTour(frame);
  assert.equal(await tour.getByRole('button',{name:'Record video',exact:true}).isEnabled(),true);
  const [ownerDownload]=await Promise.all([page.waitForEvent('download'),tour.getByRole('button',{name:'Export route',exact:true}).click()]);
  assert.equal(ownerDownload.suggestedFilename(),'camera-tour.json');assert.equal(await ownerDownload.failure(),null);
  await tour.getByRole('button',{name:'Close camera tour',exact:true}).click();
  await frame.locator('#editLayout').click();assert.equal(await frame.locator('aside').isVisible(),true);
  assert.equal(await frame.locator('#homeView').evaluate(()=>window.floorplan.canEdit),true);
  await page.goto(origin+'/offline');await page.locator('#openHome').click();
  tour=await openTour(page);
  assert.equal(await tour.getByRole('button',{name:'Record video',exact:true}).isEnabled(),true);
  const [standaloneDownload]=await Promise.all([page.waitForEvent('download'),tour.getByRole('button',{name:'Export route',exact:true}).click()]);
  assert.equal(standaloneDownload.suggestedFilename(),'camera-tour.json');assert.equal(await standaloneDownload.failure(),null);
  await tour.getByRole('button',{name:'Close camera tour',exact:true}).click();await page.locator('#editLayout').click();
  assert.equal(await page.locator('aside').isVisible(),true,'offline editor remains editable');
  assert.deepEqual(errors,[]);
  console.log('PASS: family playback without download/capture attempts, owner/standalone tour exports, immutable host edit grant, allowed controls, read-only devices, label/device filters, admin editing, offline editing.');
 }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
