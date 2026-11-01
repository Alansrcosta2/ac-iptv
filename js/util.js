/* Shared helpers. No optional chaining or ?? here: the Tizen browser engine
   does not support them. */
var U = (function () {

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined && html !== null) e.innerHTML = html;
    return e;
  }

  function esc(s) {
    if (s === undefined || s === null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* Folds Turkish characters for searching: "Şişli" -> "sisli" */
  var FOLD = { 'ı': 'i', 'İ': 'i', 'ş': 's', 'Ş': 's', 'ğ': 'g', 'Ğ': 'g',
               'ü': 'u', 'Ü': 'u', 'ö': 'o', 'Ö': 'o', 'ç': 'c', 'Ç': 'c', 'â': 'a', 'î': 'i', 'û': 'u' };
  function fold(s) {
    if (!s) return '';
    var out = '', i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i);
      out += (FOLD[c] !== undefined ? FOLD[c] : c);
    }
    return out.toLowerCase();
  }

  function fmtTime(ms) {
    if (!ms || ms < 0 || isNaN(ms)) ms = 0;
    var t = Math.floor(ms / 1000);
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (h > 0 ? h + ':' : '') + p(m) + ':' + p(s);
  }

  function clock() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* Track languages are shown using the interface dictionary (js/i18n.js),
     so they follow the selected language. */
  var LANG_ALIAS = { tr: 'tur', en: 'eng', de: 'ger', deu: 'ger', fr: 'fre', fra: 'fre',
    es: 'spa', it: 'ita', ru: 'rus', ar: 'ara', zho: 'chi', nld: 'dut', ell: 'gre',
    fas: 'per', ron: 'rum', ces: 'cze' };
  function langName(code) {
    if (!code) return '';
    var k = String(code).toLowerCase().replace(/[^a-z]/g, '');
    if (LANG_ALIAS[k]) k = LANG_ALIAS[k];
    if (k.length > 3) k = k.substring(0, 3);
    var s = T('lang.' + k);
    return (s === 'lang.' + k) ? code : s;
  }

  /* GET with timeout support. XHR behaves more reliably than fetch on Tizen. */
  function httpGet(url, opts, cb) {
    opts = opts || {};
    var xhr = new XMLHttpRequest();
    var done = false;
    function finish(err, text) {
      if (done) return;
      done = true;
      cb(err, text);
    }
    try { xhr.open('GET', url, true); } catch (e) { finish(e); return null; }
    xhr.timeout = opts.timeout || 60000;
    if (opts.onprogress) {
      xhr.onprogress = function (ev) { opts.onprogress(ev.loaded, ev.lengthComputable ? ev.total : 0); };
    }
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) finish(null, xhr.responseText);
      else finish(new Error('HTTP ' + xhr.status));
    };
    xhr.onerror = function () { finish(new Error('Baglanti hatasi')); };
    xhr.ontimeout = function () { finish(new Error('Zaman asimi')); };
    try { xhr.send(); } catch (e2) { finish(e2); }
    return xhr;
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
  }

  function initials(name) {
    if (!name) return '?';
    var parts = String(name).replace(/[^\wçğıöşüÇĞİÖŞÜ ]/g, ' ').trim().split(/\s+/);
    var a = parts[0] ? parts[0].charAt(0) : '?';
    var b = parts[1] ? parts[1].charAt(0) : '';
    return (a + b).toUpperCase();
  }

  return { $: $, el: el, esc: esc, fold: fold, fmtTime: fmtTime, clock: clock,
           langName: langName, httpGet: httpGet, debounce: debounce, initials: initials };
})();
