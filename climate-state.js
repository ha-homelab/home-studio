// Pure display state for live fan/climate readings; selected HVAC mode is not activity.
const {resolveFanStatus,resolveClimateStatus}=(()=>{
  const modes=['off','heat','cool','heat_cool','auto','dry','fan_only'];
  const actions=['off','idle','heating','cooling','drying','fan','preheating','defrosting'];
  const temperature=value=>Number.isFinite(value)&&Math.abs(value)<=1000?value:null;
  const unavailable=(reading,connected,states)=>{
    if(!connected)return 'disconnected';
    if(!reading)return 'missing';
    if(reading.restored)return 'restored';
    if(reading.state==='unavailable')return 'unavailable';
    if(!states.includes(reading.state))return 'unknown';
    return null;
  };

  function resolveFanStatus(reading,connected=true){
    const reason=unavailable(reading,connected,['on','off']);
    if(reason)return {available:false,powered:false,running:false,percentage:null,activity:reason};
    const reported=reading.fan?.percentage;
    const percentage=Number.isFinite(reported)&&reported>=0&&reported<=100?reported:null;
    const powered=reading.state==='on';
    // Binary fans need no speed attribute. An explicit zero means no movement.
    const running=powered&&percentage!==0;
    return {available:true,powered,running,percentage,activity:running?'running':powered?'idle':'off'};
  }

  function resolveClimateStatus(reading,connected=true){
    const reason=unavailable(reading,connected,modes);
    if(reason)return {available:false,powered:false,running:false,effect:null,mode:null,action:null,activity:reason,
      currentTemperature:null,targetTemperature:null,targetLow:null,targetHigh:null,unit:'',temperatureText:null,temperatureSource:null};
    const climate=reading.climate||{},mode=reading.state;
    const action=actions.includes(climate.hvac_action)?climate.hvac_action:null;
    const powered=mode!=='off';
    // Never infer heating or cooling from setpoints or mode alone. An integration
    // without hvac_action can report temperatures without claiming active work.
    const running=powered&&action!==null&&!['idle','off'].includes(action);
    const effect=!running?null:['heating','preheating'].includes(action)?'heat':
      ['cooling','drying'].includes(action)?'cool':action==='fan'?'fan':null;
    const currentTemperature=temperature(climate.current_temperature),targetTemperature=temperature(climate.temperature);
    let targetLow=temperature(climate.target_temp_low),targetHigh=temperature(climate.target_temp_high);
    if(targetLow===null||targetHigh===null||targetLow>targetHigh){targetLow=null;targetHigh=null;}
    const unit=['°C','°F','K'].includes(climate.temperature_unit)?climate.temperature_unit:'';
    const format=value=>String(Number(value.toFixed(1)))+(unit?' '+unit:'');
    const temperatureSource=currentTemperature!==null?'current':targetTemperature!==null?'target':targetLow!==null?'range':null;
    const temperatureText=temperatureSource==='current'?format(currentTemperature):temperatureSource==='target'?format(targetTemperature):
      temperatureSource==='range'?format(targetLow)+' – '+format(targetHigh):null;
    return {available:true,powered,running,effect,mode,action,activity:powered?action||'unknown':'off',
      currentTemperature,targetTemperature,targetLow,targetHigh,unit,temperatureText,temperatureSource};
  }
  return {resolveFanStatus,resolveClimateStatus};
})();

if(typeof module!=='undefined')module.exports={resolveFanStatus,resolveClimateStatus};
