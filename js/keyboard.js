/* On-screen keyboard driven by the remote. Alphabetical layout: on a TV it is
   faster to find a letter this way than on QWERTY. */
var Keyboard = (function () {

  var LAYOUT = [
    ['A', 'B', 'C', 'Ç', 'D', 'E', 'F', 'G', 'Ğ'],
    ['H', 'I', 'İ', 'J', 'K', 'L', 'M', 'N', 'O'],
    ['Ö', 'P', 'Q', 'R', 'S', 'Ş', 'T', 'U', 'Ü'],
    ['V', 'W', 'X', 'Y', 'Z', '0', '1', '2', '3'],
    ['4', '5', '6', '7', '8', '9', '-', '+', '.'],
    [{ k: 'search.space', v: ' ', w: 4 }, { k: 'search.delete', v: '\b', w: 2.5 },
     { k: 'search.clear', v: '\x00', w: 2.5 }]
  ];

  function create(container, onInput) {
    var cells = [];   /* [row][col] -> {el, val} */
    container.innerHTML = '';

    for (var r = 0; r < LAYOUT.length; r++) {
      var rowEl = U.el('div', 'kbrow');
      var row = [];
      for (var c = 0; c < LAYOUT[r].length; c++) {
        var def = LAYOUT[r][c];
        var val = typeof def === 'string' ? def : def.v;
        var txt = typeof def === 'string' ? def : T(def.k);
        var wide = typeof def === 'object' && def.w;
        var k = U.el('div', 'kb' + (wide ? ' wide' : ''), U.esc(txt));
        if (wide) k.style.flex = String(def.w);
        rowEl.appendChild(k);
        row.push({ el: k, val: val });
      }
      cells.push(row);
      container.appendChild(rowEl);
    }

    var cur = { r: 0, c: 0 };

    function paint(on) {
      for (var r = 0; r < cells.length; r++)
        for (var c = 0; c < cells[r].length; c++)
          cells[r][c].el.className = cells[r][c].el.className.replace(/ focus/g, '');
      if (on) {
        var cell = cells[cur.r][cur.c];
        cell.el.className += ' focus';
      }
    }

    function move(dr, dc) {
      var r = cur.r + dr, c = cur.c + dc;
      if (r < 0) return false;
      if (r >= cells.length) return false;
      if (dr !== 0) {
        /* keep the horizontal ratio when moving between rows */
        var ratio = cur.c / Math.max(1, cells[cur.r].length - 1);
        c = Math.round(ratio * (cells[r].length - 1));
      }
      if (c < 0) return false;
      if (c >= cells[r].length) return false;
      cur.r = r; cur.c = c;
      paint(true);
      return true;
    }

    function press() {
      var v = cells[cur.r][cur.c].val;
      onInput(v);
    }

    return {
      focus: function () { paint(true); },
      blur: function () { paint(false); },
      move: move,
      press: press,
      atRightEdge: function () { return cur.c >= cells[cur.r].length - 1; }
    };
  }

  return { create: create };
})();
