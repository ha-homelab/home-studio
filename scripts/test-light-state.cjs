const {test}=require('node:test'),assert=require('node:assert/strict');
const appearance=require('../light-state.js');
const on=light=>appearance({state:'on',light});
const luminance=rgb=>rgb.map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4}).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);

test('indicator intensity follows HA brightness while scene color stays independent',()=>{
 for(const rgb of [[255,255,251],[255,160,70],[20,100,240]]){
  let previous=-1;
  for(const level of [0,1,55,128,150,191,255]){
   const value=on({color_mode:'rgb',rgb_color:rgb,brightness:level});
   assert.equal(value.brightness,level/255);assert.deepEqual(value.rgb,rgb);
   const distance=value.indicatorRGB.reduce((sum,c,i)=>sum+(c-[39,59,73][i])**2,0);
   assert.ok(distance>previous);previous=distance;
   if(level===0)assert.deepEqual(value.indicatorRGB,[39,59,73]);
   if(level===255)assert.deepEqual(value.indicatorRGB,rgb);
   const ink=value.text.match(/[0-9a-f]{2}/gi).map(c=>parseInt(c,16));
   const a=luminance(ink),b=luminance(value.indicatorRGB);
   assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=3,'The bulb remains readable on its actual fill');
  }
 }
 const dim=on({brightness:55,color_mode:'color_temp',color_temp_kelvin:6535,rgb_color:[255,255,251]});
 const full=on({brightness:255,color_mode:'color_temp',color_temp_kelvin:6535,rgb_color:[255,255,251]});
 assert.ok(luminance(dim.indicatorRGB)<luminance(full.indicatorRGB)/4);
 assert.equal(dim.percent,22);assert.equal(dim.text,'#ffffff');assert.equal(full.text,'#182027');
});

test('off, unavailable, zero and non-dimmable lights retain truthful states',()=>{
 for(const state of ['off','unavailable'])assert.deepEqual(appearance({state,light:{brightness:255}}).indicatorRGB,[39,59,73]);
 assert.equal(on({brightness:0}).brightness,0);
 for(const brightness of [null,undefined])assert.equal(on({brightness}).brightness,1);
 assert.equal(on({brightness:-10}).brightness,0);assert.equal(on({brightness:300}).brightness,1);
 assert.deepEqual(on({}).indicatorRGB,on({}).rgb);
});

test('RGB, HS, XY and temperature colors keep their existing interpretation',()=>{
 assert.deepEqual(on({color_mode:'hs',hs_color:[120,100]}).rgb,[0,255,0]);
 assert.deepEqual(on({color_mode:'rgbw',rgb_color:[100,110,120]}).rgb,[100,110,120]);
 assert.equal(on({color_mode:'color_temp',color_temp:250}).kelvin,4000);
 assert.ok(on({color_mode:'color_temp',color_temp_kelvin:2700}).rgb[2]<on({color_mode:'color_temp',color_temp_kelvin:6500}).rgb[2]);
 for(const color_mode of ['onoff','brightness'])assert.deepEqual(on({color_mode,rgb_color:[255,0,0]}).rgb,on({}).rgb);
 assert.ok(on({color_mode:'xy',xy_color:[.17,.7]}).rgb[1]>200);
 assert.deepEqual(on({color_mode:'xy',xy_color:[0,0]}).rgb,on({}).rgb);
 assert.deepEqual(on({rgb_color:[NaN,0,0]}).rgb,on({}).rgb);
 assert.deepEqual(on({rgb_color:[0,0,0]}).rgb,[0,0,0]);
});
