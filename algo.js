/* 图片混淆算法核心（纯函数，不依赖 DOM）
 * 数据格式：RGBA，Uint8ClampedArray / Uint8Array，长度 = width * height * 4
 * 所有算法都可逆：encrypt -> decrypt 必须逐像素还原
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && typeof module.exports === 'object') module.exports = api;
  else root.ImgObf = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PHI = (Math.sqrt(5) - 1) / 2; // 0.6180339887498949

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
    let final = new Int32Array(n);
    for (let i = 0; i < n; i++) final[i] = i;
    let cur = map;
    while (steps > 0) {
      if (steps & 1) {
        const nf = new Int32Array(n);
        for (let i = 0; i < n; i++) nf[i] = cur[final[i]];
        final = nf;
      }
      steps >>= 1;
      if (steps > 0) {
        const nc = new Int32Array(n);
        for (let i = 0; i < n; i++) nc[i] = cur[cur[i]];
        cur = nc;
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
      const lastRow = out.slice((h - 1) * nw * 4, h * nw * 4);
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
    if (m < 2) return data.slice();

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

    const out = new Uint32Array(src); // 边缘非整块区域保持不变

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
    return new Uint8ClampedArray(out.buffer);
  }

  /* ---------- 模式：行列错位 ---------- */

  function rowColShift(data, w, h, seed, dir) {
    const src = asU32(data, w * h);
    const rnd = mulberry32(hashSeed((seed || 'default') + '|rc'));
    const rowShift = new Int32Array(h);
    for (let y = 0; y < h; y++) rowShift[y] = (rnd() * w) | 0;
    const colShift = new Int32Array(w);
    for (let x = 0; x < w; x++) colShift[x] = (rnd() * h) | 0;

    const a = new Uint32Array(w * h);
    const b = new Uint32Array(w * h);

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
    return new Uint8ClampedArray(b.buffer);
  }

  /* ---------- 模式：像素扰动（RGB 异或） ---------- */

  function xorKeystream(data, w, h, seed, dir) {
    const n = w * h;
    const src = asU32(data, n);
    const out = new Uint32Array(n);
    const rnd = mulberry32(hashSeed((seed || 'default') + '|xor'));
    for (let i = 0; i < n; i++) {
      const k = (rnd() * 0x1000000) | 0;
      const v = src[i];
      out[i] = (v & 0xFF000000) | ((v & 0x00FFFFFF) ^ k);
    }
    return new Uint8ClampedArray(out.buffer);
  }

  /* ---------- 统一入口 ---------- */

  function process(opts) {
    const mode = opts.mode;
    const dir = opts.dir === 'decrypt' ? 'decrypt' : 'encrypt';
    const seed = opts.seed == null ? '' : String(opts.seed);
    const w = opts.width, h = opts.height;
    if (!(w > 0 && h > 0)) throw new Error('图片尺寸无效');
    if (!opts.data || opts.data.length !== w * h * 4) throw new Error('图片数据长度异常');

    if (mode === 'tomato') return tomato(opts.data, w, h, seed, dir);

    let data;
    if (mode === 'serpentine') return serpentine(opts.data, w, h, seed, dir);
    if (mode === 'blocks') data = blockShuffle(opts.data, w, h, seed, dir);
    else if (mode === 'rows') data = rowColShift(opts.data, w, h, seed, dir);
    else if (mode === 'xor') data = xorKeystream(opts.data, w, h, seed, dir);
    else throw new Error('未知的混淆方式：' + mode);

    return { data: data, width: w, height: h };
  }

  return {
    process: process,
    // 导出内部函数，供自测 / 交叉验证
    _internals: {
      gilbertCurve: gilbertCurve,
      buildPerm: buildPerm,
      hashSeed: hashSeed,
      mulberry32: mulberry32,
      parseTomatoPw: parseTomatoPw,
      PHI: PHI
    }
  };
});
