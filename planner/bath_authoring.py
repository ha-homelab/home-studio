"""Generic sanitary fixtures with open cavities, no private floorplan data."""
import math

BATH_MODELS={'toilet','bathtub','bidet','shower_enclosure'}

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
    if model['id']=='bidet':
        return [shell((0,.54,.10),(1,.70,.80),[
                    (-1,.42),(-.80,.62),(-.25,.83),(.70,.98),(1,1),
                    (1,.86),(.78,.82),(-.52,.55),(-.76,.30)],material='body'),
                solid((0,.13,.05),(.62,.26,.65),'body','ceramic',3),
                solid((0,.78,-.35),(.84,.16,.30),'body'),
                {'shape':'cylinder','center':[0,.915,-.39],'size':[.09,.17,.06],
                 'material':'metal','surface_finish':'brushed_metal','geometry_profile':'rod'},
                {'shape':'box','center':[0,.95,-.30],'size':[.10,.06,.24],
                 'material':'metal','surface_finish':'brushed_metal','geometry_profile':'edge'},
                {'shape':'cylinder','center':[0,.278,.10],'size':[.10,.014,.065],
                 'material':'metal','surface_finish':'brushed_metal','geometry_profile':'turned'}]
    if model['id']=='shower_enclosure':
        return [shell((0,.025,0),(1,.05,1),[
                    (-1,.94),(-.80,1),(1,1),(1,.91),(.65,.89),(-.35,.88),(-.35,.10)],
                    material='body',power=8),
                {'shape':'box','center':[-.492,.525,0],'size':[.016,.95,1],
                 'material':'glass','surface_finish':'glass','geometry_profile':'flat','opacity':.28},
                {'shape':'box','center':[0,.525,-.492],'size':[1,.95,.016],
                 'material':'glass','surface_finish':'glass','geometry_profile':'flat','opacity':.28},
                {'shape':'cylinder','center':[.30,.505,-.45],'size':[.035,.90,.035],
                 'material':'metal','surface_finish':'brushed_metal','geometry_profile':'rod'},
                {'shape':'box','center':[.30,.95,-.28],'size':[.035,.025,.34],
                 'material':'metal','surface_finish':'brushed_metal','geometry_profile':'edge'},
                {'shape':'cylinder','center':[.30,.935,-.10],'size':[.20,.025,.20],
                 'material':'metal','surface_finish':'brushed_metal','geometry_profile':'lathed'},
                {'shape':'box','center':[.30,.50,-.442],'size':[.18,.05,.055],
                 'material':'metal','surface_finish':'brushed_metal','geometry_profile':'edge'},
                {'shape':'cylinder','center':[0,.019,0],'size':[.06,.007,.06],
                 'material':'metal','surface_finish':'brushed_metal','geometry_profile':'turned'}]
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
