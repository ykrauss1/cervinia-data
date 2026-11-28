#!/usr/bin/env python3
"""Build the topic pages - one panel of the site at an address of its own.

Why (Yossi, 28.11): the site is one page, and every subject in it opens as a
panel at "#kosher", "#skipass" and so on. A search engine drops everything
after the "#", so to Google the whole site is one address, the home page, and
somebody searching "kosher food in Cervinia" is never shown it.

A topic page is the site itself, opened on that one panel with nothing around
it: /kosher/ is the "Kosher and Shabbat" panel exactly as it is in the site -
the same tabs, the same live Shabbat times, the same folds - with its own
title, description and address, and a button that leads to the whole site.
A first cut wrote the texts out as a plain page of its own; it was flat, and
it was a second design to keep in step. This one cannot drift: it is the same
file as the site, with a few lines added to the head and the end of the body.

Only index.html is ever edited; .github/workflows/build-topics.yml runs this
on every push that changes it. Do not edit the generated files.

    python3 tools/build_topics.py          # writes the pages
    python3 tools/build_topics.py --check  # fails if a page is out of date
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_en  # noqa: E402  the English site is made by the same rule

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'index.html'
SITE = 'https://cervinialive.co.il'

TOPICS = {
    'kosher': {
        'modal': 'kosherModal',
        'he': {
            'title': 'כשרות ושבת בצ\'רוויניה: אוכל כשר, זמני שבת, מילאנו וטורינו · צ׳רוויניה לייב',
            'h1': 'כשרות ושבת בצ\'רוויניה (Cervinia)',
            'desc': 'זמני שבת וזמני היום בצ\'רוויניה; מה אפשר לקנות כשר בסופר בכפר ובאיטליה, עם גוף הכשרות של כל '
                    'מוצר; מסעדות, מכולות, בתי כנסת ולינה לשומרי שבת במילאנו ובטורינו; משלוח מוצרים כשרים עד הכפר.',
            'full': 'לאתר המלא',
            'full_long': 'לאתר המלא: מצב רכבלים ומסלולים, ניווט על ההר, שלג ותכנון טיול',
            'other': 'English',
        },
        'en': {
            'title': 'Kosher and Shabbat in Cervinia: kosher food, Shabbat times, Milan and Turin · Cervinia Live',
            'h1': 'Kosher and Shabbat in Cervinia',
            'desc': 'Shabbat and daily times in Cervinia; what you can buy kosher in the supermarket in the village and '
                    'across Italy, with the certifying body of each product; restaurants, groceries, synagogues and '
                    'Shabbat-friendly lodging in Milan and Turin; kosher delivery up to the village.',
            'full': 'The full site',
            'full_long': 'The full site: live lifts and runs, navigation on the mountain, snow and trip planning',
            'other': 'עברית',
        },
    },
}

esc = build_en.esc
sub1 = build_en.sub1

# What the page adds to the site's own style: everything around the panel is
# put away, and the panel stops being a box floating over a dimmed page and
# becomes the page. Other panels still open over it as they do in the site.
CSS = """
html[data-panel] #topstick, html[data-panel] body > .container, html[data-panel] body > footer,
html[data-panel] #version-badge, html[data-panel] #pwa-banner, html[data-panel] #alert-fab,
html[data-panel] #modal-float-x { display: none !important; }
html[data-panel] body { background: #eef2f7; overflow: auto !important; position: static !important;
  height: auto !important; width: auto !important; top: auto !important; }
html[data-panel] #%(modal)s { position: static !important; display: block !important; background: none !important;
  padding: 0 !important; height: auto !important; width: auto !important; overflow: visible !important; }
html[data-panel] #%(modal)s > .modal-content { width: auto !important; max-width: 760px !important;
  max-height: none !important; height: auto !important; margin: 0 auto !important; border-radius: 0 0 18px 18px;
  overflow: visible !important; box-sizing: border-box; }
html[data-panel] #%(modal)s > .modal-content > .close-btn { display: none !important; }
#panel-bar { background: #0a192f; color: #fff; }
#panel-bar .in { max-width: 760px; margin: 0 auto; padding: 12px 16px; display: flex; align-items: center;
  gap: 10px; flex-wrap: wrap; box-sizing: border-box; }
#panel-bar a.brand { color: #fff; text-decoration: none; font-weight: 700; display: flex; align-items: center; gap: 8px; }
#panel-bar a.brand img { width: 30px; height: 30px; border-radius: 7px; }
#panel-bar .sp { flex: 1; }
#panel-bar a.lang { color: #9fd8ee; text-decoration: none; font-size: 0.86rem; }
#panel-bar a.full { background: #4cc9f0; color: #0a192f; text-decoration: none; font-weight: 700;
  border-radius: 20px; padding: 7px 14px; font-size: 0.88rem; white-space: nowrap; }
#panel-h1 { max-width: 760px; margin: 0 auto; padding: 14px 16px 10px; box-sizing: border-box;
  font-size: 1.3rem; line-height: 1.35; color: #0a192f; background: #fff; }
#panel-foot { max-width: 760px; margin: 16px auto 40px; padding: 0 16px; box-sizing: border-box; }
#panel-foot a { display: block; background: #0b6b3a; color: #fff; text-decoration: none; font-weight: 700;
  border-radius: 12px; padding: 14px 16px; text-align: center; }
""".strip()

# Open the panel as the page and keep it open: nothing here closes it, the
# back button is not asked to, and the title stays this page's own.
JS = """
(function () {
  var MODAL = %(modal)r, TITLE = %(title)r;
  function start() {
    try { if (typeof openM === 'function') openM(MODAL); } catch (e) {}
    try { document.title = TITLE; } catch (e) {}
  }
  try {
    var _close = window.closeM;
    window.closeM = function (id) { if (id === MODAL) return; return _close.apply(this, arguments); };
    // The panel is the page, not a layer over one: it is never "the open
    // panel", so Escape and the phone's back button have nothing to close.
    var _open = window.openM;
    window.openM = function (id) {
      var r = _open.apply(this, arguments);
      if (id === MODAL) { try { _openModalId = null; } catch (e) {} try { _unlockBodyScroll(); } catch (e) {} }
      return r;
    };
  } catch (e) {}
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
  setTimeout(function () { try { document.title = TITLE; } catch (e) {} }, 1500);
})();
""".strip()


def js_str(s):
    """A Python string as a JavaScript string literal."""
    import json
    return json.dumps(s, ensure_ascii=False)


def build(src, slug, lang):
    tp = TOPICS[slug]
    m = tp[lang]
    he_url = '%s/%s/' % (SITE, slug)
    en_url = '%s/en/%s/' % (SITE, slug)
    url = en_url if lang == 'en' else he_url
    home = '/en/' if lang == 'en' else '/'
    other = ('/%s/' % slug) if lang == 'en' else ('/en/%s/' % slug)
    brand = 'Cervinia Live' if lang == 'en' else 'צ׳רוויניה לייב'

    t = build_en.build(src) if lang == 'en' else src
    if lang == 'en':
        t = sub1(r'<html lang="en" dir="ltr" data-page-lang="en">',
                 '<html lang="en" dir="ltr" data-page-lang="en" data-panel="%s">' % slug, t, '<html>')
        t = t.replace('GENERATED from index.html by tools/build_en.py.',
                      'GENERATED from index.html by tools/build_topics.py.', 1)
    else:
        # data-page-lang: this is the Hebrew address, so it is Hebrew whatever
        # language the reader last chose in the site - as /en/ is English
        t = sub1(r'<html lang="he" dir="rtl">',
                 '<html lang="he" dir="rtl" data-page-lang="he" data-panel="%s">' % slug, t, '<html>')
        # relative addresses are relative to the site's root, as in /en/
        t = sub1(r'<meta charset="UTF-8">',
                 '<meta charset="UTF-8">\n'
                 '<!-- GENERATED from index.html by tools/build_topics.py. Do not edit: it is overwritten. -->\n'
                 '<base href="/">\n'
                 '<script>\n'
                 'document.addEventListener("click", function (e) {\n'
                 '  var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;\n'
                 '  if (!a || e.defaultPrevented) return;\n'
                 '  var h = a.getAttribute("href") || "";\n'
                 '  if (h.charAt(0) !== "#") return;\n'
                 '  e.preventDefault();\n'
                 '  if (h.length > 1) location.hash = h;\n'
                 '});\n'
                 '</script>', t, '<meta charset>')
        t = re.sub(r'<meta name="google-site-verification"[^>]*>\n?', '', t, count=1)

    t = sub1(r'<title>[^<]*</title>', '<title>' + esc(m['title']) + '</title>', t, '<title>')
    t = sub1(r'<meta name="description" content="[^"]*">',
             '<meta name="description" content="' + esc(m['desc']) + '">', t, 'description')
    t = sub1(r'<link rel="canonical" href="[^"]*">', '<link rel="canonical" href="' + url + '">', t, 'canonical')
    t = sub1(r'<link rel="alternate" hreflang="he" href="[^"]*">',
             '<link rel="alternate" hreflang="he" href="' + he_url + '">', t, 'hreflang he')
    t = sub1(r'<link rel="alternate" hreflang="en" href="[^"]*">',
             '<link rel="alternate" hreflang="en" href="' + en_url + '">', t, 'hreflang en')
    t = sub1(r'<link rel="alternate" hreflang="x-default" href="[^"]*">',
             '<link rel="alternate" hreflang="x-default" href="' + he_url + '">', t, 'hreflang x-default')
    t = sub1(r'<meta property="og:url" content="[^"]*">', '<meta property="og:url" content="' + url + '">', t, 'og:url')
    t = sub1(r'<meta property="og:title" content="[^"]*">',
             '<meta property="og:title" content="' + esc(m['h1']) + '">', t, 'og:title')
    t = sub1(r'<meta property="og:description" content="[^"]*">',
             '<meta property="og:description" content="' + esc(m['desc']) + '">', t, 'og:description')
    t = sub1(r'<meta name="twitter:title" content="[^"]*">',
             '<meta name="twitter:title" content="' + esc(m['h1']) + '">', t, 'twitter:title')
    t = sub1(r'<meta name="twitter:description" content="[^"]*">',
             '<meta name="twitter:description" content="' + esc(m['desc']) + '">', t, 'twitter:description')

    t = sub1(r'</head>', '<style id="panel-style">\n' + CSS % {'modal': tp['modal']} + '\n</style>\n</head>', t, '</head>')
    bar = ('<div id="panel-bar"><div class="in">'
           '<a class="brand" href="%s"><img src="icon-192.png" alt="">%s</a><span class="sp"></span>'
           '<a class="lang" href="%s" hreflang="%s">%s</a><a class="full" href="%s">%s</a>'
           '</div></div>\n<h1 id="panel-h1">%s</h1>\n'
           % (home, brand, other, 'he' if lang == 'en' else 'en', m['other'], home, m['full'], m['h1']))
    t, n = re.subn(r'(<body[^>]*>)', lambda mm: mm.group(1) + '\n' + bar, t, count=1)
    if n != 1:
        sys.exit('build_topics: could not find <body> in index.html')
    if ('id="%s"' % tp['modal']) not in t:
        sys.exit('build_topics: the panel %s is not in index.html' % tp['modal'])
    js = JS.replace('%(modal)r', js_str(tp['modal'])).replace('%(title)r', js_str(m['title']))
    foot = ('<div id="panel-foot"><a href="%s">%s</a></div>\n<script id="panel-boot">\n%s\n</script>\n'
            % (home, m['full_long'], js))
    i = t.rfind('</body>')
    if i < 0:
        sys.exit('build_topics: could not find </body> in index.html')
    return t[:i] + foot + t[i:]


def outputs():
    src = SRC.read_text(encoding='utf-8')
    out = {}
    for slug in TOPICS:
        out[ROOT / slug / 'index.html'] = build(src, slug, 'he')
        out[ROOT / 'en' / slug / 'index.html'] = build(src, slug, 'en')
    return out


def main():
    check = '--check' in sys.argv
    stale = []
    for path, text in outputs().items():
        if check:
            if not path.exists() or path.read_text(encoding='utf-8') != text:
                stale.append(str(path.relative_to(ROOT)))
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        print('wrote', path.relative_to(ROOT), len(text), 'chars')
    if stale:
        sys.exit('build_topics: out of date: ' + ', '.join(stale))


if __name__ == '__main__':
    main()
