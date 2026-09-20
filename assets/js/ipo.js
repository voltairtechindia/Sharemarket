/* ============================================================================
   The IPO engine.

   Everything the page needs computed in one place: the calendar, the demand
   read, the scorecard and the history. The page draws; this decides.

   What this file will not do
   --------------------------
   It does not tell anybody to apply. Not because the arithmetic is hard, but
   because the honest output of an IPO analysis is a set of factors with their
   own working shown, and a single "APPLY" chip reads as advice from a page
   that has met nobody and knows nothing about the reader's position, horizon
   or tax situation.

   So `score()` returns factors. Each one carries what it measured, what it
   scored, and the sentence that explains it. The page prints all of them and
   a total, and says in as many words that it is a summary of factors rather
   than a recommendation. That is also the more useful object: "retail is
   under-subscribed on day three while QIBs are at 1.5x" is something a reader
   can act on; a letter grade is not.

   Where the numbers come from
   ---------------------------
   data/ipo.json, written by scripts/fetch_ipo.py from NSE's own endpoints.
   Every factor names its source, and a factor whose input is missing scores
   nothing and says so rather than defaulting to the middle - a neutral score
   for absent data is an opinion nobody formed.
   ========================================================================== */
(function (KT) {
  'use strict';

  function num(v) {
    if (v === null || v === undefined) return null;
    var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }
  function r2(n) { return n == null ? null : Math.round(n * 100) / 100; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function days(fromISO, toISO) {
    if (!fromISO || !toISO) return null;
    var a = Date.parse(fromISO + 'T00:00:00Z'), b = Date.parse(toISO + 'T00:00:00Z');
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
  }
  function todayISO() {
    var d = new Date(Date.now() + (new Date().getTimezoneOffset() + 330) * 60000);
    return d.toISOString().slice(0, 10);
  }

  /* --------------------------------------------------------------- shape --
     One row per issue, with the derived facts the page asks for repeatedly.
     Computed once here rather than in four render functions, which is how the
     index terminal's band and its accuracy panel drifted apart. */
  function shape(raw) {
    var today = todayISO();
    return (raw.issues || []).map(function (r) {
      var out = {};
      Object.keys(r).forEach(function (k) { out[k] = r[k]; });

      out.isSme = (r.series || '').toUpperCase() === 'SME';
      out.opensIn = days(today, r.opens);
      out.closesIn = days(today, r.closes);
      out.windowDays = days(r.opens, r.closes);

      /* Open, closing today, closed, or still to come. NSE's own `status`
         says Active or Forthcoming and nothing else, so "closes today" -
         which is the one a reader needs to act on - has to come from the
         clock. */
      if (out.closesIn != null && out.closesIn < 0) out.phase = 'closed';
      else if (out.closesIn === 0) out.phase = 'closing-today';
      else if (out.opensIn != null && out.opensIn > 0) out.phase = 'upcoming';
      else out.phase = 'open';

      /* Issue size in rupees needs a price. SME rows often arrive without a
         band, so this is null for them rather than zero - an issue of
         unknown size is not an issue of no size. */
      var price = num(r.bandHigh) || num(r.bandLow);
      out.issueValueCr = (price && num(r.sharesOffered))
        ? r2(price * r.sharesOffered / 10000000) : null;

      out.lotValue = (price && num(r.lotSize)) ? Math.round(price * r.lotSize) : null;
      out.bandWidthPct = (num(r.bandLow) && num(r.bandHigh) && r.bandLow > 0)
        ? r2((r.bandHigh - r.bandLow) / r.bandLow * 100) : null;

      out.detail = (raw.details || {})[r.symbol] || null;
      return out;
    });
  }

  /* ------------------------------------------------------------ the book --
     Category subscription, split the way an Indian reader reads it: QIB, NII,
     retail, employees. The sub-category rows are breakdowns and the fetcher
     already dropped the ones with no quota; these are matched by what they
     start with because NSE spells them at length and inconsistently. */
  var CATS = [
    { key: 'qib', label: 'QIB', rx: /^Qualified Institutional/i,
      why: 'Institutions. They do the most work on the valuation and they cannot flip on day one.' },
    { key: 'nii', label: 'NII / HNI', rx: /^Non Institutional Investors$/i,
      why: 'High net worth money, much of it borrowed. Big NII numbers often unwind on listing day.' },
    { key: 'retail', label: 'Retail', rx: /^Retail Individual/i,
      why: 'Individual investors bidding up to two lakh.' },
    { key: 'emp', label: 'Employees', rx: /^Employees/i,
      why: 'The reserved employee portion, usually at a discount.' },
    { key: 'total', label: 'Total', rx: /^Total$/i,
      why: 'The whole book.' },
  ];

  function book(detail) {
    var rows = (detail && detail.book) || [];
    var out = { rows: [], by: {} };
    rows.forEach(function (r) {
      var hit = null;
      for (var i = 0; i < CATS.length; i++) {
        if (CATS[i].rx.test(r.category)) { hit = CATS[i]; break; }
      }
      if (!hit) return;
      var row = {
        key: hit.key, label: hit.label, why: hit.why,
        offered: num(r.offered), bid: num(r.bid),
        times: num(r.times),
      };
      if (row.times == null && row.offered && row.bid) row.times = r2(row.bid / row.offered);
      out.by[hit.key] = row;
      out.rows.push(row);
    });
    var order = { qib: 0, nii: 1, retail: 2, emp: 3, total: 4 };
    out.rows.sort(function (a, b) { return order[a.key] - order[b.key]; });
    return out;
  }

  /* --------------------------------------------------------- demand read --
     The demand curve says where in the band the book actually is, and it is
     the one object here that cannot be read off a number.

     `atCap` is the share of bids that survive at the top of the band. Near 1
     the book is priced at the cap and the issue will price there. Well under
     1 the demand thins out above the floor, which means the final price lands
     lower than the headline band implies - and that changes the listing
     arithmetic for everybody who applied at cut-off. */
  function demandRead(detail) {
    var d = detail && detail.demand;
    if (!d || !d.points || d.points.length < 3) return null;
    var pts = d.points;
    var first = pts[0], last = pts[pts.length - 1];
    if (!first.qty) return null;

    var atCap = r2(last.qty / first.qty * 100);
    var cutOffShare = d.cutOffQty && d.totalBids
      ? r2(d.cutOffQty / d.totalBids * 100) : null;

    var read;
    if (atCap >= 99) {
      read = 'The book holds all the way to the top of the band — demand is not price sensitive, ' +
             'and the issue prices at the cap.';
    } else if (atCap >= 95) {
      read = 'Demand thins only slightly toward the cap. The issue still prices at or near the top.';
    } else if (atCap >= 80) {
      read = 'Demand falls away toward the cap. Part of the book is bidding below the top of the band.';
    } else {
      read = 'Most of the book sits near the floor. The band’s upper end is not where the money is.';
    }
    return {
      points: pts, atCapPct: atCap, cutOffSharePct: cutOffShare,
      subscribed: num(d.subscribed), asOf: d.asOf,
      floor: first.price, cap: last.price, read: read,
    };
  }

  /* ------------------------------------------------------------- history --
     What IPOs have actually done, from the issues this page priced itself.

     Grouped by listing year, because "was 2026 a good year to apply" is a
     question with an answer, and by SME against mainboard, because they are
     different markets and averaging them produces a number describing
     neither. */
  function history(raw) {
    var rows = (raw.past || []).filter(function (r) { return r.listGainPct != null; });
    if (!rows.length) {
      return { n: 0, priced: 0, total: (raw.past || []).length, years: [], buckets: null };
    }

    function stats(list) {
      if (!list.length) return null;
      var gains = list.map(function (r) { return r.listGainPct; }).sort(function (a, b) { return a - b; });
      var sum = gains.reduce(function (a, b) { return a + b; }, 0);
      var pos = gains.filter(function (g) { return g > 0; }).length;
      var mid = Math.floor(gains.length / 2);
      return {
        n: gains.length,
        avg: r2(sum / gains.length),
        median: r2(gains.length % 2 ? gains[mid] : (gains[mid - 1] + gains[mid]) / 2),
        positiveRate: r2(pos / gains.length * 100),
        best: r2(gains[gains.length - 1]), worst: r2(gains[0]),
      };
    }

    var byYear = {};
    rows.forEach(function (r) {
      var y = (r.listed || '').slice(0, 4);
      if (!y) return;
      (byYear[y] = byYear[y] || []).push(r);
    });
    var years = Object.keys(byYear).sort().map(function (y) {
      var s = stats(byYear[y]);
      s.year = y;
      return s;
    });

    var sme = rows.filter(function (r) { return (r.series || '').toUpperCase() === 'SME'; });
    var main = rows.filter(function (r) { return (r.series || '').toUpperCase() !== 'SME'; });

    return {
      n: rows.length,
      priced: rows.length,
      total: (raw.past || []).length,
      all: stats(rows),
      years: years,
      buckets: { sme: stats(sme), mainboard: stats(main) },
      rows: rows.slice().sort(function (a, b) {
        return (b.listed || '').localeCompare(a.listed || '');
      }),
    };
  }

  /* ----------------------------------------------------------- scorecard --

     Five factors. Each returns a score in [-1, 1], what it measured, and a
     sentence. A factor with no input returns hasData false and drops out of
     the average rather than voting zero - the same rule the index terminal's
     lanes follow, and for the same reason: a missing input is not a neutral
     opinion.

     The weights are judgements and the panel says so. Nothing here has been
     fitted, because fitting would need a few hundred settled issues with this
     page's own scores attached, and this page has none yet. When it does,
     the same learner that tunes the index lanes can tune these. */
  var WEIGHTS = {
    demand: 0.30,        // is the book there, and where in the band
    quality: 0.25,       // who is bidding - QIB against NII against retail
    structure: 0.20,     // OFS or fresh issue, size, band width
    history: 0.15,       // what this kind of issue has done lately
    risk: 0.10,          // flags worth naming
  };

  function factorDemand(iss, bk, dem) {
    var t = bk.by.total && bk.by.total.times;
    if (t == null) t = num(iss.subscription);
    if (t == null) return { hasData: false, note: 'No subscription figure yet.' };

    /* Subscription is strongly non-linear in what it predicts. 0.8x and 1.2x
       are very different outcomes; 40x and 60x are the same outcome. Log
       scaling rather than a straight ratio, so the top end does not saturate
       the whole scorecard. */
    var s = clamp(Math.log(Math.max(t, 0.05)) / Math.log(12), -1, 1);
    var note = t < 1
      ? 'Under-subscribed at ' + t.toFixed(2) + 'x with the book still open.'
      : 'Subscribed ' + t.toFixed(2) + 'x overall.';

    if (dem && dem.atCapPct != null) {
      // A book that will not hold at the cap is worth a real deduction.
      if (dem.atCapPct < 90) { s -= 0.25; note += ' Demand thins toward the top of the band.'; }
      else if (dem.atCapPct >= 99) { s += 0.1; note += ' The book holds to the cap.'; }
    }
    return { hasData: true, score: clamp(s, -1, 1), value: r2(t), note: note };
  }

  function factorQuality(bk) {
    var q = bk.by.qib && bk.by.qib.times;
    var n = bk.by.nii && bk.by.nii.times;
    var rt = bk.by.retail && bk.by.retail.times;
    if (q == null && n == null && rt == null) {
      return { hasData: false, note: 'The category-wise book has not been published yet.' };
    }
    var s = 0, bits = [];
    /* QIB is the category that did the work. It is also the one that cannot
       sell on listing day - the anchor portion is locked. Weight it highest. */
    if (q != null) {
      s += clamp(Math.log(Math.max(q, 0.05)) / Math.log(10), -1, 1) * 0.55;
      bits.push('QIB ' + q.toFixed(2) + 'x');
    }
    if (rt != null) {
      s += clamp(Math.log(Math.max(rt, 0.05)) / Math.log(10), -1, 1) * 0.25;
      bits.push('retail ' + rt.toFixed(2) + 'x');
    }
    /* NII money is largely leveraged and much of it exits on day one, so a
       book carried by NII alone is a weaker book than the headline says. */
    if (n != null) {
      s += clamp(Math.log(Math.max(n, 0.05)) / Math.log(10), -1, 1) * 0.20;
      bits.push('NII ' + n.toFixed(2) + 'x');
    }
    var note = bits.join(', ') + '.';
    if (q != null && rt != null) {
      if (q > 1.5 && rt < 1) note += ' Institutions are in and retail is not — the more common of the two mismatches, and the less worrying.';
      else if (rt > 3 && q < 1) note += ' Retail is carrying a book the institutions have not taken. Worth noting.';
    }
    return { hasData: true, score: clamp(s, -1, 1), note: note };
  }

  function factorStructure(iss, det) {
    var bits = [], s = 0, any = false;

    /* Offer for sale against fresh issue. In an OFS every rupee goes to the
       selling shareholder and none to the company, which is not a reason to
       avoid an issue but is a fact about where the money lands, and it is
       stated in the issue size text the exchange publishes. */
    var sizeText = (det && det.issueSizeText) || '';
    if (sizeText) {
      any = true;
      var ofs = /offer for sale/i.test(sizeText);
      var fresh = /fresh issue/i.test(sizeText);
      if (ofs && !fresh) { s -= 0.35; bits.push('Pure offer for sale — the proceeds go to selling shareholders, not into the company.'); }
      else if (ofs && fresh) { s -= 0.1; bits.push('Part fresh issue, part offer for sale.'); }
      else if (fresh) { s += 0.3; bits.push('Fresh issue — the money is raised for the company.'); }
    }

    if (iss.issueValueCr) {
      any = true;
      /* Size is not quality, but very small mainboard issues and very large
         ones behave differently on listing, and SME is its own market. */
      if (iss.isSme) bits.push('SME issue, ' + Math.round(iss.issueValueCr) + ' Cr.');
      else if (iss.issueValueCr > 5000) { s += 0.15; bits.push('Large issue at ' + Math.round(iss.issueValueCr) + ' Cr — index inclusion and institutional coverage follow size.'); }
      else bits.push('Issue size about ' + Math.round(iss.issueValueCr) + ' Cr.');
    }

    if (iss.bandWidthPct != null) {
      any = true;
      if (iss.bandWidthPct > 8) { s -= 0.1; bits.push('Wide price band at ' + iss.bandWidthPct + '% — the final price is less certain than the headline.'); }
    }

    if (det && det.discount) { any = true; bits.push('Employee discount offered.'); }

    if (!any) return { hasData: false, note: 'Issue structure has not been published yet.' };
    return { hasData: true, score: clamp(s, -1, 1), note: bits.join(' ') };
  }

  function factorHistory(iss, hist) {
    var b = hist && hist.buckets;
    var pick = b && (iss.isSme ? b.sme : b.mainboard);
    if (!pick || !pick.n) {
      return { hasData: false,
               note: 'No listing gains measured yet, so there is no base rate to compare against.' };
    }
    /* A base rate, not a forecast. It says what this kind of issue has done
       recently on this exchange, and the sample size is printed next to it
       because a 60% positive rate over five listings is not evidence. */
    var s = clamp((pick.positiveRate - 50) / 50, -1, 1) * 0.6 +
            clamp(pick.median / 25, -1, 1) * 0.4;
    return {
      hasData: true, score: clamp(s, -1, 1),
      note: (iss.isSme ? 'SME' : 'Mainboard') + ' listings recently: ' +
            pick.positiveRate + '% closed above issue price, median ' +
            pick.median + '%, over ' + pick.n + ' issue' + (pick.n === 1 ? '' : 's') + '.',
      weak: pick.n < 20,
    };
  }

  function factorRisk(iss, bk, det) {
    var flags = [];
    if (iss.isSme) {
      flags.push('SME issues trade in lot sizes only, with far less liquidity than the mainboard and a wider spread.');
    }
    /* Allotment odds, from whichever number exists.

       This read bk.by.retail only, so it stayed silent on every issue whose
       category-wise book had not been published - which is most SME issues
       and every issue on its first morning. Those are exactly the issues
       where a reader is deciding whether to apply, and "you will probably
       get nothing" is the most actionable sentence on the page. The total
       subscription is a weaker signal than the retail line, so it is used
       only when the retail line is absent, and the flag says which it had. */
    var retailX = bk.by.retail && bk.by.retail.times;
    var anyX = retailX != null ? retailX : num(iss.subscription);
    if (anyX != null && anyX > 20) {
      flags.push('Subscribed more than 20x' + (retailX == null ? ' overall' : ' in retail') +
                 ' — allotment is a lottery, and most applicants get nothing.');
    }
    if (iss.phase === 'closing-today') {
      flags.push('The book closes today. Retail cut-off is usually 5pm, earlier than the headline time.');
    }
    if (det && !(det.docs && det.docs.rhp)) {
      flags.push('The exchange has not published the Red Herring Prospectus link for this issue yet.');
    }
    if (!iss.bandLow && !iss.bandHigh) {
      flags.push('No price band published yet.');
    }
    if (!flags.length) {
      return { hasData: true, score: 0.1, note: 'Nothing flagged from what the exchange has published.', flags: [] };
    }
    return {
      hasData: true,
      score: clamp(-0.25 * flags.length, -1, 0),
      note: flags.length + ' point' + (flags.length === 1 ? '' : 's') + ' worth reading before applying.',
      flags: flags,
    };
  }

  function score(iss, hist) {
    var bk = book(iss.detail);
    var dem = demandRead(iss.detail);
    var factors = [
      { id: 'demand', label: 'Demand', res: factorDemand(iss, bk, dem) },
      { id: 'quality', label: 'Who is bidding', res: factorQuality(bk) },
      { id: 'structure', label: 'Issue structure', res: factorStructure(iss, iss.detail) },
      { id: 'history', label: 'Base rate', res: factorHistory(iss, hist) },
      { id: 'risk', label: 'Flags', res: factorRisk(iss, bk, iss.detail) },
    ].map(function (f) {
      f.weight = WEIGHTS[f.id];
      f.hasData = !!f.res.hasData;
      f.score = f.hasData ? f.res.score : 0;
      f.note = f.res.note;
      f.flags = f.res.flags || null;
      return f;
    });

    var live = factors.filter(function (f) { return f.hasData; });
    var wsum = live.reduce(function (a, f) { return a + f.weight; }, 0);
    var total = wsum ? live.reduce(function (a, f) { return a + f.score * f.weight; }, 0) / wsum : null;

    factors.forEach(function (f) {
      f.contribution = wsum && f.hasData ? r2(f.score * f.weight / wsum * 100) / 100 : 0;
    });

    return {
      factors: factors,
      book: bk,
      demand: dem,
      total: total == null ? null : r2(total),
      covered: live.length,
      of: factors.length,
      /* Deliberately not a verdict. The page prints this next to the number
         so the number is never read as advice. */
      basis: live.length + ' of ' + factors.length + ' factors had data. ' +
             'This is a summary of what the exchange has published, not a recommendation.',
    };
  }

  /* ------------------------------------------------------------ calendar --
     The month, and the months around it. Grouped by the date the issue opens,
     because that is the date a reader has to act on. */
  function calendar(issues) {
    var by = {};
    issues.forEach(function (r) {
      var m = (r.opens || '').slice(0, 7);
      if (!m) return;
      (by[m] = by[m] || []).push(r);
    });
    return Object.keys(by).sort().map(function (m) {
      var list = by[m].slice().sort(function (a, b) {
        return (a.opens || '').localeCompare(b.opens || '');
      });
      return {
        month: m,
        label: new Date(m + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
        issues: list,
        mainboard: list.filter(function (r) { return !r.isSme; }).length,
        sme: list.filter(function (r) { return r.isSme; }).length,
        valueCr: r2(list.reduce(function (a, r) { return a + (r.issueValueCr || 0); }, 0)),
      };
    });
  }

  /* The ones people are waiting for: the biggest by issue value, which is the
     only ranking available from exchange data. "Most anticipated" on other
     sites is a hand-picked list, and a hand-picked list is an opinion wearing
     a ranking's clothes. */
  function headline(issues, n) {
    return issues
      .filter(function (r) { return r.issueValueCr && r.phase !== 'closed'; })
      .sort(function (a, b) { return b.issueValueCr - a.issueValueCr; })
      .slice(0, n || 5);
  }

  function build(raw) {
    if (!raw || !raw.ok) {
      return { ok: false, error: (raw && raw.error) || 'no IPO data', issues: [], history: null };
    }
    var issues = shape(raw);
    var hist = history(raw);
    issues.forEach(function (r) { r.card = score(r, hist); });
    return {
      ok: true,
      generatedAt: raw.generated_at,
      origin: raw.origin || 'workflow',
      source: raw.source,
      counts: raw.counts || {},
      lanes: raw.lanes || [],
      issues: issues,
      open: issues.filter(function (r) { return r.phase === 'open' || r.phase === 'closing-today'; }),
      upcoming: issues.filter(function (r) { return r.phase === 'upcoming'; }),
      headline: headline(issues, 5),
      calendar: calendar(issues),
      history: hist,
      gmp: raw.gmp || null,
    };
  }

  /* Grey market premium is passed through from the fetcher and is always
     null. It is not computed here and not estimated here. Every figure in
     circulation is scraped from unregulated grey market sites that publish
     no method and disagree with each other by a third on the same morning,
     and this page's position is that a number it cannot score is a number it
     should not print. The slot exists so a source with a checkable record
     can fill it later, scored against listing gains the way history() scores
     everything else. */
  function gmp() { return null; }

  KT.ipo = {
    build: build, shape: shape, score: score, book: book, gmp: gmp,
    demandRead: demandRead, history: history, calendar: calendar,
    headline: headline, WEIGHTS: WEIGHTS, CATS: CATS,
    _num: num, _days: days,
  };
})(window.KT);
