/* ============================================================================
   The browser modules, loaded into Node.

   The workflows that study the record and freeze the daily call run the same
   files the page runs, not a Python port of them: a pattern counted on the
   page and a pattern counted over twenty years must be the same pattern.

   The modules do `window.KT = window.KT || {}` and then use a bare `KT`, which
   only works when `window` is the global object, so the context is its own
   window. Storage is in memory; the network is whatever the caller passes
   (refused by default).
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
/* Where data/ and config/ are read and written. The repository by default;
   the self-test points it at a scratch copy so a replayed evening never
   touches the real record. The modules themselves always load from ROOT. */
const DATA_ROOT = process.env.KT_DATA_ROOT ? path.resolve(process.env.KT_DATA_ROOT) : ROOT;

function load(modules, opts) {
  opts = opts || {};
  const mem = {};
  const sb = {};
  sb.window = sb;
  sb.globalThis = sb;
  sb.console = opts.quiet ? { log() {}, info() {}, warn() {}, error: console.error } : console;
  sb.navigator = { language: 'en-IN' };
  sb.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
  sb.localStorage = {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; },
    key: i => Object.keys(mem)[i] || null,
    get length() { return Object.keys(mem).length; },
    clear: () => { Object.keys(mem).forEach(k => delete mem[k]); },
  };
  const stub = () => ({
    style: {}, dataset: {}, innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, setAttribute() {}, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
  });
  sb.document = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: stub, addEventListener() {}, body: stub(), documentElement: stub(),
  };
  sb.addEventListener = () => {};
  sb.DOMParser = function () {
    this.parseFromString = () => { throw new Error('XML parsing is not available here'); };
  };
  sb.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  sb.setTimeout = setTimeout; sb.clearTimeout = clearTimeout;
  sb.setInterval = setInterval; sb.clearInterval = clearInterval;
  sb.AbortController = AbortController;
  sb.location = { origin: 'https://voltairtechindia.github.io', href: 'https://voltairtechindia.github.io/Sharemarket/', hash: '', pathname: '/Sharemarket/' };
  sb.fetch = opts.fetch || (() => Promise.reject(new Error('no network here')));
  /* A test clock: the modules read the time from Date alone, so a run can be
     replayed as if it were a given evening. The clock still moves from there. */
  if (typeof opts.now === 'number' && isFinite(opts.now)) {
    const start = Date.now(), base = opts.now;
    const at = () => base + (Date.now() - start);
    class TestDate extends Date {
      constructor(...a) { if (a.length) super(...a); else super(at()); }
      static now() { return at(); }
    }
    sb.Date = TestDate;
  }
  vm.createContext(sb);
  for (const m of modules) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js', m + '.js'), 'utf8'), sb, { filename: m + '.js' });
  }
  sb.KT.__storage = mem;
  return sb.KT;
}

function readJSON(rel, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_ROOT, rel), 'utf8')); }
  catch (e) { return fallback; }
}

function writeJSON(rel, obj) {
  const p = path.join(DATA_ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', JSON.stringify(obj));
  fs.renameSync(p + '.tmp', p);
  console.log('wrote ' + rel + ' (' + fs.statSync(p).size + ' bytes)');
}

module.exports = { load, readJSON, writeJSON, ROOT, DATA_ROOT };
