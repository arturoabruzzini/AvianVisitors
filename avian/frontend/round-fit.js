// Round-fit geometry for the kiosk's shape=round mode (the watch tile / phone
// widget render). Plain functions over the collage packer's tile shape -
// { x, y, fullW, fullH, mask: { w, h, cells } } - so they can be unit-tested
// under node and loaded into the page as window.RoundFit ahead of apt.js.
//
// Distances are measured to the bird's actual outline (its opaque mask
// cells), not its bounding box: a round layout measured by box corners would
// either overflow the disc or leave its rim empty.
(function (root) {
  // Farthest point of any opaque mask cell from (cx, cy), for the tile drawn
  // with its top-left at (tx, ty). Each cell is a rectangle, so its farthest
  // point from the centre is one of its corners.
  function tileRadius(tile, tx, ty, cx, cy) {
    var sx = tile.fullW / tile.mask.w, sy = tile.fullH / tile.mask.h;
    var cells = tile.mask.cells, best = 0;
    for (var i = 0; i < cells.length; i++) {
      var x0 = tx + cells[i][0] * sx - cx, y0 = ty + cells[i][1] * sy - cy;
      var dx = Math.max(Math.abs(x0), Math.abs(x0 + sx));
      var dy = Math.max(Math.abs(y0), Math.abs(y0 + sy));
      var d2 = dx * dx + dy * dy;
      if (d2 > best) best = d2;
    }
    return Math.sqrt(best);
  }

  function clusterRadius(tiles, cx, cy) {
    var r = 0;
    tiles.forEach(function (t) {
      if (t.x < -1000) return; // hidden: the packer could not place it
      r = Math.max(r, tileRadius(t, t.x, t.y, cx, cy));
    });
    return r;
  }

  // Scale every placed tile about (cx, cy) so the cluster's outline radius
  // becomes exactly r. Scaling about the centre scales every cell rectangle,
  // and so every distance, by the same factor.
  function scaleToRadius(tiles, cx, cy, r) {
    var cur = clusterRadius(tiles, cx, cy);
    if (!cur) return 1;
    var k = r / cur;
    tiles.forEach(function (t) {
      if (t.x < -1000) return;
      t.x = cx + (t.x - cx) * k;
      t.y = cy + (t.y - cy) * k;
      t.fullW *= k; t.fullH *= k;
    });
    return k;
  }

  function circleRadius(W, H, fill) { return Math.min(W, H) / 2 * fill; }

  var api = { tileRadius: tileRadius, clusterRadius: clusterRadius,
              scaleToRadius: scaleToRadius, circleRadius: circleRadius };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RoundFit = api;
})(this);
