/* 图片混淆 · 页面交互
 * 图片只在浏览器画布中处理，任何数据都不会离开本机。
 */
(function () {
  'use strict';

  const MAX_PIXELS = 24000000; // 2400 万像素，超过后浏览器内存吃不消

  const $ = (id) => document.getElementById(id);
  const els = {
    drop: $('drop'), file: $('file'), mode: $('mode'), seed: $('seed'), hint: $('hint'),
    obf: $('btn-obf'), rest: $('btn-rest'), reset: $('btn-reset'),
    status: $('status'), compare: $('compare'),
    orig: $('cv-orig'), res: $('cv-res'),
    metaOrig: $('meta-orig'), metaRes: $('meta-res'),
    dlWrap: $('dl-wrap'), dl: $('btn-dl')
  };

  const state = {
    name: '',      // 原始文件名（不含扩展名）
    src: null,     // { data, w, h } 载入的原图
    cur: null,     // { data, w, h } 下一次操作的对象（可能是上一次的结果）
    result: null   // { data, w, h, blob, url, mode, dir }
  };

  const busy = { value: false };

  /* ---------- 小工具 ---------- */

  const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  function fmtSize(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + ' MB';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
    return n + ' B';
  }

  function setStatus(text, kind) {
    els.status.textContent = text || '';
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setBusy(value, label) {
    busy.value = value;
    els.obf.disabled = value || !state.cur;
    els.rest.disabled = value || !state.cur;
    els.dl.disabled = value || !state.result;
    els.obf.classList.toggle('busy', value && label === 'obf');
    els.rest.classList.toggle('busy', value && label === 'rest');
    els.obf.textContent = value && label === 'obf' ? '处理中…' : '混淆';
    els.rest.textContent = value && label === 'rest' ? '处理中…' : '还原';
    if (value) setStatus(label === 'obf' ? '正在混淆…' : '正在还原…', 'busy');
  }

  function canvasFrom(data, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
    return c;
  }

  function drawPreview(canvas, data, w, h) {
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
  }

  function countDiffPixels(a, b, n) {
    const ua = new Uint32Array(a.buffer, a.byteOffset, n);
    const ub = new Uint32Array(b.buffer, b.byteOffset, n);
    let diff = 0;
    for (let i = 0; i < n; i++) if (ua[i] !== ub[i]) diff++;
    return diff;
  }

  function releaseResult() {
    if (state.result && state.result.url) URL.revokeObjectURL(state.result.url);
    state.result = null;
  }

  function syncDropLabel(hasImage, fileName) {
    const strong = els.drop.querySelector('strong');
    const span = els.drop.querySelector('span');
    if (!strong || !span) return;
    if (hasImage) {
      strong.textContent = fileName ? ('已载入 ' + fileName) : '已载入图片';
      span.textContent = '可继续换图：拖入、点选或粘贴';
    } else {
      strong.textContent = '把图片拖到这里';
      span.textContent = '也可以点击选择，或按 Ctrl / ⌘ + V 粘贴截图';
    }
  }

  /* ---------- 参数提示 / 记忆 ---------- */

  const HINTS = {
    tomato: '小番茄密码为 4 位数字：前两位迭代轮数，第 3 位右侧填充列，第 4 位下侧填充行。默认 0000，与原版小番茄互通。',
    serpentine: '任意文字作种子；留空使用默认参数。只保证本工具往返一致。',
    blocks: '任意文字作种子；留空使用默认参数。32×32 分块重排并随机旋转。',
    rows: '任意文字作种子；留空使用默认参数。逐行、逐列循环错位。',
    xor: '任意文字作种子；留空使用默认参数。必须用同一个种子才能还原。'
  };

  function applyModeUi() {
    const mode = els.mode.value;
    els.hint.textContent = HINTS[mode] || '';
    if (mode === 'tomato') {
      els.seed.maxLength = 4;
      els.seed.setAttribute('inputmode', 'numeric');
      els.seed.placeholder = '0000';
      if (!/^\d{4}$/.test(els.seed.value)) els.seed.value = '0000';
    } else {
      els.seed.maxLength = 64;
      els.seed.removeAttribute('inputmode');
      els.seed.placeholder = '可留空';
      els.seed.value = localStorage.getItem('imgobf.seed.' + mode) || '';
    }
  }

  function saveParams() {
    localStorage.setItem('imgobf.mode', els.mode.value);
    localStorage.setItem('imgobf.seed.' + els.mode.value, els.seed.value);
  }

  els.mode.addEventListener('change', () => { applyModeUi(); saveParams(); });
  els.seed.addEventListener('input', () => {
    if (els.mode.value === 'tomato') els.seed.value = els.seed.value.replace(/\D/g, '').slice(0, 4);
    saveParams();
  });

  (function initParams() {
    const mode = localStorage.getItem('imgobf.mode');
    if (mode && HINTS[mode]) els.mode.value = mode;
    applyModeUi();
    const saved = localStorage.getItem('imgobf.seed.' + els.mode.value);
    if (saved != null) els.seed.value = saved;
    if (els.mode.value === 'tomato' && !/^\d{4}$/.test(els.seed.value)) els.seed.value = '0000';
  })();

  /* ---------- 载入图片 ---------- */

  async function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setStatus('这不是图片文件。', 'err');
      return;
    }

    setStatus('正在读取 ' + file.name + ' …', 'busy');
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      if (img.decode) await img.decode();
      else await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });

      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) throw new Error('无法读取图片尺寸');
      if (w * h > MAX_PIXELS) {
        throw new Error('图片太大（' + w + '×' + h + '，约 ' + Math.round(w * h / 1e4) + ' 万像素），本工具上限 2400 万像素');
      }

      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, w, h).data;

      releaseResult();
      state.name = (file.name || 'image').replace(/\.[^.]+$/, '');
      state.src = { data: data, w: w, h: h };
      state.cur = state.src;

      drawPreview(els.orig, data, w, h);
      els.metaOrig.textContent = w + '×' + h + ' · ' + fmtSize(file.size);

      els.compare.hidden = false;
      els.res.width = 0;
      els.res.height = 0;
      els.res.hidden = true;
      els.metaRes.textContent = '';
      els.dlWrap.hidden = true;
      els.reset.hidden = false;
      syncDropLabel(true, file.name);

      setBusy(false);
      setStatus('已载入 ' + file.name + '，选择方式和密码后点「混淆」。');
      els.obf.focus();
    } catch (e) {
      console.error(e);
      setStatus('读取失败：' + (e && e.message ? e.message : e), 'err');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* ---------- 执行 ---------- */

  async function run(dir) {
    if (busy.value || !state.cur) return;

    const mode = els.mode.value;
    const seed = els.seed.value;

    if (mode === 'tomato' && !/^\d{4}$/.test(seed || '0000')) {
      setStatus('小番茄密码必须是 4 位数字，例如 0000。', 'err');
      return;
    }

    setBusy(true, dir === 'encrypt' ? 'obf' : 'rest');
    await tick();
    await tick();

    const t0 = performance.now();
    let out;
    try {
      out = ImgObf.process({
        mode: mode, dir: dir, seed: seed,
        data: state.cur.data, width: state.cur.w, height: state.cur.h
      });
    } catch (e) {
      console.error(e);
      setStatus('失败：' + (e && e.message ? e.message : e), 'err');
      setBusy(false);
      return;
    }
    const ms = performance.now() - t0;

    let blob;
    try {
      const canvas = canvasFrom(out.data, out.width, out.height);
      blob = await new Promise((res, rej) => canvas.toBlob(
        (b) => (b ? res(b) : rej(new Error('导出 PNG 失败'))), 'image/png'
      ));
      drawPreview(els.res, out.data, out.width, out.height);
      els.res.hidden = false;
    } catch (e) {
      console.error(e);
      setStatus('失败：' + (e && e.message ? e.message : e), 'err');
      setBusy(false);
      return;
    }

    releaseResult();
    state.result = {
      data: out.data, w: out.width, h: out.height,
      blob: blob, url: URL.createObjectURL(blob), mode: mode, dir: dir
    };
    state.cur = { data: out.data, w: out.width, h: out.height };

    els.metaRes.textContent = out.width + '×' + out.height + ' · ' + fmtSize(blob.size);
    els.compare.hidden = false;
    els.dlWrap.hidden = false;
    els.reset.hidden = false;
    setBusy(false);

    let msg = (dir === 'encrypt' ? '混淆完成' : '还原完成') + ' · ' + out.width + '×' + out.height +
      ' · ' + (ms / 1000).toFixed(2) + ' 秒';
    let kind = '';

    if (dir === 'decrypt' && state.src) {
      if (state.src.w === out.width && state.src.h === out.height) {
        const diff = countDiffPixels(state.src.data, out.data, out.width * out.height);
        if (diff === 0) {
          msg += ' · ✓ 与原图逐像素一致';
          kind = 'ok';
        } else {
          msg += ' · ✗ 与原图有 ' + diff + ' 个像素不同（方式或密码不对，或图片中途被压缩过）';
          kind = 'err';
        }
      } else {
        msg += ' · 尺寸与原图不同（' + state.src.w + '×' + state.src.h + '）';
      }
    }
    setStatus(msg, kind);
    els.dl.focus();
  }

  els.obf.addEventListener('click', () => run('encrypt'));
  els.rest.addEventListener('click', () => run('decrypt'));

  els.dl.addEventListener('click', () => {
    if (!state.result) return;
    const a = document.createElement('a');
    a.href = state.result.url;
    a.download = (state.name || 'image') + '-' + state.result.mode + '-' +
      (state.result.dir === 'decrypt' ? 'restored' : 'obf') + '.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  els.reset.addEventListener('click', () => {
    releaseResult();
    state.src = null;
    state.cur = null;
    els.compare.hidden = true;
    els.dlWrap.hidden = true;
    els.reset.hidden = true;
    els.file.value = '';
    syncDropLabel(false);
    setBusy(false);
    setStatus('把图片拖进来，或点击选择。');
    els.drop.focus();
  });

  /* ---------- 拖拽 / 选择 / 粘贴 ---------- */

  els.drop.addEventListener('click', () => els.file.click());
  els.drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.file.click(); }
  });
  els.file.addEventListener('change', () => {
    if (els.file.files && els.file.files[0]) loadFile(els.file.files[0]);
    els.file.value = '';
  });

  let dragDepth = 0;
  ['dragenter', 'dragover'].forEach((ev) => {
    document.addEventListener(ev, (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (ev === 'dragenter') dragDepth++;
      els.drop.classList.add('over');
    });
  });
  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.drop.classList.remove('over');
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.drop.classList.remove('over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
        e.preventDefault();
        loadFile(items[i].getAsFile());
        return;
      }
    }
  });
})();
