#!/usr/bin/env python3
"""Build the ski router's graph from data/ski-raw-AREA.json.

A graph of the mountain: nodes are junctions (where pistes meet, where a
lift starts or ends), edges are the stretches between them - piste stretches
that may be skied only downhill, lifts that go up (and a few cable cars and
railways that may also be ridden down), and short walking links where a
lift station sits beside a piste rather than on it.

Usage: python3 tools/build_ski_graph.py cervinia
Writes data/ski-graph-AREA.json and prints what it found, including the
weak spots - pieces of the network not joined to the rest - which are where
the map, not the code, has to be checked.

Nothing in here knows about Cervinia: another resort is another raw file.
"""
import json, math, sys
from collections import defaultdict

R = 6371000.0

# how close a loose end must be to join something else, in metres
SNAP_PISTE = 25      # a piste that ends near another piste
SNAP_LIFT = 70       # a lift station beside a piste
SNAP_FAR = 250       # a station with nothing that close: the nearest within this
SNAP_VILLAGE = 1500  # a station in the village: a walk through the streets
FLAT_M = 8           # an end-to-end drop smaller than this is "flat"

DIFF = {'novice': 1, 'easy': 1, 'intermediate': 2, 'advanced': 3,
        'expert': 3, 'freeride': 4, 'extreme': 4}
# metres a second, for the time each stretch costs
LIFT_SPEED = {'cable_car': 9, 'gondola': 5, 'mixed_lift': 5, 'chair_lift': 2.5,
              'drag_lift': 3, 't-bar': 3, 'j-bar': 3, 'platter': 3, 'rope_tow': 2,
              'magic_carpet': 0.8, 'funicular': 6, 'rack': 5}
LIFT_WAIT = {'cable_car': 300, 'gondola': 120, 'mixed_lift': 120, 'chair_lift': 90,
             'funicular': 240, 'rack': 600, 'magic_carpet': 15, 'rope_tow': 30}
# Lifts a skier may ride down, when they ask to: the closed cabins - a
# gondola, a cable car, the funicular - where the skis are carried, not worn.
# Never a chairlift or a drag lift.
RIDE_DOWN = {'cable_car', 'gondola', 'funicular', 'mixed_lift', 'rack'}


def dist(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def key(p):
    return (round(p[0], 7), round(p[1], 7))


def ekey(p):
    return f'{p[0]:.5f},{p[1]:.5f}'


def point_in_poly(pt, poly):
    y, x = pt
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        yi, xi = poly[i]
        yj, xj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-15) + xi:
            inside = not inside
        j = i
    return inside


def main():
    area = sys.argv[1]
    raw = json.load(open(f'data/ski-raw-{area}.json', encoding='utf-8'))
    elev = raw['elevation']

    ways = []          # {kind, geom, tags, lt}
    racks = []         # rack railway pieces, sorted out below
    areas = []         # piste areas: polygons
    for el in raw['elements']:
        if el['type'] != 'way' or not el.get('geometry'):
            continue
        t = el.get('tags', {})
        g = [(p['lat'], p['lon']) for p in el['geometry']]
        if len(g) < 2:
            continue
        if t.get('piste:type') == 'downhill':
            d = DIFF.get(t.get('piste:difficulty', ''), 2)
            if t.get('area') == 'yes' or (g[0] == g[-1] and t.get('area') != 'no' and len(g) > 3):
                areas.append({'poly': g, 'diff': d, 'tags': t, 'id': el['id']})
                continue
            ways.append({'kind': 'p', 'geom': g, 'tags': t, 'diff': d, 'id': el['id']})
        elif t.get('aerialway') and (t.get('disused') == 'yes' or 'stillgelegt' in (t.get('name') or '').lower()
                                     or t.get('aerialway:status') in ('closed', 'disused')):
            continue                         # a lift that no longer runs
        elif t.get('aerialway'):
            ways.append({'kind': 'l', 'geom': g, 'tags': t, 'lt': t['aerialway'], 'id': el['id']})
        elif t.get('railway') == 'funicular' and t.get('name'):
            # unnamed funiculars here are service lines (a dam's, a hotel's)
            ways.append({'kind': 'l', 'geom': g, 'tags': t, 'lt': 'funicular', 'id': el['id']})
        elif t.get('railway') and t.get('rack'):
            # The Gornergrat railway: dozens of track pieces and sidings. It
            # is kept only where it runs between its stations (below), and is
            # joined to the pistes at the stations only - never at a loose
            # end of a siding, never where a run merely passes the track.
            racks.append({'kind': 'l', 'geom': g, 'tags': t, 'lt': 'rack', 'id': el['id']})

    # ── the railway: the pieces of track joined to the line through its
    #    stations, as one line ──
    try:
        feedcfg = json.load(open(f'data/ski-lifts-{area}.json', encoding='utf-8'))
    except FileNotFoundError:
        feedcfg = {}
    stations = feedcfg.get('railway_stations') or {}
    rail_stops = []    # (name, track vertex)
    if racks and stations:
        touch = defaultdict(set)
        for ri, r in enumerate(racks):
            for p in r['geom']:
                touch[key(p)].add(ri)
        # pieces connected to one another through shared points
        adj_r = defaultdict(set)
        for k, rs in touch.items():
            for a in rs:
                adj_r[a] |= rs
        def nearest_vertex(ll):
            best = None
            for ri, r in enumerate(racks):
                for p in r['geom']:
                    d = dist(ll, p)
                    if best is None or d < best[0]:
                        best = (d, key(p), ri)
            return best
        seeds = []
        for nm, (oid, la, lo) in stations.items():
            hit = nearest_vertex((la, lo))
            if hit and hit[0] <= 60:
                rail_stops.append((nm, hit[1])); seeds.append(hit[2])
            else:
                print('  weak: station off the track:', nm)
        keep, st = set(seeds), list(seeds)
        while st:
            x = st.pop()
            for y in adj_r[x]:
                if y not in keep:
                    keep.add(y); st.append(y)
        # only the stretch between the outermost stations: drop the pieces
        # beyond them (the depot, the line down the valley)
        for ri in sorted(keep):
            ways.append(racks[ri])
        print(f'  railway: {len(keep)} pieces of track, {len(rail_stops)} stations')

    # how far along the track each point is from the bottom station: the
    # direction "up" along the railway
    rail_along = {}
    if rail_stops:
        import heapq
        tadj = defaultdict(list)
        for w in ways:
            if w.get('lt') != 'rack':
                continue
            gg = w['geom']
            for i in range(len(gg) - 1):
                a_, b_ = key(gg[i]), key(gg[i + 1]); m_ = dist(gg[i], gg[i + 1])
                tadj[a_].append((b_, m_)); tadj[b_].append((a_, m_))
        bottom = rail_stops[0][1]       # the first station listed is the bottom
        rail_along = {bottom: 0.0}
        pq = [(0.0, bottom)]
        while pq:
            d_, x = heapq.heappop(pq)
            if d_ > rail_along.get(x, 1e18):
                continue
            for y, m_ in tadj[x]:
                if d_ + m_ < rail_along.get(y, 1e18):
                    rail_along[y] = d_ + m_
                    heapq.heappush(pq, (d_ + m_, y))

    # ── junctions: a point used by two ways, and every way's two ends ──
    uses = defaultdict(int)
    for w in ways:
        for p in set(key(q) for q in w['geom']):
            uses[p] += 1
    junction = set(p for p, n in uses.items() if n > 1)
    for w in ways:
        junction.add(key(w['geom'][0]))
        junction.add(key(w['geom'][-1]))

    # spatial grid of piste vertices, for snapping loose ends
    CELL = 0.001
    grid = defaultdict(list)  # cell -> [(vertex, way)]
    for wi, w in enumerate(ways):
        if w['kind'] != 'p':
            continue
        for p in w['geom']:
            grid[(int(p[0] / CELL), int(p[1] / CELL))].append((key(p), wi))

    def near_ways(p, r, skip):
        """the nearest vertex of every piste within r metres, one per piste"""
        best = {}
        cr = int(r / 70) + 1               # grid cells are about 75-110 m
        cx, cy = int(p[0] / CELL), int(p[1] / CELL)
        for dx in range(-cr, cr + 1):
            for dy in range(-cr, cr + 1):
                for q, wi in grid.get((cx + dx, cy + dy), ()):
                    if wi == skip:
                        continue
                    d = dist(p, q)
                    if d <= r and (wi not in best or d < best[wi][0]):
                        best[wi] = (d, q)
        return sorted(best.values())

    links = []         # (a, b, metres, kind) two-way links on foot or on skis
    weak = []          # what the map has to be checked for
    for name, v in rail_stops:
        junction.add(v)
        hits = near_ways(v, SNAP_FAR, -1)[:1]
        kind = 'w'
        if not hits:
            hits = near_ways(v, SNAP_VILLAGE, -1)[:1]
            kind = 'v'
        for d, q in hits:
            junction.add(q); links.append((v, q, d, kind))
        if not hits:
            weak.append(f'railway station {name}: no piste near')
    for wi, w in enumerate(ways):
        g = w['geom']
        if w.get('lt') == 'rack':
            continue                     # joined at its stations only
        for end, p in (('start', g[0]), ('end', g[-1])):
            k = key(p)
            if w['kind'] == 'p':
                if uses[k] > 1:
                    continue                 # already joined by a shared node
                hits = near_ways(p, SNAP_PISTE, wi)[:1]
                for d, q in hits:
                    if q != k:
                        junction.add(q); links.append((k, q, d, 'w'))
                continue
            # a lift: join every piste that passes its station
            close = near_ways(p, SNAP_LIFT, wi)
            on_piste = any(d < 1 for d, q in close)
            hits = [h for h in close if h[1] != k and h[0] >= 1]
            kind = 'w'
            if on_piste:
                pass
            elif not hits:
                hits = near_ways(p, SNAP_FAR, wi)[:1]
                if hits:
                    weak.append(f"{w['tags'].get('name') or w['lt']} {end}: nearest piste {round(hits[0][0])} m")
            # only a lift's bottom station can be down in the village
            other = g[-1] if end == 'start' else g[0]
            hp, ho = elev.get(ekey(p)), elev.get(ekey(other))
            low = hp is not None and ho is not None and hp < ho and hp < 2100
            if not hits and not on_piste and low:
                hits = near_ways(p, SNAP_VILLAGE, wi)[:1]
                kind = 'v'
                if hits:
                    weak.append(f"{w['tags'].get('name') or w['lt']} {end}: through the village {round(hits[0][0])} m")
            for d, q in hits:
                junction.add(q); links.append((k, q, d, kind))

    # ── one station, two lifts: the top of one and the foot of the next
    #    stand a few dozen metres apart in the same building, with no piste
    #    between them to join them (Plan Maison: the gondola from Breuil
    #    arrives 72 m from the next lift up). A walk between them. ──
    SNAP_STATION = 120
    lifts = [w for w in ways if w['kind'] == 'l' and w.get('lt') != 'rack']
    for a in lifts:
        top = a['geom'][-1]
        for b in lifts:
            if b is a:
                continue
            foot = b['geom'][0]
            d = dist(top, foot)
            if 1 <= d <= SNAP_STATION:
                junction.add(key(top)); junction.add(key(foot))
                links.append((key(top), key(foot), d, 'w'))

    # ── heights: the ends are measured; a junction inside a way is
    #    interpolated along it ──
    height = {}
    for w in ways:
        for p in (w['geom'][0], w['geom'][-1]):
            h = elev.get(ekey(p))
            if h is not None:
                height[key(p)] = h

    # ── split every way at its junctions into edges ──
    nodes = {}
    def nid(k):
        if k not in nodes:
            nodes[k] = len(nodes)
        return nodes[k]

    edges = []         # (a, b, wayidx, metres, geom, mode) mode: 'down','up','both','ridedown'
    first_rack = {}
    wayinfo = []
    stats = defaultdict(int)
    for wi, w in enumerate(ways):
        g = w['geom']
        h0, h1 = height.get(key(g[0])), height.get(key(g[-1]))
        total = sum(dist(g[i], g[i + 1]) for i in range(len(g) - 1)) or 1
        t = w['tags']
        info = {'k': w['kind'], 'id': w['id']}
        ref = t.get('piste:ref') or t.get('ref')
        name = t.get('piste:name') or t.get('name')
        if ref: info['ref'] = ref
        if name: info['name'] = name
        if w['kind'] == 'p':
            info['d'] = w['diff']
            if t.get('piste:grooming') == 'backcountry': info['d'] = 4
        else:
            info['lt'] = w['lt']
            if w['lt'] == 'rack':
                info['ln'] = first_rack.setdefault('i', wi)   # one line: board once
        wayinfo.append(info)

        # direction of the whole way
        if w['kind'] == 'p':
            if h0 is None or h1 is None:
                mode, why = 'down', 'drawn'
            elif h0 - h1 > FLAT_M:
                mode, why = 'down', 'ok'
            elif h1 - h0 > FLAT_M:
                mode, why = 'rev', 'reversed'
            else:
                mode, why = 'both', 'flat'
            stats['piste_' + why] += 1
        elif w.get('lt') == 'rack' and rail_along:
            # a train runs both ways along every piece of track; "up" is
            # away from the bottom station, measured along the track itself.
            # Heights from a 90 m grid cannot tell the direction of a short,
            # almost level piece in a station, and the line wanders too much
            # for the straight distance to the top to tell it either.
            a0, a1 = rail_along.get(key(g[0]), 0), rail_along.get(key(g[-1]), 0)
            mode = 'liftrev' if a0 > a1 else 'lift'
        else:
            rev = h0 is not None and h1 is not None and h0 - h1 > 20
            if rev: stats['lift_reversed'] += 1
            mode = 'liftrev' if rev else 'lift'

        run, acc = [g[0]], 0.0
        for i in range(1, len(g)):
            acc += dist(g[i - 1], g[i])
            run.append(g[i])
            if key(g[i]) in junction or i == len(g) - 1:
                if len(run) >= 2:
                    a, b = key(run[0]), key(run[-1])
                    if a != b:
                        m = sum(dist(run[j], run[j + 1]) for j in range(len(run) - 1))
                        for k2, frac in ((a, (acc - m) / total), (b, acc / total)):
                            if k2 not in height and h0 is not None and h1 is not None:
                                height[k2] = h0 + (h1 - h0) * frac
                        edges.append((a, b, wi, m, run, mode))
                run = [g[i]]

    # ── areas: every junction inside or on the edge of a piste area may
    #    reach every lower one across it ──
    for ar in areas:
        poly = ar['poly']
        inside = [k for k in junction
                  if point_in_poly(k, poly) or min(dist(k, q) for q in poly) < 40]
        if len(inside) < 2:
            continue
        wayinfo.append({'k': 'a', 'id': ar['id'], 'd': ar['diff'],
                        **({'name': ar['tags']['name']} if ar['tags'].get('name') else {})})
        wi = len(wayinfo) - 1
        for a in inside:
            for b in inside:
                if a == b: continue
                ha, hb = height.get(a), height.get(b)
                if ha is None or hb is None or ha - hb < -5: continue
                m = dist(a, b)
                if m > 800: continue
                edges.append((a, b, wi, m, [a, b], 'down1'))
                stats['area_edges'] += 1

    # ── the live feed: which lift is which, and which the feed covers ──
    try:
        feed = json.load(open(f'data/ski-lifts-{area}.json', encoding='utf-8'))
    except FileNotFoundError:
        feed = None
    if feed:
        by_id = {}
        for fname, ids in feed['lifts'].items():
            for i in ids:
                by_id[i] = fname
        S, Wb, Nb, Eb = feed['covered']
        found = set()
        missing = []
        for wi, info in enumerate(wayinfo):
            if info['k'] != 'l':
                continue
            g0 = ways[wi]['geom'][0]
            if info['id'] in by_id:
                info['feed'] = by_id[info['id']]
                found.add(info['id'])
            elif S <= g0[0] <= Nb and Wb <= g0[1] <= Eb and info.get('lt') != 'yes':
                # (aerialway=yes is a passage between two stations, not a lift)
                info['cov'] = 1          # the feed reports on it: absent = not running
        zby = {}
        for zname, ids in (feed.get('zermatt') or {}).items():
            for i in ids:
                zby[i] = zname
        for info in wayinfo:
            if info['k'] == 'l' and info['id'] in zby:
                info['zf'] = zby[info['id']]
                found.add(info['id'])
            elif info['k'] == 'l' and info.get('lt') == 'rack':
                info['zf'] = '@GGB'
        missing += [n for n, ids in (feed.get('zermatt') or {}).items() if not any(i in found for i in ids)]
        missing = [n for n, ids in feed['lifts'].items() if not any(i in found for i in ids)] + missing
        if missing:
            sys.exit('lifts named in the feed map but not on the map: ' + ', '.join(missing))

    # ── write it out ──
    out_edges = []
    def push(a, b, wi, m, geom, kind, rev=False):
        A, B = nid(a), nid(b)
        gm = list(reversed(geom)) if rev else geom
        out_edges.append([A, B, wi, round(m), kind, enc(gm)])

    def enc(geom):
        # lat/lon in 1e-5 degrees, the first absolute and the rest as steps
        o, la, lo = [], 0, 0
        for p in geom:
            y, x = round(p[0] * 1e5), round(p[1] * 1e5)
            o += [y - la, x - lo]
            la, lo = y, x
        return o

    for a, b, wi, m, geom, mode in edges:
        if mode == 'down':   push(a, b, wi, m, geom, 's')
        elif mode == 'rev':  push(b, a, wi, m, geom, 's', True)
        elif mode == 'both':
            push(a, b, wi, m, geom, 'f'); push(b, a, wi, m, geom, 'f', True)
        elif mode == 'down1': push(a, b, wi, m, geom, 's')
        elif mode in ('lift', 'liftrev'):
            up = mode == 'lift'
            lt = wayinfo[wi].get('lt')
            if up: push(a, b, wi, m, geom, 'u')
            else:  push(b, a, wi, m, geom, 'u', True)
            if lt in RIDE_DOWN:
                if up: push(b, a, wi, m, geom, 'r', True)
                else:  push(a, b, wi, m, geom, 'r')
    for a, b, m, kind in links:
        push(a, b, -1, m, [a, b], kind); push(b, a, -1, m, [b, a], kind)

    node_list = [None] * len(nodes)
    for k, i in nodes.items():
        h = height.get(k)
        node_list[i] = [round(k[0], 5), round(k[1], 5), round(h) if h is not None else None]

    # ── dead ends: a piste that ends where nothing goes on. On the mountain
    #    the skier pushes on to the nearest thing that does, no higher than
    #    a few metres above; at the foot of the mountain they walk through
    #    the village to the nearest lift. ──
    outdeg = defaultdict(int)
    for e in out_edges:
        outdeg[e[0]] += 1
    lift_bottoms = set(e[0] for e in out_edges if e[4] == 'u')
    dead_left = []
    for d in range(len(node_list)):
        if outdeg[d]:
            continue
        pd = node_list[d]
        hd = pd[2] if pd[2] is not None else 9999
        best = None
        for c in range(len(node_list)):
            if c == d or not outdeg[c]:
                continue
            pc = node_list[c]
            m = dist(pd, pc)
            if m <= 300 and (pc[2] is None or pc[2] <= hd + 15) and (best is None or m < best[0]):
                best = (m, c, 'w')
        if best is None and hd < 2100:
            for c in lift_bottoms:
                m = dist(pd, node_list[c])
                if m <= SNAP_VILLAGE and (best is None or m < best[0]):
                    best = (m, c, 'v')
        if best is None:
            dead_left.append(d)
            continue
        m, c, kind = best
        out_edges.append([d, c, -1, round(m), kind, enc([pd[:2], node_list[c][:2]])])
        stats['deadend_' + kind] += 1
    for d in dead_left:
        weak.append(f'dead end at {node_list[d]}')

    # ── a run that ends on a harder one: two runs often share their last
    #    stretch, and the map gives it the harder run's colour only - the
    #    red Stafelalp, for one, reaches Furi on the black run's last 250 m.
    #    From such an end a skier may reach a lift or an easier run close by,
    #    on foot or on skis, rather than be sent down the harder one. ──
    def wd(e):
        return wayinfo[e[2]].get('d', 2) if e[2] >= 0 else 0
    ins = defaultdict(list); outs = defaultdict(list)
    for e in out_edges:
        if e[4] in ('s', 'f'):
            ins[e[1]].append(wd(e)); outs[e[0]].append(wd(e))
    other = defaultdict(int)             # a lift starts right here
    for e in out_edges:
        if e[4] == 'u':
            other[e[0]] += 1
    for n_, dins in list(ins.items()):
        lvl = min(dins)
        if not outs[n_] or min(outs[n_]) <= lvl or other[n_]:
            continue
        pn = node_list[n_]
        hn = pn[2] if pn[2] is not None else 9999
        # every lift close by (the skier picks the one the route needs);
        # failing any, the nearest easier run below
        picks, run_best = [], None
        for c in range(len(node_list)):
            if c == n_:
                continue
            pc = node_list[c]
            m_ = dist(pn, pc)
            if m_ > 300 or (pc[2] is not None and pc[2] > hn + 15):
                continue
            if c in lift_bottoms:
                picks.append((m_, c))
            elif outs[c] and min(outs[c]) <= lvl and pc[2] is not None and pc[2] < hn - 5:
                if run_best is None or m_ < run_best[0]:
                    run_best = (m_, c)
        if not picks and run_best:
            picks = [run_best]
        for m_, c in picks:
            out_edges.append([n_, c, -1, round(m_), 'w', enc([pn[:2], node_list[c][:2]])])
            stats['harder_end_w'] += 1

    # ── pockets: a group of pistes that leads only into itself - the runs
    #    that end in the village, at the foot of lifts that are not mapped
    #    as touching them. From the lowest point of each pocket the skier
    #    walks to the nearest lift of the main network. ──
    def reach(starts, fwd):
        adj = defaultdict(list)
        for e in out_edges:
            if fwd: adj[e[0]].append(e[1])
            else:   adj[e[1]].append(e[0])
        seen, st = set(starts), list(starts)
        while st:
            x = st.pop()
            for y in adj[x]:
                if y not in seen:
                    seen.add(y); st.append(y)
        return seen
    # the railway's stations: a walk of a few hundred metres to a train is
    # what a skier does at Riffelalp
    stop_nodes = set(nodes[v] for _, v in rail_stops if v in nodes)
    core_hub = None
    for _ in range(60):
        # the core is the biggest set of junctions that can all reach one
        # another; it is measured, not guessed from one well-connected lift
        if _ == 0 or core_hub not in lift_bottoms:
            best = None
            for n in lift_bottoms:
                c = reach([n], True) & reach([n], False)
                if best is None or len(c) > len(best[1]):
                    best = (n, c)
            core_hub = best[0]
        core = reach([core_hub], True) & reach([core_hub], False)
        back = reach(list(core), False)          # can get back to the core
        pocket = [n for n in reach(list(core), True) if n not in back]
        if not pocket:
            break
        low = min(pocket, key=lambda n: node_list[n][2] if node_list[n][2] is not None else 9999)
        pl = node_list[low]
        best = None
        for c in core:
            pc = node_list[c]
            m = dist(pl, pc)
            ok = (c in lift_bottoms and (m <= 300 or (m <= SNAP_VILLAGE and (pl[2] or 9999) < 2100))) \
                 or (c in stop_nodes and m <= 600) \
                 or (m <= 300 and pc[2] is not None and pl[2] is not None and pc[2] <= pl[2] + 15)
            if ok and (best is None or m < best[0]):
                best = (m, c)
        if best is None:
            weak.append(f'pocket of {len(pocket)} with no way out near {pl}')
            break
        m, c = best
        kind = 'v' if m > 300 else 'w'
        out_edges.append([low, c, -1, round(m), kind, enc([pl[:2], node_list[c][:2]])])
        stats['pocket_' + kind] += 1


    adj = defaultdict(set)
    for e in out_edges:
        adj[e[0]].add(e[1]); adj[e[1]].add(e[0])
    seen, comps = set(), []
    for s in range(len(node_list)):
        if s in seen: continue
        st, comp = [s], []
        seen.add(s)
        while st:
            x = st.pop(); comp.append(x)
            for y in adj[x]:
                if y not in seen: seen.add(y); st.append(y)
        comps.append(comp)
    comps.sort(key=len, reverse=True)

    # ── destinations: each the end of a lift or a railway station ──
    places = []
    if feed and feed.get('places'):
        ends_by_way = {}
        for e in out_edges:
            if e[4] == 'u' and e[2] >= 0:
                ends_by_way.setdefault(wayinfo[e[2]]['id'], []).append((e[0], e[1]))
        for pl in feed['places']:
            if pl.get('rail'):
                st_ = stations.get(pl['rail'])
                if not st_:
                    sys.exit('place on an unknown railway station: ' + pl['rail'])
                ll = (st_[1], st_[2])
            else:
                pairs = ends_by_way.get(pl['lift'])
                if not pairs:
                    sys.exit('place on a lift not in the graph: ' + str(pl['lift']))
                starts = set(a_ for a_, b_ in pairs); stops = set(b_ for a_, b_ in pairs)
                if pl['at'] == 'bottom':
                    n_ = next(iter(starts - stops), pairs[0][0])
                else:
                    n_ = next(iter(stops - starts), pairs[-1][1])
                ll = tuple(node_list[n_][:2])
            places.append([pl['g'], pl['c'], pl['he'], pl['en'], round(ll[0], 5), round(ll[1], 5)])

    graph = {
        'v': 1, 'area': area, 'places': places, 'fetched': raw['fetched'], 'license': raw['license'],
        'speed': {'ski': 7, 'flat': 3, 'walk': 1, 'lift': LIFT_SPEED, 'wait': LIFT_WAIT},
        'nodes': node_list, 'ways': wayinfo, 'edges': out_edges,
    }
    with open(f'data/ski-graph-{area}.json', 'w', encoding='utf-8') as f:
        json.dump(graph, f, ensure_ascii=False, separators=(',', ':'))

    print(f'{len(ways)} ways ({sum(w["kind"]=="p" for w in ways)} pistes, '
          f'{sum(w["kind"]=="l" for w in ways)} lifts), {len(areas)} areas')
    print(f'{len(node_list)} nodes, {len(out_edges)} edges, {len(links)} links')
    print('directions:', dict(stats))
    for x in weak: print('  weak:', x)
    print('pieces:', [len(c) for c in comps[:12]], '...', len(comps), 'in all')
    return graph, comps, node_list


if __name__ == '__main__':
    main()
