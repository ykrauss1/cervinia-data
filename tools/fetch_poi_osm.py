#!/usr/bin/env python3
"""The small places the on-mountain navigation finds "the nearest" of:
toilets, first aid, ski-pass offices, ski rental, cash machines and
pharmacies, from OpenStreetMap.

The huts, the parking places and the lifts are not here - the site has its
own verified list of each (texts.json and the ski router's graph). This file
holds only what nobody typed in.

Usage: python3 tools/fetch_poi_osm.py AREA S W N E
       python3 tools/fetch_poi_osm.py cervinia 45.86 7.58 46.04 7.83
Writes data/poi-AREA.json:
  {"fetched": ..., "license": ..., "items": [[kind, name, lat, lon], ...]}
"""
import json, re, sys, time, urllib.parse, urllib.request

OVERPASS = ['https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter',
            'https://overpass.private.coffee/api/interpreter']

# kind -> the OSM tags that mean it
KINDS = [
    ('wc',     lambda t: t.get('amenity') == 'toilets'),
    ('aid',    lambda t: t.get('emergency') in ('first_aid', 'ambulance_station', 'mountain_rescue')
                         or t.get('amenity') in ('first_aid', 'doctors', 'clinic')
                         or t.get('healthcare') in ('first_aid', 'doctor', 'clinic', 'physiotherapist')),
    ('ticket', lambda t: t.get('shop') == 'ticket' or t.get('amenity') == 'ticket_office'
                         or (t.get('vending') or '').find('ticket') >= 0 and t.get('amenity') == 'vending_machine'
                         or 'ski' in (t.get('ticket') or '') or t.get('ski_pass') == 'yes'),
    ('rental', lambda t: t.get('shop') == 'ski' or t.get('rental') in ('ski', 'snowboard')
                         or 'ski' in (t.get('rental') or '') or t.get('service:ski:rental') == 'yes'
                         or t.get('amenity') == 'ski_rental'),
    ('atm',    lambda t: t.get('amenity') == 'atm' or (t.get('amenity') == 'bank' and t.get('atm') == 'yes')),
    ('pharm',  lambda t: t.get('amenity') == 'pharmacy' or t.get('healthcare') == 'pharmacy'),
]


# What kind of medical place it is, so the list can say "doctor" or
# "physiotherapy" and not only a name (Yossi, 25.11: "medical, but what?")
def aid_sub(t):
    em, am, hc = t.get('emergency'), t.get('amenity'), t.get('healthcare')
    spec = (t.get('healthcare:speciality') or '') + ' ' + (t.get('name') or '')
    if em == 'mountain_rescue':
        return 'rescue'
    if em == 'ambulance_station':
        return 'ambulance'
    if hc == 'physiotherapist' or 'physio' in spec.lower():
        return 'physio'
    if 'first_aid' in (em, am, hc):
        return 'first_aid'
    if am == 'clinic' or hc == 'clinic':
        return 'clinic'
    if am == 'doctors' or hc == 'doctor':
        return 'doctor'
    return ''


def post(url, data, timeout=200):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(),
                                 headers={'User-Agent': 'cervinialive-poi/1.0 (cervinialive.co.il)'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def main():
    area = sys.argv[1]
    if not re.fullmatch(r'[a-z0-9-]{2,30}', area):
        sys.exit('area: lowercase letters, digits and dashes only')
    s, w, n, e = (float(x) for x in sys.argv[2:6])
    bb = f'{s},{w},{n},{e}'
    q = f'''[out:json][timeout:150];
(
  nwr["amenity"~"^(toilets|first_aid|doctors|clinic|atm|bank|pharmacy|ticket_office|ski_rental|vending_machine)$"]({bb});
  nwr["emergency"~"^(first_aid|ambulance_station|mountain_rescue)$"]({bb});
  nwr["healthcare"~"^(first_aid|doctor|clinic|pharmacy|physiotherapist)$"]({bb});
  nwr["shop"~"^(ski|ticket|sports)$"]({bb});
  nwr["rental"]({bb});
);
out tags center;'''
    osm, last = None, ''
    for attempt in range(3):
        for url in OVERPASS:
            try:
                osm = post(url, {'data': q})
                break
            except Exception as ex:      # one mirror down is normal
                last = f'{url}: {ex}'
                print('overpass failed -', last, flush=True)
        if osm:
            break
        time.sleep(30)
    if not osm:
        sys.exit('no Overpass mirror answered: ' + last)

    items, seen = [], set()
    for el in osm['elements']:
        t = el.get('tags') or {}
        lat = el.get('lat', (el.get('center') or {}).get('lat'))
        lon = el.get('lon', (el.get('center') or {}).get('lon'))
        if lat is None or lon is None:
            continue
        # a sports shop counts only when it says it rents skis
        if t.get('shop') == 'sports' and 'ski' not in (t.get('rental') or '') \
                and t.get('service:ski:rental') != 'yes':
            continue
        for kind, test in KINDS:
            if not test(t):
                continue
            name = (t.get('name') or t.get('operator') or t.get('brand') or '').strip()[:60]
            key = (kind, round(lat, 4), round(lon, 4))
            if key in seen:
                break
            seen.add(key)
            row = [kind, name, round(lat, 6), round(lon, 6)]
            if kind == 'aid':
                row.append(aid_sub(t))
            items.append(row)
            break
    items.sort()
    out = {
        'area': area, 'bbox': [s, w, n, e],
        'fetched': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'license': 'Map data © OpenStreetMap contributors, ODbL.',
        'items': items,
    }
    with open(f'data/poi-{area}.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    by = {}
    for it in items:
        by[it[0]] = by.get(it[0], 0) + 1
    print(len(items), 'places:', by)


if __name__ == '__main__':
    main()
