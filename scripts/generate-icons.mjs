import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const ROOT_DIR = process.cwd()
const BUILD_DIR = path.join(ROOT_DIR, 'build')

// Precompute CRC32 lookup table for PNG chunks
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)

  const crcInput = Buffer.concat([typeBuf, data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(crcInput), 0)

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

function encodePngRgba(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression method
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // interlace method

  // Use PNG Sub filter (type 1) per scanline for compact output
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const rowOut = y * (stride + 1)
    const rowIn = y * stride
    raw[rowOut] = 1
    for (let x = 0; x < stride; x++) {
      const cur = rgba[rowIn + x]
      const left = x >= 4 ? rgba[rowIn + x - 4] : 0
      raw[rowOut + 1 + x] = (cur - left) & 0xff
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0))
  ])
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/**
 * Signed distance to an axis-aligned rounded box centered at (cx, cy)
 * with half-extents (hx, hy) and corner radius r.
 */
function sdRoundedBox(px, py, cx, cy, hx, hy, r) {
  const dx = Math.abs(px - cx) - (hx - r)
  const dy = Math.abs(py - cy) - (hy - r)
  const ox = Math.max(dx, 0)
  const oy = Math.max(dy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r
}

/**
 * Signed distance to the crisp geometric 'T' glyph in normalized [0, 1] icon coordinates.
 */
function sdTGlyph(u, v) {
  // Bold geometric 'T' glyph: top horizontal bar + centered vertical stem
  const dTop = sdRoundedBox(u, v, 0.5, 0.32, 0.24, 0.065, 0.022)
  const dStem = sdRoundedBox(u, v, 0.5, 0.53, 0.072, 0.24, 0.022)
  return Math.min(dTop, dStem)
}

/**
 * Render an anti-aliased RGBA icon buffer of `size x size` using 4x4 supersampling.
 */
function renderAltTIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const samples = 4
  const invSamples = 1 / (samples * samples)
  const aaWidth = 1.15 / size

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let accR = 0
      let accG = 0
      let accB = 0
      let accA = 0

      for (let sy = 0; sy < samples; sy++) {
        const v = (y + (sy + 0.5) / samples) / size
        for (let sx = 0; sx < samples; sx++) {
          const u = (x + (sx + 0.5) / samples) / size

          // Outer rounded badge occupies [0.06, 0.94] so shadow/edges stay clean at all sizes
          const dBadge = sdRoundedBox(u, v, 0.5, 0.5, 0.44, 0.44, 0.19)
          const badgeAlpha = 1 - smoothstep(-aaWidth, aaWidth, dBadge)
          if (badgeAlpha <= 0) {
            continue
          }

          // Electric Indigo vertical gradient (#6366F1 -> #4338CA) with subtle top-left radial sheen
          const gradT = clamp01((v - 0.06) / 0.88)
          const sheen = Math.max(0, 1 - Math.hypot((u - 0.32) * 1.4, (v - 0.22) * 1.4)) * 0.14
          let r = 99 + (67 - 99) * gradT + sheen * 70
          let g = 102 + (56 - 102) * gradT + sheen * 75
          let b = 241 + (202 - 241) * gradT + sheen * 30

          // Subtle inner rim highlight near top edge
          if (dBadge > -0.028 && v < 0.55) {
            const rim = smoothstep(-0.028, -0.004, dBadge) * (1 - smoothstep(0.15, 0.55, v)) * 0.22
            r = r * (1 - rim) + 255 * rim
            g = g * (1 - rim) + 255 * rim
            b = b * (1 - rim) + 255 * rim
          }

          // Soft drop shadow beneath the 'T' glyph
          const dShadow = sdTGlyph(u, v - 0.022)
          const shadowCov = (1 - smoothstep(-0.015, 0.032, dShadow)) * 0.24
          r *= 1 - shadowCov
          g *= 1 - shadowCov
          b *= 1 - shadowCov

          // Crisp white 'T' glyph
          const dGlyph = sdTGlyph(u, v)
          const glyphCov = 1 - smoothstep(-aaWidth, aaWidth, dGlyph)
          r = r * (1 - glyphCov) + 255 * glyphCov
          g = g * (1 - glyphCov) + 255 * glyphCov
          b = b * (1 - glyphCov) + 255 * glyphCov

          // Premultiply for accurate supersample averaging
          accR += r * badgeAlpha
          accG += g * badgeAlpha
          accB += b * badgeAlpha
          accA += badgeAlpha
        }
      }

      const avgA = accA * invSamples
      const idx = (y * size + x) * 4
      if (avgA > 0.0001) {
        rgba[idx] = Math.min(255, Math.round((accR * invSamples) / avgA))
        rgba[idx + 1] = Math.min(255, Math.round((accG * invSamples) / avgA))
        rgba[idx + 2] = Math.min(255, Math.round((accB * invSamples) / avgA))
        rgba[idx + 3] = Math.min(255, Math.round(avgA * 255))
      }
    }
  }

  return rgba
}

function encodeIcoFromPngs(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type 1 = ICO
  header.writeUInt16LE(entries.length, 4)

  const dirSize = entries.length * 16
  let offset = 6 + dirSize
  const dirBuffers = []
  const dataBuffers = []

  for (const { size, png } of entries) {
    const dir = Buffer.alloc(16)
    dir[0] = size >= 256 ? 0 : size
    dir[1] = size >= 256 ? 0 : size
    dir[2] = 0 // color count (0 = >=8bpp)
    dir[3] = 0 // reserved
    dir.writeUInt16LE(1, 4) // color planes
    dir.writeUInt16LE(32, 6) // bits per pixel
    dir.writeUInt32LE(png.length, 8)
    dir.writeUInt32LE(offset, 12)
    dirBuffers.push(dir)
    dataBuffers.push(png)
    offset += png.length
  }

  return Buffer.concat([header, ...dirBuffers, ...dataBuffers])
}

function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true })

  const pngBySize = new Map()
  for (const size of ICO_SIZES) {
    const rgba = renderAltTIcon(size)
    pngBySize.set(size, encodePngRgba(size, size, rgba))
  }

  // Generate 512x512 master PNG for build/icon.png
  const masterPng = encodePngRgba(512, 512, renderAltTIcon(512))
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), masterPng)

  // Generate explicit helper PNG sizes
  for (const extraSize of [16, 32, 256]) {
    const png = pngBySize.get(extraSize)
    if (png) {
      fs.writeFileSync(path.join(BUILD_DIR, `icon-${extraSize}.png`), png)
    }
  }

  // Generate multi-size icon.ico (16, 24, 32, 48, 64, 128, 256)
  const icoEntries = ICO_SIZES.map((size) => ({
    size,
    png: pngBySize.get(size)
  }))
  const icoBuffer = encodeIcoFromPngs(icoEntries)
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), icoBuffer)

  console.log(
    `[icons] Generated build/icon.png (512x512, ${masterPng.length}B), build/icon-{16,32,256}.png, and build/icon.ico (${ICO_SIZES.join(',')}px, ${icoBuffer.length}B)`
  )
}

main()
