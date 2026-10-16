// Output-only, passive restore boundary trace. No GL call, timer or render.
(function installNativeRestoreTrace(host) {
  const started=host.performance.now(), result={diagnosticOnly:true,mode:'passive',requests:0,restoredEvents:0,events:[]};
  const emit=(event,details={})=>{
    if(result.events.length>=40)return;
    const value={sequence:result.events.length+1,timeMs:host.performance.now(),event,...details};
    result.events.push(value);
    host.console.info('HOME_NATIVE_RESTORE '+JSON.stringify(value));
  };
  let observedCanvas=null;
  const captured=event=>{
    if(!result.requests)return;
    observedCanvas=event.target;
    result.restoredEvents++;
    emit('context-restored-capture',{trusted:event.isTrusted===true});
  };
  host.addEventListener('webglcontextrestored',captured,true);
  const api={
    invoke(original) {
      result.requests++;
      if(result.requests!==1)return original();
      emit('restore-request');
      try {
        host.__prepareRestoreDrawObserver();
        emit('draw-observer-installed');
      } catch(error) {
        result.observerError=String(error);
        emit('draw-observer-error',{error:String(error)});
        // A diagnostic installation failure must not suppress the real call.
      }
      emit('restore-call-before');
      try {
        const returned=original();
        emit('restore-call-return');
        return returned;
      } catch(error) {
        emit('restore-call-error',{error:String(error)});
        throw error;
      }
    },
    targetRestored(event) {
      if(result.requests && event.target===observedCanvas)
        emit('context-restored-target-tail',{trusted:event.isTrusted===true});
    },
    snapshot() {
      return {...result,started,events:result.events.map(value=>({...value}))};
    },
    dispose() {
      host.removeEventListener('webglcontextrestored',captured,true);
    }
  };
  host.__nativeRestoreTrace=api;
})(window);
