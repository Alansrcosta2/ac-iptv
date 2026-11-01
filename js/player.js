/* Player: Tizen AVPlay wrapper, auto-hiding control bar, audio and subtitle
   track selection. Falls back to an HTML5 <video> element when running in a
   desktop browser for testing. */
var Player = (function () {

  var HIDE_MS = 4200;
  /* Buffer thresholds, in seconds.
     PLAY   = how much is collected before the picture starts, kept short so
              zapping stays fast.
     RESUME = how much is refilled after an underrun. This is the one that
              stops the freeze-play-freeze loop on live streams: with a large
              value AVPlay waits once and then has a real cushion, instead of
              restarting with an empty buffer and stalling again a second later. */
  var BUFFER_DEFAULT = 8;
  var STALL_MS = 8000;     /* playback clock frozen this long -> reconnect */
  var NOPIC_MS = 15000;    /* no first frame this long -> next candidate URL */
  var MAX_RECOVER = 5;     /* reconnect attempts before giving up with a dialog */
  var SUB_PROBE_MS = 12000;   /* how long to wait for the first subtitle cue */
  var SUB_PROBE_TRIES = 3;    /* re-select the track this many times before giving up */
  var WINDOW_MS = 240000;  /* how far ahead subtitles are prefetched (4 min) */
  /* small-window (PIP) rectangle: video on the right, list on the left */
  var PIP = { x: 1220, y: 220, w: 640, h: 360 };

  var st = {
    item: null, list: null, listIdx: -1,
    cands: [], candIdx: 0, url: '',
    live: false, playing: false, ready: false,
    dur: 0, cur: 0,
    audio: [], text: [], audioSel: -1, textSel: -1,
    barVisible: false, hideTimer: null, subTimer: null,
    focus: 0, menu: null, menuIdx: 0, ctls: [],
    saveTimer: null, aspect: 0, onExit: null, lastError: '', probeMeta: '',
    pollTimer: null, spinTimer: null, lastTimeAt: 0,
    openedAt: 0, stalls: 0, lastRecoverAt: 0, recovering: false,
    subGotText: false, subEvents: 0, subTries: 0, subProbeTimer: null, menuOff: 0,
    /* subtitles extracted from the file */
    mp4Scan: '', mp4Tracks: null, mp4Url: '', subMode: 'off', subTrackIdx: -1,
    subCues: null, lastCueText: null, subSession: null, subWinTimer: null,
    pip: false,
    scrub: { active: false, pos: 0, timer: null, last: 0, streak: 0, wasPlaying: false },
    seekOnStart: 0
  };

  var ASPECTS = ['PLAYER_DISPLAY_MODE_LETTER_BOX', 'PLAYER_DISPLAY_MODE_FULL_SCREEN'];
  var ASPECT_LABEL = ['screen.fit', 'screen.fill'];

  /* shortens long Xtream URLs for display: .../live/u/p/12345.m3u8 -> 12345.m3u8 */
  function shortUrl(u) {
    if (!u) return '';
    var i = u.lastIndexOf('/');
    return i >= 0 ? u.substring(i + 1) : u;
  }

  /* user-selectable buffer depth (Settings), with a safe range */
  function bufferSec() {
    var n = parseInt(Store.settings.bufferSec, 10);
    if (!n || n < 1) n = BUFFER_DEFAULT;
    if (n > 20) n = 20;
    return n;
  }
  /* start buffer: half of it, but never less than 2 s nor more than 4 s */
  function bufferPlaySec() {
    return Math.max(2, Math.min(4, Math.round(bufferSec() / 2)));
  }

  function hasAV() {
    return typeof webapis !== 'undefined' && webapis && webapis.avplay;
  }
  function safeState() {
    try { return hasAV() ? av().getState() : 'tarayici'; } catch (e) { return 'okunamadi'; }
  }
  function av() { return webapis.avplay; }
  function vid() { return U.$('av-fallback'); }

  /* ---------------- backend: AVPlay or <video> ---------------- */

  function engineOpen(url, cb) {
    if (hasAV()) {
      try { av().close(); } catch (e) { }
      /* On some streams prepareAsync never calls back at all - neither success nor
         error (for example on the .m3u8 candidate when the provider serves no HLS).
         Time it out and move on to the next candidate URL. */
      var settled = false;
      var guard = setTimeout(function () {
        if (settled) return;
        settled = true;
        cb(new Error(T('err.prepareTimeout')));
      }, 10000);
      function settle(err) {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        cb(err);
      }
      try {
        Log.line('open() ' + url);
        av().open(url);
        Log.line('open OK, state=' + safeState());
        av().setDisplayRect(0, 0, 1920, 1080);
        Log.line('setDisplayRect OK');
        /* buffering thresholds, in seconds, for initial play and for resume */
        try {
          av().setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', bufferPlaySec());
          av().setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', bufferSec());
          Log.line('setBufferingParam play=' + bufferPlaySec() + 's resume=' + bufferSec() + 's OK');
        } catch (ebuf) { Log.line('setBufferingParam not supported: ' + ebuf); }
        /* some IPTV providers reject unknown clients */
        try { av().setStreamingProperty('USER_AGENT', 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36'); } catch (eua) { }
        if (/\.m3u8(\?|$)/i.test(url)) {
          try { av().setStreamingProperty('ADAPTIVE_INFO', 'BITRATES=|STARTBITRATE=LOWEST'); } catch (ead) { }
        }
        av().setListener({
          onbufferingstart: function () { Log.line('bufferingstart'); showSpinner(true, T('player.buffering')); },
          onbufferingprogress: function (p) { showSpinner(true, T('player.bufferingPct', { p: p })); },
          onbufferingcomplete: function () { Log.line('bufferingcomplete, state=' + safeState()); showSpinner(false); },
          oncurrentplaytime: function (ms) { onTime(ms); },
          onstreamcompleted: function () { Log.line('streamcompleted'); onEnded(); },
          onevent: function (type, data) {
            Log.line('event: ' + type + (data ? ' / ' + data : ''));
            if (type === 'PLAYER_MSG_RESOLUTION_CHANGED') refreshTracks();
          },
          onsubtitlechange: function (duration, text) { onSubtitle(duration, text); },
          onerror: function (err) {
            Log.line('AVPLAY ERROR: ' + String(err) + ' state=' + safeState());
            settled ? onError(String(err)) : settle(new Error(String(err)));
          }
        });
        Log.line('calling prepareAsync');
        av().prepareAsync(function () {
          Log.line('prepare OK, state=' + safeState());
          try { av().setDisplayMethod(ASPECTS[st.aspect]); } catch (e1) { Log.line('setDisplayMethod failed: ' + e1); }
          /* AVPlay auto-selects a text track on open and, when it cannot decode the
             payload, paints an empty glyph box on screen. Keep the TV subtitle
             layer off until the user picks a track. */
          try { av().setSilentSubtitle(true); Log.line('TV subtitle layer disabled at start'); }
          catch (e2) { Log.line('setSilentSubtitle(true) failed: ' + e2); }
          settle(null);
        }, function (e) { Log.line('prepare FAILED: ' + String(e)); settle(new Error(String(e))); });
      } catch (e3) { Log.line('open/prepare threw: ' + e3); settle(e3); }
      return;
    }
    /* browser fallback */
    var v = vid();
    document.documentElement.className += ' fallback';
    v.src = url;
    v.onloadedmetadata = function () { cb(null); };
    v.onerror = function () { cb(new Error('video error')); };
    v.ontimeupdate = function () { onTime(v.currentTime * 1000); };
    v.onended = function () { onEnded(); };
    v.onwaiting = function () { showSpinner(true, T('player.loading')); };
    v.onplaying = function () { showSpinner(false); };
    try { v.load(); } catch (e4) { }
  }

  function enginePlay() {
    if (hasAV()) { try { av().play(); } catch (e) { } }
    else { try { vid().play(); } catch (e2) { } }
    st.playing = true;
  }
  function enginePause() {
    if (hasAV()) { try { av().pause(); } catch (e) { } }
    else { try { vid().pause(); } catch (e2) { } }
    st.playing = false;
  }
  function engineClose() {
    if (hasAV()) { try { av().stop(); } catch (e) { } try { av().close(); } catch (e1) { } }
    else { var v = vid(); try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e2) { } }
    st.playing = false;
  }
  function engineSeek(ms) {
    if (ms < 0) ms = 0;
    if (st.dur && ms > st.dur - 3000) ms = Math.max(0, st.dur - 3000);
    if (hasAV()) { try { av().seekTo(ms); } catch (e) { } }
    else { try { vid().currentTime = ms / 1000; } catch (e2) { } }
    st.cur = ms;
    paintSeek();
  }
  function engineDuration() {
    if (hasAV()) { try { return av().getDuration() || 0; } catch (e) { return 0; } }
    var d = vid().duration;
    return (d && isFinite(d)) ? d * 1000 : 0;
  }

  /* ---------------- track handling ---------------- */

  function parseExtra(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (e) { }
    /* some firmware returns plain text instead of JSON */
    var o = {}, parts = String(raw).split(/[,;]/), i, kv;
    for (i = 0; i < parts.length; i++) {
      kv = parts[i].split(/[:=]/);
      if (kv.length === 2) o[kv[0].replace(/["\s]/g, '')] = kv[1].replace(/["\s]/g, '');
    }
    return o;
  }

  function trackLabel(info, i, kind) {
    var x = parseExtra(info.extra_info);
    var lang = x.language || x.track_lang || x.lang || x.Language || '';
    var name = U.langName(lang);
    var extra = [];
    if (kind === 'AUDIO') {
      if (x.channels && parseInt(x.channels, 10) > 2) extra.push(x.channels + 'ch');
      if (x.codec) extra.push(String(x.codec).toUpperCase());
      if (x.audio_codec) extra.push(String(x.audio_codec).toUpperCase());
    } else {
      /* subtitle_type -1 carries no meaning, do not show it */
      var stype = x.subtitle_type || x.type || '';
      if (stype && stype !== '-1') extra.push(String(stype).toUpperCase());
      if (x.fourCC) extra.push(String(x.fourCC).replace('text/', ''));
      if (/forced/i.test(JSON.stringify(x))) extra.push(T('track.forced'));
    }
    if (!name) name = (kind === 'AUDIO' ? T('track.audio', { n: i + 1 }) : T('track.text', { n: i + 1 }));
    return { title: name, tag: extra.join(' ') };
  }

  function refreshTracks() {
    st.audio = []; st.text = [];
    if (hasAV()) {
      var list = [];
      try { list = av().getTotalTrackInfo() || []; } catch (e) { list = []; Log.line('getTotalTrackInfo failed: ' + e); }
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        var type = String(t.type || '').toUpperCase();
        if (type === 'AUDIO') {
          var la = trackLabel(t, st.audio.length, 'AUDIO');
          st.audio.push({ index: t.index, title: la.title, tag: la.tag });
        } else if (type === 'TEXT') {
          var lt = trackLabel(t, st.text.length, 'TEXT');
          st.text.push({ index: t.index, title: lt.title, tag: lt.tag });
        }
      }
      if (st.audio.length && st.audioSel < 0) st.audioSel = 0;
    } else {
      var v = vid(), j;
      if (v.audioTracks) for (j = 0; j < v.audioTracks.length; j++)
        st.audio.push({ index: j, title: U.langName(v.audioTracks[j].language) || ('Ses ' + (j + 1)), tag: '' });
      if (v.textTracks) for (j = 0; j < v.textTracks.length; j++)
        st.text.push({ index: j, title: U.langName(v.textTracks[j].language) || ('Altyazi ' + (j + 1)), tag: '' });
      if (st.audio.length && st.audioSel < 0) st.audioSel = 0;
    }
    paintCtls();
  }

  function selectAudio(i) {
    if (i < 0 || i >= st.audio.length) return;
    st.audioSel = i;
    if (hasAV()) {
      try { av().setSelectTrack('AUDIO', st.audio[i].index); }
      catch (e) { toast(T('player.audioFailed')); return; }
    } else {
      var v = vid();
      if (v.audioTracks) for (var k = 0; k < v.audioTracks.length; k++)
        v.audioTracks[k].enabled = (k === st.audio[i].index);
    }
    toast(T('player.audioSet', { name: st.audio[i].title }));
    paintCtls();
  }

  /* Path that uses the TV's own subtitle engine (only when file extraction failed) */
  function selectText(i) {
    /* i = -1 -> subtitles off */
    st.textSel = i;
    st.subMode = (i < 0) ? 'off' : 'av';
    st.subCues = null;
    setSubtitleText('');
    showSpinner(false);          /* keep the spinner from sticking when the track changes */
    if (hasAV()) {
      try {
        if (i < 0) {
          av().setSilentSubtitle(true);
          Log.line('subtitles turned off');
        } else {
          /* on some firmware a track switch only takes effect while playing */
          if (safeState() !== 'PLAYING') {
            Log.line('calling play() before selecting a subtitle track');
            enginePlay();
          }
          Log.line('setSilentSubtitle(false) first');
          av().setSilentSubtitle(false);
          Log.line('setSelectTrack TEXT index=' + st.text[i].index + ' state=' + safeState());
          av().setSelectTrack('TEXT', st.text[i].index);
          Log.line('setSelectTrack OK, state=' + safeState());

          st.subGotText = false;
          st.subEvents = 0;
          st.subTries = 0;
          armSubProbe(i);
        }
      } catch (e) { Log.line('subtitle selection FAILED: ' + e); toast(T('player.subsFailed')); return; }
    } else {
      var v = vid();
      if (v.textTracks) for (var k = 0; k < v.textTracks.length; k++)
        v.textTracks[k].mode = (i >= 0 && k === st.text[i].index) ? 'showing' : 'disabled';
    }
    toast(i < 0 ? T('player.subsOff') : T('player.subsSet', { name: st.text[i].title }));
    paintCtls();
  }

  /* The TV subtitle layer paints an empty box when it cannot decode a track, so
     a track that produces nothing has to be switched off again. Telling that
     apart from a stretch of film with no dialogue is the tricky part: waiting a
     few seconds and giving up was wrong, which is why subtitles "only worked
     after seeking and trying again" - the seek simply landed near a cue.

     So: cues with real text  -> keep it on;
         cues that are all empty -> the track truly cannot be decoded, switch off;
         nothing at all -> probably just silence. Re-issue the track selection
         (some firmware ignores it right after playback starts) and wait again,
         for SUB_PROBE_TRIES rounds before giving up. */
  function armSubProbe(i) {
    if (st.subProbeTimer) clearTimeout(st.subProbeTimer);
    st.subProbeTimer = setTimeout(function () {
      st.subProbeTimer = null;
      if (st.subMode !== 'av' || st.textSel !== i) return;   /* changed meanwhile */
      if (st.subGotText) { Log.line('subtitle text is arriving, keeping the TV layer on'); return; }
      if (st.subEvents === 0 && ++st.subTries < SUB_PROBE_TRIES) {
        Log.line('no subtitle cue yet (try ' + st.subTries + '), re-selecting the track');
        try {
          av().setSilentSubtitle(false);
          av().setSelectTrack('TEXT', st.text[i].index);
        } catch (e) { Log.line('re-select failed: ' + e); }
        armSubProbe(i);
        return;
      }
      Log.line('giving up on the TV subtitle track: events=' + st.subEvents + ' tries=' + st.subTries);
      try { av().setSilentSubtitle(true); } catch (e2) { }
      setSubtitleText('');
      st.textSel = -1;
      st.subMode = 'off';
      paintCtls();
      toast(T(st.subEvents > 0 ? 'player.subsUndecodable' : 'player.subsNoText'));
    }, SUB_PROBE_MS);
  }

  function setSubtitleText(t) {
    var box = U.$('subtitle-text');
    if (!t) {
      box.innerHTML = '';
      box.style.display = 'none';        /* stop an empty box from showing as a thick bar */
      return;
    }
    box.innerHTML = U.esc(t).replace(/\n/g, '<br>');
    box.style.display = 'inline-block';
  }

  /* ---------------- subtitles extracted from the file (mov_text) ---------------- */

  function subtitlesOff() {
    if (st.subProbeTimer) { clearTimeout(st.subProbeTimer); st.subProbeTimer = null; }
    st.subMode = 'off';
    st.subCues = null;
    st.subSession = null;
    if (st.subWinTimer) { clearInterval(st.subWinTimer); st.subWinTimer = null; }
    showSubStatus('');
    st.textSel = -1;
    st.subTrackIdx = -1;
    if (hasAV()) { try { av().setSilentSubtitle(true); } catch (e) { } }
    setSubtitleText('');
    paintCtls();
    toast(T('player.subsOff'));
  }

  /* Scans the subtitle tracks of the current file (movies and series only) */
  function scanFileSubtitles() {
    if (st.live || !st.item) return;
    if (st.mp4Scan === 'running' || st.mp4Scan === 'done') return;
    if (!/\.mp4(\?|$)/i.test(st.item.u)) { st.mp4Scan = 'failed'; return; }
    st.mp4Scan = 'running';
    Log.line('started scanning the file for subtitle tracks');
    Subs.listTracks(st.item.u, function (msg) {
      if (st.menu === 'text') paintMenu();
    }, function (err, tracks, finalUrl) {
      if (err || !tracks || !tracks.length) {
        st.mp4Scan = 'failed';
        Log.line('subtitle scan failed: ' + (err ? err.message : 'no tracks'));
        if (st.menu === 'text') paintMenu();
        return;
      }
      /* put long tracks first; short ones are usually forced/sign subtitles */
      tracks.sort(function (a, b) { return b.count - a.count; });
      st.mp4Tracks = tracks;
      st.mp4Url = finalUrl || st.item.u;
      st.mp4Scan = 'done';
      Log.line(tracks.length + ' subtitle track(s) in the file: ' +
               tracks.map(function (t) { return (t.lang || '?') + '/' + t.count; }).join(' '));
      if (st.menu === 'text') paintMenu();
    });
  }

  function cacheKey(track) {
    return 'subs:' + (st.item ? st.item.u : '') + ':' + track.lang + ':' + track.count;
  }

  function useFileSubtitle(i) {
    var track = st.mp4Tracks[i];
    if (!track) return;
    st.subMode = 'mp4';
    st.subTrackIdx = i;
    st.textSel = -1;
    if (hasAV()) { try { av().setSilentSubtitle(true); } catch (e) { } }   /* keep the TV layer off */
    setSubtitleText('');
    paintCtls();

    var label = U.langName(track.lang) || 'Altyazi';

    Store.getCache(cacheKey(track), function (err, rec) {
      if (!err && rec && rec.cues && rec.cues.length && rec.complete) {
        st.subCues = rec.cues;
        Log.line('subtitles from cache: ' + rec.cues.length + ' cues');
        toast(T('player.subsSet', { name: label }));
        return;
      }

      /* Windowed download: the area around the current position first, then ahead
         of it. The wait is a few seconds and fetching follows playback. */
      toast(T('player.subsPreparing', { name: label }));
      Log.line('subtitle session, track=' + track.lang + ' samples=' + track.count);
      var ses = Subs.createSession(st.mp4Url, track);
      st.subSession = ses;
      ses.setOnCues(function (cues, done, total) {
        if (st.subMode !== 'mp4' || st.subTrackIdx !== i) return;
        st.subCues = cues;
        var p = ses.progress();
        showSubStatus(p.done >= p.total ? '' : 'Altyazi %' + Math.round(p.done / p.total * 100));
        if (p.done >= p.total) {
          Log.line('subtitles complete: ' + cues.length + ' cues');
          Store.putCache(cacheKey(track), { cues: cues, complete: true, ts: Date.now() }, function () { });
        }
      });
      ses.ensure(Math.max(0, st.cur - 30000), st.cur + WINDOW_MS);
      showSubStatus(T('player.subsPreparing', { name: label }));
      /* extend the window as playback advances */
      if (st.subWinTimer) clearInterval(st.subWinTimer);
      st.subWinTimer = setInterval(function () {
        if (st.subMode !== 'mp4' || !st.subSession) return;
        var added = st.subSession.ensure(st.cur, st.cur + WINDOW_MS);
        if (!added && st.subSession.progress().done > 0) st.subSession.fillRest();
      }, 5000);
    });
  }

  /* Subtitle download progress is not shown to the user by request; it only
     goes to the log. The screen element stays in place in case it is needed. */
  function showSubStatus(msg) {
    var e = U.$('sub-status');
    if (e) e.className = 'hidden';
    if (msg) Log.line('subtitle status: ' + msg);
  }

  /* draw the file-extracted subtitle matching the current playback time */
  function renderFileSubtitle(ms) {
    if (st.pip) { if (st.lastCueText) { st.lastCueText = ''; setSubtitleText(''); } return; }
    if (st.subMode !== 'mp4' || !st.subCues || !st.subCues.length) return;
    var cue = Subs.cueAt(st.subCues, ms);
    var text = cue ? cue.text : '';
    if (text !== st.lastCueText) {
      st.lastCueText = text;
      setSubtitleText(text);
    }
  }

  function onSubtitle(duration, text) {
    Log.line('onsubtitlechange sure=' + duration + ' metin=' + JSON.stringify(String(text)).substring(0, 120));
    if (st.textSel < 0) return;
    st.subEvents++;
    var t = String(text === undefined || text === null ? '' : text);
    /* some firmware sends an empty cue as a single NUL character */
    t = t.split(String.fromCharCode(0)).join('');
    t = t.replace(/<[^>]*>/g, '').replace(/\\N|\\n/g, '\n').replace(/\{[^}]*\}/g, '').trim();
    if (t) st.subGotText = true;
    setSubtitleText(t);
    if (st.subTimer) clearTimeout(st.subTimer);
    var d = parseInt(duration, 10);
    if (!d || d < 300 || d > 15000) d = 4000;
    st.subTimer = setTimeout(function () { setSubtitleText(''); }, d);
  }

  /* ---------------- events ---------------- */

  function onTime(ms) {
    /* if playback is advancing, the spinner must not stay on screen */
    if (ms > 0 && ms !== st.cur) { st.lastTimeAt = Date.now(); showSpinner(false); }
    renderFileSubtitle(ms);
    st.cur = ms;
    if (!st.dur && !st.live) st.dur = engineDuration();
    paintSeek();
  }

  /* Watchdog, one tick per second while a stream is open. It covers two cases:
     - prepareAsync succeeded but no picture ever arrives -> try the next URL;
     - the picture was flowing and the playback clock froze mid-stream -> the
       stream is reconnected in place instead of dropping the user into the
       error dialog. Live reconnects at the live edge, VOD at the last
       position. */
  function startWatch() {
    stopWatch();
    st.openedAt = Date.now();
    st.pollTimer = setInterval(watchTick, 1000);
  }
  function stopWatch() {
    if (st.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = null; }
  }
  function watchTick() {
    if (!st.ready || st.recovering || !st.playing || st.scrub.active) return;
    var now = Date.now();
    if (!st.lastTimeAt) {
      if (now - st.openedAt > NOPIC_MS) { stopWatch(); onError(T('err.noPicture')); }
      return;
    }
    var idle = now - st.lastTimeAt;
    /* tell the user what is happening before doing anything drastic */
    if (idle > 2500) showSpinner(true, T('player.buffering'), true);
    if (idle > STALL_MS) recoverStall('clock frozen ' + Math.round(idle / 1000) + 's');
  }

  /* Silent reconnect. Gives up after MAX_RECOVER attempts in a row; a stream
     that ran fine for two minutes gets a fresh set of attempts. */
  function recoverStall(why) {
    if (st.recovering || !st.item) return;
    if (st.lastRecoverAt && Date.now() - st.lastRecoverAt > 120000) st.stalls = 0;
    if (st.stalls >= MAX_RECOVER) {
      stopWatch();
      showSpinner(false);
      try { if (hasAV()) av().close(); } catch (e) { }
      diagnose(st.lastError || T('err.stalled'));
      return;
    }
    st.stalls++;
    st.lastRecoverAt = Date.now();
    st.recovering = true;
    stopWatch();
    Log.line('stall recovery #' + st.stalls + ': ' + why);
    showSpinner(true, T('player.reconnecting'), true);
    var resumeAt = st.live ? 0 : st.cur;
    engineClose();
    setTimeout(function () {
      st.recovering = false;
      if (!st.item) return;              /* the user left the player meanwhile */
      st.seekOnStart = resumeAt;
      st.cur = 0; st.lastTimeAt = 0; st.ready = false;
      openCurrent();
    }, Math.min(1000 * st.stalls, 4000));
  }

  function onEnded() {
    if (st.item) Store.setResume(st.item.u, 0, st.dur);
    if (st.list && st.listIdx >= 0 && st.listIdx < st.list.length - 1) {
      toast(T('player.nextEpisode'));
      var next = st.list[st.listIdx + 1];
      st.listIdx++;
      start(next);
      return;
    }
    exit();
  }

  function onError(msg) {
    st.lastError = msg || '';
    /* try the next candidate URL (but not once the stream has started playing) */
    if (st.cur === 0 && st.candIdx < st.cands.length - 1) {
      st.candIdx++;
      openCurrent();
      return;
    }
    /* the stream was running and the provider dropped it: reconnect quietly */
    if (st.lastTimeAt > 0 && st.stalls < MAX_RECOVER) {
      recoverStall('avplay error: ' + st.lastError);
      return;
    }
    stopWatch();
    showSpinner(false);
    try { if (hasAV()) av().close(); } catch (e) { }
    diagnose(msg);
  }

  /* When a stream will not open, probe the URLs over HTTP from the TV itself.
     This shows whether the problem is the address (404/302) or the format
     (raw TS / HLS / an HTML error page). */
  function probe(url, cb) {
    /* Live endpoints may reject a Range request with 405, so issue a plain GET
       and abort as soon as the first bytes arrive. */
    var xhr = new XMLHttpRequest();
    var done = false, status = 0, ctype = '', head = '';
    function finish(line) {
      if (done) return;
      done = true;
      try { xhr.abort(); } catch (e) { }
      cb(line);
    }
    function sniff(body) {
      if (!body) return 'empty body';
      if (body.charAt(0) === 'G') return 'MPEG-TS (raw)';
      if (body.indexOf('#EXTM3U') >= 0) return 'HLS playlist';
      if (body.charAt(0) === '<') return 'HTML / error page';
      if (body.indexOf('ftyp') >= 0) return 'MP4';
      return 'unknown data';
    }
    try { xhr.open('GET', url, true); } catch (e) { finish('open failed: ' + e); return; }
    xhr.timeout = 12000;
    xhr.onreadystatechange = function () {
      if (done) return;
      if (xhr.readyState === 2) {
        status = xhr.status;
        try { ctype = xhr.getResponseHeader('Content-Type') || ''; } catch (e2) { }
        if (status >= 400) finish(T('err.httpStatus', { code: status }) + ' | ' + ctype);
        return;
      }
      if (xhr.readyState === 3 || xhr.readyState === 4) {
        try { head = String(xhr.responseText || '').substring(0, 64); } catch (e3) { }
        if (head || xhr.readyState === 4) {
          finish('HTTP ' + (status || xhr.status) + ' | ' + (ctype || '?') + ' | ' + sniff(head));
        }
      }
    };
    xhr.onerror = function () { finish(T('err.network')); };
    xhr.ontimeout = function () { finish(T('err.timeout')); };
    try { xhr.send(); } catch (e5) { finish('send failed: ' + e5); }
  }

  function diagnose(lastErr) {
    var state = 'bilinmiyor';
    try { if (hasAV()) state = av().getState(); } catch (e) { state = 'okunamadi'; }

    var head = T('dlg.playFailed.listed') + '\n' + (st.item ? st.item.u : '') +
      '\n\nAVPlay: ' + (hasAV() ? 'yes' : 'no') + '   state: ' + state +
      '\n' + T('dlg.playFailed.lastError', { err: lastErr || T('err.unknown') }) + '\n\n' + T('dlg.playFailed.tried');
    var lines = [];
    var acts = [{ label: T('dlg.retry'), act: function () {
      st.candIdx = 0; st.cur = 0; st.lastTimeAt = 0; st.stalls = 0; openCurrent();
    } }];
    /* the valid value for Xtream get.php is "m3u8", not "hls" */
    if (App.currentOutput() !== 'm3u8') {
      acts.push({ label: T('dlg.tryHls'), act: function () { exit(); App.switchOutput('m3u8'); } });
    } else {
      acts.push({ label: T('dlg.tryTs'), act: function () { exit(); App.switchOutput('mpegts'); } });
    }
    acts.push({ label: T('dlg.close'), act: function () { exit(); } });
    UI.modal(T('dlg.playFailed.title'), head + '\n' + T('dlg.playFailed.testing'), acts);

    var i = 0;
    function next() {
      if (i >= st.cands.length) return;
      var u = st.cands[i];
      probe(u, function (res) {
        lines.push(shortUrl(u) + '  ->  ' + res);
        UI.modalText(head + '\n' + lines.join('\n'));
        i++;
        next();
      });
    }
    next();
  }

  /* ---------------- rendering ---------------- */

  /* The spinner appears only while actually waiting.
     On some streams AVPlay keeps firing buffering events during playback, so it
     stays hidden if the playback clock advanced within the last 1.5 seconds, and
     it hides itself after 8 seconds no matter what. */
  function showSpinner(on, text, force) {
    var s = U.$('spinner');
    if (on) {
      /* Once the stream is flowing, AVPlay's own buffering events no longer
         put the spinner back on screen - only the watchdog does, which passes
         force, so a real stall is still visible. */
      if (st.lastTimeAt > 0 && !force) return;
      Log.line('spinner shown: ' + (text || ''));
      U.$('spinner-text').innerHTML = U.esc(text || T('player.loading'));
      s.className = '';
      if (st.spinTimer) clearTimeout(st.spinTimer);
      st.spinTimer = setTimeout(function () { st.spinTimer = null; U.$('spinner').className = 'hidden'; }, 8000);
    } else {
      if (st.spinTimer) { clearTimeout(st.spinTimer); st.spinTimer = null; }
      s.className = 'hidden';
    }
  }

  var toastTimer = null;
  function toast(msg) {
    var t = U.$('toast');
    U.$('toast-text').innerHTML = U.esc(msg);
    t.className = '';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'hidden'; }, 2200);
  }

  /* ---------------- scrubbing ----------------
     Instead of asking the server for a new position on every key press, the
     target is moved on screen and a single seek is issued 700 ms after the last
     press. Jumping back 30 seconds no longer costs a 10-second wait. */
  function scrubBy(deltaSec) {
    if (st.live) { toast(T('player.noSeekLive')); return; }
    if (!st.dur) { toast(T('player.noDuration')); return; }

    var now = Date.now();
    if (!st.scrub.active) {
      st.scrub.active = true;
      st.scrub.pos = st.cur;
      st.scrub.wasPlaying = st.playing;
      st.scrub.streak = 0;
      if (st.playing) enginePause();       /* pause the stream while scrubbing */
    }
    /* repeated presses grow the step: 10s -> 30s -> 60s */
    st.scrub.streak = (now - st.scrub.last < 450) ? st.scrub.streak + 1 : 0;
    st.scrub.last = now;
    var mult = st.scrub.streak > 8 ? 6 : (st.scrub.streak > 4 ? 3 : 1);

    st.scrub.pos += deltaSec * 1000 * mult;
    if (st.scrub.pos < 0) st.scrub.pos = 0;
    if (st.scrub.pos > st.dur - 3000) st.scrub.pos = Math.max(0, st.dur - 3000);

    paintSeek();
    if (st.scrub.timer) clearTimeout(st.scrub.timer);
    st.scrub.timer = setTimeout(commitScrub, 700);
    poke();
  }

  function commitScrub() {
    if (st.scrub.timer) { clearTimeout(st.scrub.timer); st.scrub.timer = null; }
    if (!st.scrub.active) return;
    var target = st.scrub.pos;
    st.scrub.active = false;
    Log.line('seek to: ' + Math.round(target / 1000) + 's');
    engineSeek(target);
    st.lastCueText = null;                  /* force the subtitle to refresh at the new position */
    if (st.scrub.wasPlaying) enginePlay();
    paintCtls();
  }

  function paintSeek() {
    if (st.live) {
      U.$('pl-cur').innerHTML = 'CANLI';
      U.$('pl-dur').innerHTML = U.clock();
      U.$('seek-fill').style.width = '100%';
      U.$('seek-knob').style.left = '100%';
      return;
    }
    var shown = st.scrub.active ? st.scrub.pos : st.cur;
    var pct = st.dur > 0 ? Math.min(100, (shown / st.dur) * 100) : 0;
    U.$('pl-cur').innerHTML = U.fmtTime(shown);
    U.$('pl-dur').innerHTML = U.fmtTime(st.dur);
    U.$('seek-fill').style.width = pct + '%';
    U.$('seek-knob').style.left = pct + '%';

    /* show how far the scrub has moved */
    var d = U.$('seek-delta');
    if (st.scrub.active) {
      var diff = Math.round((st.scrub.pos - st.cur) / 1000);
      d.innerHTML = (diff >= 0 ? '+' : '') + U.fmtTime(Math.abs(diff) * 1000).replace(/^00:/, '') ;
      d.style.left = Math.max(0, Math.min(96, pct)) + '%';
      d.className = '';
    } else {
      d.className = 'hidden';
    }
  }

  function buildCtls() {
    st.ctls = [];
    if (!st.live) st.ctls.push({ id: 'seek', seek: true });
    st.ctls.push({ id: 'playpause' });
    if (!st.live) { st.ctls.push({ id: 'back10' }); st.ctls.push({ id: 'fwd10' }); }
    st.ctls.push({ id: 'audio' });
    st.ctls.push({ id: 'text' });
    st.ctls.push({ id: 'subsize' });
    st.ctls.push({ id: 'aspect' });
    st.ctls.push({ id: 'fav' });
    st.focus = st.live ? 0 : 1;   /* default focus: play/pause */
    paintCtls();
  }

  /* ---------------- control icons ----------------
     Single-colour line SVGs. They use currentColor, so they pick up the focus
     colour automatically. */
  var SVG = {
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>',
    back10: '<path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/>' +
            '<text x="12" y="17" font-size="8" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">10</text>',
    fwd10: '<path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/>' +
           '<text x="12" y="17" font-size="8" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">10</text>',
    audio: '<path d="M4 9v6h4l5 4V5L8 9H4z"/>' +
           '<path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    text: '<rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
          '<path d="M6.5 14.5h5M13.5 14.5h4M6.5 10.5h3M11.5 10.5h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    size: '<text x="12" y="17" font-size="13" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">Aa</text>',
    aspect: '<rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
            '<path d="M7 9v6M17 9v6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".6"/>',
    star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9z"/>',
    starOff: '<path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'
  };

  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="currentColor">' + (SVG[name] || '') + '</svg>';
  }

  function ctlIcon(c) {
    switch (c.id) {
      case 'playpause': return st.playing ? 'pause' : 'play';
      case 'back10': return 'back10';
      case 'fwd10': return 'fwd10';
      case 'audio': return 'audio';
      case 'text': return 'text';
      case 'subsize': return 'size';
      case 'aspect': return 'aspect';
      case 'fav': return (st.item && Store.isFav(st.item.u)) ? 'star' : 'starOff';
    }
    return '';
  }

  function ctlLabel(c) {
    switch (c.id) {
      case 'playpause': return { t: st.playing ? T('ctl.pause') : T('ctl.play'), s: '' };
      case 'back10': return { t: T('ctl.back10'), s: '' };
      case 'fwd10': return { t: T('ctl.fwd10'), s: '' };
      case 'audio': return { t: T('ctl.audio'), s: st.audioSel >= 0 && st.audio[st.audioSel] ? st.audio[st.audioSel].title : T('value.none') };
      case 'text':
        if (st.subMode === 'mp4' && st.mp4Tracks && st.mp4Tracks[st.subTrackIdx]) {
          return { t: T('ctl.subtitle'), s: U.langName(st.mp4Tracks[st.subTrackIdx].lang) || T('value.on') };
        }
        if (st.subMode === 'av' && st.text[st.textSel]) return { t: T('ctl.subtitle'), s: st.text[st.textSel].title };
        return { t: T('ctl.subtitle'), s: T('value.off') };
      case 'subsize': return { t: T('ctl.size'), s: T('size.' + (Store.settings.subSize || 'normal')) };
      case 'aspect': return { t: T('ctl.screen'), s: T(ASPECT_LABEL[st.aspect]) };
      case 'fav': return { t: st.item && Store.isFav(st.item.u) ? T('ctl.faved') : T('ctl.fav'), s: '' };
    }
    return { t: '', s: '' };
  }

  function paintCtls() {
    var row = U.$('ctl-row');
    row.innerHTML = '';
    for (var i = 0; i < st.ctls.length; i++) {
      var c = st.ctls[i];
      if (c.seek) continue;
      var lab = ctlLabel(c);
      var focused = (i === st.focus);
      var on = (c.id === 'fav' && st.item && Store.isFav(st.item.u)) ||
               (c.id === 'text' && st.subMode !== 'off');
      /* only the focused button shows a text label; the rest are icon-only */
      var e = U.el('div', 'ctl' + (focused ? ' focus' : '') + (on ? ' on' : ''),
        icon(ctlIcon(c)) +
        (focused ? '<span class="ctl-label">' + U.esc(lab.t) + (lab.s ? ' · ' + U.esc(lab.s) : '') + '</span>' : ''));
      row.appendChild(e);
    }
    var seekRow = U.$('seek-row');
    seekRow.className = 'seek-row' + (st.ctls[st.focus] && st.ctls[st.focus].seek ? ' focus' : '');
    seekRow.style.display = st.live ? 'none' : 'flex';
  }

  function showBar(on) {
    st.barVisible = on;
    U.$('controls').className = 'fade' + (on ? ' show' : '');
    U.$('player-top').className = 'fade' + (on ? ' show' : '');
    U.$('subtitle-layer').className = subClass() + (on ? ' raised' : '');
    if (st.hideTimer) { clearTimeout(st.hideTimer); st.hideTimer = null; }
    if (on) st.hideTimer = setTimeout(function () { if (!st.menu) showBar(false); }, HIDE_MS);
  }

  function subClass() {
    var s = Store.settings.subSize;
    return s === 'small' ? 's-small' : (s === 'large' ? 's-large' : '');
  }

  function poke() { showBar(true); }

  /* ---------------- menus ---------------- */

  function openMenu(kind) {
    st.menu = kind;
    st.menuIdx = 0;
    st.menuOff = 0;
    var items = menuItems(kind);
    if (!items.length) { st.menu = null; toast(kind === 'audio' ? T('player.noAudioTracks') : T('player.noSubTracks')); return; }
    if (kind === 'audio') st.menuIdx = Math.max(0, st.audioSel);
    if (kind === 'text') st.menuIdx = st.textSel + 1;
    paintMenu();
    U.$('track-menu').className = '';
    showBar(true);
  }

  function menuItems(kind) {
    var out = [], i;
    if (kind === 'audio') {
      for (i = 0; i < st.audio.length; i++) {
        out.push({ title: st.audio[i].title, tag: st.audio[i].tag, sel: i === st.audioSel, act: { t: 'av', i: i } });
      }
      return out;
    }

    out.push({ title: T('value.off'), tag: '', sel: st.subMode === 'off', act: { t: 'off' } });

    /* Tracks extracted from the file (AVPlay cannot decode their text, so we
       download the samples ourselves) */
    if (st.mp4Tracks && st.mp4Tracks.length) {
      for (i = 0; i < st.mp4Tracks.length; i++) {
        var tr = st.mp4Tracks[i];
        out.push({
          title: U.langName(tr.lang) || T('track.text', { n: i + 1 }),
          tag: T('menu.cues', { n: tr.count }),
          sel: st.subMode === 'mp4' && st.subTrackIdx === i,
          act: { t: 'mp4', i: i }
        });
      }
    } else if (st.mp4Scan === 'running') {
      out.push({ title: T('menu.scanning'), tag: '', sel: false, act: { t: 'none' } });
    } else if (st.mp4Scan === 'failed' && st.text.length) {
      /* extraction failed, fall back to the TV's own tracks */
      for (i = 0; i < st.text.length; i++) {
        out.push({ title: st.text[i].title, tag: st.text[i].tag, sel: st.subMode === 'av' && st.textSel === i, act: { t: 'av', i: i } });
      }
    }
    if (out.length === 1 && st.mp4Scan !== 'running') return [];
    return out;
  }

  /* The track list can be long (one film had 13 subtitle tracks), so it needs
     scrolling that keeps the focused row visible. */
  var TM_STEP = 74, TM_VIEW = 518;

  function paintMenu() {
    var items = menuItems(st.menu);
    var list = U.$('tm-list');

    var top = st.menuIdx * TM_STEP;
    if (top < st.menuOff) st.menuOff = top;
    if (top + TM_STEP > st.menuOff + TM_VIEW) st.menuOff = top + TM_STEP - TM_VIEW;
    if (st.menuOff < 0) st.menuOff = 0;

    list.innerHTML = '';
    for (var i = 0; i < items.length; i++) {
      var y = i * TM_STEP - st.menuOff;
      if (y < -TM_STEP || y > TM_VIEW) continue;
      var e = U.el('div', 'tm' + (i === st.menuIdx ? ' focus' : ''),
        '<span>' + U.esc(items[i].title) + (items[i].sel ? ' •' : '') + '</span>' +
        '<span class="tm-tag">' + U.esc(items[i].tag) + '</span>');
      e.style.position = 'absolute';
      e.style.left = '0'; e.style.right = '0';
      e.style.top = y + 'px';
      e.style.height = (TM_STEP - 10) + 'px';
      list.appendChild(e);
    }
    /* scroll position indicator */
    var more = items.length * TM_STEP > TM_VIEW;
    U.$('tm-head').innerHTML = (st.menu === 'audio' ? T('menu.audio') : T('menu.subtitle')) +
      (more ? '  <span class="tm-count">' + (st.menuIdx + 1) + '/' + items.length + '</span>' : '');
  }

  function closeMenu() {
    st.menu = null;
    U.$('track-menu').className = 'hidden';
    showBar(true);
  }

  function menuSelect() {
    var items = menuItems(st.menu);
    var it = items[st.menuIdx];
    if (!it || !it.act) return;
    if (it.act.t === 'none') return;
    if (st.menu === 'audio') { selectAudio(it.act.i); closeMenu(); return; }
    if (it.act.t === 'off') { subtitlesOff(); closeMenu(); return; }
    if (it.act.t === 'mp4') { useFileSubtitle(it.act.i); closeMenu(); return; }
    selectText(it.act.i);
    closeMenu();
  }

  /* ---------------- playback flow ---------------- */

  function openCurrent() {
    st.url = st.cands[st.candIdx];
    st.ready = false;
    showSpinner(true, T('player.connecting', { i: st.candIdx + 1, n: st.cands.length, url: shortUrl(st.url) }));
    engineOpen(st.url, function (err) {
      if (err) { onError(err.message || String(err)); return; }
      st.ready = true;
      startWatch();
      showSpinner(false);
      st.dur = st.live ? 0 : engineDuration();
      enginePlay();
      Log.line('play() called, state=' + safeState());
      setTimeout(refreshTracks, 900);
      setTimeout(refreshTracks, 3000);
      /* for movies and series, scan subtitle tracks in the background so the menu is ready */
      setTimeout(scanFileSubtitles, 1500);
      /* the resume position is asked for in play() and applied here */
      if (st.seekOnStart > 0) {
        engineSeek(st.seekOnStart);
        st.seekOnStart = 0;
      }
      paintSeek(); paintCtls(); showBar(true);
    });
  }


  function start(item) {
    Log.line('open: ' + item.n + ' [' + item.k + ']');
    st.item = item;
    st.live = item.k === 'live';
    st.cands = M3U.candidates(item);
    st.lastTimeAt = 0;
    st.stalls = 0; st.lastRecoverAt = 0; st.recovering = false;
    st.mp4Scan = ''; st.mp4Tracks = null; st.mp4Url = '';
    st.subMode = 'off'; st.subTrackIdx = -1; st.subCues = null; st.lastCueText = null;
    st.subGotText = false; st.subEvents = 0; st.subTries = 0;
    if (st.subProbeTimer) { clearTimeout(st.subProbeTimer); st.subProbeTimer = null; }
    st.subSession = null;
    if (st.subWinTimer) { clearInterval(st.subWinTimer); st.subWinTimer = null; }
    showSubStatus('');
    st.candIdx = 0;
    st.dur = 0; st.cur = 0;
    st.audio = []; st.text = []; st.audioSel = -1; st.textSel = -1;
    setSubtitleText('');
    U.$('subtitle-layer').className = subClass();
    U.$('pl-title').innerHTML = U.esc(item.n);
    U.$('pl-sub').innerHTML = U.esc(item.g || '');
    buildCtls();
    openCurrent();
  }

  /* item, an optional playlist (series episodes) and an exit callback */
  function play(item, list, listIdx, onExit) {
    st.list = list || null;
    st.listIdx = (listIdx === undefined || listIdx === null) ? -1 : listIdx;
    st.onExit = onExit || null;
    /* coming from the list overlay: go full screen first */
    if (st.pip) {
      st.pip = false;
      document.documentElement.className = document.documentElement.className.replace(/ ?pip/g, '');
      UI.setPip(false);
    }
    setDisplay(0, 0, 1920, 1080);
    if (document.documentElement.className.indexOf('playing') < 0)
      document.documentElement.className += ' playing';
    UI.showScreen('scr-player');
    /* let one layout/paint pass happen before opening AVPlay; on some firmware
       open() would otherwise be called before the video layer is ready */
    /* For movies and series with a stored position, ask first: resume or restart? */
    var r = (item.k !== 'live') ? Store.getResume(item.u) : null;
    if (r && r.p > 15000) {
      UI.modal(T('dlg.resume.title'),
        T('dlg.resume.text', { name: item.n, time: U.fmtTime(r.p) }),
        [{ label: T('dlg.resume.continue', { time: U.fmtTime(r.p) }), act: function () { st.seekOnStart = r.p; startSoon(item); } },
         { label: T('dlg.resume.restart'), act: function () { st.seekOnStart = 0; startSoon(item); } }]);
      return;
    }
    st.seekOnStart = 0;
    startSoon(item);
  }

  function startSoon(item) {
    setTimeout(function () { start(item); }, 80);
    if (st.saveTimer) clearInterval(st.saveTimer);
    st.saveTimer = setInterval(function () {
      if (!st.live && st.item && st.cur > 0) Store.setResume(st.item.u, st.cur, st.dur);
    }, 10000);
  }

  /* ---------------- list overlay while playing ---------------- */

  /* Moves the video rectangle. Some firmware ignores setDisplayRect while
     playing; pause-set-resume works around that. */
  function setDisplay(x, y, w, h) {
    if (hasAV()) {
      var wasPlaying = (safeState() === 'PLAYING');
      try {
        if (wasPlaying) av().pause();
        av().setDisplayRect(x, y, w, h);
        try { av().setDisplayMethod(ASPECTS[st.aspect]); } catch (e1) { }
        if (wasPlaying) av().play();
        Log.line('display rect: ' + x + ',' + y + ' ' + w + 'x' + h + ' state=' + safeState());
      } catch (e) {
        Log.line('setDisplayRect failed: ' + e);
        try { if (wasPlaying) av().play(); } catch (e2) { }
      }
    } else {
      var v = vid();
      v.style.left = x + 'px'; v.style.top = y + 'px';
      v.style.width = w + 'px'; v.style.height = h + 'px';
    }
  }

  /* Return to the list without stopping playback: the video keeps playing FULL
     SCREEN and the channel list opens in a panel on the left, so the stream
     stays watchable on the right.

     Note: shrinking the picture into a corner (setDisplayRect) was tried first.
     The test model (QN85A / Tizen 6.0) silently ignores a rectangle change
     during playback - audio continues, no picture appears - and pause-set-resume
     did not help either, so only this layout remains. */
  function minimize() {
    if (!st.item) return;
    st.pip = true;
    showBar(false);
    closeMenu();
    setSubtitleText('');
    document.documentElement.className += ' pip';
    setDisplay(0, 0, 1920, 1080);
    Log.line('returned to the list, stream still playing');
    UI.setPip(true, PIP, st.item);
  }

  /* Bring the overlaid stream back to full screen */
  function maximize() {
    if (!st.item) return;
    st.pip = false;
    document.documentElement.className = document.documentElement.className.replace(/ ?pip/g, '');
    setDisplay(0, 0, 1920, 1080);
    UI.setPip(false);
    UI.showScreen('scr-player');
    paintCtls();
    showBar(true);
    Log.line('back to full screen');
  }

  function exit() {
    st.pip = false;
    document.documentElement.className = document.documentElement.className.replace(/ ?pip/g, '');
    UI.setPip(false);
    if (!st.live && st.item && st.cur > 0) Store.setResume(st.item.u, st.cur, st.dur);
    if (st.saveTimer) { clearInterval(st.saveTimer); st.saveTimer = null; }
    if (st.hideTimer) { clearTimeout(st.hideTimer); st.hideTimer = null; }
    st.recovering = false;
    stopWatch();
    if (st.subWinTimer) { clearInterval(st.subWinTimer); st.subWinTimer = null; }
    st.subSession = null;
    Log.line('closing the player');
    engineClose();
    showSpinner(false);
    closeMenu();
    document.documentElement.className =
      document.documentElement.className.replace(/ ?playing/g, '').replace(/ ?fallback/g, '');
    var cb = st.onExit;
    st.item = null; st.onExit = null;
    if (cb) cb();
  }

  function togglePlay() {
    if (st.playing) { enginePause(); toast(T('player.paused')); }
    else { enginePlay(); toast(T('player.playing')); }
    paintCtls();
  }

  function jump(sec) { scrubBy(sec); }

  function activate(c) {
    switch (c.id) {
      case 'playpause': togglePlay(); break;
      case 'back10': jump(-10); break;
      case 'fwd10': jump(10); break;
      case 'audio': openMenu('audio'); break;
      case 'text': openMenu('text'); break;
      case 'subsize':
        var order = ['small', 'normal', 'large'];
        var i = order.indexOf(Store.settings.subSize);
        Store.settings.subSize = order[(i + 1) % 3];
        Store.saveSettings();
        U.$('subtitle-layer').className = subClass() + (st.barVisible ? ' raised' : '');
        paintCtls();
        toast(T('player.subSizeSet', { size: ctlLabel({ id: 'subsize' }).s }));
        break;
      case 'aspect':
        st.aspect = (st.aspect + 1) % ASPECTS.length;
        if (hasAV()) { try { av().setDisplayMethod(ASPECTS[st.aspect]); } catch (e) { } }
        else { vid().style.objectFit = st.aspect === 1 ? 'cover' : 'contain'; }
        paintCtls();
        toast(T('player.screenSet', { mode: T(ASPECT_LABEL[st.aspect]) }));
        break;
      case 'fav':
        if (st.item) { var on = Store.toggleFav(st.item.u); toast(on ? T('player.favAdded') : T('player.favRemoved')); paintCtls(); }
        break;
    }
  }

  function key(code) {
    var K = KEY.CODE;

    /* while a menu is open every key goes to the menu */
    if (st.menu) {
      if (code === K.UP) { st.menuIdx = Math.max(0, st.menuIdx - 1); paintMenu(); }
      else if (code === K.DOWN) { st.menuIdx = Math.min(menuItems(st.menu).length - 1, st.menuIdx + 1); paintMenu(); }
      else if (code === K.ENTER) menuSelect();
      else if (code === K.BACK || code === K.EXIT) closeMenu();
      return;
    }

    switch (code) {
      case K.BACK:
      case K.EXIT:
        if (st.menu) { closeMenu(); return; }
        if (st.barVisible) { showBar(false); return; }
        /* Do not stop the stream: return to the channel list and keep watching */
        minimize();
        return;
      case K.UP:
      case K.DOWN:
        if (!st.barVisible) { poke(); return; }
        /* move between the seek row and the button row */
        if (code === K.UP && !st.live) st.focus = 0;
        else if (code === K.DOWN && st.focus === 0) st.focus = 1;
        paintCtls(); poke();
        return;
      case K.LEFT:
        if (!st.barVisible) { poke(); return; }
        if (st.ctls[st.focus] && st.ctls[st.focus].seek) { scrubBy(-10); return; }
        st.focus = Math.max(st.live ? 0 : 1, st.focus - 1);
        paintCtls(); poke();
        return;
      case K.RIGHT:
        if (!st.barVisible) { poke(); return; }
        if (st.ctls[st.focus] && st.ctls[st.focus].seek) { scrubBy(10); return; }
        st.focus = Math.min(st.ctls.length - 1, st.focus + 1);
        paintCtls(); poke();
        return;
      case K.ENTER:
        if (!st.barVisible) { poke(); return; }
        if (st.scrub.active) { commitScrub(); poke(); return; }   /* seek right away */
        if (st.ctls[st.focus] && st.ctls[st.focus].seek) { togglePlay(); poke(); return; }
        activate(st.ctls[st.focus]); poke();
        return;
      case K.PLAYPAUSE:
      case K.PLAY:
      case K.PAUSE:
        togglePlay(); poke(); return;
      case K.STOP:
        exit(); return;
      case K.REW: scrubBy(-30); return;
      case K.FF: scrubBy(30); return;
      case K.RED:
        if (st.item) { var on = Store.toggleFav(st.item.u); toast(on ? T('player.favAdded') : T('player.favRemoved')); }
        return;
      case K.GREEN: openMenu('audio'); return;
      case K.YELLOW: openMenu('text'); return;
      case K.BLUE: activate({ id: 'subsize' }); return;
      case K.INFO: Log.toggle(); return;    /* diagnostic log overlay */
      case K.CH_UP: nextInList(1); return;
      case K.CH_DOWN: nextInList(-1); return;
      default:
        poke();
    }
  }

  function nextInList(dir) {
    if (!st.list || st.listIdx < 0) return;
    var i = st.listIdx + dir;
    if (i < 0 || i >= st.list.length) { toast(T('player.endOfList')); return; }
    if (!st.live && st.item && st.cur > 0) Store.setResume(st.item.u, st.cur, st.dur);
    st.listIdx = i;
    start(st.list[i]);
  }

  return {
    play: play, key: key, exit: exit,
    isActive: function () { return !!st.item; },
    isPip: function () { return !!st.pip; },
    minimize: minimize, maximize: maximize,
    current: function () { return st.item; }
  };
})();
