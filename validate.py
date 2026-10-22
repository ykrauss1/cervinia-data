#!/usr/bin/env python3
"""
Gatekeeper for texts.json.

Everything this checks is something that actually went wrong in the file at
least once, so each rule is a scar rather than a precaution.
"""
import json, io, re, sys, os

ERR, WARN = [], []
def err(m):  ERR.append(m)
def warn(m): WARN.append(m)

# The site keeps texts.json and index.html at the repo root, while these tools
# live in tools/. Locally they sometimes sit side by side instead. Rather than
# hard-code either shape - which is exactly how the first workflow file came
# out pointing at a folder that does not exist - look in the script's own
# directory first, then one level up.
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

def near(name):
    for d in (HERE, ROOT, os.getcwd()):
        f = os.path.join(d, name)
        if os.path.exists(f):
            return f
    return os.path.join(HERE, name)        # for the error message

path = sys.argv[1] if len(sys.argv) > 1 else near('texts.json')
raw = io.open(path, 'rb').read()

# ---- 1. it has to parse, and it has to be the whole file -------------
try:
    d = json.loads(raw.decode('utf-8'))
except Exception as e:
    print('FATAL: not valid JSON -', e); sys.exit(1)

REQUIRED_TOP = ['_comment','_version','pistes','ski_instructors','ui','modals',
                'skipass','parking','services','why_cervinia','rental','lessons','kosher']
for k in REQUIRED_TOP:
    if k not in d: err('missing top-level key: ' + k)

# ---- 2. no fabricated short links -----------------------------------
# A Google short code is random. A readable word in that slot means somebody
# made the link up, and it will 404 for every visitor.
SHORTENERS = re.compile(r'https?://(maps\.app\.goo\.gl|goo\.gl/maps)/([^\s"\']+)')
URL = re.compile(r'https?://[^\s"\'<>)]+')

def walk(o, p=''):
    if isinstance(o, dict):
        for k, v in o.items(): walk(v, p + '/' + str(k))
    elif isinstance(o, list):
        for i, v in enumerate(o): walk(v, p + '[' + str(i) + ']')
    elif isinstance(o, str):
        for m in URL.finditer(o):
            u = m.group(0)
            sm = SHORTENERS.match(u)
            if sm:
                code = sm.group(2)
                # real codes are mixed-case alphanumeric, ~10-20 chars, no
                # hyphens or dictionary words
                if '-' in code or code.islower() or len(code) < 10:
                    err('fabricated-looking map link at %s: %s' % (p, u))
            if u not in VERIFIED and not any(u.startswith(x) for x in VERIFIED_PREFIX):
                warn('unverified URL at %s: %s' % (p, u))

# ---- index.html links ------------------------------------------------
# The first run of the source audit covered texts.json and nothing else,
# and three dead links sat in index.html the whole time - two domains that
# no longer resolve and a search on a US lessons site that has nothing in
# Cervinia. Hard-coded links are links too, so they are checked here now.
def check_html_links(path=None):
    path = path or near('index.html')
    try:
        html = io.open(path, encoding='utf-8').read()
    except Exception:
        return  # running without the page next to us is fine
    seen = set()
    for m in re.finditer(r'href="(https?://[^"]+)"', html):
        u = m.group(1)
        if u in seen:
            continue
        seen.add(u)
        sm = SHORTENERS.match(u)
        if sm:
            code = sm.group(2)
            if '-' in code or code.islower() or len(code) < 10:
                err('fabricated-looking map link in index.html: ' + u)
        if u not in VERIFIED and not any(u.startswith(x) for x in VERIFIED_PREFIX):
            warn('unverified URL in index.html: ' + u)


# Links confirmed working by hand. Anything else gets a warning so it has to
# be looked at rather than inherited.
VERIFIED = set()
VERIFIED_PREFIX = []
try:
    vf = json.load(io.open(near('verified_urls.json'), encoding='utf-8'))
    VERIFIED = set(vf.get('exact', []))
    VERIFIED_PREFIX = vf.get('prefix', [])
except Exception:
    warn('verified_urls.json not found - every URL will be reported')

walk(d)
check_html_links()

# ---- 3. the piste schema has to be uniform --------------------------
P = d.get('pistes', {})
NEED = {'beginner':  ['num','name','area','len','diff','desc','tip','tags'],
        'intermediate':['num','name','area','len','diff','desc','tip','tags'],
        'advanced':  ['num','name','area','len','diff','desc','tip','tags'],
        'zermatt':   ['num','name','area','len','diff','desc','tip','tags'],
        'restaurants':['name','area','desc','tip','tags'],
        'apres_ski': ['name','area','desc','tip','tags']}
for sec, fields in NEED.items():
    for i, it in enumerate(P.get(sec, [])):
        for f in fields:
            if f not in it: err('%s[%d] missing field %s' % (sec, i, f))
        if not str(it.get('name','')).strip(): err('%s[%d] has no name' % (sec,i))

# ---- 3b. the "around" section has its own schema --------------------
A = d.get('around', {})
if A:
    CATS = set(c['id'] for c in A.get('cats', []))
    if not CATS: err('around: no categories defined')
    seen_names = {}
    for i, pl in enumerate(A.get('places', [])):
        for f in ['cat', 'icon', 'name', 'he', 'what', 'drive', 'open', 'storm']:
            if f not in pl: err('around.places[%d] (%s) missing field %s'
                                % (i, pl.get('name', '?'), f))
        if pl.get('cat') not in CATS:
            err('around.places[%d] has unknown cat %r' % (i, pl.get('cat')))
        if not isinstance(pl.get('storm'), bool):
            err('around.places[%d] storm must be true/false' % i)
        nm = pl.get('name', '')
        if nm in seen_names:
            err('around: duplicate place name %r (also at index %d)' % (nm, seen_names[nm]))
        seen_names[nm] = i
        # proper names stay in the original language - a Hebrew-lettered
        # "name" means something got translated that should not have been
        if re.search(r'[\u0590-\u05FF]', nm):
            err('around.places[%d] name is in Hebrew, should be the original: %r' % (i, nm))
        # a place that claims to work in a storm but needs a lift is a
        # contradiction - that is exactly the trap this section warns about
        if pl.get('storm') and pl.get('lifts'):
            err('around.places[%d] (%s) is marked storm-ok but also lift-dependent' % (i, nm))
    for c in A.get('cats', []):
        if not any(pl.get('cat') == c['id'] for pl in A.get('places', [])):
            warn('around: category %r has no places' % c['id'])

# ---- 3c. time-limited notices that have run out ---------------------
# These hide themselves in the browser, so nothing is shown to visitors.
# They are still worth deleting, and nobody will remember to unless told.
def _expired(val):
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(20\d{2})$', str(val or ''))
    if not m: return False
    try: return datetime.date(int(m.group(3)), int(m.group(2)), int(m.group(1))) < datetime.date.today()
    except ValueError: return False

import datetime
for i, pl in enumerate(d.get('around', {}).get('places', [])):
    if _expired(pl.get('warn_until')):
        warn('expired notice on %s (ran out %s) - hidden on the site, safe to delete'
             % (pl.get('name', '?'), pl['warn_until']))
for i, c in enumerate(d.get('around', {}).get('closed', [])):
    if isinstance(c, dict) and _expired(c.get('until')):
        warn('expired "closed in winter" bullet [%d] (ran out %s) - hidden on the site, safe to delete'
             % (i, c['until']))

# ---- 3d. piste "map" holds a search phrase, not a URL ---------------
# It used to hold a URL, and a hand-written map URL is exactly how a
# fabricated link got into this file once before.
for sec in ['beginner', 'intermediate', 'advanced', 'zermatt']:
    for i, it in enumerate(d.get('pistes', {}).get(sec, [])):
        m = it.get('map', '')
        if m and ('http' in m or '/' in m):
            err('%s[%d] (%s): map should be a place name, not a URL: %r'
                % (sec, i, it.get('name', '?'), m))

# ---- 3e. Mapy targets must look like what Mapy produces -------------
for sec in ['beginner', 'intermediate', 'advanced', 'zermatt']:
    for i, it in enumerate(d.get('pistes', {}).get(sec, [])):
        o = str(it.get('mapy', ''))
        if o and not o.isdigit():
            err('%s[%d] (%s): mapy id should be digits only, got %r'
                % (sec, i, it.get('name', '?'), o))
        xy = str(it.get('xy', ''))
        if xy:
            parts = xy.split(',')
            ok = len(parts) == 2
            if ok:
                try:
                    lon, lat = float(parts[0]), float(parts[1])
                    # Cervinia / Zermatt sits around 7.5-7.9 E, 45.8-46.1 N.
                    # A swapped pair lands outside both and is caught here.
                    ok = 7.0 < lon < 8.5 and 45.5 < lat < 46.5
                except ValueError:
                    ok = False
            if not ok:
                err('%s[%d] (%s): xy should be "lon,lat" near the resort, got %r'
                    % (sec, i, it.get('name', '?'), xy))
        # A mapy id without xy opens the detail but leaves the map elsewhere,
        # and xy without an id falls back to search ranking - which is what
        # sent piste 5 to the gondola. Both halves or neither.
        if bool(it.get('mapy')) != bool(it.get('xy')):
            err('%s[%d] (%s): mapy id and xy must come as a pair'
                % (sec, i, it.get('name', '?')))
        if it.get('mapy') and not it.get('trail'):
            err('%s[%d] (%s): mapy id without a trail name to show'
                % (sec, i, it.get('name', '?')))

# ---- 3f. map queries must not be exact street addresses -------------
# A query ending in a house number is an exact-address lookup: if the indexed
# address differs at all, Google returns nothing instead of degrading to the
# comune. Name + comune + Italia always lands somewhere useful.
_STREET = re.compile(
    r"\b(Via|Viale|Piazza|Piazzale|Corso|Strada|Localit[aà]|Localita|All[eé]e"
    r"|Allee|Rue|Route|Vicolo|L'Ile)\b", re.I)
_HOUSENO = re.compile(r"\b\d{1,4}\s*(?:,|$)")
def _check_q(path, q):
    if not isinstance(q, str) or q.startswith('http'):
        return
    if _STREET.search(q) and _HOUSENO.search(q):
        err('%s: map query looks like an exact street address, '
            'use "name, comune, Italia": %r' % (path, q))
def _walk_q(o, path=''):
    if isinstance(o, dict):
        # a street address is only a problem when the name is all the link
        # has. Once the entry carries verified coordinates the map opens on
        # the right spot whatever the name does, so the rule steps aside.
        pinned = bool(o.get('latlon') or o.get('start_latlon'))
        for k, v in o.items():
            if k in ('map', 'geo', 'trail', 'trail_approx'):
                if not pinned:
                    _check_q(path + '/' + k, v)
            else:
                _walk_q(v, path + '/' + str(k))
    elif isinstance(o, list):
        for i, v in enumerate(o):
            _walk_q(v, path + '[' + str(i) + ']')
_walk_q(d)

# ---- 3g. every coordinate must be in the right corner of Europe -----
# This is the regression guard for the worst bug the browser check found:
# Google answered "Pancheron, Breuil-Cervinia" and "Piazza Emile Chanoux,
# Aosta" with a point in ISRAEL, because it fell back to the reader's own
# location when it could not match the name. A stored coordinate makes that
# impossible, and this rule makes sure a stored coordinate is never silly.
#   latlon / start_latlon : "lat,lon"  - Google order
#   xy                    : "lon,lat"  - Mapy's x,y order
# Keeping two orders in one file is asking for trouble, so the field name
# says which one it is and this rule enforces it.
def _pair(v):
    try:
        a, b = [float(x) for x in str(v).split(',')]
        return a, b
    except Exception:
        return None

def _check_coords(path, key, v):
    pr = _pair(v)
    if pr is None:
        err('%s/%s: not a coordinate pair: %r' % (path, key, v))
        return
    if key in ('latlon', 'start_latlon'):
        lat, lon = pr
    else:
        lon, lat = pr
    # Aosta valley, Piemonte, Lombardia and the Zermatt side, with margin
    if not (44.8 < lat < 46.3 and 6.7 < lon < 9.6):
        err('%s/%s: %r is outside the area the site covers '
            '(lat %.4f, lon %.4f) - wrong order, or a geocoder fallback'
            % (path, key, v, lat, lon))

def _walk_coords(o, path=''):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ('latlon', 'start_latlon', 'xy'):
                _check_coords(path, k, v)
            else:
                _walk_coords(v, path + '/' + str(k))
    elif isinstance(o, list):
        for i, v in enumerate(o):
            _walk_coords(v, path + '[' + str(i) + ']')
_walk_coords(d)

import datetime as _dt
TODAY_D = _dt.date.today()
def _parse_dmy(v):
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})$', str(v or ''))
    if not m:
        return None
    try:
        return _dt.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:
        return None

# ---- 3h. the Zermatt briefing -----------------------------------------
# The last ascent back to Italy is the one number in this file that can get
# somebody stranded on the wrong side of a border, so it gets its own rule:
# every window needs a real HH:MM and an end date, the windows must run in
# date order, and the whole block must still have a window that has not
# expired. When the last window lapses the box would silently show a stale
# time, which is worse than showing nothing.
sw = d.get('swiss')
if sw:
    ll = sw.get('last_lift') or {}
    wins = ll.get('windows') or []
    if not wins:
        err('/swiss/last_lift: no windows - the box would print nothing')
    if not ll.get('live_url'):
        err('/swiss/last_lift: no live_url; the published time changes daily '
            'and the app must be able to send the reader to the real one')
    prev = None
    for i, w in enumerate(wins):
        t = str(w.get('time', ''))
        if not re.match(r'^\d{1,2}:\d{2}$', t):
            err('/swiss/last_lift/windows[%d]: bad time %r' % (i, t))
        dt = _parse_dmy(w.get('to'))
        if dt is None:
            err('/swiss/last_lift/windows[%d]: bad or missing end date %r'
                % (i, w.get('to')))
        elif prev and dt <= prev:
            err('/swiss/last_lift/windows[%d]: end date %s is not after the '
                'previous window' % (i, w.get('to')))
        else:
            prev = dt
    if wins and prev is not None and prev < TODAY_D:
        err('/swiss/last_lift: every window has expired (last one ended %s) - '
            'refresh from the operator timetable before the season'
            % wins[-1].get('to'))

# ---- 3i. piste numbers must look like piste numbers -------------------
# The badge prints this field verbatim, so it has to be a ref a skier can
# match against a signpost. Cervino's own map really does number runs 3.0,
# 3.00, 6.0, 6.00, 7.0 and 7.00 - the decimals are not spreadsheet damage -
# so they are allowed; what is not allowed is whitespace, punctuation or
# words. Two refs joined by a middle dot mean one marked run covers two
# segments.
NUM_OK = re.compile(r'^[0-9A-Za-z][0-9A-Za-z.-]*(?: ?[\u00b7/] ?[0-9A-Za-z][0-9A-Za-z.-]*)*$')
for _sec, _runs in (P or {}).items():
    if not isinstance(_runs, list):
        continue
    for _i, _p in enumerate(_runs):
        if not isinstance(_p, dict):
            continue
        _n = _p.get('num')
        if _n in (None, ''):
            continue
        if not NUM_OK.match(str(_n)):
            err('/pistes/%s[%d] (%s): piste number %r is not a usable ref'
                % (_sec, _i, _p.get('name', '?'), _n))

# ---- 4. things that go stale do not belong in a yearly file ---------
blob = json.dumps(P, ensure_ascii=False)
for t in sorted(set(re.findall(r'\b\d{1,2}:\d{2}\b', blob))):
    warn('clock time in pistes (goes stale): ' + t)
for w in ['חינם', 'חינמי', 'ללא תשלום']:
    if w in blob: warn('a "free" claim in pistes: ' + w)

# ---- 5. dates that have already passed ------------------------------
import datetime
TODAY = datetime.date.today()
_dated = json.loads(json.dumps(d, ensure_ascii=False))
def _strip_expiries(o):
    if isinstance(o, dict):
        o.pop('warn_until', None)
        if 'until' in o and 'text' in o: o.pop('until')
        for v in o.values(): _strip_expiries(v)
    elif isinstance(o, list):
        for v in o: _strip_expiries(v)
_strip_expiries(_dated)
for m in re.finditer(r'(\d{2})/(\d{2})/(20\d{2})', json.dumps(_dated, ensure_ascii=False)):
    dd, mm, yy = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try: when = datetime.date(yy, mm, dd)
    except ValueError: continue
    if when < TODAY and yy >= TODAY.year - 1:
        warn('date already in the past: %s' % m.group(0))

# ---- 6. altitudes have to agree with each other ---------------------
# Cielo Alto was published at 2955 m while its own chairlift bottom station
# is at 2106 m. A cross-check is cheap; believing the file is not.
KNOWN = {'Plateau Rosa': (3450, 3500), 'Plan Maison': (2500, 2600),
         'Cielo Alto': (2050, 2200), 'Klein Matterhorn': (3870, 3890),
         'Cervinia': (2000, 2100), 'Zermatt': (1600, 1640)}
ALT_SKIP = {'osm', 'mapy', 'xy', 'latlon', 'start_latlon',
            'map', 'trail', 'url'}
# route_geom and route_places hold raw coordinates, not entries; the prose
# rules below have nothing to say about them.
GEOM_SECTIONS = {'route_geom', 'route_places'}
for sec in P:
    if sec in GEOM_SECTIONS or not isinstance(P[sec], list):
        continue
    for it in P[sec]:
        if not isinstance(it, dict):
            continue
        txt = json.dumps({k: v for k, v in it.items() if k not in ALT_SKIP},
                         ensure_ascii=False)
        for place, (lo, hi) in KNOWN.items():
            if place in txt:
                for alt in re.findall(re.escape(place) + r'[^0-9]{0,24}(\d{4})', txt):
                    if not (lo <= int(alt) <= hi):
                        err('%s: "%s" given as %sm, expected %d-%dm'
                            % (sec, place, alt, lo, hi))

print('--- %s ---' % path)
for e in ERR:  print('ERROR  ', e)
for w in WARN: print('warn   ', w)
print('%d errors, %d warnings' % (len(ERR), len(WARN)))
sys.exit(1 if ERR else 0)
