import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const RF = require('../../avian/frontend/round-fit.js');

// A 2x2 mask with only the top-left cell opaque, drawn 100x100 at (tx, ty):
// the opaque cell covers [tx, tx+50] x [ty, ty+50].
const corner = { w: 2, h: 2, cells: [[0, 0]] };
const tile = (x, y, mask = corner) => ({ x, y, fullW: 100, fullH: 100, mask });

test('tileRadius is the farthest corner of any opaque cell', () => {
  // Cell spans x 0..50, y 0..50 around centre (0,0): farthest corner (50,50).
  assert.equal(RF.tileRadius(tile(0, 0), 0, 0, 0, 0), Math.hypot(50, 50));
});

test('tileRadius ignores transparent cells', () => {
  // Same tile placed left-up of centre: opaque cell spans -100..-50, the far
  // corner is (-100,-100); the transparent cells reaching (0,0) do not matter.
  assert.equal(RF.tileRadius(tile(-100, -100), -100, -100, 0, 0), Math.hypot(100, 100));
});

test('clusterRadius skips hidden tiles', () => {
  const hidden = tile(-99999, -99999);
  assert.equal(RF.clusterRadius([tile(0, 0), hidden], 0, 0), Math.hypot(50, 50));
});

test('clusterRadius of nothing is 0', () => {
  assert.equal(RF.clusterRadius([], 0, 0), 0);
});

test('scaleToRadius makes the cluster radius exactly r', () => {
  const tiles = [tile(10, 20), tile(-120, 5)];
  const k = RF.scaleToRadius(tiles, 0, 0, 300);
  assert.ok(k > 0);
  assert.ok(Math.abs(RF.clusterRadius(tiles, 0, 0) - 300) < 1e-9);
});

test('scaleToRadius leaves hidden tiles hidden', () => {
  const hidden = tile(-99999, -99999);
  RF.scaleToRadius([tile(0, 0), hidden], 0, 0, 10);
  assert.equal(hidden.x, -99999);
});

test('circleRadius uses the smaller side', () => {
  assert.equal(RF.circleRadius(800, 600, 0.96), 288);
});
