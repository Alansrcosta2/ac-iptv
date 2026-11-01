/* UI: tabs, category strip, virtualised list/grid, search, the series/episode
   screen and modals. All navigation is driven by remote-control focus. */
var UI = (function () {

  var APP_VERSION = '1.1.1';

  var TABS = [
    { id: 'live', key: 'tab.live' },
    { id: 'movie', key: 'tab.movie' },
    { id: 'series', key: 'tab.series' },
    { id: 'fav', key: 'tab.fav' }
  ];

  /* Live channels and favourites are shown as a list, movies and series as a poster grid. */
  /* widths: content area is 1800px, gaps come from margins (3*586+2*20=1798, 6*280+5*24=1800) */
  var LAYOUT_FULL = {
    live: { mode: 'list', cols: 3, cw: 586, rh: 80 },
    fav: { mode: 'list', cols: 3, cw: 586, rh: 80 },
    movie: { mode: 'grid', cols: 6, cw: 280, th: 296, rh: 378 },
    series: { mode: 'grid', cols: 6, cw: 280, th: 296, rh: 378 }
  };

  /* with the overlay open the content narrows to 1120px (the right side shows the stream) */
  var LAYOUT_PIP = {
    live: { mode: 'list', cols: 2, cw: 550, rh: 80 },
    fav: { mode: 'list', cols: 2, cw: 550, rh: 80 },
    movie: { mode: 'grid', cols: 4, cw: 262, th: 278, rh: 358 },
    series: { mode: 'grid', cols: 4, cw: 262, th: 278, rh: 358 }
  };

  function layout() { return (s.pip ? LAYOUT_PIP : LAYOUT_FULL)[s.tab]; }

  var GRID_VIEW = 740;
  var STRIP_W = 1800;      /* visible width of the category strip */
  var CHIP_GAP = 14;

  var s = {
    screen: 'scr-boot',
    items: [], idx: null,
    tab: 'live', tabIdx: 0,
    zone: 'grid',           /* tabs | groups | grid */
    groups: [], groupIdx: 0, groupOff: 0, chipPos: [],
    entries: [], gridIdx: 0, gridOff: 0,
    showCache: {},
    modalOpen: false, modalIdx: 0, modalActions: [],
    setupFocus: 1, setupUrl: '',
    search: { text: '', results: [], idx: 0, off: 0, zone: 'kb', kb: null },
    ep: { show: null, seasons: [], seasonIdx: 0, eps: [], epIdx: 0, epOff: 0, zone: 'seasons' },
    onSourceSaved: null, onRefresh: null,
    pip: false, pipItem: null, setIdx: 0, onClearCache: null,
    /* screen the current playback was started from, so Back returns there */
    origin: 'scr-browse'
  };

  /* ---------------- screen switching ---------------- */

  function showScreen(id) {
    var list = document.querySelectorAll('.screen');
    for (var i = 0; i < list.length; i++) list[i].className = 'screen';
    U.$(id).className = 'screen visible';
    s.screen = id;
  }

  function boot(status, pct, hint) {
    if (status !== undefined && status !== null) U.$('boot-status').innerHTML = U.esc(status);
    if (pct !== undefined && pct !== null) U.$('boot-bar-fill').style.width = Math.round(pct * 100) + '%';
    if (hint !== undefined) U.$('boot-hint').innerHTML = U.esc(hint || '');
  }

  /* ---------------- modal ---------------- */

  function modal(title, text, actions) {
    s.modalOpen = true; s.modalIdx = 0; s.modalActions = actions || [{ label: T('dlg.ok'), act: closeModal }];
    U.$('modal-title').innerHTML = U.esc(title);
    U.$('modal-text').innerHTML = U.esc(text).replace(/\n/g, '<br>');
    paintModal();
    U.$('modal').className = '';
  }
  function paintModal() {
    var box = U.$('modal-actions');
    box.innerHTML = '';
    for (var i = 0; i < s.modalActions.length; i++) {
      var b = U.el('div', 'btn' + (i === 0 ? ' primary' : '') + (i === s.modalIdx ? ' focus' : ''),
        U.esc(s.modalActions[i].label));
      box.appendChild(b);
    }
  }
  function closeModal() { s.modalOpen = false; U.$('modal').className = 'hidden'; }

  /* updates the text of an open modal in place (used while probe results stream in) */
  function modalText(text) {
    if (!s.modalOpen) return;
    U.$('modal-text').innerHTML = U.esc(text).replace(/\n/g, '<br>');
  }

  function modalKey(code) {
    var K = KEY.CODE;
    if (code === K.LEFT) { s.modalIdx = Math.max(0, s.modalIdx - 1); paintModal(); }
    else if (code === K.RIGHT) { s.modalIdx = Math.min(s.modalActions.length - 1, s.modalIdx + 1); paintModal(); }
    else if (code === K.ENTER) { var a = s.modalActions[s.modalIdx]; closeModal(); if (a && a.act) a.act(); }
    else if (code === K.BACK) closeModal();
  }

  /* ---------------- setup screen ---------------- */

  function openSetup(current, onSaved) {
    s.setupUrl = current || '';
    s.onSourceSaved = onSaved;
    s.setupFocus = 1;
    U.$('setup-url-value').innerHTML = U.esc(s.setupUrl || T('setup.empty'));
    paintSetup();
    showScreen('scr-setup');
  }

  function paintSetup() {
    var nodes = [U.$('setup-url-field'), U.$('setup-save'), U.$('setup-paste')];
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].className = nodes[i].className.replace(/ focus/g, '') + (i === s.setupFocus ? ' focus' : '');
    }
  }

  /* a real input element is used so the TV's on-screen keyboard (IME) opens */
  function editUrl() {
    var box = U.$('setup-url-field');
    var inp = document.createElement('input');
    inp.type = 'url';
    inp.value = s.setupUrl;
    inp.style.cssText = 'position:absolute;left:160px;top:400px;width:1200px;height:90px;' +
      'font-size:30px;padding:0 20px;border-radius:14px;border:3px solid #7cc4ff;' +
      'background:#0b1120;color:#fff;z-index:80;';
    document.body.appendChild(inp);
    function finish() {
      s.setupUrl = inp.value.trim();
      U.$('setup-url-value').innerHTML = U.esc(s.setupUrl || T('setup.empty'));
      if (inp.parentNode) inp.parentNode.removeChild(inp);
      s.setupFocus = 1; paintSetup();
    }
    inp.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.keyCode === 13 || ev.keyCode === KEY.CODE.BACK) { ev.preventDefault(); finish(); }
    }, false);
    inp.addEventListener('blur', function () { setTimeout(function () { if (inp.parentNode) finish(); }, 50); }, false);
    setTimeout(function () { inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) { } }, 30);
    box.className = box.className.replace(/ focus/g, '');
  }

  function setupKey(code) {
    var K = KEY.CODE;
    if (code === K.UP) { s.setupFocus = 0; paintSetup(); }
    else if (code === K.DOWN) { if (s.setupFocus === 0) s.setupFocus = 1; paintSetup(); }
    else if (code === K.LEFT) { if (s.setupFocus === 2) { s.setupFocus = 1; paintSetup(); } }
    else if (code === K.RIGHT) { if (s.setupFocus === 1) { s.setupFocus = 2; paintSetup(); } }
    else if (code === K.ENTER) {
      if (s.setupFocus === 0) editUrl();
      else if (s.setupFocus === 1) {
        if (!s.setupUrl || s.setupUrl.indexOf('http') !== 0) { modal(T('setup.missing.title'), T('setup.missing.text')); return; }
        if (s.onSourceSaved) s.onSourceSaved(s.setupUrl);
      } else {
        s.setupUrl = Store.DEFAULT_SOURCE;
        U.$('setup-url-value').innerHTML = U.esc(s.setupUrl);
        s.setupFocus = 1; paintSetup();
      }
    } else if (code === K.BACK) {
      if (s.items.length) showBrowse();
    }
  }

  /* ---------------- browsing ---------------- */

  function setData(items, index) {
    s.items = items; s.idx = index; s.showCache = {};
  }

  function showBrowse() {
    showScreen('scr-browse');
    paintTabs();
    buildGroups();
    s.zone = 'grid';
    paintAll();
    startClock();
  }

  function paintTabs() {
    var box = U.$('tabs');
    box.innerHTML = '';
    for (var i = 0; i < TABS.length; i++) {
      var cls = 'tab' + (TABS[i].id === s.tab ? ' active' : '') +
        (s.zone === 'tabs' && i === s.tabIdx ? ' focus' : '');
      box.appendChild(U.el('div', cls, U.esc(T(TABS[i].key))));
    }
    var sb = U.$('btn-search');
    sb.className = 'top-btn' + (s.zone === 'tabs' && s.tabIdx === TABS.length ? ' focus' : '');
    var stb = U.$('btn-settings');
    stb.className = 'top-btn' + (s.zone === 'tabs' && s.tabIdx === TABS.length + 1 ? ' focus' : '');
  }

  function buildGroups() {
    s.groups = [];
    if (s.tab === 'fav') {
      s.groups.push({ name: T('tab.fav'), count: Store.favIds().length, key: '*fav' });
    } else {
      var bucket = s.idx[s.tab];
      var all = 0, i;
      for (i = 0; i < bucket.order.length; i++) all += bucket.map[bucket.order[i]].length;
      s.groups.push({ name: T('group.all'), count: all, key: '*all' });
      for (i = 0; i < bucket.order.length; i++) {
        s.groups.push({ name: bucket.order[i], count: bucket.map[bucket.order[i]].length, key: bucket.order[i] });
      }
    }
    s.groupIdx = 0; s.groupOff = 0; s.chipPos = [];
    buildEntries();
  }

  /* Builds the grid entries for the selected group.
     On the series tab, episodes are collapsed into one entry per show. */
  function buildEntries() {
    var g = s.groups[s.groupIdx];
    var out = [];
    if (!g) { s.entries = []; s.gridIdx = 0; s.gridOff = 0; return; }

    if (s.tab === 'fav') {
      var favs = {}, ids = Store.favIds(), j;
      for (j = 0; j < ids.length; j++) favs[ids[j]] = 1;
      for (j = 0; j < s.items.length; j++) if (favs[s.items[j].u]) out.push({ t: 'i', i: j });
    } else {
      var bucket = s.idx[s.tab];
      var idxList = [];
      if (g.key === '*all') {
        for (var k = 0; k < bucket.order.length; k++)
          idxList = idxList.concat(bucket.map[bucket.order[k]]);
      } else {
        idxList = bucket.map[g.key] || [];
      }

      if (s.tab === 'series') {
        var cacheKey = g.key;
        if (s.showCache[cacheKey]) out = s.showCache[cacheKey];
        else {
          var seen = {}, order = [];
          for (var m = 0; m < idxList.length; m++) {
            var it = s.items[idxList[m]];
            var name = it.s || it.n;
            if (!seen[name]) { seen[name] = { t: 's', name: name, idx: [], logo: it.l }; order.push(seen[name]); }
            seen[name].idx.push(idxList[m]);
            if (!seen[name].logo && it.l) seen[name].logo = it.l;
          }
          out = order;
          s.showCache[cacheKey] = out;
        }
      } else {
        for (var n = 0; n < idxList.length; n++) out.push({ t: 'i', i: idxList[n] });
      }
    }
    s.entries = out; s.gridIdx = 0; s.gridOff = 0;
  }

  /* Restores the screen playback was started from (browse, search or episodes). */
  function backToOrigin() {
    showScreen(s.origin);
    if (s.origin === 'scr-search') paintResults();
    else if (s.origin === 'scr-episodes') paintEpisodes();
    else paintAll();
  }

  /* ---------------- list overlay while playing ---------------- */

  /* Background for the list while the stream runs: the left panel only.
     The video keeps playing full screen, so the right side stays clear. */
  var PANEL_W = 1300;
  function layoutPipMask() {
    var el = U.$('pip-mask').getElementsByTagName('i')[2];   /* left panel */
    el.style.left = '0px'; el.style.top = '0px';
    el.style.width = PANEL_W + 'px'; el.style.height = '1080px';
  }

  function setPip(on, rect, item) {
    s.pip = !!on;
    s.pipItem = on ? (item || null) : null;
    if (on) {
      layoutPipMask();
      showScreen(s.origin);
      /* keep the focus valid for the narrower grid */
      if (s.origin === 'scr-search') { paintResults(); }
      else if (s.origin === 'scr-episodes') { paintEpisodes(); }
      else {
        if (s.gridIdx >= s.entries.length) s.gridIdx = Math.max(0, s.entries.length - 1);
        s.gridOff = 0;
        paintAll();
      }
      startClock();
    } else {
      paintAll();
    }
    paintPipHint();
  }

  function paintPipHint() {
    var e = U.$('pip-hint');
    if (!e) return;
    if (s.pip && s.pipItem) {
      e.innerHTML = '<span class="pip-now">' + U.esc(T('pip.now', { name: s.pipItem.n })) + '</span>' +
        '<span class="pip-keys"><i class="key">OK</i> ' + U.esc(T('pip.otherChannel')) + ' &nbsp; ' +
        '<i class="key">' + U.esc(T('ctl.play')) + '</i> ' + U.esc(T('pip.fullscreen')) + ' &nbsp; <i class="key">' + U.esc(T('dlg.close')) + '</i> ' + U.esc(T('pip.stop')) + '</span>';
      e.className = '';
    } else {
      e.className = 'hidden';
    }
  }

  function paintAll() { paintTabs(); paintGroups(); paintGrid(); paintPipHint(); }

  /* Category strip: horizontal and scrollable, wrapping around at both ends. */
  function measureChips() {
    var probe = U.el('div', 'gchip');
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    U.$('group-strip').appendChild(probe);
    var x = 0;
    s.chipPos = [];
    for (var i = 0; i < s.groups.length; i++) {
      probe.innerHTML = '<span>' + U.esc(s.groups[i].name) + '</span>' +
        '<span class="gcount">' + s.groups[i].count + '</span>';
      var w = probe.offsetWidth;
      s.chipPos.push({ x: x, w: w });
      x += w + CHIP_GAP;
    }
    probe.parentNode.removeChild(probe);
  }

  function paintGroups() {
    var box = U.$('group-strip');
    if (!s.chipPos.length || s.chipPos.length !== s.groups.length) measureChips();

    var stripW = s.pip ? 1120 : STRIP_W;
    var cur = s.chipPos[s.groupIdx];
    if (cur) {
      if (cur.x < s.groupOff) s.groupOff = cur.x;
      if (cur.x + cur.w > s.groupOff + stripW) s.groupOff = cur.x + cur.w - stripW;
      if (s.groupOff < 0) s.groupOff = 0;
    }

    box.innerHTML = '';
    for (var i = 0; i < s.groups.length; i++) {
      var p = s.chipPos[i];
      if (!p) continue;
      var left = p.x - s.groupOff;
      if (left + p.w < -200 || left > stripW + 200) continue;   /* skip anything off screen */
      var g = s.groups[i];
      var cls = 'gchip' + (i === s.groupIdx ? ' active' : '') +
        (s.zone === 'groups' && i === s.groupIdx ? ' focus' : '');
      var e = U.el('div', cls,
        '<span>' + U.esc(g.name) + '</span><span class="gcount">' + g.count + '</span>');
      e.style.left = left + 'px';
      box.appendChild(e);
    }
  }

  function entryLabel(e) {
    if (e.t === 's') return e.name;
    return s.items[e.i].n;
  }
  function entryLogo(e) {
    if (e.t === 's') return e.logo;
    return s.items[e.i].l;
  }

  function paintGrid() {
    var L = layout();
    var box = U.$('grid');
    var rows = Math.ceil(s.entries.length / L.cols);
    var row = Math.floor(s.gridIdx / L.cols);

    U.$('content-title').innerHTML = U.esc(s.groups[s.groupIdx] ? s.groups[s.groupIdx].name : '');
    U.$('content-count').innerHTML = s.entries.length ? T('grid.count', { n: s.entries.length }) : '';
    U.$('empty').className = s.entries.length ? 'empty hidden' : 'empty';

    var top = row * L.rh;
    if (top < s.gridOff) s.gridOff = top;
    if (top + L.rh > s.gridOff + GRID_VIEW) s.gridOff = top + L.rh - GRID_VIEW;
    if (s.gridOff < 0) s.gridOff = 0;

    var first = Math.max(0, Math.floor(s.gridOff / L.rh) - 1);
    var last = Math.min(rows - 1, Math.ceil((s.gridOff + GRID_VIEW) / L.rh));

    box.innerHTML = '';
    for (var r = first; r <= last; r++) {
      var rowEl = U.el('div', L.mode === 'list' ? 'lrow' : 'row');
      rowEl.style.top = (r * L.rh - s.gridOff) + 'px';
      for (var c = 0; c < L.cols; c++) {
        var i = r * L.cols + c;
        if (i >= s.entries.length) break;
        rowEl.appendChild(L.mode === 'list' ? listItem(s.entries[i], i, L) : card(s.entries[i], i, L));
      }
      box.appendChild(rowEl);
    }
  }

  function listItem(e, i, L) {
    var focused = (s.zone === 'grid' && i === s.gridIdx);
    var el = U.el('div', 'litem' + (focused ? ' focus' : ''));
    el.style.width = L.cw + 'px';
    el.style.height = (L.rh - 12) + 'px';

    var th = U.el('div', 'lth');
    var logo = entryLogo(e);
    if (logo) {
      var img = document.createElement('img');
      img.src = logo;
      img.onerror = function () { this.style.display = 'none'; };
      th.appendChild(img);
    } else {
      th.appendChild(U.el('div', 'initials', U.esc(U.initials(entryLabel(e)))));
    }
    el.appendChild(th);
    var nm = U.el('div', 'lname', U.esc(entryLabel(e)));
    nm.style.width = (L.cw - 162) + 'px';   /* padding + border + logo + star allowance */
    el.appendChild(nm);
    if (e.t === 'i' && Store.isFav(s.items[e.i].u)) el.appendChild(U.el('div', 'lstar', '★'));
    return el;
  }

  function card(e, i, L) {
    var focused = (s.zone === 'grid' && i === s.gridIdx);
    var el = U.el('div', 'card' + (focused ? ' focus' : ''));
    el.style.width = L.cw + 'px';

    var poster = (s.tab === 'movie' || s.tab === 'series');
    var th = U.el('div', 'thumb' + (poster ? ' poster' : ''));
    th.style.height = L.th + 'px';
    var logo = entryLogo(e);
    if (logo) {
      var img = document.createElement('img');
      img.src = logo;
      img.onerror = function () { this.style.display = 'none'; };
      th.appendChild(img);
    } else {
      th.appendChild(U.el('div', 'initials', U.esc(U.initials(entryLabel(e)))));
    }
    el.appendChild(th);
    el.appendChild(U.el('div', 'cname', U.esc(entryLabel(e))));
    if (e.t === 'i' && Store.isFav(s.items[e.i].u)) el.appendChild(U.el('div', 'fav', '★'));
    if (e.t === 's') el.appendChild(U.el('div', 'fav', String(e.idx.length)));
    return el;
  }

  /* ---------------- episode screen ---------------- */

  function openShow(entry) {
    var eps = [], i;
    for (i = 0; i < entry.idx.length; i++) eps.push(s.items[entry.idx[i]]);
    eps.sort(function (a, b) {
      var sa = a.se || 0, sb = b.se || 0;
      if (sa !== sb) return sa - sb;
      return (a.ep || 0) - (b.ep || 0);
    });
    var seasons = [], seen = {};
    for (i = 0; i < eps.length; i++) {
      var se = eps[i].se || 1;
      if (!seen[se]) { seen[se] = 1; seasons.push(se); }
    }
    s.ep = { show: entry.name, all: eps, seasons: seasons, seasonIdx: 0, eps: [], epIdx: 0, epOff: 0, zone: 'seasons' };
    U.$('ep-title').innerHTML = U.esc(entry.name);
    U.$('ep-sub').innerHTML = T('ep.count', { n: eps.length });
    filterSeason();
    showScreen('scr-episodes');
    paintEpisodes();
  }

  function filterSeason() {
    var want = s.ep.seasons[s.ep.seasonIdx];
    var out = [];
    for (var i = 0; i < s.ep.all.length; i++) if ((s.ep.all[i].se || 1) === want) out.push(s.ep.all[i]);
    s.ep.eps = out; s.ep.epIdx = 0; s.ep.epOff = 0;
  }

  function paintEpisodes() {
    var sl = U.$('season-list');
    sl.innerHTML = '';
    for (var i = 0; i < s.ep.seasons.length; i++) {
      var cls = 'season' + (i === s.ep.seasonIdx ? ' active' : '') +
        (s.ep.zone === 'seasons' && i === s.ep.seasonIdx ? ' focus' : '');
      var e = U.el('div', cls, T('ep.season', { n: s.ep.seasons[i] }));
      e.style.marginBottom = '10px';
      sl.appendChild(e);
    }

    var EH = 78, VIEW = 820;
    var top = s.ep.epIdx * EH;
    if (top < s.ep.epOff) s.ep.epOff = top;
    if (top + EH > s.ep.epOff + VIEW) s.ep.epOff = top + EH - VIEW;

    var box = U.$('episode-list');
    box.innerHTML = '';
    var first = Math.max(0, Math.floor(s.ep.epOff / EH) - 1);
    var last = Math.min(s.ep.eps.length - 1, Math.ceil((s.ep.epOff + VIEW) / EH));
    for (var j = first; j <= last; j++) {
      var it = s.ep.eps[j];
      var r = Store.getResume(it.u);
      var meta = r ? T('ep.watched', { time: U.fmtTime(r.p) }) : '';
      var cls2 = 'ep' + (s.ep.zone === 'eps' && j === s.ep.epIdx ? ' focus' : '') + (r ? ' watched' : '');
      var ee = U.el('div', cls2,
        '<span class="ep-n">' + (it.ep ? T('ep.number', { n: it.ep }) : '') + '</span>' +
        '<span class="ep-t">' + U.esc(it.n) + '</span>' +
        '<span class="ep-meta">' + U.esc(meta) + '</span>');
      ee.style.position = 'absolute';
      ee.style.left = '0'; ee.style.right = '0';
      ee.style.top = (j * EH - s.ep.epOff) + 'px';
      ee.style.height = (EH - 10) + 'px';
      box.appendChild(ee);
    }
  }

  function episodesKey(code) {
    var K = KEY.CODE;
    if (s.pip && pipKey(code)) return;
    if (code === K.BACK) { showScreen('scr-browse'); paintAll(); return; }
    if (code === K.GREEN) { openSearch(); return; }
    if (s.ep.zone === 'seasons') {
      if (code === K.UP) { s.ep.seasonIdx = Math.max(0, s.ep.seasonIdx - 1); filterSeason(); paintEpisodes(); }
      else if (code === K.DOWN) { s.ep.seasonIdx = Math.min(s.ep.seasons.length - 1, s.ep.seasonIdx + 1); filterSeason(); paintEpisodes(); }
      else if (code === K.RIGHT || code === K.ENTER) { s.ep.zone = 'eps'; paintEpisodes(); }
    } else {
      if (code === K.UP) { s.ep.epIdx = Math.max(0, s.ep.epIdx - 1); paintEpisodes(); }
      else if (code === K.DOWN) { s.ep.epIdx = Math.min(s.ep.eps.length - 1, s.ep.epIdx + 1); paintEpisodes(); }
      else if (code === K.LEFT) { s.ep.zone = 'seasons'; paintEpisodes(); }
      else if (code === K.ENTER) {
        var it = s.ep.eps[s.ep.epIdx];
        if (it) { s.origin = 'scr-episodes'; Player.play(it, s.ep.eps, s.ep.epIdx, backToOrigin); }
      } else if (code === K.RED) {
        var it2 = s.ep.eps[s.ep.epIdx];
        if (it2) { Store.toggleFav(it2.u); paintEpisodes(); }
      }
    }
  }

  /* ---------------- settings ---------------- */

  function settingsRows() {
    var langLabel = '';
    for (var i = 0; i < I18N.langs.length; i++) {
      if (I18N.langs[i].id === I18N.get()) langLabel = I18N.langs[i].label;
    }
    return [
      { id: 'lang', name: T('settings.language'), value: langLabel },
      { id: 'source', name: T('settings.source'), value: maskUrl(Store.settings.source) },
      { id: 'subsize', name: T('settings.subSize'), value: T('size.' + (Store.settings.subSize || 'normal')) },
      { id: 'buffer', name: T('settings.buffer'), value: T('settings.bufferValue', { n: Store.settings.bufferSec || 8 }) },
      { id: 'reload', name: T('settings.reload'), value: '' },
      { id: 'clear', name: T('settings.clearCache'), value: '' },
      { id: 'about', name: T('settings.about'), value: T('settings.aboutText', { version: APP_VERSION }), info: true }
    ];
  }

  function maskUrl(u) {
    if (!u) return T('setup.empty');
    return String(u).replace(/(password=)[^&]*/i, '$1***');
  }

  function openSettings() {
    s.setIdx = 0;
    paintSettings();
    showScreen('scr-settings');
  }

  function paintSettings() {
    var rows = settingsRows();
    var box = U.$('settings-list');
    box.innerHTML = '';
    for (var i = 0; i < rows.length; i++) {
      var e = U.el('div', 'srow' + (rows[i].info ? ' info' : '') + (i === s.setIdx ? ' focus' : ''),
        '<span class="sname">' + U.esc(rows[i].name) + '</span>' +
        '<span class="sval">' + U.esc(rows[i].value) + '</span>');
      box.appendChild(e);
    }
    I18N.apply();
  }

  function settingsKey(code) {
    var K = KEY.CODE;
    var rows = settingsRows();
    if (code === K.BACK) { showBrowse(); return; }
    if (code === K.UP) { s.setIdx = Math.max(0, s.setIdx - 1); paintSettings(); return; }
    if (code === K.DOWN) { s.setIdx = Math.min(rows.length - 1, s.setIdx + 1); paintSettings(); return; }
    if (code !== K.ENTER && code !== K.LEFT && code !== K.RIGHT) return;

    var row = rows[s.setIdx];
    if (!row || row.info) return;

    if (row.id === 'lang') {
      /* cycle through the available languages */
      var idx = 0;
      for (var i = 0; i < I18N.langs.length; i++) if (I18N.langs[i].id === I18N.get()) idx = i;
      var step = (code === K.LEFT) ? -1 : 1;
      var next = I18N.langs[(idx + step + I18N.langs.length) % I18N.langs.length].id;
      I18N.set(next);
      Store.settings.lang = next;
      Store.saveSettings();
      relabel();
      paintSettings();
      return;
    }
    if (row.id === 'subsize') {
      var order = ['small', 'normal', 'large'];
      var j = order.indexOf(Store.settings.subSize || 'normal');
      Store.settings.subSize = order[(j + ((code === K.LEFT) ? 2 : 1)) % 3];
      Store.saveSettings();
      paintSettings();
      return;
    }
    if (row.id === 'buffer') {
      /* deeper buffer = fewer freezes on a shaky line, slower channel change */
      var steps = [2, 4, 6, 8, 10, 12];
      var b = steps.indexOf(parseInt(Store.settings.bufferSec, 10) || 8);
      if (b < 0) b = 3;
      Store.settings.bufferSec = steps[(b + ((code === K.LEFT) ? steps.length - 1 : 1)) % steps.length];
      Store.saveSettings();
      paintSettings();
      return;
    }
    if (row.id === 'source') { openSetup(Store.settings.source, s.onSourceSaved); return; }
    if (row.id === 'reload') { if (s.onRefresh) s.onRefresh(); return; }
    if (row.id === 'clear') { if (s.onClearCache) s.onClearCache(); return; }
  }

  /* re-renders every screen after a language change */
  function relabel() {
    I18N.apply();
    if (s.items.length) {
      s.showCache = {};
      buildGroups();
      paintAll();
    }
    U.$('setup-url-value').innerHTML = U.esc(s.setupUrl || T('setup.empty'));
    U.$('search-info').innerHTML = T('search.hint');
    if (s.search.kb) s.search.kb = Keyboard.create(U.$('keyboard'), onKbInput);
  }

  /* ---------------- search ---------------- */

  function openSearch() {
    s.search.text = ''; s.search.results = []; s.search.idx = 0; s.search.off = 0; s.search.zone = 'kb';
    U.$('search-text').innerHTML = '';
    U.$('search-info').innerHTML = T('search.hint');
    U.$('search-results').innerHTML = '';
    if (!s.search.kb) s.search.kb = Keyboard.create(U.$('keyboard'), onKbInput);
    s.search.kb.focus();
    showScreen('scr-search');
  }

  function onKbInput(v) {
    if (v === '\b') s.search.text = s.search.text.substring(0, s.search.text.length - 1);
    else if (v === '\x00') s.search.text = '';
    else s.search.text += v;
    U.$('search-text').innerHTML = U.esc(s.search.text);
    runSearch();
  }

  var runSearch = U.debounce(function () {
    var q = U.fold(s.search.text.trim());
    if (q.length < 2) {
      s.search.results = [];
      U.$('search-info').innerHTML = T('search.hint');
      U.$('search-results').innerHTML = '';
      return;
    }
    var out = [], i, LIM = 300;
    for (i = 0; i < s.items.length && out.length < LIM; i++) {
      if (s.items[i].f.indexOf(q) >= 0) out.push(i);
    }
    s.search.results = out; s.search.idx = 0; s.search.off = 0;
    U.$('search-info').innerHTML = out.length ? T('search.results', { n: out.length + (out.length >= LIM ? '+' : '') }) : T('search.none');
    paintResults();
  }, 220);

  function paintResults() {
    var RH = 92, VIEW = 780;
    var top = s.search.idx * RH;
    if (top < s.search.off) s.search.off = top;
    if (top + RH > s.search.off + VIEW) s.search.off = top + RH - VIEW;

    var box = U.$('search-results');
    box.innerHTML = '';
    var first = Math.max(0, Math.floor(s.search.off / RH) - 1);
    var last = Math.min(s.search.results.length - 1, Math.ceil((s.search.off + VIEW) / RH));
    var KINDS = { live: T('kind.live'), movie: T('kind.movie'), series: T('kind.series') };
    for (var i = first; i <= last; i++) {
      var it = s.items[s.search.results[i]];
      var cls = 'sr' + (s.search.zone === 'res' && i === s.search.idx ? ' focus' : '');
      var e = U.el('div', cls,
        '<div class="sr-th">' + (it.l ? '<img src="' + U.esc(it.l) + '" onerror="this.style.display=\'none\'">' : '') + '</div>' +
        '<div class="sr-body"><div class="sr-name">' + U.esc(it.n) + '</div>' +
        '<div class="sr-meta">' + U.esc(KINDS[it.k] || '') + '  ·  ' + U.esc(it.g) + '</div></div>');
      e.style.position = 'absolute';
      e.style.left = '0'; e.style.right = '0';
      e.style.top = (i * RH - s.search.off) + 'px';
      e.style.height = (RH - 10) + 'px';
      box.appendChild(e);
    }
  }

  function searchKey(code) {
    var K = KEY.CODE;
    if (s.pip && pipKey(code)) return;
    if (code === K.BACK) {
      if (s.search.zone === 'res') { s.search.zone = 'kb'; s.search.kb.focus(); paintResults(); return; }
      showScreen('scr-browse'); paintAll(); return;
    }
    if (s.search.zone === 'kb') {
      if (code === K.UP) s.search.kb.move(-1, 0);
      else if (code === K.DOWN) s.search.kb.move(1, 0);
      else if (code === K.LEFT) s.search.kb.move(0, -1);
      else if (code === K.RIGHT) {
        if (!s.search.kb.move(0, 1) && s.search.results.length) {
          s.search.zone = 'res'; s.search.kb.blur(); paintResults();
        }
      } else if (code === K.ENTER) s.search.kb.press();
      return;
    }
    if (code === K.UP) { s.search.idx = Math.max(0, s.search.idx - 1); paintResults(); }
    else if (code === K.DOWN) { s.search.idx = Math.min(s.search.results.length - 1, s.search.idx + 1); paintResults(); }
    else if (code === K.LEFT) { s.search.zone = 'kb'; s.search.kb.focus(); paintResults(); }
    else if (code === K.ENTER) {
      var it = s.items[s.search.results[s.search.idx]];
      if (it) { s.origin = 'scr-search'; Player.play(it, null, -1, backToOrigin); }
    } else if (code === K.RED) {
      var it2 = s.items[s.search.results[s.search.idx]];
      if (it2) { Store.toggleFav(it2.u); paintResults(); }
    }
  }

  /* ---------------- browse key handling ---------------- */

  function browseKey(code) {
    var K = KEY.CODE;
    var L = layout();

    if (s.pip && pipKey(code)) return;

    switch (code) {
      case K.GREEN: openSearch(); return;
      case K.YELLOW: if (s.onRefresh) s.onRefresh(); return;
      case K.BLUE: openSetup(Store.settings.source, s.onSourceSaved); return;
      case K.RED:
        if (s.zone === 'grid') {
          var e0 = s.entries[s.gridIdx];
          if (e0 && e0.t === 'i') { Store.toggleFav(s.items[e0.i].u); paintGrid(); }
        }
        return;
    }

    if (s.zone === 'tabs') {
      if (code === K.LEFT) { s.tabIdx = Math.max(0, s.tabIdx - 1); paintTabs(); }
      else if (code === K.RIGHT) { s.tabIdx = Math.min(TABS.length + 1, s.tabIdx + 1); paintTabs(); }
      else if (code === K.DOWN) { s.zone = 'groups'; paintAll(); }
      else if (code === K.ENTER) {
        if (s.tabIdx === TABS.length) { openSearch(); return; }
        if (s.tabIdx === TABS.length + 1) { openSettings(); return; }
        s.tab = TABS[s.tabIdx].id;
        Store.settings.lastTab = s.tab; Store.saveSettings();
        buildGroups(); s.zone = 'groups'; paintAll();
      } else if (code === K.BACK) {
        modal(T('dlg.exit.title'), T('dlg.exit.text'),
          [{ label: T('dlg.exit.confirm'), act: KEY.exitApp }, { label: T('dlg.cancel'), act: closeModal }]);
      }
      return;
    }

    if (s.zone === 'groups') {
      /* horizontal strip: wraps around at both ends */
      if (code === K.LEFT) {
        s.groupIdx = (s.groupIdx - 1 + s.groups.length) % s.groups.length;
        buildEntries(); paintAll();
      } else if (code === K.RIGHT) {
        s.groupIdx = (s.groupIdx + 1) % s.groups.length;
        buildEntries(); paintAll();
      } else if (code === K.CH_UP) {
        s.groupIdx = (s.groupIdx - 5 + s.groups.length * 5) % s.groups.length;
        buildEntries(); paintAll();
      } else if (code === K.CH_DOWN) {
        s.groupIdx = (s.groupIdx + 5) % s.groups.length;
        buildEntries(); paintAll();
      } else if (code === K.UP) { s.zone = 'tabs'; s.tabIdx = tabIndex(); paintAll(); }
      else if (code === K.DOWN || code === K.ENTER) { s.zone = 'grid'; paintAll(); }
      else if (code === K.BACK) { s.zone = 'tabs'; s.tabIdx = tabIndex(); paintAll(); }
      return;
    }

    /* content list / grid */
    if (code === K.LEFT) {
      if (s.gridIdx > 0) { s.gridIdx--; paintGrid(); }
    } else if (code === K.RIGHT) {
      if (s.gridIdx < s.entries.length - 1) { s.gridIdx++; paintGrid(); }
    } else if (code === K.UP) {
      if (s.gridIdx < L.cols) { s.zone = 'groups'; paintAll(); }
      else { s.gridIdx -= L.cols; paintGrid(); }
    } else if (code === K.DOWN) {
      if (s.gridIdx + L.cols < s.entries.length) { s.gridIdx += L.cols; paintGrid(); }
      else if (s.gridIdx < s.entries.length - 1) { s.gridIdx = s.entries.length - 1; paintGrid(); }
    } else if (code === K.CH_UP) {
      s.gridIdx = Math.max(0, s.gridIdx - L.cols * 3); paintGrid();
    } else if (code === K.CH_DOWN) {
      s.gridIdx = Math.min(s.entries.length - 1, s.gridIdx + L.cols * 3); paintGrid();
    } else if (code === K.ENTER) {
      var e = s.entries[s.gridIdx];
      if (!e) return;
      if (e.t === 's') { openShow(e); return; }
      var list = null, li = -1;
      if (s.tab === 'live' || s.tab === 'fav') {
        list = []; for (var i = 0; i < s.entries.length; i++) if (s.entries[i].t === 'i') list.push(s.items[s.entries[i].i]);
        li = s.gridIdx;
      }
      s.origin = 'scr-browse';
      Player.play(s.items[e.i], list, li, backToOrigin);
    } else if (code === K.BACK) {
      s.zone = 'groups'; paintAll();
    }
  }

  /* from the tabs, down now moves into the category strip */

  /* With the overlay open: play returns to full screen, back stops the stream.
     Returns true when the key was consumed. */
  function pipKey(code) {
    var K = KEY.CODE;
    if (code === K.PLAY || code === K.PLAYPAUSE) { Player.maximize(); return true; }
    if (code === K.BACK) { Player.exit(); return true; }
    return false;
  }

  function tabIndex() {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].id === s.tab) return i;
    return 0;
  }

  /* ---------------- clock ---------------- */
  var clockTimer = null;
  function startClock() {
    if (clockTimer) return;
    function tick() { U.$('clock').innerHTML = U.clock(); }
    tick();
    clockTimer = setInterval(tick, 20000);
  }

  /* ---------------- key dispatch ---------------- */

  function key(code) {
    if (s.modalOpen) { modalKey(code); return; }
    /* while the overlay is open keys go to the UI, not to the player */
    if (Player.isActive() && !Player.isPip()) { Player.key(code); return; }
    switch (s.screen) {
      case 'scr-setup': setupKey(code); break;
      case 'scr-browse': browseKey(code); break;
      case 'scr-search': searchKey(code); break;
      case 'scr-settings': settingsKey(code); break;
      case 'scr-episodes': episodesKey(code); break;
      case 'scr-boot':
        if (code === KEY.CODE.BACK) KEY.exitApp();
        break;
    }
  }

  return {
    showScreen: showScreen, boot: boot, modal: modal, closeModal: closeModal, modalText: modalText,
    openSetup: openSetup, setData: setData, showBrowse: showBrowse, openSearch: openSearch,
    key: key, setPip: setPip, openSettings: openSettings, relabel: relabel,
    setTab: function (t) { s.tab = t; },
    onRefresh: function (fn) { s.onRefresh = fn; },
    onClearCache: function (fn) { s.onClearCache = fn; },
    onSourceSaved: function (fn) { s.onSourceSaved = fn; }
  };
})();
