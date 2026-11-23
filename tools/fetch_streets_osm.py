#!/usr/bin/env python3
"""The streets and footpaths of the villages, so that a walk through the
village follows them instead of a straight line (Yossi, 23.11: "the streets
in the village are certainly on the map").

Only the villages: Breuil-Cervinia, Valtournenche and Zermatt. On the
mountain the snow has no streets; there the ski router's own network holds.

Usage: python3 tools/fetch_streets_osm.py AREA
Writes data/streets-AREA.json:
  {"fetched": ..., "license": ..., "ways": [[dlat, dlon, dlat, dlon, ...], ...]}
each way its points in 1e-5 degrees, the first absolute, the rest as
differences - the same packing as the router's own edges.
"""
import json, re, sys, time, urllib.parse, urllib.request

OVERPASS = ['https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter',
            'https://overpass.private.coffee/api/interpreter']

VILLAGES = {
    'cervinia': [
        (45.926, 7.618, 45.946, 7.652),     # Breuil-Cervinia
        (45.866, 7.610, 45.898, 7.634),     # Valtournenche
        (45.998, 7.733, 46.032, 7.768),     # Zermatt
    ],
}
WALKABLE = 'footway|pedestrian|residential|living_street|service|unclassified|tertiary|secondary|primary|path|steps|track|cycleway'


def post(url, data, timeout=200):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(),
                                 headers={'User-Agent': 'cervinialive-streets/1.0 (cervinialive.co.il)'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def main():
    area = sys.argv[1]
    if area not in VILLAGES:
        sys.exit('unknown area')
    parts = ''.join(
        f'way["highway"~"^({WALKABLE})$"]["access"!~"^(private|no)$"]["foot"!="no"]({s},{w},{n},{e});'
        for s, w, n, e in VILLAGES[area])
    q = f'[out:json][timeout:150];({parts});out geom;'
    osm, last = None, ''
    for attempt in range(3):
        for url in OVERPASS:
            try:
                osm = post(url, {'data': q})
                break
            except Exception as ex:
                last = f'{url}: {ex}'
                print('overpass failed -', last, flush=True)
        if osm:
            break
        time.sleep(30)
    if not osm:
        sys.exit('no Overpass mirror answered: ' + last)

    ways = []
    for el in osm['elements']:
        g = el.get('geometry') or []
        if len(g) < 2:
            continue
        pts = [(round(p['lat'] * 1e5), round(p['lon'] * 1e5)) for p in g]
        flat, pa, po = [], 0, 0
        for a, o in pts:
            flat += [a - pa, o - po]
            pa, po = a, o
        ways.append(flat)
    out = {
        'area': area,
        'fetched': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'license': 'Map data © OpenStreetMap contributors, ODbL.',
        'ways': ways,
    }
    with open(f'data/streets-{area}.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, separators=(',', ':'))
    print(len(ways), 'streets and paths')


if __name__ == '__main__':
    main()
