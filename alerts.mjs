// ============================================================
//  THE ALERT RULES
//
//  Lifted out of scrape.js so they can be run without running the scraper.
//  That file is ESM and builds a Supabase client at module scope, so
//  importing it to reach one function meant starting the whole thing -
//  which is why the part of this project that decides what buzzes on
//  people's phones was the one part with no tests at all.
//
//  Nothing here touches the network, the clock or the environment: every
//  rule is a pure function of (previous reading, new reading, minute of the
//  day). The clock is a parameter precisely so a test can ask what happens
//  at 08:10 without waiting until 08:10.
// ============================================================

// ============================================================
// AUTOMATIC ALERTS
//
// The scraper runs every half hour and is the only thing on this project
// that sees the mountain twice. That is all an alert needs: not a reading,
// but a reading next to the one before it. "Gust 78" is weather; "gust was
// 40 and is now 78" is news.
//
// Three rules the whole block obeys:
//
//   1. Transitions only. Every check compares the previous row against the
//      new one, so a condition that persists is reported once, not every
//      thirty minutes. cl_auto_alert's cooldown is the net under that, for
//      the runs where the previous row is missing.
//   2. No baseline, no alerts. If the previous reading cannot be read, this
//      block does nothing at all rather than treat every value as a change.
//   3. Daylight for anything about lifts. The feed reports zero open after
//      closing time, every single evening. Pushing that would teach people
//      to ignore us by the end of the first week.
//
// Set CL_AUTO_ALERTS=off to silence the whole block without touching code.
// ============================================================

// Minutes since midnight in Europe/Rome - the mountain's own clock, not the
// runner's UTC and not the reader's.
function romeMinutes(d = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Rome',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d);
    const h = +parts.find(p => p.type === 'hour').value;
    const m = +parts.find(p => p.type === 'minute').value;
    return h * 60 + m;
  } catch {
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

// Lifts are reported closed all evening and all night, and so is the
// crossing to Zermatt - it is a cable-car link, and it shuts when the lifts
// shut. Only inside the skiing day does "closed" mean something went wrong.
//
// The window is not guessed: the feed carries the operator's own hours in
// opening_hours ("08:00 - 16:45"), so the mountain says when its day is,
// and these are the fallbacks for the runs where that field is missing.
const LIFT_WINDOW = [9 * 60, 15 * 60 + 30];   // 09:00 - 15:30 Rome
const WIND_WINDOW = [6 * 60, 18 * 60];        // 06:00 - 18:00 Rome
// Not derived from the lifts: an avalanche bulletin is read the evening
// before, by somebody deciding whether to go off-piste tomorrow.
const AVALANCHE_WINDOW = [7 * 60, 20 * 60];   // 07:00 - 20:00 Rome

function inWindow([from, to], now = romeMinutes()) {
  return now >= from && now <= to;
}

// "08:00 - 16:45" -> [480, 1005]. Anything else -> null.
function parseOpeningHours(d) {
  const m = String((d && d.opening_hours) || '')
    .match(/(\d{1,2}):(\d{2})\s*[-\u2013\u2014]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const from = (+m[1]) * 60 + (+m[2]);
  const to   = (+m[3]) * 60 + (+m[4]);
  if (!(to > from) || to > 24 * 60) return null;
  return [from, to];
}

// The operating day, trimmed at both ends. The trims are the point:
//
//   padStart - the lifts do not all start at once, so "not everything is
//              running yet" at 08:10 is a morning, not a fault.
//   padEnd   - everything shuts at the end of the day, every day. Without
//              this trim the scraper would report the timetable as an
//              emergency once every evening, and people would mute it
//              inside a week.
//
// Zermatt needs a longer tail than the lifts: the last ascent back to Italy
// is around 14:50, so the crossing is already shutting while the pistes are
// still running.
function skiDayWindow(next, padStart, padEnd, fallback) {
  const hours = parseOpeningHours(next);
  if (!hours) return fallback;
  const from = hours[0] + padStart;
  const to   = hours[1] - padEnd;
  return (to > from) ? [from, to] : fallback;
}

// Numbers arrive as numbers, as "45", as "45 cm" or as null, depending on
// which part of the feed they came from.
function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const m = String(v).match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(',', '.'));
  return isFinite(n) ? n : null;
}

function upper(v) {
  return String(v ?? '').trim().toUpperCase();
}

// The resort this site is about, falling back to the whole Matterhorn area
// when the village panel could not be read.
function liftsOpen(d) {
  const local = num(d?.lifts_open_local);
  return local !== null ? local : num(d?.lifts_open_global);
}
function liftsTotal(d) {
  const local = num(d?.lifts_total_local);
  return local !== null ? local : num(d?.lifts_total_global);
}

// ------------------------------------------------------------
// The rules
//
// Each returns an alert or nothing. Severity decides how the strip paints
// the line, NOT whether it is pushed: cl_auto_alert pushes every severity,
// 'info' included. This comment used to say that info stayed on the strip,
// which was simply false - a fresh-snow alert, severity 'info', arrived on
// a phone and settled it. The push categories a reader can switch off are
// the real control.
// ------------------------------------------------------------
// nowMin is injectable so the rules can be tested at a chosen hour instead
// of only at whatever hour the test happens to run.
function detectAutoAlerts(prev, next, nowMin = romeMinutes()) {
  if (!prev || !next) return [];
  const out = [];

  const liftWin = skiDayWindow(next, 60, 90, LIFT_WINDOW);

  // The crossing gets a window of its own, and a wider one than the lifts.
  // The first version trimmed two hours off the front, on the reasoning that
  // the last ascent back to Italy is about 14:50 - which quietly assumed
  // everybody comes back the same day. They do not: you can ski across and
  // stay, and there are lockers at the lower station in Zermatt. So the
  // afternoon stays in. Only the final hour is trimmed, because at 16:45
  // everything shuts and that is the timetable, not news.
  const zermWin = skiDayWindow(next, 0, 60, LIFT_WINDOW);

  // Two moments inside that window behave differently from the rest:
  //
  //   zMorning - by an hour after the lifts start, a crossing that is still
  //              shut is a fact about today, not a mountain waking up.
  //   zOpenFrom- the crossing opens WITH the lifts every morning, so a
  //              CLOSED->OPEN before this is the timetable. After it, the
  //              same transition means it opened after having been shut,
  //              which is the news somebody who gave up at nine wants.
  const zMorning  = zermWin[0] + 60;
  const zOpenFrom = Math.max(zermWin[0] + 90, 9 * 60 + 30);

  // --- the crossing to Zermatt ------------------------------------------
  //
  // This is a cable-car link, not a border post: it closes every single
  // evening with the lifts, and opens every morning with them. Reporting
  // either as news would mean a push every day at dusk - the same mistake
  // the lift rules were already guarded against, and one this rule made
  // until a reader asked why a closure at six in the evening would alert.
  const zPrev = upper(prev.zermatt_link);
  const zNext = upper(next.zermatt_link);
  if (!inWindow(zermWin, nowMin)) {
    // outside the crossing's operating hours, both directions are the
    // timetable doing what a timetable does
  } else if (zPrev === 'OPEN' && zNext === 'CLOSED') {
    // it was running and it stopped - wind, or a fault
    out.push({
      key: 'zermatt-closed',
      severity: 'danger',
      hours: 8,
      cooldown: 10,
      text: 'המעבר לצ׳רמט נסגר. מי שתכנן לחצות היום — בדקו לפני שאתם עולים.'
    });
  } else if (zPrev === 'CLOSED' && zNext === 'CLOSED'
             && nowMin >= zMorning && (liftsOpen(next) || 0) > 0) {
    // Still shut an hour into a day on which the mountain is running. This
    // is a STATE, not a transition, which is the point: on a day the
    // crossing never opens at all there is no transition to catch, and
    // somebody planning to cross finds out by going up. The cooldown keeps
    // it to once a day.
    out.push({
      key: 'zermatt-shut-today',
      severity: 'warning',
      hours: 7,
      cooldown: 14,
      text: 'המעבר לצ׳רמט סגור היום, בזמן שהמעליות בצ׳רוויניה פועלות.'
    });
  } else if (zPrev === 'CLOSED' && zNext === 'OPEN' && nowMin >= zOpenFrom) {
    // Opened after having been shut - worth telling the person who gave up
    // at nine. Before zOpenFrom this is just the morning timetable.
    // The one alert people actively wait for. Somebody who read at nine that
    // the crossing was shut has been checking all morning, so this is urgent
    // in the ordinary sense of the word - it just is not alarming, and must
    // not look alarming. The strip renders this key in green rather than the
    // pale blue of an ordinary notice.
    //
    // It does reach the phone. The comment that used to sit here said info
    // was "the strip, not the phone", and that was simply wrong: cl_auto_alert
    // pushes these, as a fresh-snow alert arriving on a phone proved.
    out.push({
      key: 'zermatt-open',
      severity: 'info',
      hours: 5,
      cooldown: 8,
      text: 'המעבר לצ׳רמט נפתח — אפשר לעבור לצד השוויצרי.'
    });
  }

  // --- a day worth getting up for ---------------------------------------
  //
  // Every other rule here is about something going wrong, or about a thing
  // that was shut opening. That leaves the ordinary excellent day - the
  // crossing open since breakfast, the whole mountain turning, nothing in
  // the forecast - saying nothing at all, because nothing CHANGED. On 8.11
  // every lift was running and the strip was empty.
  //
  // So this one rule reads a state rather than a transition. It is the only
  // one that does, which is why it is fenced in on all sides: the first two
  // hours of the day, once per day by its cooldown, and a bar set high
  // enough that it stays worth reading. A green line that arrives every
  // morning is a green line nobody sees.
  {
    // The first two hours of the operator's own day, whatever they are.
    // skiDayWindow trims from both ends and cannot express "the first two
    // hours", so this one is measured from the opening time directly.
    const hrs = parseOpeningHours(next);
    const goodWin = hrs ? [hrs[0], Math.min(hrs[0] + 120, hrs[1])] : [8 * 60, 10 * 60];
    const oNow = liftsOpen(next);
    const tNow = liftsTotal(next);
    const av   = num(next.avalanche_level);
    const gust = num(next.wind_gust);
    // If the crossing has just opened, that line is already on the strip and
    // already green. Two cheerful notifications in one minute is one too
    // many, and the second says less than the first.
    const alreadyGood = out.some(a => a.key === 'zermatt-open');
    if (!alreadyGood &&
        inWindow(goodWin, nowMin) &&
        zNext === 'OPEN' &&
        oNow !== null && tNow !== null && tNow > 0 &&
        oNow >= 6 && oNow >= Math.ceil(tNow * 0.8) &&
        (av === null || av <= 2) &&
        (gust === null || gust < 50)) {
      out.push({
        key: 'great-day',
        severity: 'info',
        hours: 7,
        cooldown: 20,
        text: 'יום גלישה טוב — המעבר לצ׳רמט פתוח, ' + oNow + ' מתוך ' + tNow +
              ' מעליות פועלות' +
              (av !== null && av <= 1 ? ', והשלג יציב' : '') + '.'
      });
    }
  }

  // --- lifts, inside the skiing day only --------------------------------
  if (inWindow(liftWin, nowMin)) {
    const oPrev = liftsOpen(prev);
    const oNext = liftsOpen(next);
    const tNext = liftsTotal(next);

    // "Was running, is not." Three is the floor on purpose: it means the day
    // had actually started, so this is a stoppage and not a slow morning.
    if (oPrev !== null && oNext !== null && oPrev >= 3 && oNext === 0) {
      out.push({
        key: 'lifts-all-closed',
        severity: 'danger',
        hours: 5,
        cooldown: 8,
        text: 'כל המעליות בצ׳רוויניה סגורות כרגע. בדקו את המצב לפני שאתם יוצאים.'
      });
    } else if (
      oPrev !== null && oNext !== null && tNext &&
      oPrev >= 5 && oNext > 0 && oNext <= Math.floor(oPrev * 0.4)
    ) {
      out.push({
        key: 'lifts-mostly-closed',
        severity: 'warning',
        hours: 4,
        cooldown: 8,
        text: 'רוב המעליות בצ׳רוויניה נסגרו — ' + oNext + ' פתוחות מתוך ' + tNext + '.'
      });
    }
  }

  // --- wind ---------------------------------------------------------------
  //
  // This window was a fixed 06:00-18:00 while the lift and crossing windows
  // were being derived from the feed, and it fired at 17:47 on a day whose
  // lifts had already stopped - a warning that high lifts "may close" sent
  // to people for whom everything was already shut. Same mistake as the
  // other two, left standing in the one rule that had not been revisited.
  //
  // It starts an hour BEFORE the lifts do, because wind is the one thing
  // worth knowing before you decide to set out at all, and it ends with the
  // lift window, because after that there is nothing left to close.
  const windWin = skiDayWindow(next, -60, 90, WIND_WINDOW);
  if (inWindow(windWin, nowMin)) {
    const gPrev = num(prev.wind_gust);
    const gNext = num(next.wind_gust);
    if (gPrev !== null && gNext !== null) {
      if (gPrev < 100 && gNext >= 100) {
        out.push({
          key: 'wind-severe',
          severity: 'danger',
          hours: 6,
          cooldown: 10,
          text: 'רוח עזה בהר — משבים עד ' + Math.round(gNext) +
                ' קמ״ש. צפו לסגירות נרחבות של מעליות.'
        });
      } else if (gPrev < 70 && gNext >= 70) {
        out.push({
          key: 'wind-strong',
          severity: 'warning',
          hours: 5,
          cooldown: 10,
          text: 'רוח חזקה בהר — משבים עד ' + Math.round(gNext) +
                ' קמ״ש. ייתכנו סגירות של מעליות גבוהות.'
        });
      }
    }
  }

  // --- avalanche danger ---------------------------------------------------
  // The one rule with a reason to run outside the skiing day: the bulletin
  // is issued for tomorrow, and somebody deciding tonight whether to go
  // off-piste wants it. But not at three in the morning, so it still has a
  // floor and a ceiling - just a waking-hours one rather than a lift one.
  const aPrev = num(prev.avalanche_level);
  const aNext = num(next.avalanche_level);
  if (inWindow(AVALANCHE_WINDOW, nowMin)
      && aNext !== null && aNext >= 4 && (aPrev === null || aPrev < 4)) {
    out.push({
      key: 'avalanche-high',
      severity: 'danger',
      hours: 18,
      cooldown: 20,
      text: 'דרגת סכנת מפולות ' + aNext +
            ' באיזור. אל תצאו מהפיסטות המסומנות.'
    });
  }

  // --- fresh snow ---------------------------------------------------------
  // The one piece of good news worth a line on the strip.
  //
  // It has to name the station. snow_depth is one number taken from Plan
  // Maison, or from Plateau Rosa when Plan Maison is missing - and the
  // mountain does not have one depth: on the morning this was written
  // Plateau Rosa held 45 cm, Cime Bianche 40, Plan Maison 30 and Breuil 20.
  // "30 cm" on its own reads as the depth of the resort, and sends somebody
  // up expecting a third of what is actually at the top, or twice what is
  // at the bottom.
  const sPrev = num(prev.snow_depth);
  const sNext = num(next.snow_depth);
  if (sPrev !== null && sNext !== null && sNext - sPrev >= 20) {
    const pts = Array.isArray(next.snow_points) ? next.snow_points : [];
    const at = pts.find(p => p.station === 'mid') || pts.find(p => p.station === 'top');
    const where = at && at.name
      ? ' ב-' + at.name + (at.altitude ? ' (' + at.altitude.toLocaleString('en-US') + ' מ׳)' : '')
      : '';
    // Twenty centimetres and sixty are not the same news, and until now the
    // same flat sentence carried both: "ירד שלג טרי — 30 ס״מ נוספו", in the
    // register of a weather report. Forty is where it stops being a good
    // morning and starts being the reason somebody drives four hours.
    const added = Math.round(sNext - sPrev);
    const lots  = added >= 40;
    out.push({
      key: 'fresh-snow',
      severity: 'info',
      hours: 14,
      cooldown: 20,
      text: (lots ? 'המון שלג טרי! ' : 'שלג טרי! ') +
            added + ' ס״מ נוספו' + where + '. ' +
            (where ? 'העומק כעת ' : 'עומק השלג כעת ') +
            Math.round(sNext) + ' ס״מ.' +
            (lots ? ' גלישה מהנה!' : '')
    });
  }

  return out;
}

// ------------------------------------------------------------
//  Which switch each alert answers to
//
//  This is a MIRROR. The real decision is cl_alert_topic() in the database,
//  because that is what cl_push_targets joins against. It is written out
//  here so that the test suite can check one thing the database cannot:
//  that every key the rules above can produce has a switch at all.
//
//  cl_alert_topic falls through to 'community' - the switch for what other
//  skiers report - so a key nobody mapped does not go silent. It goes to
//  the wrong people, under a heading that has nothing to do with it. That
//  is what would have happened to great-day.
//
//  Change one of these and you must change the other. The test suite will
//  tell you if you forget this half; nothing will tell you if you forget
//  the SQL half, which is the honest weakness of keeping it in two places.
// ------------------------------------------------------------
const TOPIC_OF = {
  'zermatt-closed':     'zermatt',
  'zermatt-open':       'zermatt',
  'zermatt-shut-today': 'zermatt',
  'lifts-all-closed':   'lifts',
  'lifts-mostly-closed':'lifts',
  'wind-strong':        'weather',
  'wind-severe':        'weather',
  'avalanche-high':     'weather',
  'fresh-snow':         'snow',
  'great-day':          'snow'
};

// ------------------------------------------------------------
//  The feed's placeholder
//
//  zermatt_link is not always OPEN or CLOSED. Between seasons, and between
//  the operator's own updates, it reads "NEXT UPDATE" - and on 8.11 that
//  landed in exactly the wrong place:
//
//      08:21  CLOSED
//      09:01  NEXT UPDATE
//      09:41  NEXT UPDATE
//      11:01  OPEN
//
//  The rule that announces an opening asks for CLOSED -> OPEN. What it was
//  handed was NEXT UPDATE -> OPEN, which is not that, so on a morning when
//  the crossing opened late and every lift on the mountain was running,
//  nobody was told. The time guard would have allowed it: 11:01 here is
//  10:01 in Rome, past the half-nine cutoff that separates a late opening
//  from the timetable.
//
//  So the baseline the rules compare against carries the last reading that
//  actually said something, rather than the last reading. Rows come newest
//  first; anything that is not a state is passed over.
// ------------------------------------------------------------
function lastKnownZermatt(rows) {
  for (const r of (rows || [])) {
    const z = upper(r && r.zermatt_link);
    if (z === 'OPEN' || z === 'CLOSED') return z;
  }
  return '';
}

// Hand it the history, newest first, and it gives back the previous reading
// with a zermatt_link worth comparing. Everything else is left alone: a
// placeholder says nothing about the wind either, but the wind reading in
// that same row is real.
function baselineFrom(rows) {
  const prev = (rows && rows[0]) || null;
  if (!prev) return null;
  const z = upper(prev.zermatt_link);
  if (z === 'OPEN' || z === 'CLOSED') return prev;
  const known = lastKnownZermatt(rows);
  if (!known) return prev;
  return Object.assign({}, prev, { zermatt_link: known });
}

export {
  detectAutoAlerts, lastKnownZermatt, baselineFrom, TOPIC_OF,
  romeMinutes, inWindow, skiDayWindow, parseOpeningHours,
  num, upper, liftsOpen, liftsTotal,
  LIFT_WINDOW, WIND_WINDOW, AVALANCHE_WINDOW
};
