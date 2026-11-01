/* Extracts embedded MP4 subtitles (mov_text / tx3g) straight from the server.

   Why this exists: Tizen AVPlay lists these tracks but cannot decode their text
   on some firmware - selecting a track succeeds, yet no subtitle event ever
   fires. In MP4 the byte offset of every subtitle sample is written in the
   "moov" table at the head of the file, so we can fetch and decode the samples
   ourselves.

   Flow:
     1. locate and download the "moov" box at the start of the file
     2. read the subtitle tracks, their languages, and each sample's byte range
        and timestamp
     3. download the selected track's samples, merging nearby byte ranges
     4. decode each tx3g sample: 2-byte length + UTF-8 text
*/
var Subs = (function () {

  var MERGE_GAP = 65536;      /* byte ranges closer than this are fetched in a single request */
  var CONCURRENCY = 8;

  /* ---------- HTTP ---------- */

  /* The provider 302-redirects every request to the real streaming host. Since
     we issue hundreds of small requests, resolve the redirect once and reuse
     the final URL; otherwise every request pays two round trips. */
  function fetchRange(url, from, to, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.timeout = 30000;
    if (from !== null) xhr.setRequestHeader('Range', 'bytes=' + from + '-' + to);
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        cb(null, new DataView(xhr.response), xhr.responseURL || url);
      } else cb(new Error('HTTP ' + xhr.status));
    };
    xhr.onerror = function () { cb(new Error(T('err.network'))); };
    xhr.ontimeout = function () { cb(new Error(T('err.timeout'))); };
    try { xhr.send(); } catch (e) { cb(e); }
  }

  /* ---------- MP4 boxes ---------- */

  function readBoxes(dv, start, end) {
    var out = [], p = start;
    while (p + 8 <= end) {
      var size = dv.getUint32(p);
      var type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
      var hdr = 8;
      if (size === 1) {
        /* 64-bit size: the high 32 bits are 0 in practice */
        size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12);
        hdr = 16;
      }
      if (size === 0) size = end - p;
      if (size < hdr) break;
      out.push({ type: type, start: p, dataStart: p + hdr, end: p + size });
      p += size;
    }
    return out;
  }
  function pick(list, type) {
    for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i];
    return null;
  }
  function fourcc(dv, p) {
    return String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
  }

  /* packed ISO 639-2 language code */
  function unpackLang(packed) {
    var a = ((packed >> 10) & 31) + 0x60, b = ((packed >> 5) & 31) + 0x60, c = (packed & 31) + 0x60;
    var s = String.fromCharCode(a, b, c);
    return /^[a-z]{3}$/.test(s) ? s : '';
  }

  /* ---------- moov ---------- */

  function loadMoov(url, onProgress, cb) {
    if (onProgress) onProgress(T('subs.readingHeader'));
    fetchRange(url, 0, 8191, function (err, dv, finalUrl) {
      if (err) { cb(err); return; }
      var top = readBoxes(dv, 0, dv.byteLength);
      var moov = null;
      for (var i = 0; i < top.length; i++) if (top[i].type === 'moov') moov = top[i];
      if (!moov) { cb(new Error(T('subs.noMoov'))); return; }
      var size = moov.end - moov.start;
      if (onProgress) onProgress(T('subs.downloadingTable', { size: Math.round(size / 1048576 * 10) / 10 }));
      fetchRange(finalUrl, moov.start, moov.end - 1, function (err2, mdv) {
        if (err2) { cb(err2); return; }
        cb(null, mdv, finalUrl);
      });
    });
  }

  /* ---------- track table ---------- */

  function parseTracks(moov, onProgress) {
    var tracks = [];
    var inMoov = readBoxes(moov, 8, moov.byteLength);
    var trakIdx = -1;

    for (var t = 0; t < inMoov.length; t++) {
      if (inMoov[t].type !== 'trak') continue;
      trakIdx++;
      var trak = inMoov[t];
      var tb = readBoxes(moov, trak.dataStart, trak.end);
      var mdia = pick(tb, 'mdia'); if (!mdia) continue;
      var mb = readBoxes(moov, mdia.dataStart, mdia.end);
      var hdlr = pick(mb, 'hdlr'), mdhd = pick(mb, 'mdhd'), minf = pick(mb, 'minf');
      if (!hdlr || !mdhd || !minf) continue;

      var handler = fourcc(moov, hdlr.dataStart + 8);
      if (handler !== 'text' && handler !== 'sbtl') continue;

      var ver = moov.getUint8(mdhd.dataStart);
      var base = mdhd.dataStart + (ver === 1 ? 4 + 16 : 4 + 8);
      var timescale = moov.getUint32(base);
      var langOff = base + 4 + (ver === 1 ? 8 : 4);
      var lang = unpackLang(moov.getUint16(langOff));

      var sb = readBoxes(moov, minf.dataStart, minf.end);
      var stbl = pick(sb, 'stbl'); if (!stbl) continue;
      var st = readBoxes(moov, stbl.dataStart, stbl.end);
      var stsz = pick(st, 'stsz'), stco = pick(st, 'stco'), co64 = pick(st, 'co64');
      var stsc = pick(st, 'stsc'), stts = pick(st, 'stts');
      if (!stsz || !stsc || !stts || (!stco && !co64)) continue;

      /* sample sizes */
      var uniform = moov.getUint32(stsz.dataStart + 4);
      var count = moov.getUint32(stsz.dataStart + 8);
      var sizes = new Uint32Array(count), i;
      for (i = 0; i < count; i++) sizes[i] = uniform || moov.getUint32(stsz.dataStart + 12 + i * 4);

      /* chunk offsets */
      var chunks = [], n;
      if (stco) {
        n = moov.getUint32(stco.dataStart + 4);
        for (i = 0; i < n; i++) chunks.push(moov.getUint32(stco.dataStart + 8 + i * 4));
      } else {
        n = moov.getUint32(co64.dataStart + 4);
        for (i = 0; i < n; i++) chunks.push(moov.getUint32(co64.dataStart + 8 + i * 8) * 4294967296 +
                                            moov.getUint32(co64.dataStart + 12 + i * 8));
      }

      /* samples per chunk */
      var scN = moov.getUint32(stsc.dataStart + 4), sc = [];
      for (i = 0; i < scN; i++) {
        var o = stsc.dataStart + 8 + i * 12;
        sc.push({ first: moov.getUint32(o), per: moov.getUint32(o + 4) });
      }

      /* timestamps */
      var ttN = moov.getUint32(stts.dataStart + 4), deltas = [];
      for (i = 0; i < ttN; i++) {
        var p = stts.dataStart + 8 + i * 8;
        deltas.push({ count: moov.getUint32(p), delta: moov.getUint32(p + 4) });
      }

      /* sample -> offset + timestamp */
      var offsets = new Array(count), times = new Array(count);
      var sample = 0;
      for (var c = 0; c < chunks.length && sample < count; c++) {
        var per = sc[0].per;
        for (var e = 0; e < sc.length; e++) if (c + 1 >= sc[e].first) per = sc[e].per;
        var off = chunks[c];
        for (var k = 0; k < per && sample < count; k++, sample++) {
          offsets[sample] = off;
          off += sizes[sample];
        }
      }
      var tcur = 0, si = 0;
      for (i = 0; i < deltas.length; i++) {
        for (var j = 0; j < deltas[i].count && si < count; j++, si++) {
          times[si] = { start: tcur, dur: deltas[i].delta };
          tcur += deltas[i].delta;
        }
      }

      tracks.push({
        trackIndex: trakIdx, lang: lang, count: count, timescale: timescale || 1000,
        sizes: sizes, offsets: offsets, times: times
      });
    }
    return tracks;
  }

  /* ---------- download and decode samples ---------- */

  function buildSpans(track, startMs) {
    var idx = [], i;
    for (i = 0; i < track.count; i++) if (track.sizes[i] > 2) idx.push(i);
    idx.sort(function (a, b) { return track.offsets[a] - track.offsets[b]; });

    var spans = [], cur = null;
    for (i = 0; i < idx.length; i++) {
      var s = idx[i], from = track.offsets[s], to = from + track.sizes[s] - 1;
      var tms = track.times[s].start / track.timescale * 1000;
      if (cur && from - cur.to <= MERGE_GAP) {
        cur.to = Math.max(cur.to, to);
        cur.samples.push(s);
        if (tms < cur.time) cur.time = tms;
      } else {
        cur = { from: from, to: to, samples: [s], time: tms };
        spans.push(cur);
      }
    }

    /* Fetch from the current position onwards: first the spans ahead of it in
       time order, then the ones behind. Subtitles appear within seconds and the
       rest fills in afterwards. */
    if (startMs > 0) {
      var ahead = [], behind = [];
      for (i = 0; i < spans.length; i++) {
        if (spans[i].time + 5000 >= startMs) ahead.push(spans[i]); else behind.push(spans[i]);
      }
      ahead.sort(function (a, b) { return a.time - b.time; });
      behind.sort(function (a, b) { return b.time - a.time; });
      spans = ahead.concat(behind);
    }
    return spans;
  }

  function decodeSample(dv, pos, size) {
    /* tx3g: 2-byte text length + UTF-8 text (+ style boxes, ignored) */
    if (size < 2) return '';
    var len = dv.getUint16(pos);
    if (len === 0 || len > size - 2) return '';
    var bytes = [];
    for (var i = 0; i < len; i++) bytes.push(dv.getUint8(pos + 2 + i));
    return utf8(bytes);
  }

  function utf8(bytes) {
    var out = '', i = 0, c, c2, c3;
    while (i < bytes.length) {
      c = bytes[i++];
      if (c < 128) out += String.fromCharCode(c);
      else if (c > 191 && c < 224) { c2 = bytes[i++]; out += String.fromCharCode(((c & 31) << 6) | (c2 & 63)); }
      else if (c > 223 && c < 240) {
        c2 = bytes[i++]; c3 = bytes[i++];
        out += String.fromCharCode(((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63));
      } else {
        c2 = bytes[i++]; c3 = bytes[i++]; var c4 = bytes[i++];
        var cp = ((c & 7) << 18) | ((c2 & 63) << 12) | ((c3 & 63) << 6) | (c4 & 63) - 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023));
      }
    }
    return out;
  }

  /* ---------- windowed fetching ----------
     Downloading a whole track up front is very slow on the TV: the provider is
     already feeding the video stream and queues the hundreds of small requests
     behind it. Instead only the spans around the current position are fetched,
     and the window is extended as playback advances. */
  function createSession(url, track) {
    var spans = buildSpans(track, 0);      /* ordered by time */
    var i, s;
    for (i = 0; i < spans.length; i++) {
      var maxT = 0;
      for (var k = 0; k < spans[i].samples.length; k++) {
        s = spans[i].samples[k];
        var e = (track.times[s].start + track.times[s].dur) / track.timescale * 1000;
        if (e > maxT) maxT = e;
      }
      spans[i].endTime = maxT;
      spans[i].state = 0;                  /* 0 pending, 1 in flight, 2 done */
    }
    spans.sort(function (a, b) { return a.time - b.time; });

    var cues = [];
    var active = 0, fetched = 0;
    var onCues = null;
    var CONC = 3;
    var queue = [];

    function pump() {
      while (active < CONC && queue.length) {
        var span = queue.shift();
        if (span.state !== 0) continue;
        span.state = 1;
        active++;
        (function (sp) {
          fetchRange(url, sp.from, sp.to, function (err, dv) {
            active--;
            sp.state = err ? 0 : 2;
            if (!err) {
              fetched++;
              var fresh = [];
              for (var j = 0; j < sp.samples.length; j++) {
                var idx = sp.samples[j];
                var pos = track.offsets[idx] - sp.from;
                if (pos < 0 || pos + track.sizes[idx] > dv.byteLength) continue;
                var text = decodeSample(dv, pos, track.sizes[idx]);
                if (!text) continue;
                fresh.push({
                  start: track.times[idx].start / track.timescale * 1000,
                  end: (track.times[idx].start + track.times[idx].dur) / track.timescale * 1000,
                  text: text
                });
              }
              if (fresh.length) {
                cues = cues.concat(fresh);
                cues.sort(function (a, b) { return a.start - b.start; });
                if (onCues) onCues(cues, fetched, spans.length);
              }
            }
            pump();
          });
        })(span);
      }
    }

    return {
      cues: function () { return cues; },
      progress: function () { return { done: fetched, total: spans.length }; },
      setOnCues: function (fn) { onCues = fn; },
      /* queue the spans covering the given time range */
      ensure: function (fromMs, toMs) {
        var added = 0;
        for (var i2 = 0; i2 < spans.length; i2++) {
          var sp = spans[i2];
          if (sp.state !== 0) continue;
          if (sp.endTime < fromMs || sp.time > toMs) continue;
          if (queue.indexOf(sp) < 0) { queue.push(sp); added++; }
        }
        if (added) pump();
        return added;
      },
      /* fill in the remainder at low priority */
      fillRest: function () {
        for (var i3 = 0; i3 < spans.length; i3++) {
          if (spans[i3].state === 0 && queue.indexOf(spans[i3]) < 0) queue.push(spans[i3]);
        }
        pump();
      },
      isComplete: function () { return fetched >= spans.length; }
    };
  }

  function fetchTrack(url, track, opts, cb) {
    opts = opts || {};
    var onProgress = opts.onProgress, onCues = opts.onCues;
    var spans = buildSpans(track, opts.startMs || 0);
    var cues = [];
    var done = 0, active = 0, next = 0, failed = 0, stopped = false;

    if (!spans.length) { cb(null, []); return; }

    function finishOne() {
      done++;
      if (onProgress) onProgress(T('subs.downloading', { p: Math.round(done / spans.length * 100) }));
      pump();
    }

    function pump() {
      if (stopped) return;
      if (done >= spans.length) {
        stopped = true;
        cb(null, cues);
        return;
      }
      while (active < CONCURRENCY && next < spans.length) {
        (function (span) {
          active++;
          fetchRange(url, span.from, span.to, function (err, dv) {
            active--;
            if (err) {
              failed++;
              if (failed > 20) { stopped = true; cb(err); return; }
              finishOne();
              return;
            }
            var fresh = [];
            for (var i = 0; i < span.samples.length; i++) {
              var s = span.samples[i];
              var pos = track.offsets[s] - span.from;
              if (pos < 0 || pos + track.sizes[s] > dv.byteLength) continue;
              var text = decodeSample(dv, pos, track.sizes[s]);
              if (!text) continue;
              fresh.push({
                start: track.times[s].start / track.timescale * 1000,
                end: (track.times[s].start + track.times[s].dur) / track.timescale * 1000,
                text: text
              });
            }
            if (fresh.length) {
              cues = cues.concat(fresh);
              cues.sort(function (a, b) { return a.start - b.start; });
              if (onCues) onCues(cues);      /* make the new cues usable immediately */
            }
            finishOne();
          });
        })(spans[next++]);
      }
    }
    pump();
  }

  /* ---------- public API ---------- */

  /* Lists the subtitle tracks without downloading them */
  function listTracks(url, onProgress, cb) {
    loadMoov(url, onProgress, function (err, moov, finalUrl) {
      if (err) { cb(err); return; }
      var tracks;
      try { tracks = parseTracks(moov, onProgress); }
      catch (e) { cb(new Error('altyazi tablosu okunamadi: ' + e)); return; }
      cb(null, tracks, finalUrl);
    });
  }

  /* Downloads the cues of the selected track.
     opts: { startMs, onProgress(message), onCues(cues) } */
  function loadCues(url, track, opts, cb) {
    fetchTrack(url, track, opts, cb);
  }

  /* Finds the cue for a timestamp (binary search) */
  function cueAt(cues, ms) {
    var lo = 0, hi = cues.length - 1, best = null;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cues[mid].start > ms) hi = mid - 1;
      else { best = cues[mid]; lo = mid + 1; }
    }
    if (best && ms <= best.end) return best;
    return null;
  }

  return { listTracks: listTracks, loadCues: loadCues, cueAt: cueAt, createSession: createSession };
})();
