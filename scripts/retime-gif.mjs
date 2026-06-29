// Re-time every frame of an animated GIF to a fixed delay (no dependencies).
// GIF frames are preceded by a Graphic Control Extension: 21 F9 04 <packed>
// <delayLo> <delayHi> <transIdx> 00 — the 2-byte delay is in centiseconds.
//
// Usage: node scripts/retime-gif.mjs <file.gif> [centiseconds=100]
import fs from 'node:fs';

const file = process.argv[2];
const cs = Number(process.argv[3]) || 100; // 100 cs = 1.00s per frame
if (!file) { console.error('usage: node scripts/retime-gif.mjs <file.gif> [centiseconds]'); process.exit(1); }

const b = fs.readFileSync(file);
const before = [];
let n = 0;
for (let i = 0; i < b.length - 7; i++) {
  if (b[i] === 0x21 && b[i + 1] === 0xF9 && b[i + 2] === 0x04 && b[i + 7] === 0x00) {
    before.push(b[i + 4] | (b[i + 5] << 8));
    b[i + 4] = cs & 0xFF;
    b[i + 5] = (cs >> 8) & 0xFF;
    n++;
  }
}
fs.writeFileSync(file, b);
console.log(`frames: ${n}`);
console.log(`old delays (cs): ${before.join(', ')}`);
console.log(`new delay: ${cs}cs (${cs / 100}s) per frame  →  loop ≈ ${(n * cs / 100).toFixed(1)}s`);
