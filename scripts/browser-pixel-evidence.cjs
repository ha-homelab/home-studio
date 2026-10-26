// Inspect an already captured screenshot. This never reads the live WebGL buffer
// or requests a render, and runs only after the measured viewer interactions.
const assert = require('node:assert/strict');

function sceneScreenshotRegion(bounds, viewport, overlays=[]) {
  assert(bounds && viewport && [bounds.x,bounds.y,bounds.width,bounds.height,viewport.width,viewport.height].every(Number.isFinite),
    'Screenshot canvas bounds must be finite');
  // The center excludes the editor's edge controls and lower-left help overlay.
  const left=Math.max(0,bounds.x+bounds.width*.2), top=Math.max(0,bounds.y+bounds.height*.2);
  const right=Math.min(viewport.width,bounds.x+bounds.width*.8);
  let bottom=Math.min(viewport.height,bounds.y+bounds.height*.8);
  for(const overlay of overlays.filter(Boolean)) {
    assert([overlay.x,overlay.y,overlay.width,overlay.height].every(Number.isFinite),'Overlay bounds must be finite');
    if(overlay.width>0&&overlay.height>0&&overlay.x<right&&overlay.x+overlay.width>left&&overlay.y<bottom&&overlay.y+overlay.height>top)
      bottom=Math.min(bottom,overlay.y);
  }
  assert(right-left>=16 && bottom-top>=16, 'Screenshot must contain a visible canvas interior');
  return {x:left,y:top,width:right-left,height:bottom-top};
}

function analyzeScenePixels({data,width,height}) {
  assert(Number.isInteger(width)&&width>0&&Number.isInteger(height)&&height>0&&data.length===width*height*4,
    'Screenshot pixels must be a complete RGBA image');
  const bins=new Map(), low=[255,255,255], high=[0,0,0];
  let opaque=0;
  for(let i=0;i<data.length;i+=4) {
    if(data[i+3]<250) continue;
    opaque++;
    const key=(data[i]>>4)*256+(data[i+1]>>4)*16+(data[i+2]>>4);
    bins.set(key,(bins.get(key)||0)+1);
    for(let channel=0;channel<3;channel++) {
      low[channel]=Math.min(low[channel],data[i+channel]);high[channel]=Math.max(high[channel],data[i+channel]);
    }
  }
  const pixels=width*height, largest=Math.max(0,...bins.values());
  const significantBins=[...bins.values()].filter(count=>count>=Math.max(4,pixels*.0001)).length;
  const variation=opaque ? 1-largest/opaque : 0, range=Math.max(...high.map((value,i)=>value-low[i]));
  return {pixels,opaqueFraction:opaque/pixels,significantBins,variation,range,
    nonflat:opaque/pixels>=.99&&significantBins>=8&&variation>=.02&&range>=24};
}

async function inspectSceneScreenshot(page, png, bounds, viewport, overlays) {
  const region=sceneScreenshotRegion(bounds,viewport,overlays);
  // Use the browser's existing PNG decoder on the saved image, in the fixture
  // host. The detached 2D canvas has no relationship to the viewer's WebGL canvas.
  const pixels=await page.evaluate(async ({base64,region,viewport})=>{
    const image=new Image();
    await new Promise((resolve,reject)=>{
      let settled=false;
      const finish=error=>{
        if(settled)return;settled=true;clearTimeout(timer);image.onload=image.onerror=null;
        if(error)reject(error);else resolve();
      };
      const timer=setTimeout(()=>finish(Error('Screenshot PNG decoding exceeded 5s')),5000);
      image.onload=()=>finish();image.onerror=()=>finish(Error('Screenshot PNG did not decode'));
      image.src='data:image/png;base64,'+base64;
    });
    const scaleX=image.naturalWidth/viewport.width, scaleY=image.naturalHeight/viewport.height;
    const canvas=document.createElement('canvas');
    canvas.width=Math.min(256,Math.floor(region.width));canvas.height=Math.min(256,Math.floor(region.height));
    const context=canvas.getContext('2d');
    context.drawImage(image,region.x*scaleX,region.y*scaleY,region.width*scaleX,region.height*scaleY,0,0,canvas.width,canvas.height);
    return {width:canvas.width,height:canvas.height,data:Array.from(context.getImageData(0,0,canvas.width,canvas.height).data)};
  },{base64:png.toString('base64'),region,viewport});
  return {region,...analyzeScenePixels(pixels)};
}

module.exports={sceneScreenshotRegion,analyzeScenePixels,inspectSceneScreenshot};
