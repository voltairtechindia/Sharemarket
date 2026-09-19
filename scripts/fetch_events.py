#!/usr/bin/env python3
"""Exchange holidays and scheduled global events.

Two separate jobs, in one file because both answer "what does the calendar say
about the bars this forecast is about to project onto".

1. NSE trading holidays
   forecast.js `advance()` carries this comment:

       Exchange holidays are not modelled - there is no free holiday feed in
       the repo, and being one session out in a month-ahead projection is a
       smaller error than being fourteen hours out in an intraday one.

   There is one now: `/api/holiday-master?type=trading`, segment CM, twenty
   rows a year. That comment was an honest statement of a limitation, and this
   removes the limitation rather than the comment. A daily projection that
   walks through Diwali puts every date after it one session wrong, which is
   the same class of error as the bar-alignment bug that made the accuracy
   panel score the wrong candle.

2. Scheduled global events
   ForexFactory's weekly calendar, free and keyless. Measured 19 Sep 2026: 105
   rows, of which 16 are high impact.

   **It carries no INR events at all.** Countries present are USD, EUR, CAD,
   GBP, CNY, NZD, JPY, AUD, CHF. So this gives Fed decisions and US CPI, which
   do move NIFTY through global risk, and gives nothing at all for RBI policy
   or India CPI - the two scheduled events that matter most here. That gap is
   recorded in the payload rather than papered over, because a calendar that
   silently omits the local central bank is worse than no calendar if a reader
   assumes it is complete.

   No free India macro calendar answered when probed: RBI and MOSPI serve HTML
   only, and tradingeconomics is a 500 KB scraped page. RBI announcements do
   reach the model through the news lane once they are published; what is
   missing is knowing they are coming.
"""
import json
import sys
from datetime import datetime, timedelta, timezone

import requests

from common import DATA, IST, Lanes, UA, carry_forward, get, now_ist, now_iso, write_json

NSE_HOME = "https://www.nseindia.com/"
HOLIDAYS = "https://www.nseindia.com/api/holiday-master?type=trading"
CALENDAR = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"

# Which foreign calendars move an Indian index enough to be worth a band that
# is wider at that minute. The rest are noise from here.
WATCH = {"USD", "CNY", "EUR"}


def nse_session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-IN,en;q=0.9",
        "Referer": NSE_HOME,
        "X-Requested-With": "XMLHttpRequest",
    })
    s.get(NSE_HOME, timeout=20)
    return s


def holidays(lanes):
    """Cash-market trading holidays, as plain YYYY-MM-DD strings."""
    try:
        s = nse_session()
        payload = get(HOLIDAYS, session=s, retries=2).json() or {}
        rows = payload.get("CM") or []
        out = []
        for r in rows:
            raw = r.get("tradingDate")
            if not raw:
                continue
            try:
                d = datetime.strptime(raw, "%d-%b-%Y").date()
            except ValueError:
                continue
            out.append({"date": d.isoformat(),
                        "name": (r.get("description") or "").strip()[:60]})
        out.sort(key=lambda x: x["date"])
        lanes.record("nse holiday-master", True, len(out))
        return out
    except Exception as exc:  # noqa: BLE001
        lanes.record("nse holiday-master", False, 0, repr(exc))
        return []


def events(lanes):
    """High and medium impact scheduled releases, in UTC epoch seconds."""
    try:
        r = get(CALENDAR, retries=2)
        rows = r.json() or []
        out = []
        for e in rows:
            impact = (e.get("impact") or "").lower()
            country = e.get("country") or ""
            if impact not in ("high", "medium"):
                continue
            if country not in WATCH:
                continue
            raw = e.get("date")
            if not raw:
                continue
            try:
                # ForexFactory stamps these with an explicit UTC offset.
                dt = datetime.fromisoformat(raw)
            except ValueError:
                continue
            out.append({
                "ts": int(dt.timestamp()),
                "iso": dt.astimezone(timezone.utc).isoformat(timespec="seconds"),
                "ist": dt.astimezone(IST).isoformat(timespec="seconds"),
                "country": country,
                "impact": impact,
                "title": (e.get("title") or "")[:80],
            })
        out.sort(key=lambda x: x["ts"])
        lanes.record("forexfactory calendar", True, len(out))
        return out, len(rows)
    except Exception as exc:  # noqa: BLE001
        lanes.record("forexfactory calendar", False, 0, repr(exc))
        return [], 0


def main():
    lanes = Lanes()
    hol = holidays(lanes)
    evs, scanned = events(lanes)

    today = datetime.now(IST).date().isoformat()
    upcoming = [h for h in hol if h["date"] >= today]

    payload = {
        "generated_at": now_iso(),
        "generated_ist": now_ist(),
        "holidays": hol,
        "upcomingHolidays": upcoming[:12],
        "nextHoliday": upcoming[0] if upcoming else None,
        "events": evs,
        "eventsScanned": scanned,
        "watchedCountries": sorted(WATCH),
        # Stated in the payload so the UI can say it rather than imply coverage
        # the source does not have.
        "indiaCoverage": False,
        "indiaNote": ("ForexFactory carries no INR rows - measured 19 Sep 2026, "
                      "105 rows across USD/EUR/CAD/GBP/CNY/NZD/JPY/AUD/CHF and "
                      "no India. RBI policy and India CPI are therefore NOT in "
                      "this calendar. They reach the model through the news lane "
                      "once announced; what is missing is advance warning."),
        "lanes": lanes.as_list(),
        "ok": bool(hol or evs),
    }
    # Holidays change a few times a year and the projection clock depends on
    # them; losing the table to one failed fetch would put every daily forecast
    # back to weekends-only without anything saying so.
    payload = carry_forward("events.json", payload, keep_stamp=False)
    write_json("events.json", payload)
    print(f"  {len(hol)} holidays ({len(upcoming)} upcoming), {len(evs)} watched events "
          f"of {scanned} scanned; next holiday "
          f"{(upcoming[0]['date'] + ' ' + upcoming[0]['name']) if upcoming else 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
