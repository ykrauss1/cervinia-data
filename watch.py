# -*- coding: utf-8 -*-
"""Weekly watch on the official sources the site's facts rest on.

Yossi, 15.11: "is anything following updates? The price list is 26/27 - next
season, does something check and update, or ask whether to update?"

It asks; it does not update. Every fact on the site was checked by hand
against its source, and a scraper that rewrote prices would undo exactly
that. So this only notices, and says what it noticed:

  * a document (a price list, a timetable PDF): the file itself changed;
  * a page: the sentence a fact on the site rests on - the verbatim excerpt
    kept in verified_urls.json - is no longer on it (freshness.py picks
    which pages, by whether the excerpt carries a price, an hour or a date);
  * the hub pages of the resort and the region: a new document link turned
    up (a new season's price list is usually just that), or the next season
    is named on the page.

Nothing is reported on the first run: that run only records how things are.
After that, a change is reported once, when it happens, in watch-report.md -
which the workflow turns into a GitHub issue, so it arrives by e-mail. A
source that cannot be reached is mentioned only after three weeks in a row,
since sites block a run now and then.

    python3 watch.py            # check, update watch-state.json, write the report
    python3 watch.py --dry      # check and print, write nothing
"""
import hashlib, html, io, json, os, re, sys, time, datetime, urllib.request, urllib.error

import freshness

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, 'watch-state.json')
REPORT = os.path.join(HERE, 'watch-report.md')
UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
      'Chrome/126.0 Safari/537.36 CerviniaLive-source-watch')

# Where a new season's documents get linked from. A new PDF or Drive link on
# one of these, or the next season's name on it, is worth a look.
HUBS = [
    'https://www.cervinia.it/en/impianti',
    'https://www.cervinia.it/en/skirama',
    'https://www.cervinia.it/eventi/accesso-alle-biglietterie-e-acquisto-ticket-online',
    'https://www.cervinia.it/en/parcheggio-cervino-ski-paradise',
    'https://www.torgnon.org/',
    'https://www.matterhornparadise.ch/en/book/tickets',
]

DOC = re.compile(r'\.pdf(\?|$)|drive\.google\.com/file/d/', re.I)


def season_names(today=None):
    """The next season, written the ways the sites write it: 2027/2028,
    2027/28, 2027-28, 27/28."""
    t = today or datetime.date.today()
    y = t.year + (1 if t.month >= 7 else 0)   # in Nov 2026 the next is 2027/28
    a, b = y, y + 1
    return [f'{a}/{b}', f'{a}/{str(b)[2:]}', f'{a}-{b}', f'{a}-{str(b)[2:]}',
            f'{str(a)[2:]}/{str(b)[2:]}', f'{str(a)[2:]}-{str(b)[2:]}']


def season_named(text, seasons):
    """The next season, as the page's visible text names it. The full forms
    (2027/2028, 2027/28) stand on their own; a short one ("27-28") counts
    only beside a season word - on its own it is as likely a date, "26-27-28
    gennaio"."""
    word = r'(?:stagione|season|saison|inverno|winter|hiver|skipass|ski pass|tariff|prezzi|listino)'
    for s in seasons:
        pat = r'(?<![\d-])' + re.escape(s) + r'(?![\d-])'
        if len(s) >= 7:
            if re.search(pat, text):
                return [s]
        elif re.search(word + r'.{0,40}' + pat + '|' + pat + r'.{0,40}' + word, text):
            return [s]
    return []


def fetch(url):
    u = url
    m = re.search(r'drive\.google\.com/file/d/([^/]+)', url)
    if m:  # the file, not the viewer around it, which changes on its own
        u = 'https://drive.google.com/uc?export=download&id=' + m.group(1)
    req = urllib.request.Request(u, headers={'User-Agent': UA, 'Accept-Language': 'en,it;q=0.8'})
    last = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read(), r.headers.get('Content-Type', '')
        except Exception as e:  # noqa - any failure is "not reachable this week"
            last = e
            time.sleep(3)
    raise last


def norm(s):
    s = html.unescape(s)
    s = s.replace('’', "'").replace('‘', "'").replace(' ', ' ')
    s = s.replace('–', '-').replace('—', '-')
    return re.sub(r'\s+', ' ', s).strip().lower()


def page_text(raw):
    t = raw.decode('utf-8', 'replace')
    t = re.sub(r'(?is)<(script|style|noscript)[^>]*>.*?</\1>', ' ', t)
    t = re.sub(r'<[^>]+>', ' ', t)
    return norm(t)


def doc_links(raw, base):
    t = raw.decode('utf-8', 'replace')
    out = set()
    for h in re.findall(r'href=["\']([^"\']+)["\']', t, re.I):
        h = html.unescape(h)
        if h.startswith('//'):
            h = 'https:' + h
        elif h.startswith('/'):
            h = re.match(r'https?://[^/]+', base).group(0) + h
        if h.startswith('http') and DOC.search(h):
            out.add(h.split('#')[0])
    return sorted(out)


def is_doc(url):
    return bool(DOC.search(url))


def main():
    dry = '--dry' in sys.argv
    today = datetime.date.today().isoformat()
    try:
        state = json.load(io.open(STATE, encoding='utf-8'))
    except FileNotFoundError:
        state = {}
    first = not state
    st_src = state.setdefault('sources', {})
    st_hub = state.setdefault('hubs', {})

    items = [i for i in freshness.build() if i['volatility'] == 'volatile']
    changes, unreachable = [], []

    for it in items:
        url = it['url']
        rec = st_src.setdefault(url, {})
        try:
            raw, ctype = fetch(url)
        except Exception as e:
            rec['fails'] = rec.get('fails', 0) + 1
            rec['error'] = str(e)[:120]
            if rec['fails'] == 3:
                unreachable.append((it, rec['error']))
            continue
        rec['fails'] = 0
        rec.pop('error', None)
        rec['checked'] = today
        if is_doc(url) or 'pdf' in ctype.lower():
            h = hashlib.sha256(raw).hexdigest()
            if rec.get('hash') and rec['hash'] != h:
                changes.append((it, 'הקובץ עצמו השתנה'))
            rec['hash'] = h
        else:
            text = page_text(raw)
            now = {q: norm(q) in text for q in it['canary']}
            before = rec.get('present', {})
            gone = [q for q, ok in now.items() if not ok and before.get(q, False)]
            if gone:
                changes.append((it, 'המשפט שעליו נשענת העובדה כבר לא בדף: "%s"' % gone[0][:140]))
            rec['present'] = now

    seasons = season_names()
    told = set()   # one new link, linked from five pages, is one finding
    for url in HUBS:
        rec = st_hub.setdefault(url, {})
        try:
            raw, _ = fetch(url)
        except Exception as e:
            rec['fails'] = rec.get('fails', 0) + 1
            if rec['fails'] == 3:
                unreachable.append(({'name': url.split('/')[2], 'url': url, 'covers': 'עמוד מרכזי'}, str(e)[:120]))
            continue
        rec['fails'] = 0
        rec['checked'] = today
        links = doc_links(raw, url)
        if 'links' in rec:
            new = [l for l in links if l not in rec['links'] and l not in told]
            told.update(new)
            for l in new[:6]:
                changes.append(({'name': url.split('/')[2], 'url': url, 'covers': 'מסמך חדש בעמוד מרכזי'},
                                'קישור חדש למסמך: %s' % l))
        rec['links'] = links
        named = season_named(page_text(raw), seasons)
        if named and not rec.get('season_seen'):
            changes.append(({'name': url.split('/')[2], 'url': url, 'covers': 'העונה הבאה'},
                            'העונה הבאה (%s) מופיעה בעמוד — אולי פורסם מחירון חדש' % named[0]))
            rec['season_seen'] = named[0]

    state['last_run'] = today
    lines = []
    if first:
        print('ריצה ראשונה: נרשם המצב הקיים (%d מקורות, %d עמודים מרכזיים). אין דיווח.'
              % (len(st_src), len(st_hub)))
    elif changes or unreachable:
        lines.append('בדיקת המקורות השבועית מצאה דברים שכדאי להסתכל עליהם. '
                     'שום דבר באתר לא השתנה מעצמו — כל עדכון עובר אימות.\n')
        if changes:
            lines.append('## השתנה')
            for it, what in changes:
                lines.append('- **%s** — %s  \n  %s  \n  באתר תלוי בזה: %s'
                             % (it.get('name', ''), what, it['url'], it.get('covers') or '—'))
        if unreachable:
            lines.append('\n## לא נגיש כבר שלושה שבועות')
            for it, err in unreachable:
                lines.append('- **%s** — %s  \n  %s' % (it.get('name', ''), err, it['url']))
    print('\n'.join(lines) if lines else ('אין שינויים.' if not first else ''))
    if dry:
        return
    json.dump(state, io.open(STATE, 'w', encoding='utf-8'), ensure_ascii=False, indent=1, sort_keys=True)
    if lines:
        io.open(REPORT, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
    elif os.path.exists(REPORT):
        os.remove(REPORT)


if __name__ == '__main__':
    main()
