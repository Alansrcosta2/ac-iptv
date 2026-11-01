/* Persistent storage.
   - settings / favourites / resume positions -> localStorage (small)
   - parsed playlist                         -> IndexedDB (can be tens of thousands of rows) */
var Store = (function () {

  var LS_SET = 'opentv.settings';
  var LS_FAV = 'opentv.favorites';
  var LS_POS = 'opentv.resume';
  var DB_NAME = 'opentv';
  var DB_STORE = 'cache';

  /* Default source.
     Empty in the repository, so a fresh install shows the setup screen.
     To ship your own subscription with the build, create js/local-config.js
     (see js/local-config.example.js). That file is git-ignored, so your
     credentials never reach the repository. */
  var DEFAULT_SOURCE = (typeof LOCAL_CONFIG !== 'undefined' && LOCAL_CONFIG && LOCAL_CONFIG.source)
    ? LOCAL_CONFIG.source : '';

  var settings = { source: DEFAULT_SOURCE, subSize: 'normal', lastTab: 'live', autoRefreshHours: 12,
                   lang: 'pt', bufferSec: 8 };
  var favorites = {};
  var resume = {};

  function loadLS() {
    try {
      var s = localStorage.getItem(LS_SET);
      if (s) {
        var o = JSON.parse(s), k;
        for (k in o) if (o.hasOwnProperty(k)) settings[k] = o[k];
      }
    } catch (e) { }
    if (!settings.source) settings.source = DEFAULT_SOURCE;
    try { favorites = JSON.parse(localStorage.getItem(LS_FAV) || '{}') || {}; } catch (e2) { favorites = {}; }
    try { resume = JSON.parse(localStorage.getItem(LS_POS) || '{}') || {}; } catch (e3) { resume = {}; }
  }

  function saveSettings() {
    try { localStorage.setItem(LS_SET, JSON.stringify(settings)); } catch (e) { }
  }
  function saveFav() {
    try { localStorage.setItem(LS_FAV, JSON.stringify(favorites)); } catch (e) { }
  }
  function saveResume() {
    try { localStorage.setItem(LS_POS, JSON.stringify(resume)); } catch (e) { }
  }

  function isFav(id) { return favorites[id] === 1; }
  function toggleFav(id) {
    if (favorites[id]) delete favorites[id]; else favorites[id] = 1;
    saveFav();
    return !!favorites[id];
  }
  function favIds() {
    var out = [], k;
    for (k in favorites) if (favorites.hasOwnProperty(k)) out.push(k);
    return out;
  }

  function getResume(id) { return resume[id] || null; }
  function setResume(id, pos, dur) {
    if (!id) return;
    if (!pos || pos < 15000) { delete resume[id]; }
    else if (dur && pos > dur - 90000) { delete resume[id]; }
    else { resume[id] = { p: pos, d: dur || 0, t: Date.now() }; }
    /* keep at most 400 entries */
    var keys = [], k;
    for (k in resume) if (resume.hasOwnProperty(k)) keys.push(k);
    if (keys.length > 400) {
      keys.sort(function (a, b) { return resume[a].t - resume[b].t; });
      for (var i = 0; i < keys.length - 400; i++) delete resume[keys[i]];
    }
    saveResume();
  }

  /* ---- IndexedDB ---- */
  function openDb(cb) {
    var req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { cb(e); return; }
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = function () { cb(null, req.result); };
    req.onerror = function () { cb(req.error || new Error('IndexedDB acilamadi')); };
  }

  function putCache(key, value, cb) {
    openDb(function (err, db) {
      if (err) { if (cb) cb(err); return; }
      try {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(value, key);
        tx.oncomplete = function () { db.close(); if (cb) cb(null); };
        tx.onerror = function () { db.close(); if (cb) cb(tx.error); };
      } catch (e) { db.close(); if (cb) cb(e); }
    });
  }

  function getCache(key, cb) {
    openDb(function (err, db) {
      if (err) { cb(err); return; }
      try {
        var tx = db.transaction(DB_STORE, 'readonly');
        var rq = tx.objectStore(DB_STORE).get(key);
        rq.onsuccess = function () { db.close(); cb(null, rq.result); };
        rq.onerror = function () { db.close(); cb(rq.error); };
      } catch (e) { db.close(); cb(e); }
    });
  }

  function clearCache(cb) {
    openDb(function (err, db) {
      if (err) { if (cb) cb(err); return; }
      try {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).clear();
        tx.oncomplete = function () { db.close(); if (cb) cb(null); };
      } catch (e) { db.close(); if (cb) cb(e); }
    });
  }

  loadLS();

  return {
    settings: settings, saveSettings: saveSettings, DEFAULT_SOURCE: DEFAULT_SOURCE,
    isFav: isFav, toggleFav: toggleFav, favIds: favIds,
    getResume: getResume, setResume: setResume,
    putCache: putCache, getCache: getCache, clearCache: clearCache
  };
})();
