/* M3U / m3u_plus parser.
   Playlists can hold tens of thousands of entries, so the text is processed in
   chunks and control returns to the event loop between them; otherwise the TV
   watchdog kills the app. */
var M3U = (function () {

  var RE_ATTR = /([a-zA-Z0-9-]+)="([^"]*)"/g;
  var RE_SERIES = /\bS\s?(\d{1,2})\s*[ .:_-]*\s?E\s?(\d{1,3})\b/i;
  var RE_VOD_EXT = /\.(mp4|mkv|avi|mov|m4v|flv|wmv|mpg|mpeg)(\?.*)?$/i;

  function kindOf(url, group) {
    var u = url.toLowerCase();
    if (u.indexOf('/series/') >= 0) return 'series';
    if (u.indexOf('/movie/') >= 0 || u.indexOf('/vod/') >= 0) return 'movie';
    if (RE_VOD_EXT.test(u)) {
      var g = (group || '').toLowerCase();
      if (g.indexOf('dizi') >= 0 || g.indexOf('series') >= 0 || g.indexOf('serie') >= 0) return 'series';
      return 'movie';
    }
    return 'live';
  }

  function parseExtinf(line) {
    /* #EXTINF:-1 tvg-id="" tvg-name="X" tvg-logo="http" group-title="Y",Display Name */
    var comma = line.lastIndexOf(',');
    var head = comma > 0 ? line.substring(0, comma) : line;
    var name = comma > 0 ? line.substring(comma + 1).trim() : '';
    var attrs = {}, m;
    RE_ATTR.lastIndex = 0;
    while ((m = RE_ATTR.exec(head)) !== null) attrs[m[1].toLowerCase()] = m[2];
    if (!name) name = attrs['tvg-name'] || '';
    return { name: name, group: attrs['group-title'] || '', logo: attrs['tvg-logo'] || '' };
  }

  function cleanShowTitle(s) {
    return s.replace(/[\s._:|-]+$/, '')
            .replace(/^\s*(TR|EN|US|UK|DE|FR|AR|NL)\s*[|:-]\s*/i, '')
            .trim();
  }

  /* text -> items (async, chunked) */
  function parse(text, onProgress, done) {
    var items = [];
    var pos = 0, len = text.length;
    var pending = null;   /* pending #EXTINF metadata */
    var lineNo = 0;

    function step() {
      var processed = 0;
      while (pos < len && processed < 4000) {
        var nl = text.indexOf('\n', pos);
        var line;
        if (nl < 0) { line = text.substring(pos); pos = len; }
        else { line = text.substring(pos, nl); pos = nl + 1; }
        if (line.charCodeAt(line.length - 1) === 13) line = line.substring(0, line.length - 1);
        processed++; lineNo++;

        if (!line) continue;
        var c0 = line.charAt(0);
        if (c0 === '#') {
          if (line.substring(0, 8) === '#EXTINF:') pending = parseExtinf(line);
          continue;
        }
        if (!pending) continue;

        var url = line.trim();
        if (!url) { pending = null; continue; }

        var kind = kindOf(url, pending.group);
        var it = {
          n: pending.name, g: pending.group || T('group.other'), l: pending.logo,
          u: url, k: kind, f: U.fold(pending.name)
        };
        if (kind === 'series') {
          var sm = RE_SERIES.exec(pending.name);
          if (sm) {
            it.s = cleanShowTitle(pending.name.substring(0, sm.index));
            it.se = parseInt(sm[1], 10);
            it.ep = parseInt(sm[2], 10);
          } else {
            it.s = cleanShowTitle(pending.name);
            it.se = 1; it.ep = 0;
          }
          if (!it.s) it.s = pending.name;
        }
        items.push(it);
        pending = null;
      }

      if (onProgress) onProgress(pos / len, items.length);
      if (pos < len) setTimeout(step, 0);
      else done(null, items);
    }

    if (text.indexOf('#EXTM3U') < 0 && text.indexOf('#EXTINF') < 0) {
      done(new Error(T('err.badPlaylist')));
      return;
    }
    setTimeout(step, 0);
  }

  /* Category tree: group list and counts for each tab */
  function buildIndex(items) {
    var idx = {
      live: { order: [], map: {} },
      movie: { order: [], map: {} },
      series: { order: [], map: {} },
      shows: {}          /* series name -> episode list */
    };
    var i, it, bucket, g;
    for (i = 0; i < items.length; i++) {
      it = items[i];
      bucket = idx[it.k];
      if (!bucket) continue;
      g = it.g || T('group.other');
      if (!bucket.map[g]) { bucket.map[g] = []; bucket.order.push(g); }
      bucket.map[g].push(i);
      if (it.k === 'series') {
        var key = it.g + '|' + it.s;
        if (!idx.shows[key]) idx.shows[key] = [];
        idx.shows[key].push(i);
      }
    }
    return idx;
  }

  /* Candidate URLs to try, in order, for AVPlay compatibility.
     Xtream live URLs are usually raw TS; the HLS variant plays more reliably. */
  function candidates(item) {
    var u = item.u, out = [];
    function add(x) { if (x && out.indexOf(x) < 0) out.push(x); }

    if (item.k === 'live') {
      var m = u.match(/^(https?:\/\/[^/]+)\/live\/([^/]+)\/([^/]+)\/(\d+)(?:\.\w+)?(\?.*)?$/i);
      if (!m) {
        var m2 = u.match(/^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/(\d+)(?:\.\w+)?(\?.*)?$/i);
        if (m2 && m2[2] !== 'movie' && m2[2] !== 'series') m = m2;
      }
      if (m) {
        /* Try the playlist URL first (the format the provider intends),
           then the HLS and TS variants. */
        var base = m[1] + '/live/' + m[2] + '/' + m[3] + '/' + m[4];
        add(u);
        add(base + '.m3u8');
        add(base + '.ts');
      } else if (/\.ts(\?|$)/i.test(u)) {
        add(u);
        add(u.replace(/\.ts(\?|$)/i, '.m3u8$1'));
      } else {
        add(u);
        if (!/\.m3u8(\?|$)/i.test(u)) add(u + '.m3u8');
      }
    } else {
      add(u);
      /* some providers also serve an .mkv link as .mp4 */
      if (/\.mkv(\?|$)/i.test(u)) add(u.replace(/\.mkv(\?|$)/i, '.mp4$1'));
    }
    return out;
  }

  return { parse: parse, buildIndex: buildIndex, candidates: candidates };
})();
