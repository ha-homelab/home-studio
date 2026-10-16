'use strict';
// Test-only CPU state stamp. No GL access, render, state update or scheduling.
function observeFirstNaturalRender(renderer, state, endpoint) {
  const original = renderer.render;
  let captured = false;
  renderer.render = function(scene, camera) {
    if (!captured && scene?.name !== 'interaction-copy') {
      captured = true;
      try {
        const value = {stage:'before-render', time:performance.now(), timeOrigin:performance.timeOrigin,
          ...state(), ownedPointLights:0, visiblePointLights:0, activePointLights:0};
        scene.traverse(object => { if (object.isPointLight) value.ownedPointLights++; });
        scene.traverseVisible(object => {
          if (object.isPointLight && object.layers.test(camera.layers)) {
            value.visiblePointLights++;
            if (object.intensity > 0) value.activePointLights++;
          }
        });
        // One asynchronous loopback message survives a blocked renderer. Never
        // await delivery or replace the original render's result/exception.
        fetch(endpoint, {method:'POST', mode:'no-cors', headers:{'Content-Type':'text/plain'},
          body:JSON.stringify(value), keepalive:true}).catch(() => {});
      } catch { /* Missing evidence fails diagnostic validation, not rendering. */ }
    }
    return original.apply(this, arguments);
  };
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const endpoint = '/__home-studio-first-natural-render';
function validateStamp(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  const keys = ['stage','time','timeOrigin','connected','renderCount','homeActive',
    'ownedPointLights','visiblePointLights','activePointLights'];
  assert.deepEqual(Object.keys(value).sort(), keys.sort());
  assert.equal(value.stage, 'before-render');
  for (const key of ['time','timeOrigin']) assert(Number.isFinite(value[key]) && value[key] >= 0);
  for (const key of ['connected','homeActive']) assert.equal(typeof value[key], 'boolean');
  for (const key of ['renderCount','ownedPointLights','visiblePointLights','activePointLights'])
    assert(Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 10000);
  assert(value.activePointLights <= value.visiblePointLights && value.visiblePointLights <= value.ownedPointLights);
  return value;
}
function createFirstRenderCapture(startupFile) {
  assert(startupFile && path.isAbsolute(startupFile), 'Original startup diagnostics must be enabled');
  const filename = path.join(path.dirname(startupFile), 'first-natural-render.jsonl');
  const seen = new Set();
  return {
    source(origin) {
      assert(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin));
      return `if(renderer)(${observeFirstNaturalRender.toString()})(renderer,()=>({connected:haConnected,renderCount,homeActive:!!homeView?.active}),${JSON.stringify(origin+endpoint)});`;
    },
    handle(request, response, sourceHash) {
      if (request.url !== endpoint) return false;
      const end = code => response.writeHead(code, {'Cache-Control':'no-store'}).end();
      if (request.socket.remoteAddress !== '127.0.0.1' || request.method !== 'POST' ||
          request.headers['content-type'] !== 'text/plain') { end(400); return true; }
      let body = '', bytes = 0, rejected = false;
      request.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2048) { if (!rejected) end(413); rejected = true; return; }
        body += chunk.toString('utf8');
      });
      request.on('end', () => {
        if (rejected) return;
        try {
          const value = validateStamp(JSON.parse(body));
          assert(/^[a-f0-9]{64}$/.test(sourceHash));
          if (seen.has(value.timeOrigin) || seen.size >= 2) { end(204); return; }
          fs.appendFileSync(filename, JSON.stringify({sourceHash,...value})+'\n');
          seen.add(value.timeOrigin);
          end(204);
        } catch { end(400); }
      });
      return true;
    },
  };
}
module.exports = {observeFirstNaturalRender, validateStamp, createFirstRenderCapture};
