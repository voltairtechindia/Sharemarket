/* Reads the JSON files written by the GitHub Actions fetchers.
   Everything is same origin, so there is no CORS problem and no API key here. */

const REFRESH_MS = 30000;
const state = { market: null, news: null, social: null, forecast: null, prices: {} };

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const dirClass = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");
const num = (v, d = 2) =>
  v === null || v === undefined ? "--" : Number(v).toLocaleString("en-IN", {
    minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v, d = 2) => (v > 0 ? "+" : "") + num(v, d);

function ago(iso) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + " min ago";
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? hrs + " hr ago" : Math.round(hrs / 24) + " d ago";
}

function sparkline(points) {
  if (!points || points.length < 3) return null;
  const w = 64, h = 20, min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => `${(i / (points.length - 1)) * w},${h - ((p - min) / span) * h}`)
    .join(" ");
  const rising = points[points.length - 1] >= points[0];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);
  svg.setAttribute("class", "spark");
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", d);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke-width", "1.4");
  line.setAttribute("stroke", rising ? "var(--up)" : "var(--down)");
  svg.appendChild(line);
  return svg;
}

/* ------------------------------------------------------------- rendering */

function renderHeadline(quotes) {
  const host = $("#headline");
  host.innerHTML = "";
  if (!quotes || !quotes.length) {
    host.appendChild(el("p", "empty", "Market feed returned nothing on the last run."));
    return;
  }
  quotes.forEach((q) => {
    const box = el("div", "hl");
    box.appendChild(el("div", "name", q.label));
    box.appendChild(el("div", "price " + dirClass(q.change), num(q.price)));
    box.appendChild(el("div", "delta " + dirClass(q.change),
      `${signed(q.change)}  ${signed(q.change_pct)}%`));
    const s = sparkline(q.spark);
    if (s) box.appendChild(s);

    const before = state.prices[q.symbol];
    if (before !== undefined && before !== q.price) {
      box.classList.add(q.price > before ? "flash-up" : "flash-down");
    }
    state.prices[q.symbol] = q.price;
    host.appendChild(box);
  });
}

function renderQuotes(id, quotes) {
  const host = $("#" + id);
  host.innerHTML = "";
  (quotes || []).forEach((q) => {
    const row = el("div", "q");
    row.appendChild(el("div", "qn", q.label));
    row.appendChild(el("div", "qp", num(q.price)));
    row.appendChild(el("div", "qc " + dirClass(q.change), signed(q.change_pct) + "%"));
    host.appendChild(row);
  });
}

function renderNews() {
  const host = $("#news-list");
  const data = state.news;
  host.innerHTML = "";
  if (!data || !data.items.length) {
    host.appendChild(el("p", "empty", "No news pulled yet. Run the news workflow."));
    return;
  }
  const onlyHigh = $("#only-high").checked;
  const term = $("#news-search").value.trim().toLowerCase();

  const rows = data.items.filter((i) => {
    if (onlyHigh && i.impact !== "high") return false;
    if (!term) return true;
    return (i.title + " " + i.summary + " " + i.stocks.join(" ") + " " +
      i.sectors.join(" ")).toLowerCase().includes(term);
  });

  if (!rows.length) {
    host.appendChild(el("p", "empty", "Nothing matches that filter."));
    return;
  }

  rows.forEach((i) => {
    const box = el("div", "item " + i.impact);
    const head = el("div", "head");
    const a = el("a", "title", i.title);
    a.href = i.link; a.target = "_blank"; a.rel = "noopener";
    head.appendChild(a);
    if (i.direction !== "flat") {
      head.appendChild(el("span", "dir " + (i.direction === "up" ? "up" : "down"),
        i.direction === "up" ? "\u25b2" : "\u25bc"));
    }
    box.appendChild(head);

    const meta = el("div", "meta");
    meta.appendChild(el("span", null, i.source));
    meta.appendChild(el("span", "sep", "/"));
    meta.appendChild(el("span", null, ago(i.published)));
    if (i.triggers.length) {
      meta.appendChild(el("span", "sep", "/"));
      meta.appendChild(el("span", null, i.triggers.join(", ")));
    }
    box.appendChild(meta);

    if (i.summary) box.appendChild(el("div", "sum", i.summary));
    if (i.stocks.length) {
      box.appendChild(el("div", "stocks",
        i.sectors.join(" ") + "  \u2192  " + i.stocks.join("  ")));
    }
    host.appendChild(box);
  });
}

function renderSocial() {
  const host = $("#social-list");
  const data = state.social;
  host.innerHTML = "";
  if (!data || !data.items.length) {
    host.appendChild(el("p", "empty", "No posts pulled yet."));
    return;
  }
  $("#x-status").textContent = data.x_available
    ? "X mirror responding"
    : "X mirror down right now, Reddit and Telegram still live";

  const onlyMarket = $("#only-market").checked;
  const rows = data.items.filter((i) => !onlyMarket || i.relevant);

  if (!rows.length) {
    host.appendChild(el("p", "empty", "Nothing market related in the last pull."));
    return;
  }

  rows.forEach((i) => {
    const box = el("div", "item " + (i.relevant ? "medium" : ""));
    const a = el("a", "title", i.text);
    a.href = i.link; a.target = "_blank"; a.rel = "noopener";
    box.appendChild(a);
    const meta = el("div", "meta");
    meta.appendChild(el("span", null, i.platform + " " + i.author));
    meta.appendChild(el("span", "sep", "/"));
    meta.appendChild(el("span", null, ago(i.published)));
    box.appendChild(meta);
    host.appendChild(box);
  });
}

function renderOptions() {
  const host = $("#options-body");
  const chains = (state.market && state.market.options) || {};
  const keys = Object.keys(chains);
  if (!keys.length) return; // keep the setup message that is already in the HTML
  host.innerHTML = "";

  keys.forEach((sym) => {
    const c = chains[sym];
    const wrap = el("div", "chain-wrap");
    wrap.appendChild(el("h3", null, sym));

    const head = el("div", "chain-head");
    const bits = [
      ["Spot", num(c.spot)], ["Expiry", c.expiry || "--"],
      ["PCR", c.pcr === null ? "--" : c.pcr], ["Max pain", num(c.max_pain, 0)],
      ["Source", c.source],
    ];
    bits.forEach(([k, v]) => {
      const s = el("span", null, k + " ");
      s.appendChild(el("b", null, String(v)));
      head.appendChild(s);
    });
    wrap.appendChild(head);

    const table = el("table", "chain");
    table.innerHTML =
      "<thead><tr><th>CE OI</th><th>CE chg</th><th>CE IV</th><th>CE LTP</th>" +
      "<th>Strike</th><th>PE LTP</th><th>PE IV</th><th>PE chg</th><th>PE OI</th></tr></thead>";
    const body = el("tbody");

    let atm = null;
    if (c.spot && c.strikes.length) {
      atm = c.strikes.reduce((a, b) =>
        Math.abs(b.strike - c.spot) < Math.abs(a.strike - c.spot) ? b : a).strike;
    }

    c.strikes.forEach((s) => {
      const tr = el("tr");
      if (s.strike === atm) tr.className = "atm";
      const cells = [
        [num(s.ce_oi, 0), ""], [signed(s.ce_oi_chg, 0), dirClass(s.ce_oi_chg)],
        [num(s.ce_iv, 1), ""], [num(s.ce_ltp), ""],
        [num(s.strike, 0), "strike"],
        [num(s.pe_ltp), ""], [num(s.pe_iv, 1), ""],
        [signed(s.pe_oi_chg, 0), dirClass(s.pe_oi_chg)], [num(s.pe_oi, 0), ""],
      ];
      cells.forEach(([v, cls]) => tr.appendChild(el("td", cls, v)));
      body.appendChild(tr);
    });
    table.appendChild(body);
    wrap.appendChild(table);
    host.appendChild(wrap);
  });
}


function renderFno() {
  const host = $("#fno");
  const c = ((state.market && state.market.options) || {}).NIFTY;
  host.innerHTML = "";
  if (!c) {
    host.appendChild(el("p", "empty",
      "Needs an option chain. Add a Dhan token, or run the fetcher locally."));
    return;
  }
  const rows = [
    ["Spot", num(c.spot)],
    ["Max pain", num(c.max_pain, 0)],
    ["PCR", c.pcr === null ? "--" : c.pcr],
    ["Call OI", (c.total_ce_oi || 0).toLocaleString("en-IN")],
    ["Put OI", (c.total_pe_oi || 0).toLocaleString("en-IN")],
    ["Expiry", c.expiry || "--"],
  ];
  // Futures and basis need a broker feed. Say so rather than showing a made up number.
  rows.push(["Futures", "broker feed only"], ["Basis", "broker feed only"]);
  rows.forEach(([k, v]) => {
    const row = el("div", "q");
    row.appendChild(el("div", "qn", k));
    row.appendChild(el("div", "qp", String(v)));
    row.appendChild(el("div", "qc", ""));
    host.appendChild(row);
  });
}

function renderForecast() {
  const host = $("#forecast-body");
  const f = state.forecast;
  if (!f || !f.predictions || !f.predictions.length) return;
  host.innerHTML = "";

  const latest = f.predictions[f.predictions.length - 1];
  const acc = f.accuracy || {};

  const call = el("div", "callout");
  const dir = latest.nifty.direction;
  const head = el("div", "call-dir " + (dir === "up" ? "up" : dir === "down" ? "down" : "flat"));
  head.textContent = dir === "flat" ? "No directional call" : "Nifty " + dir;
  call.appendChild(head);
  call.appendChild(el("div", "call-sub",
    `Range ${num(latest.nifty.range_low, 0)} to ${num(latest.nifty.range_high, 0)} ` +
    `for the ${latest.horizon}. Anchored on ${num(latest.nifty.spot_at_prediction)} ` +
    `at ${ago(latest.made_at)}.`));
  call.appendChild(el("div", "call-sub",
    `Signal agreement ${Math.round(latest.agreement * 100)}%, ` +
    `${latest.fired} of ${latest.signals.length} inputs available, ` +
    `option chain ${latest.option_chain_used ? "used" : "missing"}.`));
  host.appendChild(call);

  if (acc.sample_warning) host.appendChild(el("p", "warn", acc.sample_warning));
  if (acc.validated) {
    host.appendChild(el("p", "note",
      `${acc.correct} of ${acc.validated} direction calls settled correct (${acc.percent}%), ` +
      `close landed inside the range ${acc.range_hits} of ${acc.validated} times.`));
  }

  host.appendChild(el("h3", "sub-head", "What each input said"));
  const st = el("table", "chain");
  st.innerHTML = "<thead><tr><th class='l'>Signal</th><th class='l'>Says</th>" +
    "<th>Weight</th><th class='l'>Because</th></tr></thead>";
  const sb = el("tbody");
  latest.signals.forEach((s) => {
    const tr = el("tr");
    if (!s.fired) tr.className = "muted-row";
    tr.appendChild(el("td", "l", s.name));
    tr.appendChild(el("td", "l " + (s.fired ? dirWord(s.bias) : "flat"),
      s.fired ? s.bias : "no data"));
    tr.appendChild(el("td", null, s.weight.toFixed(2)));
    tr.appendChild(el("td", "l dim", s.because));
    sb.appendChild(tr);
  });
  st.appendChild(sb);
  host.appendChild(st);

  const settled = f.predictions.filter((p) => p.validated).slice(-15).reverse();
  if (settled.length) {
    host.appendChild(el("h3", "sub-head", "Settled calls"));
    const lt = el("table", "chain");
    lt.innerHTML = "<thead><tr><th class='l'>Made</th><th class='l'>Called</th>" +
      "<th class='l'>Actual</th><th>Move</th><th>Close</th><th class='l'>Result</th></tr></thead>";
    const lb = el("tbody");
    settled.forEach((p) => {
      const o = p.outcome;
      const tr = el("tr");
      tr.appendChild(el("td", "l", p.made_at.slice(0, 10)));
      tr.appendChild(el("td", "l " + dirWord(p.nifty.direction), p.nifty.direction));
      tr.appendChild(el("td", "l " + dirWord(o.actual_direction), o.actual_direction));
      tr.appendChild(el("td", dirClass(o.move_pct), signed(o.move_pct) + "%"));
      tr.appendChild(el("td", null, num(o.close)));
      tr.appendChild(el("td", "l " + (o.correct ? "up" : "down"), o.correct ? "hit" : "miss"));
      lb.appendChild(tr);
    });
    lt.appendChild(lb);
    host.appendChild(lt);
  }

  if (f.legacy_demo && f.legacy_demo.length) {
    host.appendChild(el("p", "note",
      `${f.legacy_demo.length} rows from the original prototype are kept in ` +
      `predictions.json under legacy_demo. They were never checked against a real close, ` +
      `so they are excluded from the numbers above.`));
  }
}

const dirWord = (b) => (b === "up" ? "up" : b === "down" ? "down" : "flat");

function renderStatus() {
  const pairs = [["market", "#age-market"], ["news", "#age-news"], ["social", "#age-social"]];
  pairs.forEach(([key, sel]) => {
    const d = state[key];
    const node = $(sel);
    node.textContent = d ? ago(d.generated_at) : "never";
    const mins = d ? (Date.now() - new Date(d.generated_at).getTime()) / 60000 : 999;
    node.classList.toggle("stale", mins > 25);
  });

  const host = $("#lanes");
  host.innerHTML = "";
  ["market", "news", "social"].forEach((key) => {
    const d = state[key];
    if (!d) return;
    (d.lanes || []).forEach((l) => {
      const dot = el("span", "lane" + (l.ok ? "" : " bad"));
      dot.title = `${l.name}: ${l.ok ? l.count + " items" : l.error || "failed"}`;
      host.appendChild(dot);
    });
  });
}

/* ------------------------------------------------------------- data load */

async function loadFile(name) {
  const r = await fetch(`data/${name}.json?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${name}.json ${r.status}`);
  return r.json();
}

async function refresh() {
  const results = await Promise.allSettled([
    loadFile("market"), loadFile("news"), loadFile("social"), loadFile("predictions"),
  ]);
  const [m, n, s, f] = results;
  if (m.status === "fulfilled") {
    state.market = m.value;
    renderHeadline(state.market.headline);
    renderQuotes("india", state.market.india);
    renderQuotes("movers", (state.market.gainers || []).concat(state.market.losers || []));
    renderQuotes("global", state.market.global);
    renderQuotes("macro", state.market.macro);
    renderOptions();
    renderFno();
  }
  if (n.status === "fulfilled") { state.news = n.value; renderNews(); }
  if (s.status === "fulfilled") { state.social = s.value; renderSocial(); }
  if (f.status === "fulfilled") { state.forecast = f.value; renderForecast(); }
  renderStatus();
}

/* ------------------------------------------------------------- wiring */

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.remove("is-on");
      t.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("is-on"));
    tab.classList.add("is-on");
    tab.setAttribute("aria-selected", "true");
    $("#panel-" + tab.dataset.panel).classList.add("is-on");
  });
});

$("#only-high").addEventListener("change", renderNews);
$("#news-search").addEventListener("input", renderNews);
$("#only-market").addEventListener("change", renderSocial);

function tickClock() {
  $("#clock").textContent = new Date().toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata", hour12: false });
}

tickClock();
setInterval(tickClock, 1000);
refresh();
setInterval(refresh, REFRESH_MS);
setInterval(renderStatus, 60000);
