const fs = require('fs');
const path = require('path');
const A = require('../algo.js');

const dir = __dirname;
const inDir = path.join(dir, 'in');
const refDir = path.join(dir, 'out');

let fail = 0;
function check(cond, msg) {
  if (!cond) { fail++; console.log('FAIL:', msg); }
}

function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- 1. 与 Python 参考实现（原版 JS 的直译）逐字节比对 ----
for (const f of fs.readdirSync(inDir).filter(f => f.endsWith('.json'))) {
  const meta = JSON.parse(fs.readFileSync(path.join(inDir, f), 'utf8'));
  const raw = new Uint8Array(fs.readFileSync(path.join(inDir, meta.raw)));
  const w = meta.w, h = meta.h;
  for (const pw of ['0000', '1234']) {
    const enc = A.process({ mode: 'tomato', dir: 'encrypt', seed: pw, data: raw, width: w, height: h });
    const refEnc = new Uint8Array(fs.readFileSync(path.join(refDir, `${f.slice(0, -5)}.${pw}.enc.raw`)));
    check(eq(enc.data, refEnc), `tomato encrypt vs ref ${w}x${h} pw=${pw}`);
    check(enc.width === w + Number(pw[2]) && enc.height === h + Number(pw[3]), `padded size ${w}x${h} pw=${pw}`);

    // 拿参考实现的密文给 JS 解，验证互通（双向）
    const dec = A.process({ mode: 'tomato', dir: 'decrypt', seed: pw, data: refEnc, width: enc.width, height: enc.height });
    check(eq(dec.data, raw), `tomato decrypt(python enc) ${w}x${h} pw=${pw}`);
  }
}
console.log('1) tomato vs reference: done');

// ---- 2. 五种模式往返 ----
const sizes = [[1, 1], [3, 7], [4, 4], [16, 16], [33, 17], [64, 64], [100, 37], [257, 1], [517, 301]];
const modes = ['tomato', 'serpentine', 'blocks', 'rows', 'xor'];
const seeds = { tomato: ['0000', '1234', '9909'], serpentine: ['', 'abc'], blocks: ['', 'hello'], rows: ['', '中文种子'], xor: ['', 'k3y'] };
for (const [w, h] of sizes) {
  const raw = new Uint8Array(w * h * 4);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + (i >> 3)) & 255;
  for (let i = 3; i < raw.length; i += 4) raw[i] = 255;
  for (const mode of modes) {
    for (const seed of seeds[mode]) {
      const enc = A.process({ mode, dir: 'encrypt', seed, data: raw, width: w, height: h });
      const dec = A.process({ mode, dir: 'decrypt', seed, data: enc.data, width: enc.width, height: enc.height });
      check(dec.width === w && dec.height === h, `roundtrip size ${mode} ${w}x${h}`);
      check(eq(dec.data, raw), `roundtrip ${mode} ${w}x${h} seed=${seed}`);
      // 混淆后必须与原文不同（1 像素宽/高的退化图无法分块）
      if (w * h >= 16 && !(mode === 'blocks' && (w < 2 || h < 2))) check(!eq(enc.data, raw), `changed after encrypt ${mode} ${w}x${h} seed=${seed}`);
    }
  }
}
console.log('2) roundtrip all modes: done');

// ---- 3. 密码/种子错误必须解不出原文 ----
{
  const w = 64, h = 48;
  const raw = new Uint8Array(w * h * 4);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 91 + 7) & 255;
  for (let i = 3; i < raw.length; i += 4) raw[i] = 255;
  const enc = A.process({ mode: 'tomato', dir: 'encrypt', seed: '1234', data: raw, width: w, height: h });
  const bad = A.process({ mode: 'tomato', dir: 'decrypt', seed: '4321', data: enc.data, width: enc.width, height: enc.height });
  check(!eq(bad.data, raw), 'wrong password must not decode');
  // 小番茄密码非法要报错
  let threw = false;
  try { A.process({ mode: 'tomato', dir: 'encrypt', seed: '12', data: raw, width: w, height: h }); } catch (e) { threw = true; }
  check(threw, 'invalid password must throw');
}
console.log('3) wrong-params guard: done');

// ---- 4. 大图耗时 / 内存 ----
{
  const w = 1920, h = 1080;
  const raw = new Uint8Array(w * h * 4);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 13) & 255;
  for (let i = 3; i < raw.length; i += 4) raw[i] = 255;
  for (const mode of modes) {
    const t0 = Date.now();
    const enc = A.process({ mode, dir: 'encrypt', seed: mode === 'tomato' ? '0000' : 'x', data: raw, width: w, height: h });
    const t1 = Date.now();
    const dec = A.process({ mode, dir: 'decrypt', seed: mode === 'tomato' ? '0000' : 'x', data: enc.data, width: enc.width, height: enc.height });
    const t2 = Date.now();
    check(eq(dec.data, raw), `1920x1080 roundtrip ${mode}`);
    console.log(`   1920x1080 ${mode.padEnd(10)} encrypt ${t1 - t0}ms  decrypt ${t2 - t1}ms`);
  }
}

console.log(fail ? `\n${fail} FAILED` : '\nALL OK');
process.exit(fail ? 1 : 0);
