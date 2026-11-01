/* Application flow: cache -> playlist download -> parsing -> UI */
var App = (function () {

  var CACHE_KEY = 'playlist';

  function human(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function useItems(items, fromCache) {
    if (!items || !items.length) {
      UI.modal(T('dlg.empty.title'), T('dlg.empty.text'),
        [{ label: T('dlg.changeSource'), act: function () { UI.openSetup(Store.settings.source, onSourceSaved); } }]);
      return;
    }
    var index = M3U.buildIndex(items);
    UI.setData(items, index);
    var tab = Store.settings.lastTab || 'live';
    if (!index[tab] && tab !== 'fav') tab = 'live';
    if (index[tab] && !index[tab].order.length && tab !== 'fav') {
      tab = index.live.order.length ? 'live' : (index.movie.order.length ? 'movie' : 'series');
    }
    UI.setTab(tab);
    UI.showBrowse();
    if (fromCache) maybeBackgroundRefresh(items.length);
  }

  function maybeBackgroundRefresh() {
    Store.getCache(CACHE_KEY, function (err, rec) {
      if (err || !rec) return;
      var hours = (Date.now() - rec.ts) / 3600000;
      if (hours >= (Store.settings.autoRefreshHours || 12)) download(true);
    });
  }

  function download(silent) {
    var url = Store.settings.source;
    if (!url) { UI.openSetup('', onSourceSaved); return; }

    if (!silent) {
      UI.showScreen('scr-boot');
      UI.boot(T('boot.downloading'), 0.05, url.replace(/(password=)[^&]*/i, '$1***'));
    }

    U.httpGet(url, {
      timeout: 180000,
      onprogress: function (loaded, total) {
        if (silent) return;
        var pct = total ? (loaded / total) * 0.6 : Math.min(0.55, loaded / (25 * 1024 * 1024) * 0.6);
        UI.boot(T('boot.downloadingSize', { size: human(loaded) }), 0.05 + pct);
      }
    }, function (err, text) {
      if (err) {
        if (silent) return;
        UI.modal(T('dlg.downloadFailed.title'), T('dlg.downloadFailed.text', { err: err.message || String(err) }),
          [{ label: T('dlg.retry'), act: function () { download(false); } },
           { label: T('dlg.changeSource'), act: function () { UI.openSetup(Store.settings.source, onSourceSaved); } }]);
        return;
      }
      if (!silent) UI.boot(T('boot.parsing'), 0.65);
      M3U.parse(text, function (ratio, count) {
        if (!silent) UI.boot(T('boot.parsingCount', { n: count }), 0.65 + ratio * 0.3);
      }, function (perr, items) {
        if (perr) {
          if (silent) return;
          UI.modal(T('dlg.parseFailed.title'), perr.message,
            [{ label: T('dlg.changeSource'), act: function () { UI.openSetup(Store.settings.source, onSourceSaved); } }]);
          return;
        }
        Store.putCache(CACHE_KEY, { url: url, ts: Date.now(), items: items }, function () { });
        if (silent) return;
        UI.boot(T('boot.ready'), 1);
        setTimeout(function () { useItems(items, false); }, 200);
      });
    });
  }

  function onSourceSaved(url) {
    var changed = (url !== Store.settings.source);
    Store.settings.source = url;
    Store.saveSettings();
    if (changed) Store.clearCache(function () { download(false); });
    else download(false);
  }

  /* Rewrites the "output" parameter of the Xtream URL and reloads the playlist.
     If the provider serves HLS, the resulting .m3u8 URLs play reliably in AVPlay. */
  function switchOutput(fmt) {
    var url = Store.settings.source || '';
    if (/[?&]output=/i.test(url)) url = url.replace(/([?&]output=)[^&]*/i, '$1' + fmt);
    else url += (url.indexOf('?') >= 0 ? '&' : '?') + 'output=' + fmt;
    Store.settings.source = url;
    Store.saveSettings();
    Store.clearCache(function () { download(false); });
  }

  function currentOutput() {
    var m = (Store.settings.source || '').match(/[?&]output=([^&]*)/i);
    return m ? m[1].toLowerCase() : '';
  }

  function clearAndReload() {
    Store.clearCache(function () { download(false); });
  }

  function refresh() {
    UI.modal(T('dlg.reload.title'), T('dlg.reload.text'),
      [{ label: T('dlg.reload.confirm'), act: function () { download(false); } },
       { label: T('dlg.cancel'), act: UI.closeModal }]);
  }

  function start() {
    Log.line('app started, webapis=' + (typeof webapis !== 'undefined' && webapis && webapis.avplay ? 'yes' : 'no') +
             ' source=' + (Store.settings.source || '').replace(/(password=)[^&]*/i, '$1***'));
    I18N.set(Store.settings.lang || 'pt');
    I18N.apply();
    KEY.init();
    KEY.onKey(function (code) { UI.key(code); });
    UI.onSourceSaved(onSourceSaved);
    UI.onRefresh(refresh);
    UI.onClearCache(clearAndReload);

    UI.boot(T('boot.readingCache'), 0.15, '');

    /* Preview mode: index.html?demo=1 loads the bundled sample playlist */
    if (location.search.indexOf('demo') >= 0) {
      Store.settings.source = 'demo.m3u';
      download(false);
      return;
    }

    if (!Store.settings.source) {
      setTimeout(function () { UI.openSetup('', onSourceSaved); }, 300);
      return;
    }

    Store.getCache(CACHE_KEY, function (err, rec) {
      if (!err && rec && rec.items && rec.items.length && rec.url === Store.settings.source) {
        UI.boot(T('boot.loadingCache', { n: rec.items.length }), 0.8);
        setTimeout(function () { useItems(rec.items, true); }, 120);
      } else {
        download(false);
      }
    });
  }

  return { start: start, switchOutput: switchOutput, currentOutput: currentOutput };
})();

window.addEventListener('load', function () { App.start(); }, false);
