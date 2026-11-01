/* On-device diagnostic log.
   Kept in memory only; nothing is ever sent off the device.
   Press INFO during playback to show the most recent lines on screen. */
var Log = (function () {

  var MAX = 80;
  var ring = [];
  var t0 = Date.now();

  function line(msg) {
    ring.push('[' + ((Date.now() - t0) / 1000).toFixed(1) + 's] ' + msg);
    if (ring.length > MAX) ring.shift();
    paint();
  }

  function paint() {
    var box = document.getElementById('debug-log');
    if (!box || box.className.indexOf('hidden') >= 0) return;
    var start = Math.max(0, ring.length - 16), out = '';
    for (var i = start; i < ring.length; i++) {
      out += String(ring[i]).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '<br>';
    }
    box.innerHTML = out;
  }

  function toggle() {
    var box = document.getElementById('debug-log');
    if (!box) return;
    box.className = (box.className.indexOf('hidden') >= 0) ? '' : 'hidden';
    paint();
  }

  window.onerror = function (msg, src, ln, col) {
    line('JS ERROR: ' + msg + ' @' + String(src).split('/').pop() + ':' + ln + ':' + col);
    return false;
  };

  return { line: line, toggle: toggle };
})();
