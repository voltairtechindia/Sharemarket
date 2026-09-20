/* ============================================================================
   The IPO page.

   Draws what KT.ipo computed. Statistics first: every panel here is a number,
   a bar or a curve, and the prose that does appear is one line explaining what
   the number means rather than a paragraph a reader has to mine.

   Layout: the list on the left, one company in the middle, the market's own
   record on the right. Selecting a company changes the middle only, so the
   base rate you are judging it against stays on screen next to it - which is
   the whole point of having it.
   ========================================================================== */
(function (KT) {
  'use strict';
  var core = KT.core, fmt = core.fmt, el = core.el, text = core.text;
  var C = KT.CONFIG;

  var S = { model: null, selected: null, list: 'open' };

  /* Everything that reaches innerHTML goes through here. Company names and
     lead manager names come from an exchange feed, which is somebody else's
     input arriving in this page. */
  function esc(x) {
    return String(x == null ? '' : x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function pct(n, d) { return n == null ? '—' : fmt.pct(n, d === undefined ? 1 : d); }
  function cls(n) { return n == null ? 'flat' : fmt.cls(n); }

  /* The score dial gets a deadband. fmt.cls() calls anything above zero up,
     which is right for a price change and wrong for a -1..+1 summary: +0.05
     drawn in full green reads as a green light, and +0.05 means the factors
     very nearly cancelled. Below a tenth either way it is drawn neutral. */
  function scoreCls(n) { return n == null || Math.abs(n) < 0.1 ? 'flat' : fmt.cls(n); }

  /* Subscription is read as a multiple, never as a percentage. 18.43x is the
     unit every Indian source and every applicant uses. */
  function times(n) { return n == null ? '—' : n.toFixed(2) + 'x'; }

  function dayLabel(iso) {
    if (!iso) return '—';
    var d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  /* --------------------------------------------------------------- top --- */
  function renderTop() {
    var m = S.model, box = el('ipo-topstats');
    if (!box || !m) return;
    var openN = m.open.length, upN = m.upcoming.length;
    var liveValue = m.open.reduce(function (a, r) { return a + (r.issueValueCr || 0); }, 0);
    var tiles = [
      { k: 'Open now', v: String(openN), s: openN ? 'accepting bids' : 'none today' },
      { k: 'Coming', v: String(upN), s: 'with dates announced' },
      { k: 'Money on the table', v: liveValue ? '₹' + fmt.crore(liveValue) : '—',
        s: 'across the open issues' },
      { k: 'Listings priced', v: String(m.history.n),
        s: m.history.n ? 'measured, not quoted' : 'none yet' },
    ];
    box.innerHTML = tiles.map(function (t) {
      return '<div class="ipo-stat"><span class="ipo-stat-k">' + esc(t.k) + '</span>' +
             '<span class="ipo-stat-v num">' + esc(t.v) + '</span>' +
             '<span class="ipo-stat-s">' + esc(t.s) + '</span></div>';
    }).join('');
  }

  /* -------------------------------------------------------------- list --- */
  function listFor(which) {
    var m = S.model;
    if (which === 'upcoming') return m.upcoming;
    if (which === 'big') return m.headline;
    return m.open;
  }

  function renderList() {
    var box = el('ipo-list'), m = S.model;
    if (!box || !m) return;
    var rows = listFor(S.list);
    if (!rows.length) {
      box.innerHTML = '<p class="ipo-none">Nothing in this list right now. ' +
        'The exchange publishes an issue here once its dates are filed.</p>';
      return;
    }
    box.innerHTML = rows.map(function (r) {
      var sub = r.card.book.by.total ? r.card.book.by.total.times : r.subscription;
      var band = (r.bandLow && r.bandHigh)
        ? (r.bandLow === r.bandHigh ? fmt.price(r.bandHigh)
           : fmt.price(r.bandLow) + '–' + fmt.price(r.bandHigh))
        : 'band awaited';
      var when = r.phase === 'closing-today' ? 'closes today'
        : r.phase === 'open' ? 'closes ' + dayLabel(r.closes)
        : r.phase === 'upcoming' ? 'opens ' + dayLabel(r.opens)
        : 'closed';
      return '<button class="ipo-row' + (S.selected === r.symbol ? ' is-on' : '') +
        '" data-symbol="' + esc(r.symbol) + '">' +
        '<span class="ipo-row-top">' +
          '<span class="ipo-row-name">' + esc(r.company || r.symbol) + '</span>' +
          (r.isSme ? '<span class="ipo-chip sme">SME</span>' : '') +
        '</span>' +
        '<span class="ipo-row-mid">' +
          '<span class="ipo-row-band num">₹' + esc(band) + '</span>' +
          '<span class="ipo-row-sub num ' + (sub >= 1 ? 'up' : 'down') + '">' + esc(times(sub)) + '</span>' +
        '</span>' +
        '<span class="ipo-row-bot">' +
          '<span class="' + (r.phase === 'closing-today' ? 'warn-ink' : '') + '">' + esc(when) + '</span>' +
          '<span>' + (r.issueValueCr ? '₹' + esc(fmt.crore(r.issueValueCr)) : '—') + '</span>' +
        '</span>' +
        '</button>';
    }).join('');
  }

  /* ---------------------------------------------------------- calendar --- */
  function renderCalendar() {
    var box = el('ipo-calendar'), m = S.model;
    if (!box || !m) return;
    if (!m.calendar.length) { box.innerHTML = ''; text('ipo-cal-note', 'no dated issues'); return; }
    text('ipo-cal-note', m.calendar.length + ' month' + (m.calendar.length === 1 ? '' : 's'));
    box.innerHTML = m.calendar.map(function (c) {
      return '<div class="ipo-cal-row">' +
        '<span class="ipo-cal-m">' + esc(c.label) + '</span>' +
        '<span class="ipo-cal-n num">' + c.issues.length + '</span>' +
        '<span class="ipo-cal-s">' + c.mainboard + ' main &middot; ' + c.sme + ' SME</span>' +
        '<span class="ipo-cal-v num">' + (c.valueCr ? '₹' + esc(fmt.crore(c.valueCr)) : '—') + '</span>' +
        '</div>';
    }).join('');
  }

  function renderLanes() {
    var box = el('ipo-lanes'), m = S.model;
    if (!box || !m) return;
    box.innerHTML = (m.lanes || []).map(function (l) {
      return '<div class="ipo-lane">' +
        '<span class="ipo-lane-dot ' + (l.ok ? 'ok' : 'bad') + '"></span>' +
        '<span class="ipo-lane-n">' + esc(l.name) + '</span>' +
        '<span class="ipo-lane-c num">' + (l.ok ? l.count : 'failed') + '</span>' +
        '</div>';
    }).join('');
    text('ipo-source', (m.origin === 'capture'
      ? 'This file is a point-in-time capture taken while the page was built, kept so the page had real rows to render. The workflow replaces it on its first run. '
      : '') + (m.source || ''));
    text('ipo-updated', m.generatedAt ? core.fmt.stamp(Math.floor(Date.parse(m.generatedAt) / 1000), 3600) : '—');
  }

  /* ================================================ THE COMPANY, IN DETAIL */

  /* A horizontal bar per category. Subscription is unbounded above, so the
     bar is scaled against the largest category on this book rather than
     against a fixed maximum - the comparison a reader makes is between
     categories, not against an absolute. The 1x line is drawn because
     "did this category fill" is the single most-read fact on the page. */
  function bookBars(bk) {
    var rows = bk.rows.filter(function (r) { return r.key !== 'total'; });
    if (!rows.length) return '<p class="hint">The category-wise book is published once bidding opens.</p>';
    var max = Math.max.apply(null, rows.map(function (r) { return r.times || 0; }).concat([1.2]));
    return '<div class="subs">' + rows.map(function (r) {
      var w = Math.min(100, (r.times || 0) / max * 100);
      var onex = 1 / max * 100;
      return '<div class="sub-row" title="' + esc(r.why) + '">' +
        '<span class="sub-k">' + esc(r.label) + '</span>' +
        '<span class="sub-track">' +
          '<span class="sub-fill ' + (r.times >= 1 ? 'up' : 'down') + '" style="width:' + w.toFixed(1) + '%"></span>' +
          '<span class="sub-one" style="left:' + onex.toFixed(1) + '%" title="fully subscribed"></span>' +
        '</span>' +
        '<span class="sub-v num ' + (r.times >= 1 ? 'up' : 'down') + '">' + esc(times(r.times)) + '</span>' +
        '</div>';
    }).join('') + '</div>';
  }

  /* The demand curve, as inline SVG.

     X is the price band, Y is cumulative bid quantity. Drawn rather than
     tabulated because the only question it answers is a shape question: does
     the book hold as the price rises, or does it fall away. A table of 86
     rows answers that question much worse. */
  function demandSvg(d) {
    if (!d || !d.points || d.points.length < 3) return '';
    var w = 520, h = 130, padL = 6, padR = 6, padT = 8, padB = 18;
    var pts = d.points;
    var xs = pts.map(function (p) { return p.price; });
    var ys = pts.map(function (p) { return p.qty; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    // A near-flat curve compressed to full height reads as a cliff. Give the
    // y-axis headroom proportional to the actual spread so a 0.4% fall looks
    // like a 0.4% fall.
    var spread = y1 - y0;
    var pad = Math.max(spread * 0.35, y1 * 0.004);
    var lo = y0 - pad, hi = y1 + pad;
    function X(p) { return padL + (p - x0) / ((x1 - x0) || 1) * (w - padL - padR); }
    function Y(q) { return padT + (1 - (q - lo) / ((hi - lo) || 1)) * (h - padT - padB); }

    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p.price).toFixed(1) + ' ' + Y(p.qty).toFixed(1); }).join(' ');
    var area = line + ' L' + X(x1).toFixed(1) + ' ' + (h - padB) + ' L' + X(x0).toFixed(1) + ' ' + (h - padB) + ' Z';

    return '<svg class="demand-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" ' +
      'aria-label="Cumulative bid quantity across the price band">' +
      '<path class="demand-area" d="' + area + '"/>' +
      '<path class="demand-line" d="' + line + '"/>' +
      '<text class="demand-ax" x="' + padL + '" y="' + (h - 5) + '">₹' + esc(fmt.price(x0)) + ' floor</text>' +
      '<text class="demand-ax" x="' + (w - padR) + '" y="' + (h - 5) + '" text-anchor="end">₹' + esc(fmt.price(x1)) + ' cap</text>' +
      '</svg>';
  }

  /* The scorecard. Factors with their own working, and a total that is
     labelled as a summary of factors rather than a verdict.

     Coverage is shown as prominently as the score, because a 0.63 built on
     two of five factors and a 0.63 built on all five are not the same claim
     and the number alone cannot tell them apart. Below three factors the
     number is drawn muted. */
  function scoreCard(c) {
    var covered = c.covered, thin = covered < 3;
    var total = c.total;
    var head = '<div class="score-head' + (thin ? ' is-thin' : '') + '">' +
      '<div class="score-dial ' + scoreCls(total) + '">' +
        '<span class="score-n num">' + (total == null ? '—' : (total > 0 ? '+' : '') + total.toFixed(2)) + '</span>' +
        '<span class="score-scale">−1 to +1</span>' +
      '</div>' +
      '<div class="score-meta">' +
        '<span class="score-cov">' + covered + ' of ' + c.of + ' factors had data</span>' +
        (thin ? '<span class="score-warn">Too thin to lean on. Most of what this issue will be judged on has not been published yet.</span>' : '') +
        '<span class="score-basis">A summary of what the exchange has published. Not a recommendation, and not advice.</span>' +
      '</div></div>';

    var rows = c.factors.map(function (f) {
      var w = Math.abs(f.score) * 50;
      return '<div class="fac' + (f.hasData ? '' : ' is-dark') + '">' +
        '<span class="fac-k">' + esc(f.label) + '</span>' +
        '<span class="fac-track">' +
          (f.hasData ? '<span class="fac-fill ' + cls(f.score) + '" style="width:' + w.toFixed(1) + '%;left:' +
             (f.score >= 0 ? '50' : (50 - w).toFixed(1)) + '%"></span>' : '') +
          '<span class="fac-zero"></span>' +
        '</span>' +
        '<span class="fac-v num ' + cls(f.hasData ? f.score : null) + '">' +
          (f.hasData ? (f.score >= 0 ? '+' : '') + f.score.toFixed(2) : 'n/a') + '</span>' +
        '<span class="fac-note">' + esc(f.note) +
          (f.flags && f.flags.length
            ? '<ul class="fac-flags">' + f.flags.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
            : '') +
        '</span>' +
        '</div>';
    }).join('');

    return head + '<div class="facs">' + rows + '</div>';
  }

  function kv(k, v, cl) {
    return '<div class="ipo-kv"><span class="ipo-kv-k">' + esc(k) + '</span>' +
           '<span class="ipo-kv-v num ' + (cl || '') + '">' + v + '</span></div>';
  }

  function renderDetail() {
    var box = el('ipo-detail'), m = S.model;
    if (!box || !m) return;
    var r = null;
    for (var i = 0; i < m.issues.length; i++) if (m.issues[i].symbol === S.selected) r = m.issues[i];
    if (!r) {
      box.innerHTML = '<div class="ipo-empty"><strong>Pick an issue on the left.</strong>' +
        '<span class="muted">Its book, its demand curve, its official filings and how its kind has listed.</span></div>';
      return;
    }

    var d = r.detail || {};
    var c = r.card;
    var bandTxt = (r.bandLow && r.bandHigh)
      ? (r.bandLow === r.bandHigh ? '₹' + fmt.price(r.bandHigh)
         : '₹' + fmt.price(r.bandLow) + ' – ₹' + fmt.price(r.bandHigh))
      : 'not published yet';

    var when;
    if (r.phase === 'closing-today') when = '<span class="warn-ink">Closes today</span>';
    else if (r.phase === 'open') when = 'Open · closes ' + esc(dayLabel(r.closes));
    else if (r.phase === 'upcoming') when = 'Opens ' + esc(dayLabel(r.opens)) +
      (r.opensIn != null ? ' · in ' + r.opensIn + ' day' + (r.opensIn === 1 ? '' : 's') : '');
    else when = 'Closed ' + esc(dayLabel(r.closes));

    var docs = d.docs || {};
    var docLinks = [
      { k: 'rhp', label: 'Red Herring Prospectus', why: 'The filing itself — three years of audited financials, the risk factors, what the money is for.' },
      { k: 'ratios', label: 'Basis of Issue Price', why: 'The issuer’s own peer comparison and the ratios it used to justify the band. Filed with the exchange.' },
      { k: 'anchor', label: 'Anchor allocation', why: 'Which institutions took the anchor book, and at what price.' },
    ].filter(function (x) { return docs[x.k]; });

    var html = '';

    /* ---- header: the facts you act on, in one row ---- */
    html += '<div class="ipo-head">' +
      '<div class="ipo-head-l">' +
        '<h1 class="ipo-name">' + esc(r.company || r.symbol) + '</h1>' +
        '<div class="ipo-head-meta">' +
          '<span class="ipo-chip">' + esc(r.symbol) + '</span>' +
          (r.isSme ? '<span class="ipo-chip sme">SME</span>' : '<span class="ipo-chip">Mainboard</span>') +
          '<span>' + when + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="ipo-head-r">' +
        '<span class="ipo-band num">' + bandTxt + '</span>' +
        '<span class="ipo-band-s">price band per share</span>' +
      '</div>' +
    '</div>';

    /* ---- the numbers grid ---- */
    var totalSub = c.book.by.total ? c.book.by.total.times : r.subscription;
    html += '<div class="ipo-grid">' +
      kv('Subscribed', times(totalSub), totalSub >= 1 ? 'up' : 'down') +
      kv('Issue size', r.issueValueCr ? '₹' + fmt.crore(r.issueValueCr) : '—') +
      kv('Shares offered', r.sharesOffered ? fmt.count(r.sharesOffered) : '—') +
      kv('Lot size', r.lotSize ? fmt.count(r.lotSize) + ' sh' : '—') +
      kv('One lot costs', r.lotValue ? '₹' + fmt.count(r.lotValue) : '—') +
      kv('Band width', r.bandWidthPct != null ? r.bandWidthPct + '%' : '—') +
      kv('Bidding window', r.windowDays != null ? (r.windowDays + 1) + ' days' : '—') +
      kv('Face value', d.faceValue ? '₹' + d.faceValue : '—') +
    '</div>';

    /* ---- scorecard ---- */
    html += '<section class="ipo-sec"><div class="section-head">' +
      '<span class="label">Scorecard</span><span class="label">factors, with their working</span>' +
      '</div>' + scoreCard(c) + '</section>';

    /* ---- the book ---- */
    html += '<section class="ipo-sec"><div class="section-head">' +
      '<span class="label">Who is bidding</span>' +
      '<span class="label">' + esc(d.updatedAt || '—') + '</span>' +
      '</div>' + bookBars(c.book) + '</section>';

    /* ---- demand curve ---- */
    if (c.demand) {
      html += '<section class="ipo-sec"><div class="section-head">' +
        '<span class="label">Demand across the band</span>' +
        '<span class="label">' + esc(c.demand.asOf || '') + '</span>' +
        '</div>' + demandSvg(c.demand) +
        '<div class="ipo-grid tight">' +
          kv('Bids holding at the cap', c.demand.atCapPct + '%') +
          kv('Bid at cut-off', c.demand.cutOffSharePct != null ? c.demand.cutOffSharePct + '%' : '—') +
          kv('Subscribed', times(c.demand.subscribed), c.demand.subscribed >= 1 ? 'up' : 'down') +
        '</div>' +
        '<p class="hint">' + esc(c.demand.read) + '</p>' +
      '</section>';
    }

    /* ---- the filings ---- */
    html += '<section class="ipo-sec"><div class="section-head">' +
      '<span class="label">The official filings</span>' +
      '<span class="label">nsearchives.nseindia.com</span>' +
      '</div>';
    if (docLinks.length) {
      html += '<div class="docs">' + docLinks.map(function (x) {
        return '<a class="doc" href="' + esc(docs[x.k]) + '" target="_blank" rel="noopener noreferrer">' +
          '<span class="doc-k">' + esc(x.label) + '</span>' +
          '<span class="doc-w">' + esc(x.why) + '</span>' +
          '<span class="doc-a">Open on NSE ↗</span></a>';
      }).join('') + '</div>' +
      '<p class="hint">These are links to the exchange’s own archive, not copies. ' +
      'The three-year financial record you are asking for is in the prospectus, ' +
      'filed by the company and audited — which is worth more than any summary of it.</p>';
    } else {
      html += '<p class="hint">The exchange has not published filing links for this issue yet. ' +
        'They appear on the issue page once the offer document is filed.</p>';
    }
    html += '</section>';

    /* ---- who is running it ---- */
    if ((d.leadManagers && d.leadManagers.length) || d.registrar || d.issueSizeText) {
      html += '<section class="ipo-sec"><div class="section-head">' +
        '<span class="label">Issue detail</span><span class="label">as filed</span></div>';
      if (d.issueSizeText) html += '<p class="ipo-prose">' + esc(d.issueSizeText) + '</p>';
      if (d.discount) html += '<p class="ipo-prose">' + esc(d.discount) + '</p>';
      html += '<div class="ipo-grid tight">' +
        kv('Issue type', esc(d.issueType || '—')) +
        kv('Registrar', esc((d.registrar || '—').slice(0, 40))) +
        kv('Lead managers', d.leadManagers ? String(d.leadManagers.length) : '—') +
      '</div>';
      if (d.leadManagers && d.leadManagers.length) {
        html += '<p class="hint">' + esc(d.leadManagers.slice(0, 6).join(' · ')) +
          (d.leadManagers.length > 6 ? ' and ' + (d.leadManagers.length - 6) + ' more' : '') + '</p>';
      }
      html += '</section>';
    }

    box.innerHTML = html;
  }

  /* ============================================== THE MARKET'S OWN RECORD */
  function renderHistory() {
    var m = S.model, h = m.history;
    text('ipo-hist-n', h.n ? h.n + ' priced' : 'none yet');

    var sum = el('ipo-hist-summary');
    if (!h.n) {
      if (sum) sum.innerHTML = '';
      /* Two sections below this one are driven by the same rows. A header
         with nothing under it reads as a panel that failed; a line saying
         what it is waiting for reads as a panel that is honest. */
      var waiting = '<p class="hint">Fills in once the workflow has priced some listings.</p>';
      if (el('ipo-years')) el('ipo-years').innerHTML = waiting;
      if (el('ipo-recent')) el('ipo-recent').innerHTML = waiting;
      text('ipo-hist-note', 'No listing has been priced yet. The workflow computes each one from the ' +
        'listed symbol’s own daily series rather than copying a figure, so this fills in on the ' +
        'first run that reaches Yahoo. ' + h.total + ' past issue' + (h.total === 1 ? '' : 's') +
        ' are waiting to be priced.');
      return;
    }

    var a = h.all;
    if (sum) {
      sum.innerHTML = '<div class="ipo-grid tight">' +
        kv('Listed above issue', a.positiveRate + '%', a.positiveRate >= 50 ? 'up' : 'down') +
        kv('Median gain', pct(a.median), cls(a.median)) +
        kv('Average gain', pct(a.avg), cls(a.avg)) +
        kv('Best', pct(a.best), 'up') +
        kv('Worst', pct(a.worst), 'down') +
        kv('Sample', String(a.n)) +
      '</div>';
    }

    var b = h.buckets;
    var note = 'Measured from each symbol’s own listing-day close against its issue price, ' +
      'not copied from anywhere.';
    if (b && b.mainboard && b.sme) {
      note += ' Mainboard ' + b.mainboard.positiveRate + '% positive over ' + b.mainboard.n +
        ', SME ' + b.sme.positiveRate + '% over ' + b.sme.n +
        ' — two different markets, which is why they are not averaged together.';
    }
    if (a.n < 20) note += ' Fewer than twenty listings is an anecdote, not a base rate.';
    text('ipo-hist-note', note);

    var years = el('ipo-years');
    if (years) {
      years.innerHTML = h.years.length ? h.years.map(function (y) {
        var w = Math.min(100, Math.abs(y.median) / 40 * 100);
        return '<div class="yr">' +
          '<span class="yr-k">' + esc(y.year) + '</span>' +
          '<span class="yr-track"><span class="yr-fill ' + cls(y.median) +
            '" style="width:' + w.toFixed(1) + '%;left:' + (y.median >= 0 ? '50' : (50 - w).toFixed(1)) + '%"></span>' +
            '<span class="yr-zero"></span></span>' +
          '<span class="yr-v num ' + cls(y.median) + '">' + pct(y.median) + '</span>' +
          '<span class="yr-n">' + y.n + ' listing' + (y.n === 1 ? '' : 's') + ' · ' + y.positiveRate + '% up</span>' +
          '</div>';
      }).join('') : '<p class="hint">Not enough listings yet to split by year.</p>';
    }

    var recent = el('ipo-recent');
    if (recent) {
      recent.innerHTML = (h.rows || []).slice(0, 12).map(function (r) {
        return '<div class="rec">' +
          '<span class="rec-n">' + esc(r.company || r.symbol) + '</span>' +
          '<span class="rec-p num">₹' + esc(fmt.price(r.issuePrice)) + ' → ₹' + esc(fmt.price(r.listClose)) + '</span>' +
          '<span class="rec-g num ' + cls(r.listGainPct) + '">' + pct(r.listGainPct) + '</span>' +
          '</div>';
      }).join('');
    }
  }

  /* ------------------------------------------------------------- render --- */
  function renderAll() {
    renderTop();
    renderList();
    renderCalendar();
    renderLanes();
    renderDetail();
    renderHistory();
  }

  function select(sym) {
    S.selected = sym;
    renderList();
    renderDetail();
  }

  /* --------------------------------------------------------------- boot --- */
  function clock() {
    var st = core.marketState();
    text('market-clock', fmt.clock(core.fmt.ist()));
    text('market-state', st.label || st.state);
    var dot = el('market-dot');
    if (dot) dot.className = 'dot ' + (st.state === 'live' ? 'live' : st.state === 'pre' ? 'pre' : 'closed');
  }

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
  }

  function boot() {
    applyTheme(core.store.get('theme', 'light'));
    el('btn-theme').addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      core.store.set('theme', next);
    });

    el('ipo-list').addEventListener('click', function (e) {
      var b = e.target.closest('.ipo-row');
      if (b) select(b.getAttribute('data-symbol'));
    });

    document.querySelector('.ipo-tabs').addEventListener('click', function (e) {
      var b = e.target.closest('.ipo-tab');
      if (!b) return;
      S.list = b.getAttribute('data-list');
      document.querySelectorAll('.ipo-tab').forEach(function (x) {
        x.classList.toggle('is-on', x === b);
        x.setAttribute('aria-selected', String(x === b));
      });
      renderList();
    });

    clock();
    setInterval(clock, 1000);

    KT.data.loadBaked(C.baked.ipo)
      .then(function (raw) {
        S.model = KT.ipo.build(raw);
        if (!S.model.ok) throw new Error(S.model.error);
        /* Open the biggest live issue by default. A page that opens on
           nothing makes a reader do work before it has shown them anything. */
        var first = S.model.open[0] || S.model.upcoming[0] || S.model.issues[0];
        S.selected = first ? first.symbol : null;
        var byValue = S.model.open.slice().sort(function (a, b) {
          return (b.issueValueCr || 0) - (a.issueValueCr || 0);
        })[0];
        if (byValue) S.selected = byValue.symbol;
        renderAll();
      })
      .catch(function (e) {
        var box = el('ipo-detail');
        if (box) {
          box.innerHTML = '<div class="ipo-empty"><strong>No IPO data yet.</strong>' +
            '<span class="muted">data/ipo.json has not been written. It is produced by ' +
            'scripts/fetch_ipo.py in the workflow. (' + esc(e.message || e) + ')</span></div>';
        }
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.KT);
