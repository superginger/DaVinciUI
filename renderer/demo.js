'use strict';

// ============================================================
// DaVinciUI v1.1 — 演示驱动器
// 职责：加载示例 JSONL、流式/单步执行、probe→fact 应答模拟、
//       日志与内容栈展示。
// demo:// 是演示本地的图片 scheme：运行时用离屏 canvas 生成
// 已知尺寸的测试图，保证示例零网络依赖、尺寸确定。
// ============================================================

// ---------- demo:// 测试图注册表 ----------

function makeImageDataUrl(width, height, draw) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  draw(c.getContext('2d'), width, height);
  return c.toDataURL('image/png');
}

const DEMO_IMAGES = {};

function registerDemoImages() {
  // 240×160：天空 + 太阳（3:2）
  DEMO_IMAGES['demo://photo-240x160'] = makeImageDataUrl(240, 160, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#38BDF8');
    g.addColorStop(1, '#0EA5E9');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#FDE047';
    ctx.beginPath();
    ctx.arc(180, 48, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.ellipse(70, 60, 34, 14, 0, 0, Math.PI * 2);
    ctx.ellipse(100, 54, 26, 12, 0, 0, Math.PI * 2);
    ctx.fill();
  });
  // 750×300：山景横幅
  DEMO_IMAGES['demo://banner-750x300'] = makeImageDataUrl(750, 300, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#1E3A5F');
    g.addColorStop(1, '#4C7A9F');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#2B5876';
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(180, 110);
    ctx.lineTo(360, h);
    ctx.lineTo(520, 150);
    ctx.lineTo(750, h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#FDE047';
    ctx.beginPath();
    ctx.arc(600, 70, 32, 0, Math.PI * 2);
    ctx.fill();
  });
}

function resolveSrc(src) {
  return DEMO_IMAGES[src] || src;
}

// ---------- DOM ----------

const canvas = document.getElementById('canvas');
const logEl = document.getElementById('log');
const stackEl = document.getElementById('stack');
const exampleSelect = document.getElementById('example-select');
const btnLoad = document.getElementById('btn-load');
const btnPlay = document.getElementById('btn-play');
const btnStep = document.getElementById('btn-step');
const btnReset = document.getElementById('btn-reset');
const btnRunCustom = document.getElementById('btn-run-custom');
const customInput = document.getElementById('custom-input');
const chkSlow = document.getElementById('chk-slow');

const renderer = new CanvasRenderer(canvas, {
  resolveSrc,
  onInvalidate: () => updateStackPanel(),
});

// ---------- 日志与栈面板 ----------

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function log(cls, tag, text) {
  const div = document.createElement('div');
  div.className = `log-line log-${cls}`;
  div.innerHTML = `<span class="tag">${tag}</span>${escapeHtml(text)}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function shortJson(op) {
  const s = JSON.stringify(op);
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

function updateStackPanel() {
  const snap = renderer.snapshot();
  if (!snap.def) {
    stackEl.innerHTML = '<span class="hint">画布未初始化</span>';
    return;
  }
  const head = `<div class="depth">画布 ${snap.def.width}×${snap.def.height} · 栈深 ${snap.depth}</div>`;
  const rows = snap.stack.map((s) => `<div>${escapeHtml(s)}</div>`).join('');
  stackEl.innerHTML = head + (rows || '<span class="hint">（空栈）</span>');
}

// ---------- 执行引擎 ----------

let queue = [];       // 待执行指令
let cursor = 0;
let playing = false;

function parseJsonl(text) {
  const ops = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('//')) continue; // 允许空行与注释行
    try {
      ops.push(JSON.parse(line));
    } catch (e) {
      log('skipped', '解析失败', `第 ${i + 1} 行: ${e.message}`);
    }
  }
  return ops;
}

async function executeOne(op) {
  const result = renderer.apply(op);

  if (result instanceof Promise) {
    // probe：异步测量 → 生成 fact
    log('probe', 'probe', shortJson(op));
    const r = await result;
    if (r.status === 'fact') {
      log('fact', 'fact', JSON.stringify(r.fact.items));
      log('noop', '注入', 'fact 作为上下文注入下一轮生成（演示中直接继续执行后续指令）');
    } else {
      log('skipped', '跳过', r.reason);
    }
  } else {
    switch (result.status) {
      case 'applied':
        log('applied', '执行', shortJson(op));
        break;
      case 'skipped':
        log('skipped', '跳过', `${result.reason} — ${shortJson(op)}`);
        break;
      case 'noop':
        log('noop', '忽略', `${result.reason}`);
        break;
    }
  }
  updateStackPanel();
}

function resetPlayback() {
  queue = [];
  cursor = 0;
  playing = false;
  btnPlay.disabled = false;
  btnStep.disabled = false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function play() {
  if (playing) return;
  playing = true;
  btnPlay.disabled = true;
  const delay = () => (chkSlow.checked ? 900 : 300);
  while (playing && cursor < queue.length) {
    await executeOne(queue[cursor++]);
    if (cursor < queue.length) await sleep(delay());
  }
  playing = false;
  btnPlay.disabled = false;
}

async function step() {
  if (playing || cursor >= queue.length) return;
  await executeOne(queue[cursor++]);
}

// ---------- 事件绑定 ----------

async function loadExample() {
  resetPlayback();
  logEl.innerHTML = '';
  const url = exampleSelect.value;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    queue = parseJsonl(text);
    cursor = 0;
    log('noop', '载入', `${url} · ${queue.length} 条指令`);
  } catch (e) {
    log('skipped', '载入失败',
      `${e.message} — 请通过 HTTP 服务访问（在仓库根目录运行 python3 -m http.server，然后打开 /renderer/）`);
  }
}

btnLoad.addEventListener('click', loadExample);
btnPlay.addEventListener('click', play);
btnStep.addEventListener('click', step);
btnReset.addEventListener('click', () => {
  resetPlayback();
  renderer.def = null;
  renderer.stack = [];
  canvas.width = 0;
  canvas.height = 0;
  logEl.innerHTML = '';
  updateStackPanel();
});
btnRunCustom.addEventListener('click', async () => {
  resetPlayback();
  queue = parseJsonl(customInput.value);
  cursor = 0;
  log('noop', '自定义', `解析出 ${queue.length} 条指令`);
  while (cursor < queue.length) {
    await executeOne(queue[cursor++]);
  }
});

// ---------- 启动 ----------

registerDemoImages();
updateStackPanel();
log('noop', '就绪', '选择示例流后点击「载入」，再「流式播放」或「单步」执行。');
