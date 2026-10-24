"""Generic sanitary fixtures with open cavities, no private floorplan data."""
import math

BATH_MODELS={'toilet','bathtub'}

def shell(center,size,profile,material='white',finish='ceramic',power=2,sides=24):
    """A closed solid from outer bottom through the rim to the inner floor.

    The first and last rings are capped below the cavity; no face fills the
    upper opening. Coordinates are normalized, never physical measurements.
    """
    rings=[]
    for y,radius in profile:
        ring=[]
        for i in range(sides):
            a=-i*math.tau/sides;c,s=math.cos(a),math.sin(a)
            scale=(abs(c)**power+abs(s)**power)**(-1/power)
            ring.append([round(c*scale*radius,13),y,round(s*scale*radius,13)])
        rings.append(ring)
    return {'shape':'box','center':list(center),'size':list(size),'material':material,
            'surface_finish':finish,'geometry_profile':'molded_shell','geometry_rings':rings}

def solid(center,size,material='white',finish='ceramic',power=4):
    return shell(center,size,[(-1,.88),(-.85,.97),(-.6,1),(.6,1),(.85,.97),(1,.88)],material,finish,power)

def bath_parts(model):
    if model['id']=='bathtub':
        return [shell((0,.535,0),(1,.93,1),[
                    (-1,.58),(-.88,.70),(-.48,.85),(.55,.98),(.90,1),(1,.99),
                    (1,.88),(.84,.85),(-.58,.62),(-.76,.42)],power=3,sides=32),
                solid((0,.06,0),(.50,.12,.57),'body','rubber',3),
                {'shape':'cylinder','center':[0,.185,.20],'size':[.075,.012,.045],
                 'material':'metal','surface_finish':'brushed_metal','geometry_profile':'turned'}]
    if model['id']=='toilet':
        body=shell((0,.40,.17),(1,.40,.66),[
            (-1,.40),(-.83,.53),(-.3,.77),(.58,.96),(.84,1),(1,.99),
            (1,.86),(.73,.80),(-.30,.52),(-.55,.25)])
        seat={'shape':'ring','center':[0,.635,.17],'size':[1,.05,.66],
              'material':'body','surface_finish':'plastic','geometry_profile':'rounded_fine','inner_ratio':.74}
        lid=solid((0,.785,-.135),(.89,.035,.35),'body','plastic',2)
        lid['rotation_deg']=[90,0,0]
        # The thin lid stands in front of the cistern; its normalized depth
        # does not pretend to be a filled dark opening in the seat.
        return [body,seat,lid,
                shell((0,.205,-.025),(.54,.41,.56),[(-1,.94),(-.85,1),(-.3,.82),(.4,.66),(1,.9)],power=3),
                solid((0,.31,-.32),(.45,.38,.27)),
                solid((0,.75,-.335),(.88,.48,.33)),
                {'shape':'cylinder','center':[0,.995,-.335],'size':[.15,.01,.06],
                 'material':'metal','surface_finish':'brushed_metal','geometry_profile':'turned'}]
    raise ValueError('unknown generic bath model')
