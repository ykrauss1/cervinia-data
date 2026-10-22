# -*- coding: utf-8 -*-
"""Builds the monthly re-check worklist.

The idea is to avoid re-parsing anyone's website. verified_urls.json already
stores a verbatim excerpt from each source - the sentence the site's claim
rests on. So the monthly check is one question per source: does that sentence
still appear on that page? If it does, nothing moved. If it is gone, the page
changed and the claim needs a human look. A canary, not a parser.

Only volatile sources are worth checking. An altitude, a piste number or a
coordinate does not drift; a price, an opening time or a season date does.
Volatility is read off the excerpt itself rather than declared by hand, so a
source that gains a price later starts being checked without anyone
remembering to mark it.

    python3 freshness.py              # print the worklist
    python3 freshness.py --write      # also refresh freshness.json
"""
import json, io, re, sys, datetime, os

# Same two layouts as validate.py: tools/ beside the repo root, or everything
# in one folder.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)

def _near(name):
    for d in (_HERE, _ROOT, os.getcwd()):
        f = os.path.join(d, name)
        if os.path.exists(f):
            return f
    return os.path.join(_HERE, name)

MONEY = re.compile(r'(?:€|EUR|CHF|\$)\s?\d|\b\d+(?:[.,]\d{2})?\s?(?:EUR|CHF|€)')
# A clock time only counts when it reads like opening hours - as one end of a
# range, or next to a word about opening. Without that, "0.33 Liter" and
# "45.93" look exactly like times and every source turns volatile.
HOURS = re.compile(
    r'\b([01]?\d|2[0-3])[:.][0-5]\d\b\s*(?:-|–|—|alle|to|a|until)\s*\b([01]?\d|2[0-3])[:.][0-5]\d\b'
    r'|(?:orari|aperto|apertura|open|opening|hours|chiuso|closed)[^.]{0,40}\b([01]?\d|2[0-3])[:.][0-5]\d\b',
    re.I)
# Likewise a date: a real day/month/year, a month name, or a season word -
# not any two numbers with a slash between them ("25/30 brands in bottle").
DATE = re.compile(
    r'\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b'
    r'|\b\d{1,2}\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre'
    r'|january|february|march|april|may|june|july|august|september|october|november|december)\b'
    r'|\b(?:stagione|season|inverno|winter|estate|summer)\b',
    re.I)
PHONE = re.compile(r'\b(?:\+?39[\s.]?)?(?:0\d{2,3}[\s.]?\d{5,7}|3\d{2}[\s.]?\d{3}[\s.]?\d{3,4})\b')

# Excerpts that are true but say nothing about the data, so they make useless
# canaries: a site header out of season, a brand name, a phrase of ours.
JUNK = set(['Closed', 'Nessun risultato trovato', 'temporarily closed',
            'The Glow Village', 'Carta del viaggiatore', 'Aosta archeologica',
            'stormy Monday, go to Aosta'])

# A canary only notices a change to the sentence it quotes. For a document
# that IS a price list, that is not enough: the season rolls over and the
# whole table is replaced. These are re-checked every season whatever their
# excerpt says, because being wrong here costs the reader money or strands
# them in another country.
ALWAYS = {
    'https://drive.google.com/file/d/1mXQHehvBzR39FtN9t_5SFMKihn1bmam4/view':
        'מחירון הסקי פס — כל טבלת המחירים באתר תלויה בו',
    'https://www.torgnon.org/wp-content/uploads/2024/02/Tariffe-Torgnon-inverno-26-27.pdf':
        'מחירון טורגנון — שם הקובץ נושא את העונה, אז בעונה הבאה זו כתובת אחרת',
    'https://www.matterhornparadise.ch/ZBAG/17-PDF/flyer/flyer-winter/2026-2027/fahrplan_winter%202026_27.pdf':
        'שעת העלייה האחרונה מצרמט — המקור היחיד בעולם למספר הזה',
    'https://scuolacervino.com/lezioni-di-sci-cervinia/':
        'מחירון השיעורים — כל המחירים בעמוד השיעורים',
    'https://www.cervinia.it/en/parcheggio-cervino-ski-paradise':
        'תעריפי החניון',
}


def classify(quote):
    """What kind of fact is this excerpt carrying, and how fast does it rot."""
    kinds = []
    if MONEY.search(quote):  kinds.append('מחיר')
    if HOURS.search(quote):  kinds.append('שעות')
    if DATE.search(quote):   kinds.append('עונה/תאריכים')
    if PHONE.search(quote) and not MONEY.search(quote): kinds.append('טלפון')
    if not kinds:
        return 'stable', []
    # A price list is the thing that changes every season and costs real money
    # when it is wrong, so it goes first.
    return ('volatile', kinds)


def load():
    reg = json.load(io.open(_near('verified_urls.json'), encoding='utf-8'))
    txt = json.load(io.open(_near('texts.json'), encoding='utf-8'))
    return reg, txt


def covers_map(txt):
    """What each source is said to back, in Yossi's own words, out of the
    generated sources block - so the worklist reads like the site."""
    out = {}
    for g in txt.get('sources', {}).get('groups', []):
        for it in g.get('items', []):
            out[it.get('url')] = (g.get('label', ''), it.get('name', ''), it.get('covers', ''))
    return out


def build():
    reg, txt = load()
    cov = covers_map(txt)
    items = []
    for url in reg.get('exact', []):
        note = reg.get(url)
        if not isinstance(note, str):
            # A source on the always-check list belongs in the worklist even
            # if nobody has written an excerpt for it yet.
            if url not in ALWAYS:
                continue
            note = ''
        quotes = [q for q in re.findall(r"(?<![A-Za-z])'([^']{6,220})'(?![A-Za-z])", note)
                  if q not in JUNK]
        if not quotes and url not in ALWAYS:
            continue
        kind, kinds = classify(' · '.join(quotes))
        if url in ALWAYS:
            kind = 'volatile'
            if 'מחירון' not in kinds:
                kinds = ['מחירון עונתי'] + kinds
        group, name, covers = cov.get(url, ('', '', ''))
        items.append({
            'url': url,
            'name': name or url.split('/')[2],
            'group': group,
            'covers': covers,
            'volatility': kind,
            'kinds': kinds,
            'canary': quotes,
        })
    # price first, then hours, then the rest - worst consequence first
    rank = {'מחירון עונתי': 0, 'מחיר': 1, 'שעות': 2, 'עונה/תאריכים': 3, 'טלפון': 4}
    items.sort(key=lambda i: (i['volatility'] != 'volatile',
                              min([rank.get(k, 9) for k in i['kinds']] or [9]),
                              i['name']))
    return items


def main():
    items = build()
    vol = [i for i in items if i['volatility'] == 'volatile']
    sta = [i for i in items if i['volatility'] != 'volatile']
    print('מקורות עם ציטוט: %d · לבדיקה חודשית: %d · יציבים: %d'
          % (len(items), len(vol), len(sta)))
    print()
    for i in vol:
        print('• %-46s [%s]' % (i['name'][:46], ', '.join(i['kinds'])))
        if i['url'] in ALWAYS:
            print('  ⚠️ %s' % ALWAYS[i['url']])
        print('  %s' % i['url'])
        for q in i['canary'][:2]:
            print('  ציטוט: "%s"' % q[:96])
        print()
    if sta:
        print('לא דורשים בדיקה (אין בציטוט מחיר, שעה או תאריך).')
        print('שימו לב: הציטוט מגלה רק שינוי במשפט שצוטט. אם מקור מחזיק גם מחיר')
        print('שלא צוטט, שינוי בו לא ייתפס — לכן המחירונים נמצאים ברשימה הקבועה למעלה.')
        for i in sta:
            print('  · %s' % i['name'][:60])
    if '--write' in sys.argv:
        out = {'_comment': 'Generated by freshness.py. The canary is a verbatim '
                           'excerpt from the source; if it is gone, the page changed.',
               'generated': datetime.date.today().isoformat(),
               'items': items}
        json.dump(out, io.open(os.path.join(_HERE, 'freshness.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=2)
        print('\nנכתב freshness.json · %d פריטים' % len(items))


if __name__ == '__main__':
    main()
