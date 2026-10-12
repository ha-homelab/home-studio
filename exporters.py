"""glTF, USD, OBJ and COLLADA exports from the same metric triangle meshes."""
import json, struct

def export_models(data, ROOT, stem):
    meshes=data['meshes'];MATS=data['materials'];H=data['ceiling_height_m']
    def export_glb():
        blob=bytearray();views=[];accessors=[];gm=[];nodes=[]
        def accessor(vals,fmt,typ,target):
            while len(blob)%4:blob.append(0)
            offset=len(blob);flat=[v for row in vals for v in row] if isinstance(vals[0],list) else vals
            bb=struct.pack('<'+fmt*len(flat),*flat);blob.extend(bb)
            views.append(dict(buffer=0,byteOffset=offset,byteLength=len(bb),target=target))
            a=dict(bufferView=len(views)-1,componentType=5126 if fmt=='f' else 5125,count=len(vals),type=typ)
            if typ=='VEC3':a.update(min=[min(v[i] for v in vals) for i in range(3)],max=[max(v[i] for v in vals) for i in range(3)])
            accessors.append(a);return len(accessors)-1
        for m in meshes:
            p=accessor(m['vertices'],'f','VEC3',34962);n=accessor(m['normals'],'f','VEC3',34962);idx=accessor(m['indices'],'I','SCALAR',34963)
            gm.append(dict(name=m['name'],primitives=[dict(attributes=dict(POSITION=p,NORMAL=n),indices=idx,material=list(MATS).index(m['material']))]))
            nodes.append(dict(name=m['name'],mesh=len(gm)-1,extras=dict(category=m['kind'],estimated=m.get('estimated',False))))
        gl=dict(asset=dict(version='2.0',generator=data['title']+' dimension-constrained reconstruction'),scene=0,
           scenes=[dict(name=stem+'_ceiling_2_7m',nodes=list(range(len(nodes))))],nodes=nodes,meshes=gm,
           materials=[dict(name=k,pbrMetallicRoughness=dict(baseColorFactor=v,metallicFactor=.05,roughnessFactor=.72),doubleSided=True,alphaMode='BLEND' if v[3]<1 else 'OPAQUE') for k,v in MATS.items()],
           buffers=[dict(byteLength=len(blob))],bufferViews=views,accessors=accessors,
           extras=dict(units='metres',ceiling_height=H,status='provisional reconstruction; see README.md'))
        jj=json.dumps(gl,separators=(',',':')).encode();jj+=b' '*((-len(jj))%4);blob+=b'\0'*((-len(blob))%4)
        (ROOT/(stem+'.glb')).write_bytes(struct.pack('<III',0x46546c67,2,28+len(jj)+len(blob))+struct.pack('<II',len(jj),0x4e4f534a)+jj+struct.pack('<II',len(blob),0x004e4942)+blob)
    export_glb()

    # USDA is Y-up and metrically identical to the GLB; package_usdz.py creates the archive.
    lines=['#usda 1.0','(defaultPrim = "HomeModel"',' metersPerUnit = 1',' upAxis = "Y")','def Xform "HomeModel" {',' def Scope "Materials" {']
    for name,col in MATS.items():
        lines += [f'  def Material "{name}" {{',f'   token outputs:surface.connect = </HomeModel/Materials/{name}/Shader.outputs:surface>',
           '   def Shader "Shader" {','    uniform token info:id = "UsdPreviewSurface"',f'    color3f inputs:diffuseColor = ({col[0]}, {col[1]}, {col[2]})',f'    float inputs:opacity = {col[3]}','    float inputs:roughness = 0.72','    token outputs:surface','   }','  }']
    lines+=[' }']
    for m in meshes:
        pts=', '.join('('+', '.join(f'{x:.7f}' for x in p)+')' for p in m['vertices'])
        ns=', '.join('('+', '.join(f'{x:.6f}' for x in p)+')' for p in m['normals'])
        lines += [f' def Mesh "{m["name"]}" (prepend apiSchemas = ["MaterialBindingAPI"]) {{',f'  point3f[] points = [{pts}]',f'  int[] faceVertexCounts = [{", ".join(["3"]*(len(m["indices"])//3))}]',f'  int[] faceVertexIndices = [{", ".join(map(str,m["indices"]))}]',f'  normal3f[] normals = [{ns}] (interpolation = "vertex")','  uniform token subdivisionScheme = "none"','  uniform bool doubleSided = true',f'  rel material:binding = </HomeModel/Materials/{m["material"]}>',' }']
    lines+=['}'];(ROOT/(stem+'.usda')).write_text('\n'.join(lines).replace('HomeModel',stem.title()))

    # OBJ/DAE use Z-up for architectural import; the plan-down coordinate becomes -Y.
    obj=['# '+data['title']+', METRES, Z up; imported reference meshes, not BIM families','mtllib '+stem+'.mtl'];off=1
    for m in meshes:
        obj.extend([f'o {m["name"]}',f'usemtl {m["material"]}'])
        obj.extend(f'v {x:.7f} {-z:.7f} {y:.7f}' for x,y,z in m['vertices'])
        obj.extend('f '+' '.join(str(off+i) for i in m['indices'][j:j+3]) for j in range(0,len(m['indices']),3));off+=len(m['vertices'])
    (ROOT/(stem+'.obj')).write_text('\n'.join(obj))
    (ROOT/(stem+'.mtl')).write_text('\n'.join(f'newmtl {k}\nKd {v[0]} {v[1]} {v[2]}\nd {v[3]}\n' for k,v in MATS.items()))
    dae=['<?xml version="1.0" encoding="utf-8"?>','<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1"><asset><contributor><authoring_tool>Home floorplan builder</authoring_tool></contributor><created>2026-09-19T00:00:00Z</created><modified>2026-09-19T00:00:00Z</modified><unit name="meter" meter="1"/><up_axis>Z_UP</up_axis></asset><library_effects>']
    for k,v in MATS.items():dae.append(f'<effect id="{k}-fx"><profile_COMMON><technique sid="common"><lambert><diffuse><color>{" ".join(map(str,v))}</color></diffuse></lambert></technique></profile_COMMON></effect>')
    dae+=['</library_effects><library_materials>']
    for k in MATS:dae.append(f'<material id="{k}-mat" name="{k}"><instance_effect url="#{k}-fx"/></material>')
    dae+=['</library_materials><library_geometries>']
    for i,m in enumerate(meshes):
        vals=' '.join(f'{v:.7f}' for x,y,z in m['vertices'] for v in (x,-z,y));n=len(m['vertices'])
        dae.append(f'<geometry id="g{i}" name="{m["name"]}"><mesh><source id="g{i}-pos"><float_array id="g{i}-arr" count="{n*3}">{vals}</float_array><technique_common><accessor source="#g{i}-arr" count="{n}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source><vertices id="g{i}-v"><input semantic="POSITION" source="#g{i}-pos"/></vertices><triangles material="mat" count="{len(m["indices"])//3}"><input semantic="VERTEX" source="#g{i}-v" offset="0"/><p>{" ".join(map(str,m["indices"]))}</p></triangles></mesh></geometry>')
    dae+=['</library_geometries><library_visual_scenes><visual_scene id="Scene" name="Home floorplan">']
    for i,m in enumerate(meshes):dae.append(f'<node id="n{i}" name="{m["name"]}"><instance_geometry url="#g{i}"><bind_material><technique_common><instance_material symbol="mat" target="#{m["material"]}-mat"/></technique_common></bind_material></instance_geometry></node>')
    dae+=['</visual_scene></library_visual_scenes><scene><instance_visual_scene url="#Scene"/></scene></COLLADA>'];(ROOT/(stem+'.dae')).write_text('\n'.join(dae))
