// Exercise the real renderer and native host without operating any device.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {chromium}=require('playwright');
const http=require('node:http');
const root=path.resolve(__dirname,'..');
(async()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'home-lock-'));
  let browser;
  const server=http.createServer((request,response)=>{response.setHeader('Content-Type','text/html');response.end('<home-floorplan-panel></home-floorplan-panel>');});
  try{
    const output=path.join(temporary,'viewer.html');
    const built=spawnSync('python3',['-c',`import json,sys
from pathlib import Path
from planner.project import validate_project,make_floor,render_viewer
p=json.loads(Path('planner/example-home.json').read_text())
p['floors'][0]['items'][0].update(name='Front door',entity_id='lock.front_door')
p['floors'][0]['items'][1].update(name='Test light',entity_id='light.test')
p['floors'][0]['items'].append(dict(p['floors'][0]['items'][0],id='test_curtain',name='Test curtain',entity_id='cover.test',position_m={'x':5,'y':0,'z':2}))
p=validate_project(p)
data,svg=make_floor(p,p['floors'][0],None)
Path(sys.argv[1]).write_text(render_viewer(data,svg))`,output],{cwd:root,encoding:'utf8'});
    assert.equal(built.status,0,built.stderr);
    const html=fs.readFileSync(output,'utf8').replace('<head>','<head><script>window.__HOME_FLOORPLAN_EMBED__=true;</script>');
    const items=JSON.parse(html.match(/<script id="modelData" type="application\/json">([\s\S]*?)<\/script>/)[1]).inventory;
    browser=await chromium.launch({headless:true,args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const page=await browser.newPage({viewport:{width:1350,height:950}}),errors=[];
    page.on('pageerror',error=>errors.push(String(error)));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.addScriptTag({path:path.join(root,'custom_components/home_floorplan/static/panel.js')});
    await page.evaluate(({html,items})=>{
      const panel=document.querySelector('home-floorplan-panel');
      window.calls=[];window.inspected=[];
      panel.addEventListener('hass-more-info',event=>inspected.push(event.detail.entityId));
      window.hass={connected:true,states:{},callWS:async message=>{
        if(message.type!=='home_floorplan/viewer')calls.push(message);
        return {html,items,revision:1,floor:'main',floors:['main'],site_features:false};
      },callService:(...args)=>calls.push(args)};
      window.changeLock=(state,connected=true)=>{
        hass.connected=connected;hass.states={'cover.test':{state:'open',attributes:{friendly_name:'Test curtain',supported_features:15,current_position:50}},'light.test':{state:'on',attributes:{friendly_name:'Test light'}},...(state===null?{}:{'lock.front_door':{state,attributes:{friendly_name:'Front door'}}})};
        panel.hass=hass;
      };
      changeLock('locked');
    },{html,items});
    const frame=page.frameLocator('iframe'),marker=frame.locator('[data-home-item="studio_table"]'),card=frame.locator('[data-home-device="studio_table"]');
    await marker.waitFor();
    const states={locked:'Locked',unlocked:'Unlocked',locking:'Locking',unlocking:'Unlocking',jammed:'Jammed',open:'Open',unknown:'Unavailable',unavailable:'Unavailable',on:'Unavailable'};
    for(const [state,label] of Object.entries(states)){
      await page.evaluate(state=>changeLock(state),state);
      const expected=['unknown','unavailable','on'].includes(state)?'unavailable':state;
      await marker.locator('svg').waitFor();
      // Wait on the state delivered over MessagePort, not the host's synchronous update.
      await frame.locator(`[data-home-item="studio_table"][data-state="${expected}"]`).waitFor();
      assert.equal(await marker.getAttribute('data-kind'),'lock');
      assert.equal(await marker.getAttribute('aria-pressed'),null);
      assert.match(await marker.getAttribute('aria-label'),new RegExp(label));
      const shackle=await marker.locator('[data-lock-shackle]').getAttribute('d');
      assert.equal(shackle.endsWith('v4'),!['unlocked','unlocking','open'].includes(state));
      await card.click();
    }
    await page.evaluate(()=>changeLock('locked'));
    await frame.locator('[data-home-item="studio_table"][data-state="locked"]').waitFor();
    await marker.click();
    await page.waitForFunction(()=>inspected.length===10);
    assert.equal((await page.evaluate(()=>inspected)).length,10);
    assert.deepEqual(await page.evaluate(()=>calls),[],'inspection must not operate the lock or any other device');
    await frame.locator('#homeLanguage').selectOption('ru');
    assert.match(await marker.getAttribute('aria-label'),/Заперт/);
    await page.evaluate(()=>changeLock('locked',false));
    await frame.locator('[data-home-item="studio_table"][data-state="disconnected"]').waitFor();
    assert.equal(await marker.isDisabled(),true);
    await page.evaluate(()=>changeLock(null));
    await frame.locator('[data-home-item="studio_table"][data-state="missing"]').waitFor();
    assert.equal(await marker.isDisabled(),true);
    const before=await page.evaluate(()=>inspected.length);
    await page.evaluate(()=>{
      const panel=document.querySelector('home-floorplan-panel');
      window.hass.states['lock.unbound']={state:'locked',attributes:{}};
      panel.handleViewerMessage({type:'more_info',entity_id:'lock.unbound'},panel.generation);
    });
    assert.equal(await page.evaluate(()=>inspected.length),before,'unbound locks cannot open native controls');
    await page.evaluate(()=>changeLock('locked'));
    await frame.locator('[data-home-item="studio_table"][data-state="locked"]').waitFor();
    await page.locator('home-floorplan-panel #dry-run').click();
    assert.equal(await page.locator('home-floorplan-panel #dry-run').getAttribute('aria-pressed'),'true');
    await card.click();
    await page.waitForFunction(()=>document.querySelector('home-floorplan-panel').shadowRoot.querySelector('#notice').textContent.includes('команда не отправлена'));
    assert.equal(await page.evaluate(()=>inspected.length),before,'Dry run cannot open native lock controls');
    const light=frame.locator('[data-home-device="living_light"]');
    for(let attempt=0;attempt<2;attempt++){
      await light.click();
      await frame.locator('#homeFeedback').filter({hasText:'команда не отправлена'}).waitFor();
      await light.evaluate(button=>new Promise(resolve=>{
        const ready=()=>button.disabled?requestAnimationFrame(ready):resolve();ready();
      }));
      assert.equal(await frame.locator('[data-home-item="living_light"]').getAttribute('data-state'),'on',
        'The simulated click must not change the reported light state');
    }
    await frame.locator('#homeLanguage').selectOption('ar');
    await frame.locator('#homeFeedback').filter({hasText:'لم يُرسل'}).waitFor();
    assert.match(await page.locator('home-floorplan-panel #notice').textContent(),/لم يُرسل/,'existing host error also follows language');
    await frame.locator('#homeLanguage').selectOption('ru');
    await page.locator('home-floorplan-panel #dry-run').click();
    await frame.locator('[data-home-device="test_curtain"]').click();
    await frame.locator('#curtainDialog').waitFor();
    await page.locator('home-floorplan-panel #dry-run').click();
    await frame.locator('#curtainClose').click();
    await frame.locator('#curtainError').filter({hasText:'команда не отправлена'}).waitFor();
    assert.equal(await frame.locator('#curtainClose').isEnabled(),true,'blocked command clears curtain pending state');
    await frame.locator('#curtainOpen').click();
    await frame.locator('#curtainError').filter({hasText:'команда не отправлена'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>calls),[],'Dry run blocks buttons in a curtain dialog opened before enabling it');
    assert.equal(await page.evaluate(()=>hass.states['cover.test'].attributes.current_position),50,'no simulated curtain position');
    assert.deepEqual(await page.evaluate(()=>calls),[],'Dry run must not dispatch any service call');
    assert.deepEqual(errors,[]);
    console.log('PASS: lock states, shackle, native inspection, localization, disconnection and saved-binding guard; dry-run lock blocking, previously opened curtain dialog, localized retained feedback and cleared pending controls; zero device commands.');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
