// Bounded startup evidence for isolated, loopback-only native browser fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const endpoint = '/__home-studio-startup';
const events = new Set(['context-before','context-after','gpu','profile',
  'compile-before','compile-after','link-before','link-after','link-status-before','link-status-after']);

function installStartupProbe(origin) {
  // The host injects its exact origin; sandboxed srcdoc cannot read its parent.
  let host;
  try { host = new URL(origin); } catch { return; }
  if (host.protocol !== 'http:' || host.hostname !== '127.0.0.1') return;
  const url = host.origin + '/__home-studio-startup';
  let sequence = 0, canvas, gl;
  const send = (event, extra = {}) => {
    if (sequence >= 10) return;
    try {
      const value = {sequence:++sequence, event, time:performance.now(), ...extra};
      if (canvas) value.canvas = [canvas.width, canvas.height];
      if (gl) value.drawingBuffer = [gl.drawingBufferWidth, gl.drawingBufferHeight];
      // No await or scheduling change: the separate fixture process persists
      // the request even if the next synchronous GL operation blocks the page.
      fetch(url, {method:'POST', mode:'no-cors', headers:{'Content-Type':'text/plain'},
        body:JSON.stringify(value), keepalive:true}).catch(() => {});
    } catch { /* Diagnostics must not change the application's exception path. */ }
  };
  window.__homeStudioStartupProfile = profile => send('profile', {profile});
  const original = HTMLCanvasElement.prototype.getContext;
  let started = false;
  HTMLCanvasElement.prototype.getContext = function(...args) {
    if (started || !String(args[0]).startsWith('webgl')) return original.apply(this,args);
    started = true; canvas = this; send('context-before');
    const context = original.apply(this,args);
    gl = context; send('context-after', {created:!!gl});
    if (!gl) return context;
    try {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      send('gpu', {gpu:{version:gl.getParameter(gl.VERSION),
        renderer:gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)}});
    } catch { /* Preserve ordinary behavior when renderer information is hidden. */ }
    for (const [method, label] of [['compileShader','compile'], ['linkProgram','link'], ['getProgramParameter','link-status']]) {
      const call = gl[method]; let recorded = false;
      gl[method] = function(...values) {
        if (recorded || (method === 'getProgramParameter' && values[1] !== gl.LINK_STATUS)) return call.apply(this,values);
        recorded = true; send(label+'-before');
        const result = call.apply(this,values);
        send(label+'-after');
        return result;
      };
    }
    return context;
  };
}

function validateCheckpoint(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  const allowed = new Set(['sequence','event','time','canvas','drawingBuffer','created','gpu','profile']);
  assert(Object.keys(value).every(key => allowed.has(key)), 'Unexpected checkpoint field');
  assert(Number.isInteger(value.sequence) && value.sequence >= 1 && value.sequence <= 10);
  assert(events.has(value.event));
  assert(Number.isFinite(value.time) && value.time >= 0 && value.time <= 1e9);
  for (const key of ['canvas','drawingBuffer']) if (key in value) {
    assert(Array.isArray(value[key]) && value[key].length === 2);
    assert(value[key].every(n => Number.isInteger(n) && n >= 0 && n <= 1000000));
  }
  if ('created' in value) assert(typeof value.created === 'boolean');
  if ('gpu' in value) {
    assert(value.gpu && Object.keys(value.gpu).length === 2);
    for (const key of ['version','renderer']) assert(typeof value.gpu[key] === 'string' && value.gpu[key].length <= 256);
  }
  if ('profile' in value) {
    const keys = new Set(['pixels','pointShadows','pointShadowSize','sunShadowSize','shadowSize']);
    assert(value.profile && Object.keys(value.profile).length > 0);
    for (const [key,n] of Object.entries(value.profile)) assert(keys.has(key) && Number.isInteger(n) && n >= 0 && n <= 2000000);
  }
  return value;
}

function createStartupDiagnostics(filename) {
  if (!filename) return {scriptFor:()=>'', checkpointSource:source=>source, allowLoopback:source=>source, handle:()=>false};
  assert(path.isAbsolute(filename), 'Startup diagnostics output must be an absolute host path');
  const seen = new Set();
  return {
    scriptFor(origin) {
      assert(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin), 'Exact loopback fixture origin required');
      return `(${installStartupProbe.toString()})(${JSON.stringify(origin)});`;
    },
    allowLoopback(source, origin) {
      // Only the served diagnostic fixture permits this endpoint. The shipped
      // viewer keeps connect-src 'none'; non-loopback hosts remain forbidden.
      assert.equal(source.split("connect-src 'none'").length, 2, 'Viewer connection policy must occur exactly once');
      assert(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin), 'Exact loopback fixture origin required');
      return source.replace("connect-src 'none'", 'connect-src '+origin);
    },
    checkpointSource(source, anchor, expression) {
      assert.equal(source.split(anchor).length, 2, 'Startup profile anchor must occur exactly once');
      return source.replace(anchor, anchor+`;window.__homeStudioStartupProfile?.(${expression});`);
    },
    handle(request, response, sourceHash) {
      if (request.url !== endpoint) return false;
      const end = code => response.writeHead(code, {'Cache-Control':'no-store'}).end();
      if (request.socket.remoteAddress !== '127.0.0.1' || request.method !== 'POST' ||
          request.headers['content-type'] !== 'text/plain') { end(400); return true; }
      let body = '', bytes = 0, rejected = false;
      request.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 4096) { if (!rejected) end(413); rejected = true; return; }
        body += chunk.toString('utf8');
      });
      request.on('end', () => {
        if (rejected) return;
        try {
          const value = validateCheckpoint(JSON.parse(body));
          // Later fixture cycles intentionally do not restart the ten-event
          // host budget or produce HTTP errors in otherwise healthy pages.
          if (seen.has(value.sequence) || seen.size >= 10) { end(204); return; }
          assert(/^[a-f0-9]{64}$/.test(sourceHash), 'Source hash required');
          fs.appendFileSync(filename, JSON.stringify({sourceHash,...value})+'\n', 'utf8');
          seen.add(value.sequence);
          end(204);
        } catch { end(400); }
      });
      return true;
    },
  };
}

module.exports = {createStartupDiagnostics, installStartupProbe, validateCheckpoint};
