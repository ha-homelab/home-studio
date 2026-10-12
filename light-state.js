// HA exposes derived RGB for HS/XY/temperature lights. Brightness is independent.
// https://developers.home-assistant.io/docs/core/entity/light/
const resolveLightAppearance = (() => {
  const neutral = [255,244,226];
  const clamp = (n,lo,hi) => Math.min(hi,Math.max(lo,n));
  const isNumericTuple = (v,n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
  const clampRGB = v => v.map(n=>Math.round(clamp(n,0,255)));
  function kelvinToRGB(kelvin) {
    const t=clamp(kelvin,1000,40000)/100;
    return clampRGB([t<=66?255:329.698727446*Math.pow(t-60,-.1332047592),
      t<=66?99.4708025861*Math.log(t)-161.1195681661:288.1221695283*Math.pow(t-60,-.0755148492),
      t>=66?255:t<=19?0:138.5177312231*Math.log(t-10)-305.0447927307]);
  }
  function hsToRGB([h,s]) {
    h=((h%360)+360)%360/60;s=clamp(s/100,0,1);
    const x=s*(1-Math.abs(h%2-1));
    const c=h<1?[s,x,0]:h<2?[x,s,0]:h<3?[0,s,x]:h<4?[0,x,s]:h<5?[x,0,s]:[s,0,x];
    return clampRGB(c.map(v=>(v+1-s)*255));
  }
  function xyToRGB([x,y]) {
    if(x<0 || y<=0 || x+y>1)return neutral.slice();
    const X=x/y,Z=(1-x-y)/y;
    let c=[1.656492*X-.354851-.255038*Z,-.707196*X+1.655397+.036152*Z,.051713*X-.121364+1.011530*Z]
      .map(v=>v<=.0031308?12.92*v:1.055*Math.pow(v,1/2.4)-.055);
    const max=Math.max(1,...c);return clampRGB(c.map(v=>v/max*255));
  }
  return entity => {
    const a=entity?.light||{},mode=a.color_mode;
    const dimmable=Number.isFinite(a.brightness);
    const level=dimmable?clamp(a.brightness/255,0,1):1;
    let color=neutral.slice(),kelvin=null;
    if(mode==='color_temp') {
      kelvin=Number.isFinite(a.color_temp_kelvin)&&a.color_temp_kelvin>0?a.color_temp_kelvin:
        Number.isFinite(a.color_temp)&&a.color_temp>0?1000000/a.color_temp:null;
      color=isNumericTuple(a.rgb_color,3)?clampRGB(a.rgb_color):kelvin?kelvinToRGB(kelvin):color;
    } else if(['rgb','rgbw','rgbww','hs','xy'].includes(mode) || !mode) {
      // Prefer HA's conversion (including its RGBW/RGBWW white-channel mixture).
      if(isNumericTuple(a.rgb_color,3))color=clampRGB(a.rgb_color);
      else if(isNumericTuple(a.hs_color,2))color=hsToRGB(a.hs_color);
      else if(isNumericTuple(a.xy_color,2))color=xyToRGB(a.xy_color);
    } else if(mode==='white')color=[255,255,255];
    const brightness=entity?.state==='on'?level:0;
    const linear=color.map(c=>{c/=255;return c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4)});
    return {rgb:color,brightness,percent:dimmable?Math.round(level*100):null,kelvin:kelvin?Math.round(kelvin):null,
      text:linear[0]*.2126+linear[1]*.7152+linear[2]*.0722>.179?'#182027':'#ffffff'};
  };
})();
if(typeof module!=='undefined')module.exports=resolveLightAppearance;
