"""Offline authored car surfaces: continuous coachwork and attached glazing.

The normalized envelope and wheel anchors remain stable. These are generic
body-class proportions, not manufacturer CAD or scanned product geometry.
"""
import copy

VEHICLES={'tesla_model_3','tesla_model_y','tesla_model_s','tesla_cybertruck','cargo_van','classic_compact_car'}


def shell(rings, material='body', finish='car_paint'):
    points=[p for ring in rings for p in ring]
    low=[min(p[i] for p in points) for i in range(3)]
    high=[max(p[i] for p in points) for i in range(3)]
    size=[high[i]-low[i] for i in range(3)]
    center=[(high[i]+low[i])/2 for i in range(3)]
    assert min(size)>0
    return {'shape':'box','center':center,'size':size,'material':material,
            'surface_finish':finish,'geometry_profile':'vehicle_shell',
            'geometry_rings':[[[round(2*(p[i]-center[i])/size[i],13) for i in range(3)] for p in ring] for ring in rings]}


def box(center,size,material='body',finish='car_paint',profile='edge'):
    return {'shape':'box','center':center,'size':size,'material':material,'surface_finish':finish,'geometry_profile':profile}


def vehicle_parts(model):
    name=model['id'];parts=copy.deepcopy(model['parts'][:8])
    assert len(parts)==8 and all(p['shape']=='cylinder' for p in parts)
    for i,p in enumerate(parts):
        p['geometry_profile']='lathed' if i%2==0 else 'rod'
        p['surface_finish']='rubber' if i%2==0 else 'brushed_metal'
    van=name=='cargo_van';truck=name=='tesla_cybertruck';classic=name=='classic_compact_car'
    # Rounded rocker, shoulder and hood rows; widths contract at bumpers.
    body=[]
    body_rows=[(-.5,.32,.31,.43),(-.455,.43,.26,.50),(-.31,.47,.24,.55),(-.1,.475,.23,.565),(.13,.475,.23,.565),(.32,.46,.25,.53),(.46,.40,.30,.47),(.5,.32,.34,.43)]
    if truck:body_rows=[(-.5,.42,.26,.57),(-.43,.47,.25,.59),(.34,.47,.25,.59),(.5,.42,.32,.54)]
    for z,w,lo,hi in body_rows:
        body.append([[-.90*w,lo,z],[.90*w,lo,z],[w,lo+.055,z],[w,hi-.045,z],[.87*w,hi,z],[-.87*w,hi,z],[-w,hi-.045,z],[-w,lo+.055,z]])
    body_part=shell(body)
    if truck:body_part['geometry_shading']='flat'
    parts.append(body_part)
    # z, top height, top half-width, sill half-width. Front faces +Z.
    if van:
        rows=[(-.46,.91,.37,.42),(-.42,1,.38,.42),(-.18,1,.38,.42),(.07,1,.38,.42),(.18,.97,.37,.42),(.29,.78,.36,.42),(.38,.545,.34,.40)]
    elif truck:
        rows=[(-.39,.57,.38,.41),(-.29,.74,.39,.42),(-.11,1,.39,.42),(.02,.94,.39,.42),(.22,.73,.37,.42),(.30,.545,.34,.40)]
    elif classic:
        rows=[(-.34,.55,.32,.39),(-.27,.80,.34,.40),(-.18,.97,.33,.40),(-.06,1,.33,.40),(.08,.98,.33,.40),(.18,.84,.34,.40),(.25,.55,.34,.39)]
    else:
        rows=[(-.36,.545,.31,.38),(-.29,.67,.34,.40),(-.21,.89,.34,.405),(-.13,.985,.335,.41),(-.02,1,.33,.41),(.08,.95,.32,.405),(.17,.79,.35,.40),(.28,.545,.35,.39)]
        if name=='tesla_model_y':rows=[(z,h if h==1 else .54+(h-.54)*1.015,w*1.02,b) for z,h,w,b in rows]
    base=.515
    cabin=[]
    for z,top,w,b in rows:
        cabin.append([[-b,base,z],[b,base,z],[b,base+.012,z],[w,top,z],[-w,top,z],[-b,base+.012,z]])
    cabin_part=shell(cabin)
    if truck:cabin_part['geometry_shading']='flat'
    parts.append(cabin_part)
    def at(z):
        for a,b in zip(rows,rows[1:]):
            if a[0]-1e-9<=z<=b[0]+1e-9:
                t=(z-a[0])/(b[0]-a[0]);return [z]+[a[i]+t*(b[i]-a[i]) for i in range(1,4)]
        raise ValueError(z)
    def cuts(lo,hi):return [lo]+[r[0] for r in rows if lo<r[0]<hi]+[hi]
    # Windows attach to the very same interpolated shell surface. Leaving a
    # narrow longitudinal gap forms the painted B pillar without floating bars.
    side_ranges=[(.025,.265)] if van else [(-.20,-.075),(-.045,.185)] if truck else [(-.265,-.075),(-.045,.185)]
    def strip(rings):
        # Consistent counter-clockwise cross-sections produce one closed pane;
        # no coincident internal caps between adjacent tessellation cells.
        for ring in rings:
            area=sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(ring,ring[1:]+ring[:1]))
            if area<0:ring.reverse()
        parts.append(shell(rings,'dark','glass'))
    for sign in (-1,1):
        for lo,hi in side_ranges:
            rings=[]
            for z in cuts(lo,hi):
                _,h,w,b=at(z);outer=[]
                for f in (.18,.88):
                    outer.append([sign*(b+(w-b)*f+.0015),base+.012+(h-base-.012)*f,z])
                rings.append(outer+[[p[0]-sign*.002,p[1],p[2]] for p in reversed(outer)])
            strip(rings)
    front=(.19,.36) if van else (.025,.275) if truck else (.09,.24) if classic else (.09,.265)
    rear=None if van or truck else (-.34,-.215) if not classic and not truck else (-.33,-.20) if classic else (-.375,-.24)
    for limits in [front]+([rear] if rear else []):
        rings=[]
        for z in cuts(*limits):
            _,h,w,b=at(z)
            rings.append([[-.88*w,h+.0015,z],[.88*w,h+.0015,z],[.88*w,h-.0015,z],[-.88*w,h-.0015,z]])
        strip(rings)
    # Door shut-lines and flush handles have thickness, staying on the body.
    for sign in (-1,1):
        parts.append(box([sign*.477,.395,-.065],[.003,.25,.005],'dark','plastic','flat'))
        parts.append(box([sign*.475,.50,.025],[.008,.013,.055],'metal','brushed_metal','flat'))
        parts.append(box([sign*.456,.535,.17],[.071,.035,.06]))
        # Front and rear optical units remain separate from painted bodywork.
        if not classic and not truck:parts.append(box([sign*.27,.445,.485],[.22,.025,.015],'white','light_diffuser','flat'))
        if not truck:parts.append(box([sign*.27,.475,-.47],[.22,.025,.015],'#b82a28','light_diffuser','flat'))
    parts.append(box([0,.345,.486],[.47,.037,.02],'dark','plastic','flat'))
    if truck:
        parts.append(box([0,.555,.488],[.84,.02,.02],'white','light_diffuser','flat'))
        parts.append(box([0,.59,-.489],[.84,.02,.02],'#b82a28','light_diffuser','flat'))
    if classic:
        for sign in (-1,1):
            parts.append({'shape':'cylinder','center':[sign*.29,.47,.489],'size':[.15,.018,.16],'rotation_deg':[90,0,0],'material':'white','surface_finish':'light_diffuser','geometry_profile':'turned'})
        for z in (-.482,.486):parts.append(box([0,.35,z],[.75,.025,.025],'metal','brushed_metal','flat'))
    glazing=[p for p in parts if p['surface_finish']=='glass']
    if glazing:
        world=[[[[(q[i]*p['size'][i]/2+p['center'][i]) for i in range(3)] for q in ring] for ring in p['geometry_rings']] for p in glazing]
        merged=shell([ring for rings in world for ring in rings],'dark','glass')
        normalized=merged.pop('geometry_rings');merged['geometry_shells']=[]
        offset=0
        for rings in world:
            merged['geometry_shells'].append(normalized[offset:offset+len(rings)]);offset+=len(rings)
        parts=[p for p in parts if p['surface_finish']!='glass']+[merged]
    return parts
