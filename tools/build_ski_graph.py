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
RIDE_DOWN = {'cable_car', 'gondola', 'funicular', 'mixed_lift'}


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
        # The Gornergrat rack railway is mapped as dozens of track pieces and
        # sidings with no stations among them; joining it to the pistes needs
        # its station nodes, which the raw file does not have yet. Left out
        # until it does, rather than joined at guessed places.

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
    for wi, w in enumerate(ways):
        g = w['geom']
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
        missing = [n for n, ids in feed['lifts'].items() if not any(i in found for i in ids)]
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
    for _ in range(60):
        hub = max(lift_bottoms, key=lambda n: len(reach([n], True)))
        core = reach([hub], True) & reach([hub], False)
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

    graph = {
        'v': 1, 'area': area, 'fetched': raw['fetched'], 'license': raw['license'],
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
