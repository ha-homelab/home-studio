// One portable HDR reflection environment per context. Analytic radiance is
// neutral and generic: it is not a photograph of a private room or a live probe.
export function createReflectionEnvironment(THREE,renderer,scene,profile) {
  let target=null,disposed=false;
  const previous=scene.environment,previousIntensity=scene.environmentIntensity;
  function prepare() {
    if(disposed||profile.diffuseLighting||profile.pixels<=250000||!renderer.extensions.has('EXT_color_buffer_float'))return;
    const width=512,height=256,pixels=new Uint16Array(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const u=(x+.5)/width,v=(y+.5)/height,sky=Math.max(0,Math.cos(v*Math.PI));
      // Broad softboxes give metals a legible reflection with no baked shadows.
      const box=(cx,cy,rx,ry)=>Math.exp(-Math.pow(Math.abs(u-cx)/rx,8)-Math.pow(Math.abs(v-cy)/ry,8));
      const light=2.8*box(.24,.32,.075,.12)+1.3*box(.76,.38,.12,.085);
      const value=.045+.26*sky+light,i=(y*width+x)*4;
      pixels[i]=THREE.DataUtils.toHalfFloat(value*1.02);pixels[i+1]=THREE.DataUtils.toHalfFloat(value);pixels[i+2]=THREE.DataUtils.toHalfFloat(value*.97);pixels[i+3]=THREE.DataUtils.toHalfFloat(1);
    }
    const source=new THREE.DataTexture(pixels,width,height,THREE.RGBAFormat,THREE.HalfFloatType);
    source.mapping=THREE.EquirectangularReflectionMapping;source.colorSpace=THREE.LinearSRGBColorSpace;source.needsUpdate=true;
    const generator=new THREE.PMREMGenerator(renderer);
    try{target=generator.fromEquirectangular(source);scene.environment=target.texture;}finally{generator.dispose();source.dispose()}
  }
  prepare();
  return {
    update(ambient=.4){if(target)scene.environmentIntensity=Math.max(.04,Math.min(.24,.04+ambient*.45))},
    releaseGPU(){target?.dispose();target=null;if(scene.environment!==previous)scene.environment=previous},
    restore(){if(!target)prepare()},
    dispose(){this.releaseGPU();scene.environmentIntensity=previousIntensity;disposed=true},
    get active(){return !!target}
  };
}

// Screen-space contact shading from actual opaque depth, at <=250k pixels.
// The main scene is still drawn directly, retaining its tone mapping, transparent
// walls, room masks and emissive displays. No timer or animation loop is owned.
export function createContactShading(THREE,renderer,profile) {
  const enabled=!profile.diffuseLighting&&profile.pixels>250000;
  let target=null,aoTarget=null,color=null,disposed=false;
  const size=new THREE.Vector2(),viewport=new THREE.Vector4(),materials=new Map();
  const quadScene=new THREE.Scene(),quadCamera=new THREE.Camera();
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
  const shader=new THREE.RawShaderMaterial({
    uniforms:{source:{value:null},depthMap:{value:null},maskMap:{value:null},inverseProjection:{value:new THREE.Matrix4()},projection:{value:new THREE.Matrix4()},outputSize:{value:new THREE.Vector2()},depthSize:{value:new THREE.Vector2()}},
    vertexShader:'precision highp float;attribute vec3 position;void main(){gl_Position=vec4(position,1.);}',
    fragmentShader:`precision highp float;
      uniform sampler2D source,depthMap,maskMap;uniform mat4 inverseProjection,projection;uniform vec2 outputSize,depthSize;
      vec3 viewAt(vec2 uv){float d=texture2D(depthMap,uv).r;vec4 p=inverseProjection*vec4(uv*2.-1.,d*2.-1.,1.);return p.xyz/p.w;}
      void main(){vec2 uv=gl_FragCoord.xy/outputSize;float depth=texture2D(depthMap,uv).r;
        if(depth>.99999||texture2D(maskMap,uv).r<.9){gl_FragColor=vec4(1.);return;}
        vec2 texel=1./depthSize;vec3 p=viewAt(uv),a=viewAt(uv+vec2(texel.x,0.))-p,b=p-viewAt(uv-vec2(texel.x,0.));
        vec3 dx=abs(a.z)<abs(b.z)?a:b;a=viewAt(uv+vec2(0.,texel.y))-p;b=p-viewAt(uv-vec2(0.,texel.y));vec3 dy=abs(a.z)<abs(b.z)?a:b;
        vec3 n=normalize(cross(dx,dy));if(dot(n,-p)<0.)n=-n;
        vec4 projected=projection*vec4(p+vec3(.18,0.,0.),1.);vec2 radius=vec2(abs(projected.x/projected.w*.5+.5-uv.x));radius.y*=outputSize.x/outputSize.y;
        float sum=0.;float rotation=6.2831853*fract(sin(dot(floor(gl_FragCoord.xy),vec2(12.9898,78.233)))*43758.5453);
        for(int i=0;i<16;i++){float angle=float(i)*2.39996323+rotation,r=sqrt((float(i)+.5)/16.);vec2 q=uv+vec2(cos(angle),sin(angle))*radius*r;
          if(q.x>0.&&q.x<1.&&q.y>0.&&q.y<1.){vec3 delta=viewAt(q)-p;float d=length(delta);
            sum+=max(0.,dot(n,delta)/max(d,.001)-.1)*max(0.,1.-d/.2);}}
        // Deliberately bounded: contact AO complements light shadows, never blacks them out.
        float ao=1.-min(.18,sum*.12);gl_FragColor=vec4(vec3(ao),1.);
      }`,depthTest:false,depthWrite:false,blending:THREE.NoBlending,toneMapped:false
  });
  const composite=new THREE.RawShaderMaterial({
    uniforms:{source:{value:null},aoMap:{value:null},maskMap:{value:null},depthMap:{value:null},outputSize:{value:new THREE.Vector2()},depthSize:{value:new THREE.Vector2()}},
    vertexShader:shader.vertexShader,
    fragmentShader:`precision highp float;uniform sampler2D source,aoMap,depthMap,maskMap;uniform vec2 outputSize,depthSize;
      void main(){vec2 uv=gl_FragCoord.xy/outputSize;vec4 c=texture2D(source,uv);float depth=texture2D(depthMap,uv).r;
        if(texture2D(maskMap,uv).r<.9||depth>.99999){gl_FragColor=c;return;}
        float sum=0.,weight=0.;vec2 stepUV=1./depthSize;
        for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 q=uv+vec2(float(x),float(y))*stepUV;
          float w=1./(1.+float(x*x+y*y));w*=max(0.,1.-abs(texture2D(depthMap,q).r-depth)*2000.);
          sum+=texture2D(aoMap,q).r*w;weight+=w;}
        float ao=sum/max(weight,.001);
        if(ao>=1.){gl_FragColor=c;return;}
        vec3 linear=mix(pow((c.rgb+.055)/1.055,vec3(2.4)),c.rgb/12.92,step(c.rgb,vec3(.04045)));
        linear*=ao;
        vec3 encoded=mix(1.055*pow(linear,vec3(1./2.4))-.055,12.92*linear,step(linear,vec3(.0031308)));
        gl_FragColor=vec4(encoded,c.a);}`,
    depthTest:false,depthWrite:false,blending:THREE.NoBlending,toneMapped:false
  });
  const quad=new THREE.Mesh(geometry,shader);quad.frustumCulled=false;quadScene.add(quad);
  function releaseTargets(){target?.dispose();aoTarget?.dispose();color?.dispose();target=aoTarget=color=null}
  function prepare() {
    renderer.getDrawingBufferSize(size);if(size.x<1||size.y<1)return false;
    if(!color||color.image.width!==size.x||color.image.height!==size.y){
      releaseTargets();color=new THREE.FramebufferTexture(size.x,size.y);color.colorSpace=THREE.NoColorSpace;color.minFilter=color.magFilter=THREE.NearestFilter;renderer.initTexture(color);
      const scale=Math.min(1,Math.sqrt(250000/(size.x*size.y))),width=Math.max(1,Math.floor(size.x*scale)),height=Math.max(1,Math.floor(size.y*scale));
      target=new THREE.WebGLRenderTarget(width,height,{minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthTexture:new THREE.DepthTexture(width,height,THREE.UnsignedIntType)});
      aoTarget=new THREE.WebGLRenderTarget(width,height,{minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false});
      composite.uniforms.source.value=color;composite.uniforms.aoMap.value=aoTarget.texture;composite.uniforms.depthMap.value=target.depthTexture;composite.uniforms.maskMap.value=target.texture;composite.uniforms.depthSize.value.set(width,height);
      shader.uniforms.source.value=color;shader.uniforms.depthMap.value=target.depthTexture;shader.uniforms.maskMap.value=target.texture;shader.uniforms.depthSize.value.set(width,height);
    }return true;
  }
  function maskMaterial(source) {
    if(!materials.has(source)) {
      const receives=!source.isMeshBasicMaterial&&!source.isLineBasicMaterial&&(source.emissiveIntensity??1)*Math.max(source.emissive?.r||0,source.emissive?.g||0,source.emissive?.b||0)<.05;
      materials.set(source,new THREE.MeshBasicMaterial({color:receives?0xffffff:0,side:source.side,clippingPlanes:source.clippingPlanes,clipIntersection:source.clipIntersection,toneMapped:false}));
    }
    const material=materials.get(source);
    if(material.clippingPlanes!==source.clippingPlanes||material.clipIntersection!==source.clipIntersection||material.side!==source.side){
      material.clippingPlanes=source.clippingPlanes;material.clipIntersection=source.clipIntersection;material.side=source.side;material.needsUpdate=true;
    }
    const receives=!source.isMeshBasicMaterial&&(source.emissiveIntensity??1)*Math.max(source.emissive?.r||0,source.emissive?.g||0,source.emissive?.b||0)<.05;
    material.color.setHex(receives?0xffffff:0);return material;
  }
  return {
    apply(scene,camera) {
      if(!enabled||disposed||renderer.getRenderTarget()||renderer.getScissorTest()||!prepare())return;
      renderer.copyFramebufferToTexture(color);renderer.getViewport(viewport);
      const saved={background:scene.background,fog:scene.fog,autoClear:renderer.autoClear,shadow:renderer.shadowMap.enabled,autoReset:renderer.info.autoReset},changed=[];
      try {
        scene.background=new THREE.Color(0);scene.fog=null;renderer.shadowMap.enabled=false;renderer.info.autoReset=false;renderer.autoClear=true;
        scene.traverse(object=>{if(!object.isMesh&&!object.isLine&&!object.isPoints)return;changed.push([object,object.material,object.visible]);
          if(!object.isMesh||Array.isArray(object.material)||object.material.transparent||object.material.depthWrite===false)object.visible=false;
          else object.material=maskMaterial(object.material);});
        const active=new Set(changed.map(([,material])=>material));for(const [source,material] of materials)if(!active.has(source)){material.dispose();materials.delete(source)}
        renderer.setRenderTarget(target);renderer.render(scene,camera);
      }finally{
        for(const [object,material,visible] of changed){object.material=material;object.visible=visible}
        scene.background=saved.background;scene.fog=saved.fog;renderer.shadowMap.enabled=saved.shadow;renderer.autoClear=saved.autoClear;renderer.setRenderTarget(null);renderer.setViewport(viewport);renderer.info.autoReset=saved.autoReset;
      }
      shader.uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);shader.uniforms.projection.value.copy(camera.projectionMatrix);shader.uniforms.outputSize.value.set(target.width,target.height);composite.uniforms.outputSize.value.copy(size);
      const autoClear=renderer.autoClear,autoReset=renderer.info.autoReset;
      try{renderer.info.autoReset=false;quad.material=shader;renderer.setRenderTarget(aoTarget);renderer.autoClear=true;renderer.render(quadScene,quadCamera);renderer.setRenderTarget(null);renderer.setViewport(viewport);quad.material=composite;renderer.autoClear=false;renderer.render(quadScene,quadCamera)}finally{quad.material=shader;renderer.setRenderTarget(null);renderer.setViewport(viewport);renderer.autoClear=autoClear;renderer.info.autoReset=autoReset}
    },
    // Dispose also detaches Three's old context-specific buffer listeners. The
    // CPU attributes remain available for the next draw after context recovery.
    releaseGPU(){releaseTargets();for(const material of materials.values())material.dispose();materials.clear();shader.dispose();composite.dispose();geometry.dispose()},
    dispose(){if(disposed)return;this.releaseGPU();disposed=true},
    get active(){return enabled&&!disposed},get pixels(){return target?target.width*target.height:0}
  };
}
