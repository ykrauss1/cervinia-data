#!/usr/bin/env python3
"""Build en/index.html - the site in English at its own address - from index.html.

Why (Yossi, 26.11): a search in English showed the site with its Hebrew
description. /en/ used to be a small page that forwarded the reader to
/?lang=en; Google followed the forward, found the Hebrew page, and knew the
site in Hebrew only. Now /en/ is the whole site, the same file, declared as
English: its own title, description, canonical address and sharing card, and
the page set to English before anything is drawn.

Only index.html is ever edited, by hand or by any chat; this script makes the
English copy from it, and .github/workflows/build-en.yml runs it on every
push that changes index.html. Do not edit en/index.html: it is overwritten.

    python3 tools/build_en.py          # writes en/index.html
    python3 tools/build_en.py --check  # fails if en/index.html is out of date
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'index.html'
OUT = ROOT / 'en' / 'index.html'

SITE = 'https://cervinialive.co.il'
TITLE = 'Cervinia Live · the live ski guide'
DESC = ('Everything for a ski holiday in Cervinia: lifts and runs live, a piste guide with huts, '
        'navigation on the mountain, getting there from the airport, ski passes, equipment rental and costs.')
OG_TITLE = 'Cervinia Live — the live ski guide to Cervinia'
OG_DESC = 'Lifts and runs live, navigation on the mountain, a piste guide with huts, getting there from the airport, ski passes and equipment rental.'
OG_IMAGE = SITE + '/og-image-en.png'


def esc(s):
    return s.replace('&', '&amp;').replace('"', '&quot;').replace('<', '&lt;')


def sub1(pattern, repl, text, what):
    """Replace exactly one match, or stop: a head tag that moved must not be
    silently left in Hebrew."""
    new, n = re.subn(pattern, lambda m: repl, text, count=1, flags=re.S)
    if n != 1:
        sys.exit('build_en: could not find ' + what + ' in index.html')
    return new


def build(src):
    t = src
    # the page is English, and says so before the boot script decides the language
    t = sub1(r'<html lang="he" dir="rtl">', '<html lang="en" dir="ltr" data-page-lang="en">', t, '<html>')
    # Every relative address in the page (texts.json, img/, data/, sw.js ...)
    # is relative to the site's root, not to /en/. The click guard after it
    # keeps an in-page link ("#") in the page: with a base, "#x" would
    # otherwise point at the Hebrew home page.
    t = sub1(r'<meta charset="UTF-8">',
             '<meta charset="UTF-8">\n'
             '<!-- GENERATED from index.html by tools/build_en.py. Do not edit: it is overwritten. -->\n'
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
    t = sub1(r'<title>[^<]*</title>', '<title>' + TITLE + '</title>', t, '<title>')
    t = sub1(r'<meta name="description" content="[^"]*">', '<meta name="description" content="' + esc(DESC) + '">', t, 'description')
    t = sub1(r'<link rel="canonical" href="[^"]*">', '<link rel="canonical" href="' + SITE + '/en/">', t, 'canonical')
    t = sub1(r'<meta property="og:site_name" content="[^"]*">', '<meta property="og:site_name" content="Cervinia Live">', t, 'og:site_name')
    t = sub1(r'<meta property="og:locale" content="[^"]*">',
             '<meta property="og:locale" content="en_GB">\n<meta property="og:locale:alternate" content="he_IL">', t, 'og:locale')
    t = sub1(r'<meta property="og:url" content="[^"]*">', '<meta property="og:url" content="' + SITE + '/en/">', t, 'og:url')
    t = sub1(r'<meta property="og:title" content="[^"]*">', '<meta property="og:title" content="' + esc(OG_TITLE) + '">', t, 'og:title')
    t = sub1(r'<meta property="og:description" content="[^"]*">', '<meta property="og:description" content="' + esc(OG_DESC) + '">', t, 'og:description')
    t = sub1(r'<meta property="og:image" content="[^"]*">', '<meta property="og:image" content="' + OG_IMAGE + '">', t, 'og:image')
    t = sub1(r'<meta property="og:image:alt" content="[^"]*">', '<meta property="og:image:alt" content="' + esc(OG_TITLE) + '">', t, 'og:image:alt')
    t = sub1(r'<meta name="twitter:title" content="[^"]*">', '<meta name="twitter:title" content="' + esc(OG_TITLE) + '">', t, 'twitter:title')
    t = sub1(r'<meta name="twitter:description" content="[^"]*">', '<meta name="twitter:description" content="' + esc(OG_DESC) + '">', t, 'twitter:description')
    t = sub1(r'<meta name="twitter:image" content="[^"]*">', '<meta name="twitter:image" content="' + OG_IMAGE + '">', t, 'twitter:image')
    # The Search Console line proves the root is Yossi's; the copy needs none.
    t = re.sub(r'<meta name="google-site-verification"[^>]*>\n?', '', t, count=1)
    return t


def main():
    out = build(SRC.read_text(encoding='utf-8'))
    if '--check' in sys.argv:
        cur = OUT.read_text(encoding='utf-8') if OUT.exists() else ''
        if cur != out:
            sys.exit('en/index.html is out of date: run python3 tools/build_en.py')
        print('en/index.html is up to date')
        return
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(out, encoding='utf-8')
    print('wrote', OUT.relative_to(ROOT), len(out), 'chars')


if __name__ == '__main__':
    main()
