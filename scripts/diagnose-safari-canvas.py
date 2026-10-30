#!/usr/bin/env python3
"""Disposable hosted-runner diagnostic; never changes acceptance assertions."""
import argparse
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('safari', ROOT / 'scripts/test-safari-acceptance.py')
safari = importlib.util.module_from_spec(spec)
spec.loader.exec_module(safari)
original_planner = safari.native.planner
original_execute = safari.SafariWebDriver.execute
original_fixture_server = safari.fixture_server
fixture_identity = {}
current_output = None


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def fixture_server(name, log):
    server, info, project = original_fixture_server(name, log)
    fixture_identity.clear()
    fixture_identity.update(info)
    return server, info, project


def execute(self, script, *args):
    if script == safari.native.PLANNER_2D_PIXELS:
        self.screenshot(current_output / 'planner-before-readback.png')
        state = original_execute(self, """
          const c=document.getElementById('plan-canvas'),ctx=c.getContext('2d');
          return {phase:'before-first-acceptance-readback',state:window.__plannerPlanState(),
            attributes:ctx.getContextAttributes?.()??null,lost:ctx.isContextLost?.()??null,
            source:'post-load snapshot; no claim about earlier context events'};
        """)
        write(current_output / 'planner-before-readback.json', state)
    return original_execute(self, script, *args)


safari.fixture_server = fixture_server
safari.SafariWebDriver.execute = execute

SETUP = r"""
const [alpha,mode]=arguments;
document.body.replaceChildren();
const c=document.createElement('canvas');c.id='probe';document.body.append(c);
const events=[];for(const name of ['contextlost','contextrestored'])c.addEventListener(name,e=>events.push({type:e.type,time:performance.now()}));
const ctx=alpha==='default'?c.getContext('2d'):c.getContext('2d',{alpha:false});
window.probe={c,ctx,events,mode,alpha,phases:[]};
return {created:!!ctx,attributes:ctx.getContextAttributes?.()??null};
"""
RESIZE = r"""
const {c,ctx,mode}=window.probe,[w,h]=arguments,intermediate=[];
const set=(key,value)=>{c[key]=value;intermediate.push([c.width,c.height]);};
if(mode==='zero'){set('width',0);set('height',h);set('width',w);}
else if(mode==='one'){set('width',1);set('height',h);set('width',w);}
else if(mode==='shrink-first'){
  if(w<c.width){set('width',w);set('height',h);}else{set('height',h);set('width',w);}
}else{set('height',h);set('width',w);}
ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#ecdfc8';ctx.fillRect(0,0,w,h);
ctx.fillStyle='#164b3b';ctx.fillRect(20,20,w/2,h/2);ctx.fillStyle='#e9773b';ctx.fillRect(w/2,h/2,60,80);
return {width:c.width,height:c.height,intermediate,lost:ctx.isContextLost?.()??null,events:window.probe.events};
"""
READ = r"""
const {c,ctx,events}=window.probe;
try{
 const data=ctx.getImageData(0,0,c.width,c.height).data,colors=new Set();
 for(let i=0;i<data.length;i+=4)if(data[i+3])colors.add((data[i]<<16)|(data[i+1]<<8)|data[i+2]);
 return {status:'pixels-read',bytes:data.length,colors:[...colors],lost:ctx.isContextLost?.()??null,events};
}catch(e){return {status:'readback-failed',name:e.name,message:e.message,lost:ctx.isContextLost?.()??null,events};}
"""


def matrix(client, origin, project, record, save):
    client.call('WebDriver:Navigate', {'url': 'about:blank'})
    for alpha in ('opaque', 'default'):
        for mode in ('direct', 'zero', 'one', 'shrink-first'):
            sample = {'alpha': alpha, 'mode': mode, 'phases': []}
            record['samples'].append(sample)
            sample['context'] = client.execute(SETUP, alpha, mode)
            save()
            for number, (width, height) in enumerate(((934, 772), (772, 934), (934, 772))):
                phase = client.execute(RESIZE, width, height)
                sample['phases'].append(phase)
                client.screenshot(Path(record['output']) / f'{alpha}-{mode}-{number}-before-readback.png')
                phase['readback'] = client.execute(READ)
                save()


@contextlib.contextmanager
def source_variant(variant):
    if variant == 'original':
        yield
        return
    source = (ROOT / 'planner/editor.js').read_text(encoding='utf-8')
    old = "planCanvas.width = 0; planCanvas.height = Math.floor(size.height * dpr); planCanvas.width = Math.floor(size.width * dpr);"
    if variant == 'default-alpha':
        before = "ctx = planCanvas.getContext('2d', { alpha: false });"
        after = "ctx = planCanvas.getContext('2d');"
    elif variant == 'one-pixel':
        before, after = old, old.replace('planCanvas.width = 0;', 'planCanvas.width = 1;')
    elif variant == 'shrink-first':
        before, after = old, """const nextWidth = Math.floor(size.width * dpr), nextHeight = Math.floor(size.height * dpr);
    if (nextWidth < planCanvas.width) { planCanvas.width = nextWidth; planCanvas.height = nextHeight; }
    else { planCanvas.height = nextHeight; planCanvas.width = nextWidth; }"""
    else:
        raise ValueError(variant)
    if source.count(before) != 1:
        raise AssertionError('Expected exactly one diagnostic replacement')
    with tempfile.TemporaryDirectory(prefix='safari-canvas-source-') as directory:
        target = Path(directory)
        for child in ROOT.iterdir():
            if child.name not in ('planner', '.git', 'node_modules'):
                (target / child.name).symlink_to(child, target_is_directory=child.is_dir())
        (target / 'planner').mkdir()
        for child in (ROOT / 'planner').iterdir():
            if child.name != 'editor.js':
                (target / 'planner' / child.name).symlink_to(child, target_is_directory=child.is_dir())
        (target / 'planner/editor.js').write_text(source.replace(before, after), encoding='utf-8')
        previous = os.environ.get('PLANNER_STABILITY_SOURCE_ROOT')
        os.environ['PLANNER_STABILITY_SOURCE_ROOT'] = directory
        try:
            yield
        finally:
            if previous is None:
                os.environ.pop('PLANNER_STABILITY_SOURCE_ROOT', None)
            else:
                os.environ['PLANNER_STABILITY_SOURCE_ROOT'] = previous


def run(output, label, name='planner-256', variant='original'):
    global current_output
    current_output = output / label
    with source_variant(variant):
        record = safari.run_case(current_output, name, '/usr/bin/safaridriver')
    record['diagnosticLabel'] = label
    record['diagnosticSourceVariant'] = variant
    record['sourceHashScope'] = fixture_identity.get('sourceHashScope')
    record['sourceFiles'] = fixture_identity.get('sourceFiles')
    write(current_output / 'report.json', record)
    return {'label': label, 'status': record['status'], 'error': record.get('error'),
            'sourceHash': record.get('sourceHash'), 'sourceFiles': record.get('sourceFiles')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    output = parser.parse_args().output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    summary = {'sourceRevision': os.environ.get('GITHUB_SHA'), 'diagnosticOnly': True,
               'osVersion': subprocess.check_output(['sw_vers'], text=True), 'cases': []}
    preparation = safari.prepare_hosted_safari(output)
    summary['preparation'] = preparation
    if preparation['status'] != 'passed':
        write(output / 'diagnostic-summary.json', summary)
        return 1
    # Run the original planner before any viewer workload; its assertions are unchanged.
    summary['cases'].append(run(output, 'fresh-original'))
    safari.native.planner = matrix
    summary['cases'].append(run(output, 'canvas-matrix'))
    safari.native.planner = original_planner
    for variant in ('default-alpha', 'one-pixel', 'shrink-first'):
        summary['cases'].append(run(output, variant, variant=variant))
        write(output / 'diagnostic-summary.json', summary)
    for name in ('viewer-6', 'viewer-24'):
        summary['cases'].append(run(output, name, name=name))
    summary['cases'].append(run(output, 'after-viewers-original'))
    write(output / 'diagnostic-summary.json', summary)
    # This job gathers evidence. PR acceptance retains its original result and checks.
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
