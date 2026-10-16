#!/usr/bin/env python3
"""Prepare/run one separate passive replay of an observed native restore failure.

No production file is modified. The original two-cycle case and all its limits
remain intact. This replay is diagnostic-only, never a replacement acceptance.
"""
import argparse
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent
RESTORE_SCRIPT='window.restoreTestContext();return true;'
EXPECTED_SOURCE='f4a9ebba66b8f7ddce017535092f1885fbbfa8c0'
SOURCE_FILES=('viewer.js','home-view.js','room-lighting.js','planner/render-capacity.js','planner/interaction-render.js')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def eligible(record):
    samples=record.get('samples',[])
    second=samples[1] if len(samples)==2 else {}
    return (record.get('status')=='failed' and not record.get('diagnosticOnly') and
            record.get('suite')=='viewer-24' and
            record.get('os',{}).get('platform')=='darwin' and
            record.get('sourceRevision')==EXPECTED_SOURCE and
            RESTORE_SCRIPT in record.get('traceback','') and
            set(record.get('sourceFiles',{}))==set(SOURCE_FILES) and
            second.get('cycle')==1 and 'recovery' not in second and
            [state.get('active') for state in second.get('states',[])]==[72,0,36,72])


def validate_source(source,primary):
    revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
    if revision!=EXPECTED_SOURCE:raise ValueError('Restore source checkout is not the pinned candidate')
    if subprocess.check_output(['git','status','--porcelain','--untracked-files=no'],cwd=source,text=True).strip():
        raise ValueError('Restore source checkout has tracked modifications')
    actual={name:digest(source/name) for name in SOURCE_FILES}
    if actual!=primary.get('sourceFiles'):raise ValueError('Restore runtime bytes differ from the actual failed primary')
    return actual


def tree_hashes(root):
    values={}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():raise ValueError('Primary evidence tree must not contain symlinks')
        if path.is_file():values[str(path.relative_to(root))]=digest(path)
    return values


def load_module(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def configure(module,primary,output):
    """Change only observation around the original restore call, not its work."""
    source=inspect.getsource(module.viewer)
    loss='window.restoreTestContext=()=>e.restoreContext();'
    call="            client.execute('"+RESTORE_SCRIPT+"')"
    assert source.count(loss)==1 and source.count(call)==1
    assert source.count('for cycle in range(2):')==1
    original=source
    source=source.replace('def viewer(', 'def restore_diagnostic_viewer(',1)
    source=source.replace(loss,'window.restoreTestContext=()=>window.__nativeRestoreTrace.invoke(()=>e.restoreContext());',1)
    source=source.replace(call,'            trace_restore_call(client,record,save)',1)
    source=source.replace("    client.call('WebDriver:Navigate'", "    require(record.get('sourceFiles') == RESTORE_PRIMARY_FILES, 'Restore diagnostic source differs from failed primary')\n    client.call('WebDriver:Navigate'",1)
    # Retain the original post-viewer independent capacity/backend assertions,
    # which run_case intentionally omits for a generic diagnostic-only worker.
    source+='    assert_masked_capacity(record)\n    assert_requested_backend(record)\n'
    events=[]
    def trace_restore_call(client,record,save):
        def emit(event,**details):
            value={'event':event,'monotonicNs':time.monotonic_ns(),**details}
            events.append(value)
            record['restoreHostTrace']=list(events)
            with (output/'host-events.jsonl').open('a',encoding='utf-8') as stream:
                stream.write(json.dumps(value)+'\n');stream.flush()
            save()
        emit('execute-restore-before',script=RESTORE_SCRIPT)
        try:
            returned=client.execute(RESTORE_SCRIPT)
        except Exception as error:
            emit('execute-restore-error',error=str(error),errorType=type(error).__name__)
            raise
        emit('execute-restore-return')
        return returned
    module.RESTORE_PRIMARY_FILES=primary['sourceFiles']
    module.trace_restore_call=trace_restore_call
    module.browser_preferences=lambda port:{**primary['preferences'],'marionette.port':port,'devtools.console.stdout.content':True}
    module.NATIVE_GL_DIAGNOSTICS+='\n'+(HERE/'restore-trace.js').read_text()
    module.NATIVE_VIEWER_FRAME_DIAGNOSTICS+='\n'+(HERE/'passive-restore-draw.js').read_text()+'''
window.__prepareRestoreDrawObserver=()=>attachPassiveRestoreDrawDiagnostic(renderer,()=>({
  connected:haConnected,renderCount,profile:renderProfile,restore:window.__nativeRestoreTrace.snapshot()
}));
renderer.domElement.addEventListener('webglcontextrestored',event=>window.__nativeRestoreTrace.targetRestored(event));
'''
    exec(compile(source,'<passive-restore-diagnostic>','exec'),module.__dict__)
    module.viewer=module.restore_diagnostic_viewer
    return original,source


def recover_events(log):
    events=[]
    if not log.exists():return events
    for line in log.read_text(errors='replace').splitlines():
        if line.startswith('console.info: '):
            try:line=json.loads(line[len('console.info: '):])
            except (ValueError,TypeError):continue
        for prefix in ('HOME_NATIVE_RESTORE ','HOME_NATIVE_RESTORE_DRAW '):
            if prefix not in line:continue
            try:value=json.loads(line[line.index(prefix)+len(prefix):])
            except ValueError:continue
            if isinstance(value,dict) and len(events)<2040:
                events.append({'stream':'draw' if prefix.endswith('DRAW ') else 'restore',**value})
            break
    return events


def capture_complete(events):
    frames=[event for event in events if event.get('event')=='frame-after']
    return (len(frames)==1 and frames[0].get('done') is True and
            not frames[0].get('truncated') and not frames[0].get('error') and
            0 < frames[0].get('draws',0) <= 600 and
            any(event.get('event')=='restore-call-before' for event in events) and
            any(event.get('event')=='context-restored-capture' for event in events))


def worker(args):
    primary=json.loads(args.primary_report.read_text())
    if not eligible(primary):raise ValueError('The pinned candidate second-cycle viewer-24 restore-call failure is required')
    validate_source(args.source,primary)
    sys.path.insert(0,str(args.source/'scripts'))
    module=load_module(args.source/'scripts/test-waterfox-acceptance.py','restore_native_acceptance')
    installation=json.loads(args.installation.read_text())
    module.validate_installation(installation,args.product,args.expected_version)
    if installation!=primary['installation']:raise ValueError('Installation must equal the failed primary')
    subprocess.run(['codesign','--verify','--deep','--strict',str(Path(installation['binary']).parents[2])],check=True,timeout=60)
    os.environ['GITHUB_SHA']=primary['sourceRevision']
    os.environ['NATIVE_STARTUP_DIAGNOSTICS']='1'
    os.environ['HOME_STUDIO_SOURCE_ROOT']=str(args.source)
    original,changed=configure(module,primary,args.output)
    (args.output/'original-viewer.py').write_text(original)
    (args.output/'observed-viewer.py').write_text(changed)
    record=module.run_case(installation,args.output/primary['suite'],primary['suite'],primary.get('headless',False),diagnostic_only=True)
    return 0 if record['status']=='diagnostic-completed' else 1


def supervise(command,output):
    with (output/'worker.log').open('w') as stream:
        process=subprocess.Popen(command,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
        def kill(sig):
            try:os.killpg(process.pid,sig)
            except ProcessLookupError:pass
        try:return process.wait(timeout=180),False
        except subprocess.TimeoutExpired:
            kill(signal.SIGTERM)
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:kill(signal.SIGKILL);process.wait(timeout=5)
            return process.returncode,True
        finally:kill(signal.SIGKILL)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--primary-report',type=Path,required=True)
    parser.add_argument('--primary-root',type=Path,required=True,help='Entire immutable same-job candidate raw evidence directory')
    parser.add_argument('--installation',type=Path,required=True)
    parser.add_argument('--product',choices=('firefox','waterfox'),required=True)
    parser.add_argument('--expected-version',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--run',action='store_true',help='Explicitly allow one diagnostic browser replay')
    parser.add_argument('--worker',action='store_true',help=argparse.SUPPRESS)
    args=parser.parse_args()
    for name in ('source','primary_report','primary_root','installation','output'):setattr(args,name,getattr(args,name).resolve())
    if not args.run:parser.error('Prepared only; --run is required to launch a browser')
    if args.worker:return worker(args)
    if args.primary_root not in args.primary_report.parents:
        raise ValueError('Primary report must be inside the specified raw evidence root')
    if args.output==args.primary_root or args.primary_root in args.output.parents or args.output in args.primary_root.parents:
        raise ValueError('Diagnostic output must remain separate from the entire primary evidence tree')
    if args.output==args.source or args.source in args.output.parents:
        raise ValueError('Output must remain outside the source checkout')
    args.output.mkdir(parents=True,exist_ok=False)
    primary=json.loads(args.primary_report.read_text()); before=digest(args.primary_report)
    before_tree=tree_hashes(args.primary_root)
    receipt={'diagnosticOnly':True,'releaseEligible':False,'acceptanceStatus':'not-run','status':'skipped','primarySHA256':before,
      'installationFileSHA256':digest(args.installation),
      'sourceRevision':primary.get('sourceRevision'),'expectedSource':EXPECTED_SOURCE,'primaryTreeSHA256':before_tree,'limits':{'workerSeconds':180,'browserSeconds':180,'loadMs':30000,'dragMs':15000,'draws':600,'drawEvents':2000,'restoreEvents':40},
      'sourceRoot':str(args.source),'sourceCheckout':subprocess.check_output(['git','rev-parse','HEAD'],cwd=args.source,text=True).strip(),
      'nativeDriverSHA256':digest(args.source/'scripts/test-waterfox-acceptance.py'),
      'helperHashes':{name:digest(HERE/name) for name in ('diagnose-restore.py','restore-trace.js','passive-restore-draw.js')},
      'scope':'One separate unchanged two-cycle case, observing original restore API/events/first restored frame. No extra draws, GL queries or GPU fences. Not acceptance or a retry verdict.'}
    began=time.monotonic()
    try:
        if eligible(primary) and sys.platform=='darwin':
            receipt['verifiedRuntimeFiles']=validate_source(args.source,primary)
            command=[sys.executable,str(Path(__file__).resolve()),*sys.argv[1:],'--worker']
            code,expired=supervise(command,args.output)
            events=recover_events(args.output/primary['suite']/'browser.log')
            (args.output/'restore-events.jsonl').write_text(''.join(json.dumps(event)+'\n' for event in events))
            complete=capture_complete(events)
            receipt.update(status='diagnostic-completed' if code==0 and not expired and complete else 'diagnostic-incomplete',workerExitCode=code,deadlineExceeded=expired,captureComplete=complete)
            receipt['capturedEvents']=len(events)
    finally:
        if 'verifiedRuntimeFiles' in receipt:
            try:
                receipt['sourceUnchanged']=validate_source(args.source,primary)==receipt['verifiedRuntimeFiles']
            except Exception as error:
                receipt['sourceUnchanged']=False;receipt['sourceVerificationError']=str(error)
        receipt['installationFileUnchanged']=digest(args.installation)==receipt['installationFileSHA256']
        receipt.update(primaryUnchanged=digest(args.primary_report)==before,primaryTreeUnchanged=tree_hashes(args.primary_root)==before_tree,durationMs=round((time.monotonic()-began)*1000))
        (args.output/'diagnostic.json').write_text(json.dumps(receipt,indent=2)+'\n')
    if not receipt['primaryUnchanged'] or not receipt['primaryTreeUnchanged']:raise RuntimeError('Primary evidence bytes changed during diagnostic')
    if not receipt['installationFileUnchanged'] or receipt.get('sourceUnchanged') is False:
        raise RuntimeError('Candidate source or installation receipt changed during diagnostic')
    print(json.dumps(receipt,indent=2))
    return 0 if receipt['status'] in ('skipped','diagnostic-completed') else 1


if __name__=='__main__':sys.exit(main())
