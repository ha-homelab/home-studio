'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Module = require('node:module');
const helperPath = path.join(__dirname, 'first-natural-render.cjs');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function adaptFixture(content) {
  if (content.includes('const firstRender = require(')) throw Error('Fixture already has the observation adapter');
  const replaceOnce = (before, after) => {
    if (content.split(before).length !== 2) throw Error('Original fixture observation anchor changed');
    content = content.replace(before, () => after);
  };
  const initialization = "const startup = createStartupDiagnostics(fixtureOnly && process.env.HOME_STUDIO_STARTUP_DIAGNOSTICS_FILE);";
  replaceOnce(initialization, initialization + `\nconst firstRender = require(${JSON.stringify(helperPath)}).createFirstRenderCapture(process.env.HOME_STUDIO_STARTUP_DIAGNOSTICS_FILE);`);
  replaceOnce('    if(startup.handle(request,response,sourceHash))return;',
    '    if(firstRender.handle(request,response,sourceHash))return;\n    if(startup.handle(request,response,sourceHash))return;');
  const origin = '    const startupScript = startup.scriptFor(origin);';
  // Literal function replacement prevents $ replacement tokens in injected JS.
  // Installed after the original capture wrapper but before native tail wrapper.
  replaceOnce(origin, "    html = html.replace('</script></body>', () => firstRender.source(origin)+'</script></body>');\n" + origin);
  return content;
}
if (path.basename(process.argv[1] || '') === 'test-browser-stability.cjs') {
  const target = fs.realpathSync(process.argv[1]), compile = Module.prototype._compile;
  Module.prototype._compile = function(content, filename) {
    if (path.resolve(filename) === target) {
      const adapted = adaptFixture(content);
      const startup = process.env.HOME_STUDIO_STARTUP_DIAGNOSTICS_FILE;
      if (!startup || !path.isAbsolute(startup)) throw Error('Original startup output required');
      fs.writeFileSync(path.join(path.dirname(startup), 'first-render-adaptation.json'), JSON.stringify({
        diagnosticOnly:true, originalPath:filename, originalSha256:digest(content),
        adaptedSha256:digest(adapted), helperSha256:digest(fs.readFileSync(helperPath)),
        preloadSha256:digest(fs.readFileSync(__filename)), changes:'Three test-only fixture anchors; original case logic unchanged'
      }, null, 2)+'\n');
      content = adapted;
    }
    return compile.call(this, content, filename);
  };
}
module.exports = {adaptFixture};
