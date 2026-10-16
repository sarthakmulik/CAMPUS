const fs = require('fs')
const path = require('path')
// 64x64 purple PNG built from raw bytes (valid PNG signature + IHDR/IDAT/IEND)
const zlib = require('zlib')

const W = 64, H = 64
// raw image data: each row prefixed with filter byte 0
const raw = Buffer.alloc((W * 3 + 1) * H)
let p = 0
for (let y = 0; y < H; y++) {
  raw[p++] = 0
  for (let x = 0; x < W; x++) {
    raw[p++] = 102   // 0x66
    raw[p++] = 84    // 0x54
    raw[p++] = 245   // 0xF5
  }
}
const idat = zlib.deflateSync(raw)

function crc32(buf) {
  let table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crcBuf])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8   // bit depth
ihdr[9] = 2   // color type RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
])

const out = path.join(__dirname, 'avatar-test.png')
fs.writeFileSync(out, png)
console.log('wrote', out, png.length, 'bytes')
