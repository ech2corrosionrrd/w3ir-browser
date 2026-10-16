'use strict';
// Генерує build/icon.png (256x256): градієнтний квадрат із літерою W.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 256;
const buf = Buffer.alloc(N * N * 4);
const W = [[62, 74], [98, 188], [128, 112], [158, 188], [194, 74]];

function distSeg(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function sample(x, y) {
  const r = 52, m = 8;
  const cx = Math.max(m + r, Math.min(N - m - r, x)), cy = Math.max(m + r, Math.min(N - m - r, y));
  if (Math.hypot(x - cx, y - cy) > r) return [0, 0, 0, 0];
  let d = 1e9;
  for (let i = 0; i < W.length - 1; i++) d = Math.min(d, distSeg(x, y, W[i], W[i + 1]));
  if (d < 10) return [255, 255, 255, 255];
  const t = (x + y) / (2 * N);
  return [Math.round(90 + t * 70), Math.round(141 - t * 60), Math.round(238 - t * 20), 255];
}

for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const acc = [0, 0, 0, 0];
  for (const [ox, oy] of [[.25, .25], [.75, .25], [.25, .75], [.75, .75]]) {
    const s = sample(x + ox, y + oy);
    for (let k = 0; k < 4; k++) acc[k] += s[k] / 4;
  }
  const o = (y * N + x) * 4;
  for (let k = 0; k < 4; k++) buf[o + k] = Math.round(acc[k]);
}

const rows = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) { rows[y * (N * 4 + 1)] = 0; buf.copy(rows, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4); }

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(path.join(__dirname, 'icon.png'), Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
]));
console.log('icon.png written');
