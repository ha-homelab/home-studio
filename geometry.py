"""Shared metric geometry primitives for the two independently calibrated plans."""
from types import SimpleNamespace
import math

MATERIALS = {
 'wall': [0.86,0.85,0.80,1], 'wood':[0.63,0.46,0.30,1],
 'floor':[0.73,0.65,0.51,1], 'tile':[0.70,0.77,0.75,1],
 'deck':[0.47,0.54,0.50,1], 'frame':[0.19,0.26,0.28,1],
 'glass':[0.44,0.71,0.80,.30], 'white':[.93,.94,.91,1],
 'steel':[.40,.45,.47,1], 'dark':[.11,.16,.18,1],
 'counter':[.79,.78,.70,1], 'stair':[.64,.66,.62,1],
 'added':[.82,.48,.23,1]
}

def floor_context(meshes, elevation_m):
    """Bake a lightweight, read-only storey in the active floor's metric frame.

    Keep architectural surfaces and true edges, never inventory, labels or
    devices. Adjacent coplanar triangles do not introduce diagonal wire lines.
    This is viewer metadata; the active floor's export meshes stay untouched.
    """
    if not math.isfinite(elevation_m) or elevation_m >= 0:
        raise ValueError('Context floor elevation must be finite and below zero')
    surfaces, lines = [], set()
    for mesh in meshes:
        if mesh['kind'] not in {'walls', 'floors', 'windows', 'doors'}:
            continue
        edges = {}
        vertices = [tuple(round(v + (elevation_m if i == 1 else 0), 4)
                          for i, v in enumerate(p)) for p in mesh['vertices']]
        for i in range(0, len(mesh['indices']), 3):
            triangle = [vertices[j] for j in mesh['indices'][i:i+3]]
            a, b, c = triangle
            u, v = [b[j]-a[j] for j in range(3)], [c[j]-a[j] for j in range(3)]
            n = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]
            length = math.sqrt(sum(x*x for x in n))
            if length < 1e-9:
                continue
            normal = [x/length for x in n]
            # The active storey's slab must not intersect or peek above itself.
            if max(p[1] for p in triangle) >= -.01:
                continue
            surfaces.extend(x for p in triangle for x in p)
            for j in range(3):
                key = tuple(sorted((triangle[j], triangle[(j+1) % 3])))
                edges.setdefault(key, []).append(normal)
        for edge, normals in edges.items():
            if len(normals) == 1 or any(abs(sum(a*b for a, b in zip(normals[0], n))) < .999 for n in normals[1:]):
                lines.add(edge)
    return {'elevation_m': elevation_m, 'surfaces': surfaces,
            'lines': [x for edge in sorted(lines) for p in edge for x in p]}

def create_geometry(x_anchors, z_anchors, height=2.7):
    H=height; XA=x_anchors; YA=z_anchors
    def interp(v, aa):
        a,b = aa[0],aa[1]
        for i in range(len(aa)-1):
            a,b=aa[i:i+2]
            if v<=b[0]: break
        return a[1]+(v-a[0])*(b[1]-a[1])/(b[0]-a[0])
    def X(p): return interp(p,XA)
    def Z(p): return interp(p,YA)
    meshes=[]; openings=[]
    def mesh(name,vs,fs,mat,kind,**meta):
        # Expand faces for stable flat normals across every export.
        vv=[]; nn=[]; ii=[]
        for f in fs:
            a,b,c=[vs[i] for i in f]
            u=[b[i]-a[i] for i in range(3)]; v=[c[i]-a[i] for i in range(3)]
            n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
            d=math.sqrt(sum(x*x for x in n))
            if d<1e-10: continue
            n=[x/d for x in n]
            for p in [a,b,c]: ii.append(len(vv));vv.append(p);nn.append(n)
        meshes.append(dict(name=name,vertices=vv,normals=nn,indices=ii,material=mat,kind=kind,**meta))
    def box_m(name,x0,z0,x1,z1,y0,y1,mat='wall',kind='walls',**meta):
        assert x1>x0 and z1>z0 and y1>y0, (name,x0,z0,x1,z1,y0,y1)
        vs=[[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1],
            [x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1]]
        fs=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],
            [1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
        mesh(name,vs,[f[::-1] for f in fs],mat,kind,**meta)
    def box(name,x0,z0,x1,z1,y0=0,y1=H,mat='wall',kind='walls',**meta):
        box_m(name,X(x0),Z(z0),X(x1),Z(z1),y0,y1,mat,kind,**meta)
    def triangulate(poly):
        def cr(a,b,c):return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
        idx=list(range(len(poly)));fs=[]
        if sum(poly[i][0]*poly[(i+1)%len(poly)][1]-poly[(i+1)%len(poly)][0]*poly[i][1] for i in idx)<0: idx.reverse()
        while len(idx)>3:
            for i,b in enumerate(idx):
                a=idx[i-1];c=idx[(i+1)%len(idx)]
                if cr(poly[a],poly[b],poly[c])<=1e-9:continue
                if any(all(cr(poly[u],poly[v],poly[p])>=-1e-9 for u,v in [(a,b),(b,c),(c,a)]) for p in idx if p not in [a,b,c]):continue
                fs.append([a,b,c]);idx.pop(i);break
            else:raise ValueError('Cannot triangulate '+str(poly))
        return fs+[idx]
    def floor(name,poly,mat='floor',kind='floors',y=0,depth=.16):
        ps=[(X(x),Z(z)) for x,z in poly];n=len(ps)
        vs=[[x,y-depth,z] for x,z in ps]+[[x,y,z] for x,z in ps]
        fs=[]
        for a,b,c in triangulate(ps):fs.extend([[a,b,c],[a+n,c+n,b+n]])
        for a in range(n):
            b=(a+1)%n;fs.extend([[a,b+n,b],[a,a+n,b+n]])
        mesh(name,vs,fs,mat,kind)
    def opening(oid,rect,typ,sill=0,head=2.1,hinge=None,end=None,*,mullion=True):
        x0,z0,x1,z1=rect;vertical=(z1-z0)>(x1-x0)
        width=(Z(z1)-Z(z0)) if vertical else (X(x1)-X(x0))
        openings.append(dict(id=oid,type=typ,rect=rect,width_m=round(width,4),sill_m=sill,head_m=head,confidence='traced_width_assumed_height'))
        box(oid+'_lintel',*rect,head,H,estimated=True)
        if sill:box(oid+'_sill_wall',*rect,0,sill,estimated=True)
        else:box(oid+'_threshold',*rect,-.16,0,'floor','floors')
        ax,bx=X(x0),X(x1);az,bz=Z(z0),Z(z1);t=.035
        if vertical:
            mid=(ax+bx)/2
            for z,n in [(az,'a'),(bz-t,'b')]:box_m(oid+'_jamb_'+n,ax,z,bx,z+t,sill,head,'frame','frames')
            box_m(oid+'_head',ax,az,bx,bz,head-t,head,'frame','frames')
            if typ=='window':
                box_m(oid+'_glass',mid-.01,az+t,mid+.01,bz-t,sill+t,head-t,'glass','windows')
                box_m(oid+'_bottom',ax,az,bx,bz,sill,sill+t,'frame','frames')
                if mullion:box_m(oid+'_mullion',ax,(az+bz)/2-t/2,bx,(az+bz)/2+t/2,sill,head,'frame','frames')
        else:
            mid=(az+bz)/2
            for x,n in [(ax,'a'),(bx-t,'b')]:box_m(oid+'_jamb_'+n,x,az,x+t,bz,sill,head,'frame','frames')
            box_m(oid+'_head',ax,az,bx,bz,head-t,head,'frame','frames')
            if typ=='window':
                box_m(oid+'_glass',ax+t,mid-.01,bx-t,mid+.01,sill+t,head-t,'glass','windows')
                box_m(oid+'_bottom',ax,az,bx,bz,sill,sill+t,'frame','frames')
                if mullion:box_m(oid+'_mullion',(ax+bx)/2-t/2,az,(ax+bx)/2+t/2,bz,sill,head,'frame','frames')
        if typ=='door' and hinge and end:
            xx0,zz0=hinge;xx1,zz1=end
            # Drawing shows leaves open; slabs and headers retain full-height geometry.
            if abs(xx1-xx0)>abs(zz1-zz0):box_m(oid+'_leaf',min(X(xx0),X(xx1)),Z(zz0)-.019,max(X(xx0),X(xx1)),Z(zz0)+.019,0,head-.025,'wood','doors')
            else:box_m(oid+'_leaf',X(xx0)-.019,min(Z(zz0),Z(zz1)),X(xx0)+.019,max(Z(zz0),Z(zz1)),0,head-.025,'wood','doors')
        if typ=='sliding_door':
            mid=(az+bz)/2
            box_m(oid+'_glass_fixed',ax+t,mid-.02,(ax+bx)/2,mid+.005,0.05,head-.04,'glass','doors')
            box_m(oid+'_glass_sliding',(ax+bx)/2-t,mid+.015,bx-t,mid+.04,.05,head-.04,'glass','doors')
            box_m(oid+'_handle',(ax+bx)/2,mid-.04,(ax+bx)/2+.03,mid+.07,.95,1.1,'frame','doors')

    return SimpleNamespace(box=box, box_m=box_m, floor=floor, opening=opening, mesh=mesh, X=X, Z=Z, meshes=meshes, openings=openings)
