/**
 * 纯 JS 图像工具：PNG 解码 + JPEG 编码。
 *
 * 为什么自带而不调外部程序：
 *  - 导出 JPG 需要编码器，Node 只内置 zlib；靠 sips/ImageMagick 会让"换个系统就不能用"。
 *  - 自己的编码器 + 固定质量参数，跨平台导出结果一致，测试也好写。
 *
 * 只实现实际会遇到的子集：8/16bit、非隔行、灰度/RGB/RGBA 的 PNG；
 * JPEG 为标准 baseline、4:4:4（不降采样，保证文字边缘清晰）。
 */
import zlib from 'node:zlib';

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 判断是否 PNG。 */
export function isPng(buffer) {
  if (buffer.length < 8) return false;
  return PNG_SIGNATURE.every((byte, index) => buffer[index] === byte);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解码 PNG 为 RGBA。
 * @param {Buffer|Uint8Array} buffer
 * @returns {{width:number, height:number, data:Uint8Array}}
 */
export function decodePng(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!isPng(buf)) throw new Error('不是 PNG 文件');
  let offset = 8;
  let header = null;
  const idat = [];
  let palette = null;
  let transparency = null;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end > buf.length) break;
    if (type === 'IHDR') {
      header = {
        width: buf.readUInt32BE(start),
        height: buf.readUInt32BE(start + 4),
        bitDepth: buf[start + 8],
        colorType: buf[start + 9],
        compression: buf[start + 10],
        filter: buf[start + 11],
        interlace: buf[start + 12],
      };
    } else if (type === 'PLTE') {
      palette = buf.subarray(start, end);
    } else if (type === 'tRNS') {
      transparency = buf.subarray(start, end);
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }
  if (!header) throw new Error('PNG 缺少 IHDR');
  const { width, height, bitDepth, colorType, interlace } = header;
  if (interlace !== 0) throw new Error('暂不支持隔行 PNG');
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`暂不支持 ${bitDepth}bit PNG`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`暂不支持 PNG colorType=${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const sampleBytes = bitDepth === 16 ? 2 : 1;
  const bpp = channels * sampleBytes;
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let pos = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    for (let i = 0; i < stride; i += 1) {
      const value = raw[pos + i] ?? 0;
      const left = i >= bpp ? line[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      let restored;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`未知 PNG 行过滤类型 ${filter}`);
      }
      line[i] = restored & 0xff;
    }
    pos += stride;
    for (let x = 0; x < width; x += 1) {
      const src = x * bpp;
      const dst = (y * width + x) * 4;
      const sample = (channel) => line[src + channel * sampleBytes];
      if (colorType === 0) {
        const gray = sample(0);
        out[dst] = gray;
        out[dst + 1] = gray;
        out[dst + 2] = gray;
        out[dst + 3] = 255;
      } else if (colorType === 4) {
        const gray = sample(0);
        out[dst] = gray;
        out[dst + 1] = gray;
        out[dst + 2] = gray;
        out[dst + 3] = sample(1);
      } else if (colorType === 2) {
        out[dst] = sample(0);
        out[dst + 1] = sample(1);
        out[dst + 2] = sample(2);
        out[dst + 3] = 255;
      } else if (colorType === 6) {
        out[dst] = sample(0);
        out[dst + 1] = sample(1);
        out[dst + 2] = sample(2);
        out[dst + 3] = sample(3);
      } else if (colorType === 3) {
        const index = line[src];
        const pr = palette ? palette[index * 3] : 0;
        const pg = palette ? palette[index * 3 + 1] : 0;
        const pb = palette ? palette[index * 3 + 2] : 0;
        out[dst] = pr;
        out[dst + 1] = pg;
        out[dst + 2] = pb;
        out[dst + 3] = transparency && transparency[index] != null ? transparency[index] : 255;
      }
    }
    prev.set(line);
  }
  return { width, height, data: out };
}

// ---------------------------------------------------------------------------
// JPEG 编码（baseline，4:4:4）
// ---------------------------------------------------------------------------

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
];

const STD_LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51,
  87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

const STD_CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99,
];

const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];

const DC_LUMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_CHROMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14,
  0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09,
  0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a,
  0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65,
  0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88,
  0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
  0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
  0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
const AC_CHROMA_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32,
  0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16,
  0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39,
  0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64,
  0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86,
  0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8,
  0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
  0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

/** 由 BITS/HUFFVAL 生成规范 Huffman 码表：code[value] = {code, length} */
function buildHuffmanTable(bits, values) {
  const table = new Map();
  let code = 0;
  let valueIndex = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < bits[length - 1]; i += 1) {
      table.set(values[valueIndex], { code, length });
      valueIndex += 1;
      code += 1;
    }
    code <<= 1;
  }
  return table;
}

const HUFF = {
  dcLuma: buildHuffmanTable(DC_LUMA_BITS, DC_LUMA_VALS),
  dcChroma: buildHuffmanTable(DC_CHROMA_BITS, DC_CHROMA_VALS),
  acLuma: buildHuffmanTable(AC_LUMA_BITS, AC_LUMA_VALS),
  acChroma: buildHuffmanTable(AC_CHROMA_BITS, AC_CHROMA_VALS),
};

class BitWriter {
  constructor() {
    this.chunks = [];
    this.bytes = [];
    this.accumulator = 0;
    this.count = 0;
  }

  writeBits(code, length) {
    this.accumulator = (this.accumulator << length) | (code & ((1 << length) - 1));
    this.count += length;
    while (this.count >= 8) {
      const byte = (this.accumulator >> (this.count - 8)) & 0xff;
      this.bytes.push(byte);
      if (byte === 0xff) this.bytes.push(0x00);
      this.count -= 8;
      if (this.bytes.length > 1 << 16) {
        this.chunks.push(Buffer.from(this.bytes));
        this.bytes = [];
      }
    }
    this.accumulator &= (1 << this.count) - 1;
  }

  finish() {
    if (this.count > 0) this.writeBits(0x7f, 8 - this.count);
    if (this.bytes.length) this.chunks.push(Buffer.from(this.bytes));
    this.bytes = [];
    return Buffer.concat(this.chunks);
  }
}

function qualityScale(quality) {
  const q = Math.min(100, Math.max(1, quality));
  return q < 50 ? Math.floor(5000 / q) : Math.floor(200 - q * 2);
}

function scaledQuantTable(base, quality) {
  const scale = qualityScale(quality);
  return base.map((value) => Math.min(255, Math.max(1, Math.floor((value * scale + 50) / 100))));
}

const COS = new Float64Array(64);
for (let x = 0; x < 8; x += 1) {
  for (let u = 0; u < 8; u += 1) {
    COS[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 : 1);
  }
}

/** 8x8 二维 DCT（分离式，够快且无第三方依赖）。 */
function fdct(block, out) {
  const temp = new Float64Array(64);
  for (let y = 0; y < 8; y += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let x = 0; x < 8; x += 1) sum += block[y * 8 + x] * COS[x * 8 + u];
      temp[y * 8 + u] = sum * 0.5;
    }
  }
  for (let u = 0; u < 8; u += 1) {
    for (let v = 0; v < 8; v += 1) {
      let sum = 0;
      for (let y = 0; y < 8; y += 1) sum += temp[y * 8 + u] * COS[y * 8 + v];
      out[v * 8 + u] = sum * 0.5;
    }
  }
}

const bitLength = (value) => {
  let magnitude = Math.abs(value);
  let length = 0;
  while (magnitude) {
    magnitude >>= 1;
    length += 1;
  }
  return length;
};

const categoryCode = (value, length) => {
  if (value >= 0) return value;
  return value + (1 << length) - 1;
};

let lastDc = [0, 0, 0];

function encodeBlock(writer, block, quantTable, dcTable, acTable, component) {
  const dct = new Float64Array(64);
  fdct(block, dct);
  const quantized = new Int32Array(64);
  for (let i = 0; i < 64; i += 1) {
    quantized[i] = Math.round(dct[ZIGZAG[i]] / quantTable[ZIGZAG[i]]);
  }
  const diff = quantized[0] - lastDc[component];
  lastDc[component] = quantized[0];
  const diffLength = bitLength(diff);
  const dcEntry = HUFF[dcTable].get(diffLength);
  if (!dcEntry) throw new Error('JPEG DC Huffman 编码失败');
  writer.writeBits(dcEntry.code, dcEntry.length);
  if (diffLength) writer.writeBits(categoryCode(diff, diffLength), diffLength);

  let run = 0;
  for (let i = 1; i < 64; i += 1) {
    const value = quantized[i];
    if (value === 0) {
      run += 1;
      continue;
    }
    while (run > 15) {
      const zrl = HUFF[acTable].get(0xf0);
      writer.writeBits(zrl.code, zrl.length);
      run -= 16;
    }
    const length = bitLength(value);
    const symbol = (run << 4) | length;
    const entry = HUFF[acTable].get(symbol);
    if (!entry) throw new Error(`JPEG AC Huffman 编码失败: ${symbol}`);
    writer.writeBits(entry.code, entry.length);
    writer.writeBits(categoryCode(value, length), length);
    run = 0;
  }
  if (run > 0) {
    const eob = HUFF[acTable].get(0x00);
    writer.writeBits(eob.code, eob.length);
  }
}

function pushMarker(chunks, marker, payload) {
  chunks.push(Buffer.from([0xff, marker]));
  if (payload && payload.length) {
    const header = Buffer.alloc(2);
    header.writeUInt16BE(payload.length + 2, 0);
    chunks.push(header, payload);
  }
}

/**
 * 编码 baseline JPEG。
 * @param {{width:number, height:number, data:Uint8Array}} image RGBA 数据
 * @param {{quality?:number}} options
 * @returns {Buffer}
 */
export function encodeJpeg(image, options = {}) {
  const quality = Number.isFinite(options.quality) ? options.quality : 88;
  const { width, height, data } = image;
  const lumaQ = scaledQuantTable(STD_LUMA_Q, quality);
  const chromaQ = scaledQuantTable(STD_CHROMA_Q, quality);
  const chunks = [];
  pushMarker(chunks, 0xd8, null);

  // APP0 / JFIF
  const app0 = Buffer.alloc(14);
  app0.write('JFIF\0', 0, 'latin1');
  app0[5] = 1;
  app0[6] = 1;
  app0[7] = 0;
  app0.writeUInt16BE(1, 8);
  app0.writeUInt16BE(1, 10);
  app0[12] = 0;
  app0[13] = 0;
  pushMarker(chunks, 0xe0, app0);

  // DQT
  const dqtPayload = Buffer.alloc(2 + 128);
  dqtPayload[0] = 0x00;
  for (let i = 0; i < 64; i += 1) dqtPayload[1 + i] = lumaQ[ZIGZAG[i]];
  dqtPayload[65] = 0x01;
  for (let i = 0; i < 64; i += 1) dqtPayload[66 + i] = chromaQ[ZIGZAG[i]];
  pushMarker(chunks, 0xdb, dqtPayload);

  // SOF0（1 + 2 + 2 + 1 + 3*3 = 15 字节）
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3;
  sof[6] = 1;
  sof[7] = 0x11;
  sof[8] = 0;
  sof[9] = 2;
  sof[10] = 0x11;
  sof[11] = 1;
  sof[12] = 3;
  sof[13] = 0x11;
  sof[14] = 1;
  pushMarker(chunks, 0xc0, sof);

  // DHT
  const dhtTables = [
    [0x00, DC_LUMA_BITS, DC_LUMA_VALS],
    [0x10, AC_LUMA_BITS, AC_LUMA_VALS],
    [0x01, DC_CHROMA_BITS, DC_CHROMA_VALS],
    [0x11, AC_CHROMA_BITS, AC_CHROMA_VALS],
  ];
  for (const [id, bits, values] of dhtTables) {
    const payload = Buffer.alloc(1 + 16 + values.length);
    payload[0] = id;
    for (let i = 0; i < 16; i += 1) payload[1 + i] = bits[i];
    for (let i = 0; i < values.length; i += 1) payload[17 + i] = values[i];
    pushMarker(chunks, 0xc4, payload);
  }

  // SOS
  const sos = Buffer.alloc(10);
  sos[0] = 3;
  sos[1] = 1;
  sos[2] = 0x00;
  sos[3] = 2;
  sos[4] = 0x11;
  sos[5] = 3;
  sos[6] = 0x11;
  sos[7] = 0;
  sos[8] = 63;
  sos[9] = 0;
  pushMarker(chunks, 0xda, sos);

  const yBlock = new Float64Array(64);
  const cbBlock = new Float64Array(64);
  const crBlock = new Float64Array(64);
  const writer = new BitWriter();
  lastDc = [0, 0, 0];

  const accumulate = (block, sx, sy) => {
    let sum = 0;
    let count = 0;
    for (let y = 0; y < 8; y += 1) {
      const py = sy + y;
      if (py >= height) break;
      for (let x = 0; x < 8; x += 1) {
        const px = sx + x;
        if (px >= width) break;
        sum += block[py * width + px];
        count += 1;
      }
    }
    return count ? sum / count : 0;
  };

  const yPlane = new Float32Array(width * height);
  const cbPlane = new Float32Array(width * height);
  const crPlane = new Float32Array(width * height);
  for (let i = 0, p = 0; i < width * height; i += 1, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const alpha = data[p + 3] / 255;
    const rr = r * alpha + 255 * (1 - alpha);
    const gg = g * alpha + 255 * (1 - alpha);
    const bb = b * alpha + 255 * (1 - alpha);
    yPlane[i] = 0.299 * rr + 0.587 * gg + 0.114 * bb - 128;
    cbPlane[i] = -0.168736 * rr - 0.331264 * gg + 0.5 * bb;
    crPlane[i] = 0.5 * rr - 0.418688 * gg - 0.081312 * bb;
  }

  for (let sy = 0; sy < height; sy += 8) {
    for (let sx = 0; sx < width; sx += 8) {
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          const px = Math.min(width - 1, sx + x);
          const py = Math.min(height - 1, sy + y);
          const index = py * width + px;
          yBlock[y * 8 + x] = yPlane[index];
          cbBlock[y * 8 + x] = cbPlane[index];
          crBlock[y * 8 + x] = crPlane[index];
        }
      }
      encodeBlock(writer, yBlock, lumaQ, 'dcLuma', 'acLuma', 0);
      encodeBlock(writer, cbBlock, chromaQ, 'dcChroma', 'acChroma', 1);
      encodeBlock(writer, crBlock, chromaQ, 'dcChroma', 'acChroma', 2);
    }
  }
  chunks.push(writer.finish());
  pushMarker(chunks, 0xd9, null);
  void accumulate;
  return Buffer.concat(chunks);
}
