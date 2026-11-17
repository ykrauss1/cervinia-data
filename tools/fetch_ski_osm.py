#!/usr/bin/env python3
"""Download the raw material for the ski router: every downhill piste, every
lift and the mountain railways of one ski area from OpenStreetMap, with the
height of every piste and lift end from the Open-Meteo elevation service.

The heights are what tell a piste's downhill direction: OSM asks mappers to
draw a downhill piste in the direction it is skied, but not every one is,
and a route sent the wrong way down a run is the one mistake a ski router
must not make.

Usage: python3 tools/fetch_ski_osm.py AREA S W N E
       python3 tools/fetch_ski_osm.py cervinia 45.86 7.58 46.04 7.83
Writes data/ski-raw-AREA.json. Another resort is one more run with its own
name and box - nothing in here knows about Cervinia.
"""
import json, sys, time, urllib.parse, urllib.request

OVERPASS = ['https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter',
            'https://overpass.private.coffee/api/interpreter']
ELEV = 'https://api.open-meteo.com/v1/elevation'


def post(url, data, timeout=300):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(),
                                 headers={'User-Agent': 'cervinialive-ski-graph/1.0 (cervinialive.co.il)'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def get(url, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': 'cervinialive-ski-graph/1.0 (cervinialive.co.il)'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def main():
    area = sys.argv[1]
    if not __import__('re').fullmatch(r'[a-z0-9-]{2,30}', area):
        sys.exit('area: lowercase letters, digits and dashes only')
    s, w, n, e = (float(x) for x in sys.argv[2:6])
    bb = f'{s},{w},{n},{e}'
    q = f'''[out:json][timeout:240];
(
  way["piste:type"="downhill"]({bb});
  relation["piste:type"="downhill"]({bb});
  way["aerialway"]["aerialway"!~"^(station|goods|pylon|zip_line)$"]({bb});
  way["railway"="funicular"]({bb});
  way["railway"]["rack"]({bb});
);
out tags geom;'''
    osm, last = None, ''
    for attempt in range(3):
        for url in OVERPASS:
            try:
                osm = post(url, {'data': q})
                osm['_source'] = url
                break
            except Exception as ex:      # one mirror down is normal
                last = f'{url}: {ex}'
                print('overpass failed -', last, flush=True)
        if osm:
            break
        time.sleep(30)
    if not osm:
        sys.exit('no Overpass mirror answered: ' + last)

    # the two ends of every way
    ends = {}
    for el in osm['elements']:
        g = el.get('geometry')
        if el['type'] != 'way' or not g:
            continue
        for p in (g[0], g[-1]):
            ends[f"{p['lat']:.5f},{p['lon']:.5f}"] = None
    keys = list(ends)
    for i in range(0, len(keys), 100):
        chunk = keys[i:i + 100]
        lat = ','.join(k.split(',')[0] for k in chunk)
        lon = ','.join(k.split(',')[1] for k in chunk)
        for attempt in range(4):
            try:
                r = get(f'{ELEV}?latitude={lat}&longitude={lon}')
                for k, h in zip(chunk, r['elevation']):
                    ends[k] = h
                break
            except Exception as ex:
                print('elevation failed -', ex, flush=True)
                time.sleep(5 * (attempt + 1))
        time.sleep(1)
    missing = sum(1 for v in ends.values() if v is None)
    out = {
        'area': area, 'bbox': [s, w, n, e],
        'fetched': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'source': osm['_source'],
        'license': 'Map data © OpenStreetMap contributors, ODbL. Heights: Open-Meteo (Copernicus DEM).',
        'elements': osm['elements'],
        'elevation': ends,
    }
    with open(f'data/ski-raw-{area}.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f"{len(osm['elements'])} elements, {len(ends)} ends, {missing} without height")
    if missing > len(ends) * 0.05:
        sys.exit('too many ends without a height')


if __name__ == '__main__':
    main()
