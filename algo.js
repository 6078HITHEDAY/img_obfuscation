/* 图片混淆算法核心（纯函数，不依赖 DOM）
 * 数据格式：RGBA，Uint8ClampedArray / Uint8Array，长度 = width * height * 4
 * 所有算法都可逆：encrypt -> decrypt 必须逐像素还原
 *
 * 可逆标识（marker）：加密后把一行元数据追加到图像最底部（height+1）。
 * 固定位置：最后一行；格式见 MARKER_* / appendMarker 注释。
 * 无标识的旧图仍可手动选模式解密；解密时若检测到标识会先裁掉末行再运算。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && typeof module.exports === 'object') module.exports = api;
  else root.ImgObf = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PHI = (Math.sqrt(5) - 1) / 2; // 0.6180339887498949

  const MARKER_MAGIC0 = 0x49; // I
  const MARKER_MAGIC1 = 0x4F; // O
  const MARKER_MAGIC2 = 0x42; // B
  const MARKER_MAGIC3 = 0x46; // F
  const MARKER_VERSION = 1;
  const MARKER_MIN_WIDTH = 4; // 无种子时至少 12 字节 → 4 像素
  const MODE_ID = { tomato: 1, serpentine: 2, blocks: 3, rows: 4, xor: 5 };
  const ID_MODE = ['', 'tomato', 'serpentine', 'blocks', 'rows', 'xor'];

  function sign(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); }

  /* ---------- 通用工具 ---------- */

  function hashSeed(str) {
    // FNV-1a 32bit
    let h = 2166136261 >>> 0;
    str = String(str);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function asU32(data, n) {
    if (data.byteOffset % 4 === 0 && data.byteOffset + n * 4 <= data.buffer.byteLength) {
      return new Uint32Array(data.buffer, data.byteOffset, n);
    }
    const tmp = new Uint8Array(n * 4);
    tmp.set(data.subarray(0, n * 4));
    return new Uint32Array(tmp.buffer);
  }

  // 标准 CRC-32（ISO 3309），表延迟初始化一次
  let CRC_TABLE = null;
  function crc32(bytes, len) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        CRC_TABLE[n] = c >>> 0;
      }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < len; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    // 极简回退（覆盖 BMP 常用字符）
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; ) {
      const c = bytes[i++];
      if (c < 0x80) s += String.fromCharCode(c);
      else if ((c & 0xE0) === 0xC0) s += String.fromCharCode(((c & 31) << 6) | (bytes[i++] & 63));
      else {
        s += String.fromCharCode(((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
      }
    }
    return s;
  }

  /* ---------- 可逆标识（末行） ----------
   *
   * 位置：图像最底部一整行（y = height-1），不改动上方任何混淆像素。
   * 编码：每个像素 RGB 各存 1 字节，A 固定 255（PNG 无损可往返）。
   *
   * 字节布局：
   *   0..3   magic = "IOBF"
   *   4      version = 1
   *   5      modeId  = 1..5（tomato/serpentine/blocks/rows/xor）
   *   6      flags   bit0=含种子
   *   7      seedLen
   *   8..    seed UTF-8（可因行宽截断；截断时 flags.bit0=0）
   *   末 4B  CRC32（覆盖此前全部字节，小端）
   *
   * 容量：一行最多 floor(width*3) 字节；无种子最少 12 字节（宽≥4）。
   * 加密默认写入（opts.marker !== false）；与原版小番茄逐字节互通时请传 marker:false。
   */

  function buildMarkerPayload(mode, seed, maxBytes) {
    const modeId = MODE_ID[mode];
    if (!modeId) return null;
    // header(8) + crc(4) = 12；剩余给种子
    const overhead = 12;
    if (maxBytes < overhead) return null;

    let seedBytes = utf8Encode(seed == null ? '' : String(seed));
    const maxSeed = maxBytes - overhead;
    let flags = 0;
    if (seedBytes.length > 0 && maxSeed > 0) {
      if (seedBytes.length > maxSeed) seedBytes = seedBytes.subarray(0, 0); // 放不下则不写种子，仍写模式
      else flags |= 1;
    } else {
      seedBytes = new Uint8Array(0);
    }
    if (!(flags & 1)) seedBytes = new Uint8Array(0);

    const bodyLen = 8 + seedBytes.length;
    const buf = new Uint8Array(bodyLen + 4);
    buf[0] = MARKER_MAGIC0; buf[1] = MARKER_MAGIC1;
    buf[2] = MARKER_MAGIC2; buf[3] = MARKER_MAGIC3;
    buf[4] = MARKER_VERSION;
    buf[5] = modeId;
    buf[6] = flags;
    buf[7] = seedBytes.length;
    buf.set(seedBytes, 8);
    const c = crc32(buf, bodyLen);
    buf[bodyLen] = c & 255;
    buf[bodyLen + 1] = (c >>> 8) & 255;
    buf[bodyLen + 2] = (c >>> 16) & 255;
    buf[bodyLen + 3] = (c >>> 24) & 255;
    return buf;
  }

  function parseMarkerRow(rowBytes, width) {
    // rowBytes: Uint8Array length width*4
    if (width < MARKER_MIN_WIDTH || rowBytes.length < width * 4) return null;
    const maxBytes = width * 3;
    const packed = new Uint8Array(maxBytes);
    for (let x = 0, p = 0; x < width; x++, p += 3) {
      const o = x * 4;
      packed[p] = rowBytes[o];
      packed[p + 1] = rowBytes[o + 1];
      packed[p + 2] = rowBytes[o + 2];
      if (rowBytes[o + 3] !== 255) return null; // 要求不透明，降低误检
    }
    if (packed[0] !== MARKER_MAGIC0 || packed[1] !== MARKER_MAGIC1 ||
        packed[2] !== MARKER_MAGIC2 || packed[3] !== MARKER_MAGIC3) return null;
    if (packed[4] !== MARKER_VERSION) return null;
    const modeId = packed[5];
    const mode = ID_MODE[modeId];
    if (!mode) return null;
    const flags = packed[6];
    const seedLen = packed[7];
    if (seedLen > 200) return null;
    const bodyLen = 8 + seedLen;
    if (bodyLen + 4 > maxBytes) return null;
    const expect = crc32(packed, bodyLen);
    const got = packed[bodyLen] | (packed[bodyLen + 1] << 8) |
      (packed[bodyLen + 2] << 16) | (packed[bodyLen + 3] << 24);
    if ((expect >>> 0) !== (got >>> 0)) return null;

    let seed = '';
    if ((flags & 1) && seedLen > 0) {
      seed = utf8Decode(packed.subarray(8, 8 + seedLen));
    }
    return { mode: mode, seed: seed, version: MARKER_VERSION, hasSeed: !!(flags & 1) };
  }

  function appendMarker(data, w, h, mode, seed) {
    if (w < MARKER_MIN_WIDTH) return { data: data, width: w, height: h, marked: false };
    const payload = buildMarkerPayload(mode, seed, w * 3);
    if (!payload) return { data: data, width: w, height: h, marked: false };

    const out = new Uint8ClampedArray(w * (h + 1) * 4);
    out.set(data.subarray(0, w * h * 4));
    const rowOff = w * h * 4;
    // 先用确定性噪声填满末行，再覆盖有效载荷像素，避免「一条黑线」
    const rnd = mulberry32(hashSeed('IOBF|' + mode + '|' + w + 'x' + h));
    for (let x = 0; x < w; x++) {
      const o = rowOff + x * 4;
      const v = (rnd() * 0x1000000) | 0;
      out[o] = v & 255;
      out[o + 1] = (v >>> 8) & 255;
      out[o + 2] = (v >>> 16) & 255;
      out[o + 3] = 255;
    }
    for (let i = 0, x = 0; i < payload.length; x++) {
      const o = rowOff + x * 4;
      out[o] = payload[i++];
      out[o + 1] = i < payload.length ? payload[i++] : out[o + 1];
      out[o + 2] = i < payload.length ? payload[i++] : out[o + 2];
      out[o + 3] = 255;
    }
    return { data: out, width: w, height: h + 1, marked: true };
  }

  function stripMarkerIfPresent(data, w, h) {
    if (h < 2 || w < MARKER_MIN_WIDTH) return { data: data, width: w, height: h, marker: null };
    const rowOff = w * (h - 1) * 4;
    const row = data.subarray(rowOff, rowOff + w * 4);
    const marker = parseMarkerRow(row, w);
    if (!marker) return { data: data, width: w, height: h, marker: null };
    const body = data.subarray(0, rowOff);
    // 拷贝以免与原 buffer 共享（后续算法可能再分配）
    const cropped = new Uint8ClampedArray(body.length);
    cropped.set(body);
    return { data: cropped, width: w, height: h - 1, marker: marker };
  }

  function inspect(data, width, height) {
    if (!(width > 0 && height > 0) || !data || data.length !== width * height * 4) return null;
    const rowOff = width * (height - 1) * 4;
    return parseMarkerRow(data.subarray(rowOff, rowOff + width * 4), width);
  }

  /* ---------- Gilbert（广义 Hilbert）曲线 ---------- */

  function gilbertCurve(width, height) {
    const total = width * height;
    const out = new Int32Array(total);
    let i = 0;

    function gen(x, y, ax, ay, bx, by) {
      const w = Math.abs(ax + ay);
      const h = Math.abs(bx + by);
      const dax = sign(ax), day = sign(ay);
      const dbx = sign(bx), dby = sign(by);

      if (h === 1) {
        for (let k = 0; k < w; k++) { out[i++] = y * width + x; x += dax; y += day; }
        return;
      }
      if (w === 1) {
        for (let k = 0; k < h; k++) { out[i++] = y * width + x; x += dbx; y += dby; }
        return;
      }

      // Python 的 // 是向下取整，负坐标时必须用 floor
      let ax2 = Math.floor(ax / 2), ay2 = Math.floor(ay / 2);
      let bx2 = Math.floor(bx / 2), by2 = Math.floor(by / 2);
      const w2 = Math.abs(ax2 + ay2), h2 = Math.abs(bx2 + by2);

      if (2 * w > 3 * h) {
        if ((w2 % 2) && w > 2) { ax2 += dax; ay2 += day; }
        gen(x, y, ax2, ay2, bx, by);
        gen(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by);
      } else {
        if ((h2 % 2) && h > 2) { bx2 += dbx; by2 += dby; }
        gen(x, y, bx2, by2, ax2, ay2);
        gen(x + bx2, y + by2, ax, ay, bx - bx2, by - by2);
        gen(x + (ax - dax) + (bx2 - dbx), y + (ay - day) + (by2 - dby),
          -bx2, -by2, -(ax - ax2), -(ay - ay2));
      }
    }

    if (width >= height) gen(0, 0, width, 0, 0, height);
    else gen(0, 0, 0, height, width, 0);
    if (i !== total) throw new Error('Gilbert 曲线生成异常：' + i + '/' + total);
    return out;
  }

  /* ---------- 置换表 ---------- */

  // perm[dst] = src（加密） / perm[src] = dst（解密）
  function buildPerm(curve, offset, step, inverse) {
    const total = curve.length;
    const perm = new Int32Array(total);
    for (let c = 0; c < total; c++) {
      const src = curve[c];
      const dst = curve[(c + offset) % total];
      if (inverse) perm[src] = dst;
      else perm[dst] = src;
    }
    return powerPerm(perm, step);
  }

  function powerPerm(map, steps) {
    const n = map.length;
    // 双缓冲，避免每步都 new
    let final = new Int32Array(n);
    let finalTmp = new Int32Array(n);
    for (let i = 0; i < n; i++) final[i] = i;
    let cur = map;
    let curTmp = new Int32Array(n);
    while (steps > 0) {
      if (steps & 1) {
        for (let i = 0; i < n; i++) finalTmp[i] = cur[final[i]];
        const swap = final; final = finalTmp; finalTmp = swap;
      }
      steps >>= 1;
      if (steps > 0) {
        for (let i = 0; i < n; i++) curTmp[i] = cur[cur[i]];
        const swap = cur; cur = curTmp; curTmp = (swap === map ? new Int32Array(n) : swap);
      }
    }
    return final;
  }

  function permute(data, w, h, perm) {
    const n = w * h;
    const src = asU32(data, n);
    const outData = new Uint8ClampedArray(n * 4);
    const out = new Uint32Array(outData.buffer);
    for (let j = 0; j < n; j++) out[j] = src[perm[j]];
    return outData;
  }

  /* ---------- 边缘填充 / 裁剪（小番茄密码用） ---------- */

  function padRGBA(data, w, h, extraCols, extraRows) {
    if (!extraCols && !extraRows) return data;
    const nw = w + extraCols, nh = h + extraRows;
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < h; y++) {
      out.set(data.subarray(y * w * 4, (y + 1) * w * 4), y * nw * 4);
      if (extraCols) {
        const px = data.subarray((y * w + w - 1) * 4, (y * w + w) * 4);
        for (let x = w; x < nw; x++) out.set(px, (y * nw + x) * 4);
      }
    }
    if (extraRows) {
      const lastRow = out.subarray((h - 1) * nw * 4, h * nw * 4);
      for (let y = h; y < nh; y++) out.set(lastRow, y * nw * 4);
    }
    return out;
  }

  function cropRGBA(data, w, h, cw, ch) {
    if (cw === w && ch === h) return data;
    const out = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      out.set(data.subarray(y * w * 4, (y * w + cw) * 4), y * cw * 4);
    }
    return out;
  }

  /* ---------- 模式：小番茄 ---------- */

  function parseTomatoPw(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) s = '0000';
    if (!/^\d{4}$/.test(s)) throw new Error('小番茄密码必须是 4 位数字（例如 0000）');
    return {
      step: Math.max(1, parseInt(s.slice(0, 2), 10)),
      padCols: parseInt(s[2], 10),
      padRows: parseInt(s[3], 10)
    };
  }

  function tomato(data, w, h, pwStr, dir) {
    const pw = parseTomatoPw(pwStr);
    if (dir === 'decrypt') {
      const cw = w - pw.padCols, ch = h - pw.padRows;
      if (cw < 1 || ch < 1) throw new Error('图片尺寸与密码中的填充位数不符，无法还原');
      data = cropRGBA(data, w, h, cw, ch);
      w = cw; h = ch;
    }
    const curve = gilbertCurve(w, h);
    const offset = Math.round(PHI * w * h);
    const perm = buildPerm(curve, offset, pw.step, dir === 'decrypt');
    data = permute(data, w, h, perm);
    if (dir === 'encrypt') {
      data = padRGBA(data, w, h, pw.padCols, pw.padRows);
      w += pw.padCols; h += pw.padRows;
    }
    return { data: data, width: w, height: h };
  }

  /* ---------- 模式：蛇形扫描 ---------- */

  function serpentine(data, w, h, seed, dir) {
    const total = w * h;
    const curve = new Int32Array(total);
    let i = 0;
    for (let y = 0; y < h; y++) {
      if (y & 1) for (let x = w - 1; x >= 0; x--) curve[i++] = y * w + x;
      else for (let x = 0; x < w; x++) curve[i++] = y * w + x;
    }
    let offset = Math.round(PHI * total);
    if (seed) offset = (offset + hashSeed(seed) % total) % total;
    const perm = buildPerm(curve, offset, 1, dir === 'decrypt');
    return { data: permute(data, w, h, perm), width: w, height: h };
  }

  /* ---------- 模式：分块打乱 ---------- */

  function blockShuffle(data, w, h, seed, dir) {
    let bs = 32;
    while (bs > 2 && (Math.floor(w / bs) < 2 || Math.floor(h / bs) < 2)) bs >>= 1;
    const cols = Math.floor(w / bs), rows = Math.floor(h / bs), m = cols * rows;
    const src = asU32(data, w * h);
    if (m < 2) return new Uint8ClampedArray(data);

    const rnd = mulberry32(hashSeed(seed || 'default'));
    const order = new Int32Array(m);
    for (let i = 0; i < m; i++) order[i] = i;
    for (let i = m - 1; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    const rot = new Uint8Array(m);
    for (let i = 0; i < m; i++) rot[i] = (rnd() * 4) | 0;
    const inv = new Int32Array(m);
    for (let i = 0; i < m; i++) inv[order[i]] = i;

    const outData = new Uint8ClampedArray(w * h * 4);
    const out = new Uint32Array(outData.buffer);
    out.set(src); // 边缘非整块区域保持不变

    for (let bi = 0; bi < m; bi++) {
      const srcBi = dir === 'encrypt' ? order[bi] : inv[bi];
      const kEnc = dir === 'encrypt' ? rot[bi] : rot[srcBi];
      const k = dir === 'encrypt' ? kEnc : (4 - kEnc) % 4;

      const dx0 = (bi % cols) * bs, dy0 = ((bi / cols) | 0) * bs;
      const sx0 = (srcBi % cols) * bs, sy0 = ((srcBi / cols) | 0) * bs;

      for (let y = 0; y < bs; y++) {
        const dRow = (dy0 + y) * w + dx0;
        for (let x = 0; x < bs; x++) {
          let rx, ry;
          switch (k) {
            case 1: rx = y; ry = bs - 1 - x; break;
            case 2: rx = bs - 1 - x; ry = bs - 1 - y; break;
            case 3: rx = bs - 1 - y; ry = x; break;
            default: rx = x; ry = y;
          }
          out[dRow + x] = src[(sy0 + ry) * w + sx0 + rx];
        }
      }
    }
    return outData;
  }

  /* ---------- 模式：行列错位 ---------- */

  function rowColShift(data, w, h, seed, dir) {
    const n = w * h;
    const src = asU32(data, n);
    const rnd = mulberry32(hashSeed((seed || 'default') + '|rc'));
    const rowShift = new Int32Array(h);
    for (let y = 0; y < h; y++) rowShift[y] = (rnd() * w) | 0;
    const colShift = new Int32Array(w);
    for (let x = 0; x < w; x++) colShift[x] = (rnd() * h) | 0;

    const a = new Uint32Array(n);
    const outData = new Uint8ClampedArray(n * 4);
    const b = new Uint32Array(outData.buffer);

    if (dir === 'encrypt') {
      for (let y = 0; y < h; y++) {
        const s = rowShift[y], base = y * w;
        for (let x = 0; x < w; x++) a[base + ((x + s) % w)] = src[base + x];
      }
      for (let x = 0; x < w; x++) {
        const s = colShift[x];
        for (let y = 0; y < h; y++) b[((y + s) % h) * w + x] = a[y * w + x];
      }
    } else {
      for (let x = 0; x < w; x++) {
        const s = colShift[x];
        for (let y = 0; y < h; y++) a[((y - s + h) % h) * w + x] = src[y * w + x];
      }
      for (let y = 0; y < h; y++) {
        const s = rowShift[y], base = y * w;
        for (let x = 0; x < w; x++) b[base + ((x - s + w) % w)] = a[base + x];
      }
    }
    return outData;
  }

  /* ---------- 模式：像素扰动（RGB 异或） ---------- */

  function xorKeystream(data, w, h, seed, dir) {
    const n = w * h;
    const src = asU32(data, n);
    const outData = new Uint8ClampedArray(n * 4);
    const out = new Uint32Array(outData.buffer);
    const rnd = mulberry32(hashSeed((seed || 'default') + '|xor'));
    for (let i = 0; i < n; i++) {
      const k = (rnd() * 0x1000000) | 0;
      const v = src[i];
      out[i] = (v & 0xFF000000) | ((v & 0x00FFFFFF) ^ k);
    }
    return outData;
  }

  /* ---------- 统一入口 ---------- */

  function runMode(mode, data, w, h, seed, dir) {
    if (mode === 'tomato') return tomato(data, w, h, seed, dir);
    if (mode === 'serpentine') return serpentine(data, w, h, seed, dir);
    if (mode === 'blocks') {
      return { data: blockShuffle(data, w, h, seed, dir), width: w, height: h };
    }
    if (mode === 'rows') {
      return { data: rowColShift(data, w, h, seed, dir), width: w, height: h };
    }
    if (mode === 'xor') {
      return { data: xorKeystream(data, w, h, seed, dir), width: w, height: h };
    }
    throw new Error('未知的混淆方式：' + mode);
  }

  function process(opts) {
    const dir = opts.dir === 'decrypt' ? 'decrypt' : 'encrypt';
    let seed = opts.seed == null ? '' : String(opts.seed);
    let w = opts.width, h = opts.height;
    let data = opts.data;
    if (!(w > 0 && h > 0)) throw new Error('图片尺寸无效');
    if (!data || data.length !== w * h * 4) throw new Error('图片数据长度异常');

    let detected = null;
    if (dir === 'decrypt') {
      const stripped = stripMarkerIfPresent(data, w, h);
      data = stripped.data;
      w = stripped.width;
      h = stripped.height;
      detected = stripped.marker;
    }

    let mode = opts.mode;
    if (!mode || mode === 'auto') {
      if (detected) mode = detected.mode;
      else throw new Error('未指定混淆方式，且图片中没有可识别的标识');
    }
    // 解密且调用方未给种子时，可用标识里的种子
    if (dir === 'decrypt' && detected && detected.hasSeed && (opts.seed == null || opts.seed === '')) {
      seed = detected.seed;
    }

    let out = runMode(mode, data, w, h, seed, dir);

    // 加密默认写入标识；与原版小番茄互通时传 marker:false
    const wantMarker = opts.marker !== false;
    if (dir === 'encrypt' && wantMarker) {
      out = appendMarker(out.data, out.width, out.height, mode, seed);
    }

    if (detected) out.marker = detected;
    return out;
  }

  return {
    process: process,
    inspect: inspect,
    // 导出内部函数，供自测 / 交叉验证
    _internals: {
      gilbertCurve: gilbertCurve,
      buildPerm: buildPerm,
      hashSeed: hashSeed,
      mulberry32: mulberry32,
      parseTomatoPw: parseTomatoPw,
      appendMarker: appendMarker,
      stripMarkerIfPresent: stripMarkerIfPresent,
      PHI: PHI,
      MARKER_VERSION: MARKER_VERSION,
      MODE_ID: MODE_ID
    }
  };
});
