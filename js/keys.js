/* Remote control keys: Samsung TV key codes plus desktop keyboard equivalents
   used when testing in a browser. */
var KEY = (function () {

  var CODE = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: 10009, EXIT: 10182,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    PLAY: 415, PAUSE: 19, STOP: 413, PLAYPAUSE: 10252,
    REW: 412, FF: 417, INFO: 457,
    CH_UP: 427, CH_DOWN: 428,
    DIGIT0: 48
  };

  /* Browser testing: F1..F4 map to the colour keys, Escape = back, Space = play/pause */
  var PC_ALIAS = { 27: CODE.BACK, 8: CODE.BACK, 32: CODE.PLAYPAUSE,
                   112: CODE.RED, 113: CODE.GREEN, 114: CODE.YELLOW, 115: CODE.BLUE };

  var NAMES = ['MediaPlay', 'MediaPause', 'MediaStop', 'MediaPlayPause', 'MediaRewind',
               'MediaFastForward', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
               'Info', 'ChannelUp', 'ChannelDown'];

  var handler = null;

  function register() {
    try {
      if (typeof tizen !== 'undefined' && tizen.tvinputdevice) {
        for (var i = 0; i < NAMES.length; i++) {
          try { tizen.tvinputdevice.registerKey(NAMES[i]); } catch (e) { /* not available on this model */ }
        }
      }
    } catch (e2) { /* running in a browser */ }
  }

  function onKey(fn) { handler = fn; }

  function init() {
    register();
    document.addEventListener('keydown', function (ev) {
      var code = ev.keyCode;
      if (PC_ALIAS[code] !== undefined && !ev.__tv) code = PC_ALIAS[code];
      if (handler) {
        var consumed = handler(code, ev);
        if (consumed !== false) { ev.preventDefault(); ev.stopPropagation(); }
      }
    }, false);
  }

  function exitApp() {
    try {
      if (typeof tizen !== 'undefined' && tizen.application) {
        tizen.application.getCurrentApplication().exit();
        return;
      }
    } catch (e) { }
    try { window.close(); } catch (e2) { }
  }

  return { CODE: CODE, init: init, onKey: onKey, exitApp: exitApp };
})();
