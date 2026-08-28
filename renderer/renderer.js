'use strict';

// ============================================================
// DaVinciUI v1.1 — 参考渲染器
// 实现 spec/davinciui.md 定义的渲染语义。
// 关键设计：
// 1) 文本布局算法 layoutText() 被绘制与 probe 测量共用，
//    从结构上保证「测得值 = 渲染值」；
// 2) $ 引用解析是流前缀的纯函数：def 与 add 同栈，
//    rollback/init 统一管辖命名注册表。
// ============================================================

const LINE_HEIGHT_RATIO = 1.4;

// ---------- 基础工具 ----------

const COLOR_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function isColor(v) {
  return typeof v === 'string' && COLOR_RE.test(v);
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPosNum(v) {
  return isNum(v) && v > 0;
}

function isNonNegNum(v) {
  return isNum(v) && v >= 0;
}

function isRefString(v) {
  return typeof v === 'string' && v.length > 1 && v[0] === '$';
}

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// CJK 判定：每个 CJK 字符是独立断行单元
const CJK_RE = /[\u2E80-\u2FD5\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

function fontFor(fontSize, style = {}) {
  const parts = [];
  if (style.italic) parts.push('italic');
  if (style.bold) parts.push('bold');
  parts.push(`${fontSize}px`, 'sans-serif');
  return parts.join(' ');
}

// ---------- 指令校验 ----------
// 两段式：validateShallow（结构 + 引用容忍）→ resolveInstruction（解引用）
// → validateFull（全量语义）。原则：非法指令整条跳过（spec §10）。

function validatePaint(p, label) {
  if (typeof p === 'string') {
    return isColor(p) ? null : `${label}: 非法颜色 "${p}"`;
  }
  if (p && typeof p === 'object') {
    if (p.type === 'linear' || p.type === 'radial') {
      const keys = p.type === 'linear' ? ['x0', 'y0', 'x1', 'y1'] : ['x0', 'y0', 'r0', 'x1', 'y1', 'r1'];
      for (const k of keys) {
        if (!isNum(p[k])) return `${label}: 渐变缺少数值字段 ${k}`;
        if (p.type === 'radial' && (k === 'r0' || k === 'r1') && p[k] < 0) return `${label}: 半径不可为负`;
      }
      if (!Array.isArray(p.stops) || p.stops.length < 2) return `${label}: stops 至少 2 个`;
      for (const s of p.stops) {
        if (!s || !isNum(s.offset) || s.offset < 0 || s.offset > 1 || !isColor(s.color)) {
          return `${label}: 非法 stop`;
        }
      }
      return null;
    }
    return `${label}: 未知渐变 type`;
  }
  return `${label}: 非法 paint`;
}

function validateRadius(r, label) {
  if (isNonNegNum(r)) return null;
  if (Array.isArray(r) && r.length === 4 && r.every(isNonNegNum)) return null;
  return `${label}: radius 必须是 ≥0 数值或四元数组`;
}

function validateContour(c, label) {
  if (!c || typeof c !== 'object') return `${label}: 轮廓必须是对象`;
  if (c.shape === 'rect' || c.shape === 'ellipse') {
    if (!isNum(c.x) || !isNum(c.y) || !isPosNum(c.width) || !isPosNum(c.height)) {
      return `${label}: ${c.shape} 轮廓几何非法`;
    }
    return null;
  }
  if (c.shape === 'roundedRect') {
    if (!isNum(c.x) || !isNum(c.y) || !isPosNum(c.width) || !isPosNum(c.height)) {
      return `${label}: roundedRect 轮廓几何非法`;
    }
    return validateRadius(c.radius, label);
  }
  if (c.shape === 'path') {
    return typeof c.d === 'string' && c.d.length > 0 ? null : `${label}: path 缺少 d`;
  }
  return `${label}: 未知轮廓类型 "${c.shape}"`;
}

function validateMask(m) {
  if (!m || typeof m !== 'object') return 'mask 必须是对象';
  if (m.op !== 'remove' && m.op !== 'keep') return `mask.op 必须是 remove/keep`;
  if (!Array.isArray(m.contours) || m.contours.length === 0) return 'mask.contours 不能为空';
  for (const c of m.contours) {
    const e = validateContour(c, 'mask');
    if (e) return e;
  }
  if (m.fillRule !== undefined && m.fillRule !== 'evenodd') return 'fillRule 仅支持 evenodd';
  return null;
}

function validateOpacity(v) {
  return v === undefined || (isNum(v) && v >= 0 && v <= 1) ? null : 'opacity 必须在 0~1';
}

function validateBlur(v) {
  return v === undefined || isNonNegNum(v) ? null : 'blur 必须是 ≥0 数值';
}

function validateShadow(s) {
  if (s === undefined) return null;
  if (!s || typeof s !== 'object') return 'shadow 必须是对象';
  if (!isNum(s.dx) || !isNum(s.dy)) return 'shadow: dx/dy 必须是数值';
  if (!isNonNegNum(s.blur)) return 'shadow: blur 必须是 ≥0 数值';
  if (!isColor(s.color)) return 'shadow: color 非法';
  return null;
}

function validateStrokeDash(d) {
  if (d === undefined) return null;
  if (!Array.isArray(d) || d.length === 0 || !d.every(isPosNum)) return 'strokeDash 必须是正数数组';
  return null;
}

function validateTextStyle(el, label) {
  if (el.bold !== undefined && typeof el.bold !== 'boolean') return `${label}: bold 必须是布尔`;
  if (el.italic !== undefined && typeof el.italic !== 'boolean') return `${label}: italic 必须是布尔`;
  if (el.align !== undefined && !['left', 'center', 'right'].includes(el.align)) return `${label}: align 必须是 left/center/right`;
  if (el.letterSpacing !== undefined && !isNum(el.letterSpacing)) return `${label}: letterSpacing 必须是数值`;
  if (el.lineHeightRatio !== undefined && !isPosNum(el.lineHeightRatio)) return `${label}: lineHeightRatio 必须 > 0`;
  return null;
}

// 结构级校验：已知 op/type、def 字段齐全；引用位置容忍 "$" 字符串。
function validateShallow(op) {
  if (!op || typeof op !== 'object') return '指令必须是 JSON 对象';
  switch (op.op) {
    case 'init':
    case 'add':
    case 'def':
    case 'rollback':
    case 'probe':
    case 'fact':
      break;
    default:
      return `未知 op "${op.op}"`;
  }
  if (op.op === 'add' && !['text', 'image', 'shape'].includes(op.type)) {
    return `add: 未知 type "${op.type}"`;
  }
  if (op.op === 'def') {
    if (typeof op.name !== 'string' || op.name.length === 0) return 'def: name 必须是非空字符串';
    if (op.value === undefined) return 'def: value 必填';
  }
  return null;
}

// 引用解析：$ref 样式包展开 + 值引用替换（一层解析，不回溯）。
function resolveInstruction(op, defs) {
  let o = Object.assign({}, op);

  if (o.op === 'init') {
    // init.defs 随画布定义一次到达：background 可引用同条 init 自带的声明
    const local = Object.assign({}, defs, o.defs || {});
    if (isRefString(o.background)) {
      const name = o.background.slice(1);
      if (!(name in local)) return { ok: false, error: `引用 "${o.background}" 未定义` };
      o.background = deepClone(local[name]);
    }
    return { ok: true, op: o };
  }
  if (o.op !== 'add') return { ok: true, op: o };

  // $ref 样式包：基底展开，元素自身字段覆盖
  if (o.$ref !== undefined) {
    if (!isRefString(o.$ref)) return { ok: false, error: '$ref 必须是 "$名字"' };
    const base = defs[o.$ref.slice(1)];
    if (!base || typeof base !== 'object' || Array.isArray(base)) {
      return { ok: false, error: `$ref "${o.$ref}" 未定义或目标不是样式包对象` };
    }
    const merged = deepClone(base);
    delete merged.$ref;
    for (const k of Object.keys(o)) {
      if (k !== '$ref') merged[k] = o[k];
    }
    o = merged;
  }

  // 值引用：仅限指定消费位（text/src/d 等语义字段不解析）
  for (const k of ['fill', 'stroke', 'color', 'contours', 'mask']) {
    if (!isRefString(o[k])) continue;
    const name = o[k].slice(1);
    if (!(name in defs)) return { ok: false, error: `引用 "${o[k]}" 未定义` };
    let v = deepClone(defs[name]);
    if (k === 'contours') {
      // 几何值 {contours, fillRule} → 取轮廓，fillRule 作为默认
      if (v && !Array.isArray(v)) {
        if (!Array.isArray(v.contours)) return { ok: false, error: `contours 引用 "${o[k]}" 必须是几何值或轮廓数组` };
        if (o.fillRule === undefined && v.fillRule !== undefined) o.fillRule = v.fillRule;
        v = v.contours;
      }
    }
    o[k] = v;
  }
  return { ok: true, op: o };
}

// 全量语义校验（对解析后的指令）。
function validateFull(op) {
  switch (op.op) {
    case 'init':
      if (!isPosNum(op.width) || !isPosNum(op.height)) return 'init: width/height 非法';
      if (op.background !== undefined) {
        const e = validatePaint(op.background, 'background');
        if (e) return e;
      }
      if (op.defs !== undefined && (typeof op.defs !== 'object' || Array.isArray(op.defs))) return 'init: defs 必须是对象';
      return null;

    case 'add': {
      const eOp = validateOpacity(op.opacity);
      if (eOp) return eOp;
      const eB = validateBlur(op.blur);
      if (eB) return eB;
      const eS = validateShadow(op.shadow);
      if (eS) return eS;
      if (op.mask !== undefined) {
        const eM = validateMask(op.mask);
        if (eM) return eM;
      }
      if (op.type === 'text') {
        if (!isNum(op.x) || !isNum(op.y) || !isPosNum(op.width) || !isPosNum(op.height)) return 'text: 外接盒非法';
        if (typeof op.text !== 'string') return 'text: text 必须是字符串';
        if (!isPosNum(op.fontSize)) return 'text: fontSize 非法';
        if (!isColor(op.color)) return 'text: color 非法';
        return validateTextStyle(op, 'text');
      }
      if (op.type === 'image') {
        if (!isNum(op.x) || !isNum(op.y) || !isPosNum(op.width) || !isPosNum(op.height)) return 'image: 目标盒非法';
        if (typeof op.src !== 'string' || op.src.length === 0) return 'image: src 非法';
        if (op.sx !== undefined && !isNum(op.sx)) return 'image: sx 非法';
        if (op.sy !== undefined && !isNum(op.sy)) return 'image: sy 非法';
        if (op.sw !== undefined && !isPosNum(op.sw)) return 'image: sw 非法';
        if (op.sh !== undefined && !isPosNum(op.sh)) return 'image: sh 非法';
        return null;
      }
      if (op.type === 'shape') {
        if (op.strokeWidth !== undefined && !isPosNum(op.strokeWidth)) return 'shape: strokeWidth 非法';
        const eD = validateStrokeDash(op.strokeDash);
        if (eD) return eD;
        if (op.fill !== undefined) {
          const e = validatePaint(op.fill, 'fill');
          if (e) return e;
        }
        if (op.stroke !== undefined) {
          const e = validatePaint(op.stroke, 'stroke');
          if (e) return e;
        }
        if (op.fillRule !== undefined && op.fillRule !== 'evenodd') return 'shape: fillRule 仅支持 evenodd';
        if (Array.isArray(op.contours)) {
          if (op.contours.length === 0) return 'shape: contours 不能为空';
          for (const c of op.contours) {
            const e = validateContour(c, 'shape');
            if (e) return e;
          }
          return null;
        }
        if (op.shape === 'rect' || op.shape === 'ellipse') {
          if (!isNum(op.x) || !isNum(op.y) || !isPosNum(op.width) || !isPosNum(op.height)) return 'shape: 几何非法';
          return null;
        }
        if (op.shape === 'roundedRect') {
          if (!isNum(op.x) || !isNum(op.y) || !isPosNum(op.width) || !isPosNum(op.height)) return 'shape: 几何非法';
          return validateRadius(op.radius, 'shape');
        }
        return 'shape: 需要 contours 或 shape(rect/roundedRect/ellipse)';
      }
      return `add: 未知 type "${op.type}"`;
    }

    case 'def':
      return null; // 浅校验已保证 name/value 齐全；值在消费位按类型校验

    case 'rollback':
      if (op.count !== undefined && (!Number.isInteger(op.count) || op.count < 1)) return 'rollback: count 非法（按 1 处理）';
      return null;

    case 'probe': {
      if (!Array.isArray(op.items) || op.items.length === 0) return 'probe: items 不能为空';
      for (const it of op.items) {
        if (!it || typeof it !== 'object') return 'probe: item 必须是对象';
        if (it.type === 'text') {
          if (typeof it.text !== 'string' || !isPosNum(it.fontSize) || !isPosNum(it.maxWidth)) {
            return 'probe.text: text/fontSize/maxWidth 必填';
          }
          const e = validateTextStyle(it, 'probe.text');
          if (e) return e;
        } else if (it.type === 'textBBox') {
          if (typeof it.text !== 'string' || !isPosNum(it.fontSize)) return 'probe.textBBox: text/fontSize 必填';
          if (it.bold !== undefined && typeof it.bold !== 'boolean') return 'probe.textBBox: bold 必须是布尔';
          if (it.italic !== undefined && typeof it.italic !== 'boolean') return 'probe.textBBox: italic 必须是布尔';
          if (it.letterSpacing !== undefined && !isNum(it.letterSpacing)) return 'probe.textBBox: letterSpacing 必须是数值';
        } else if (it.type === 'image') {
          if (typeof it.src !== 'string' || it.src.length === 0) return 'probe.image: src 必填';
        } else {
          return `probe: 不支持 type "${it.type}"`;
        }
      }
      return null;
    }

    case 'fact':
      return null; // fact 是生成方上下文消息，渲染端不执行也不校验细节

    default:
      return `未知 op "${op.op}"`;
  }
}

// 对外统一入口：结构 → 解引用 → 全量。defs 缺省为空注册表。
function validateInstruction(op, defs = {}) {
  const s = validateShallow(op);
  if (s) return s;
  const r = resolveInstruction(op, defs);
  if (!r.ok) return r.error;
  return validateFull(r.op);
}

// ---------- 文本布局（绘制与测量共用） ----------
// spec §9.1：贪心折行；CJK 任意字符断行；西文单词整体；
// 单单元超宽强制逐字符断行；行首不留空格；对齐为折行后的精确偏移。

function tokenizeForWrap(text) {
  const tokens = [];
  let buf = '';
  for (const ch of text) {
    if (CJK_RE.test(ch) || /\s/.test(ch)) {
      if (buf) { tokens.push(buf); buf = ''; }
      tokens.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);
  return tokens;
}

function applyTextState(ctx, fontSize, style = {}) {
  ctx.font = fontFor(fontSize, style);
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${style.letterSpacing || 0}px`;
}

function layoutText(ctx, text, fontSize, maxWidth, style = {}) {
  applyTextState(ctx, fontSize, style);
  const ratio = style.lineHeightRatio || LINE_HEIGHT_RATIO;
  const lineHeight = fontSize * ratio;
  const lines = [];
  let line = '';
  let lineWidth = 0;

  const pushLine = () => {
    lines.push(line.replace(/\s+$/, ''));
    line = '';
    lineWidth = 0;
  };
  // 逐字符强拆一个超宽 token
  const forceAppend = (token) => {
    for (const ch of token) {
      const w = ctx.measureText(ch).width;
      if (lineWidth + w > maxWidth && line !== '') pushLine();
      line += ch;
      lineWidth += w;
    }
  };

  for (const tok of tokenizeForWrap(text)) {
    if (line === '' && /^\s+$/.test(tok)) continue; // 行首不留空格
    const tokWidth = ctx.measureText(tok).width;
    if (lineWidth + tokWidth <= maxWidth) {
      line += tok;
      lineWidth += tokWidth;
    } else if (line === '') {
      forceAppend(tok);
    } else {
      pushLine();
      if (/^\s+$/.test(tok)) continue; // 换行后的空格丢弃
      if (ctx.measureText(tok).width <= maxWidth) {
        line = tok;
        lineWidth = ctx.measureText(tok).width;
      } else {
        forceAppend(tok);
      }
    }
  }
  pushLine();

  const lineWidths = lines.map((l) => ctx.measureText(l).width);
  return { lines, lineWidths, height: lines.length * lineHeight, lineHeight };
}

// ---------- 几何构建 ----------

function addRoundedRect(p, x, y, w, h, radius) {
  let [tl, tr, br, bl] = Array.isArray(radius) ? radius : [radius, radius, radius, radius];
  const m = Math.min(w, h) / 2;
  tl = Math.min(tl, m); tr = Math.min(tr, m); br = Math.min(br, m); bl = Math.min(bl, m);
  p.moveTo(x + tl, y);
  p.lineTo(x + w - tr, y);
  p.arcTo(x + w, y, x + w, y + h, tr);
  p.lineTo(x + w, y + h - br);
  p.arcTo(x + w, y + h, x, y + h, br);
  p.lineTo(x + bl, y + h);
  p.arcTo(x, y + h, x, y, bl);
  p.lineTo(x, y + tl);
  p.arcTo(x, y, x + w, y, tl);
  p.closePath();
}

function buildPath(contours) {
  const p = new Path2D();
  for (const c of contours) {
    if (c.shape === 'rect') {
      p.rect(c.x, c.y, c.width, c.height);
    } else if (c.shape === 'roundedRect') {
      addRoundedRect(p, c.x, c.y, c.width, c.height, c.radius);
    } else if (c.shape === 'ellipse') {
      // Path2D.ellipse 会从当前点连线到弧起点：先 moveTo 到弧起点，避免多轮廓互连产生细条填充
      p.moveTo(c.x + c.width, c.y + c.height / 2);
      p.ellipse(c.x + c.width / 2, c.y + c.height / 2, c.width / 2, c.height / 2, 0, 0, Math.PI * 2);
    } else if (c.shape === 'path') {
      try {
        p.addPath(new Path2D(c.d));
      } catch (e) {
        // 非法 d：该轮廓按空处理（容错）
      }
    }
  }
  return p;
}

function normalizeShape(op) {
  // 统一为轮廓列表（简单记法 = 单轮廓糖）
  if (Array.isArray(op.contours)) return op.contours;
  const c = { shape: op.shape, x: op.x, y: op.y, width: op.width, height: op.height };
  if (op.shape === 'roundedRect') c.radius = op.radius;
  return [c];
}

// ---------- 渲染器 ----------

class CanvasRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [options]
   * @param {(src:string)=>string} [options.resolveSrc] 图片地址解析钩子（演示用 demo:// 等）
   * @param {()=>void} [options.onInvalidate] 需要重绘时的回调（图片异步加载完成）
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resolveSrc = options.resolveSrc || ((s) => s);
    this.onInvalidate = options.onInvalidate || (() => {});

    this.def = null;        // {width, height, background, defs}
    this.stack = [];        // 已解析的指令（add 元素与 def 声明同栈）
    this.defs = {};         // 活跃命名注册表（随栈状态维护）
    this.imageCache = new Map(); // src -> {status:'loading'|'ok'|'error', img?}
  }

  // ---- 指令入口。返回 {status, ...}；probe 返回 Promise ----
  apply(op) {
    const shallow = validateShallow(op);
    if (shallow) return { status: 'skipped', reason: shallow };

    const resolved = resolveInstruction(op, this.defs);
    if (!resolved.ok) return { status: 'skipped', reason: resolved.error };
    const r = resolved.op;

    const error = validateFull(r);
    if (error) return { status: 'skipped', reason: error };

    switch (r.op) {
      case 'init': {
        this.def = { width: r.width, height: r.height, background: r.background, defs: r.defs };
        this.stack = [];
        this.defs = deepClone(r.defs) || {};
        this.canvas.width = r.width;
        this.canvas.height = r.height;
        this.render();
        return { status: 'applied' };
      }
      case 'def': {
        if (!this.def) return { status: 'skipped', reason: 'init 之前收到 def' };
        // def 存原始值（未解析），与 add 同栈受 rollback 管辖
        this.stack.push(op);
        this.defs[op.name] = deepClone(op.value);
        this.render(); // 可能改变其后引用它的元素的结果
        return { status: 'applied' };
      }
      case 'add': {
        if (!this.def) return { status: 'skipped', reason: 'init 之前收到 add' };
        if (r.type === 'image') this.prefetchImage(r.src);
        this.stack.push(r); // 存解析后的元素
        this.render();
        return { status: 'applied' };
      }
      case 'rollback': {
        if (!this.def) return { status: 'skipped', reason: 'init 之前收到 rollback' };
        const count = Number.isInteger(r.count) && r.count >= 1 ? r.count : 1;
        this.stack.splice(Math.max(0, this.stack.length - count));
        this.rebuildDefs();
        this.render();
        return { status: 'applied' };
      }
      case 'probe': {
        // probe 豁免 init 门槛：无副作用、不碰栈，先测后画首轮可先 probe 后 init（spec §4.1/§4.5）。
        return this.measure(r.items).then((items) => ({ status: 'fact', fact: { op: 'fact', items } }));
      }
      case 'fact':
        return { status: 'noop', reason: 'fact 是生成方上下文消息，渲染端不执行' };
      default:
        return { status: 'skipped', reason: `未知 op` };
    }
  }

  // ---- 命名注册表：init.defs 打底 + 栈内 def 按序覆盖 ----
  rebuildDefs() {
    this.defs = deepClone(this.def && this.def.defs) || {};
    for (const item of this.stack) {
      if (item && item.op === 'def') this.defs[item.name] = deepClone(item.value);
    }
  }

  // ---- 探测：与渲染共用布局/加载实现 ----
  async measure(items) {
    const results = [];
    const round1 = (v) => Math.round(v * 10) / 10;
    for (const it of items) {
      try {
        if (it.type === 'text') {
          this.ctx.save();
          const layout = layoutText(this.ctx, it.text, it.fontSize, it.maxWidth, it);
          this.ctx.restore();
          results.push({
            type: 'text', ok: true,
            lines: layout.lines.length,
            lineWidths: layout.lineWidths.map(round1),
            height: round1(layout.height),
          });
        } else if (it.type === 'textBBox') {
          this.ctx.save();
          applyTextState(this.ctx, it.fontSize, it);
          const m = this.ctx.measureText(it.text);
          this.ctx.restore();
          results.push({
            type: 'textBBox', ok: true,
            width: round1(m.width),
            ascent: round1(m.actualBoundingBoxAscent || 0),
            descent: round1(m.actualBoundingBoxDescent || 0),
          });
        } else if (it.type === 'image') {
          const img = await this.loadImage(it.src);
          results.push({ type: 'image', ok: true, width: img.naturalWidth, height: img.naturalHeight });
        } else {
          results.push({ type: String(it.type), ok: false, error: `不支持的探测类型 "${it.type}"` });
        }
      } catch (e) {
        results.push({ type: String(it.type || 'unknown'), ok: false, error: String(e && e.message || e) });
      }
    }
    return results;
  }

  // ---- 图片加载（缓存 + 失败标记） ----
  prefetchImage(src) { this.loadImage(src).catch(() => {}); }

  loadImage(src) {
    const url = this.resolveSrc(src);
    let rec = this.imageCache.get(url);
    if (rec) {
      return rec.status === 'ok' ? Promise.resolve(rec.img)
        : rec.status === 'error' ? Promise.reject(new Error(`图片加载失败: ${src}`))
        : rec.promise;
    }
    rec = { status: 'loading' };
    rec.promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { rec.status = 'ok'; rec.img = img; this.render(); this.onInvalidate(); resolve(img); };
      img.onerror = () => { rec.status = 'error'; this.render(); this.onInvalidate(); reject(new Error(`图片加载失败: ${src}`)); };
      img.src = url;
    });
    this.imageCache.set(url, rec);
    return rec.promise;
  }

  // ---- 状态快照（画布清单的渲染端侧投影） ----
  snapshot() {
    return {
      def: this.def ? { ...this.def } : null,
      depth: this.stack.length,
      stack: this.stack.map((el, i) => describeElement(el, i)),
      defs: Object.keys(this.defs),
    };
  }

  // ---- 主渲染 ----
  render() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.def) return;

    ctx.fillStyle = resolvePaint(ctx, this.def.background || '#FFFFFF');
    ctx.fillRect(0, 0, this.def.width, this.def.height);

    for (const el of this.stack) {
      if (el && el.op === 'add') this.renderElement(el); // def 无渲染副作用
    }
  }

  // ---- 单元素合成：内容 → blur → mask → shadow → opacity（spec §9.3/9.4） ----
  renderElement(el) {
    const ctx = this.ctx;
    const opacity = el.opacity === undefined ? 1 : el.opacity;
    const needOff = el.mask || el.blur !== undefined || el.shadow;

    if (!needOff) {
      ctx.save();
      ctx.globalAlpha = opacity;
      this.drawContent(ctx, el);
      ctx.restore();
      return;
    }

    const off = document.createElement('canvas');
    off.width = this.def.width;
    off.height = this.def.height;
    const octx = off.getContext('2d');

    if (el.blur !== undefined && el.blur > 0) {
      try { octx.filter = `blur(${el.blur}px)`; } catch (e) { /* 端不支持：降级为无效果 */ }
    }
    this.drawContent(octx, el);
    try { octx.filter = 'none'; } catch (e) { /* ignore */ }

    if (el.mask) {
      octx.globalCompositeOperation = el.mask.op === 'remove' ? 'destination-out' : 'destination-in';
      octx.fillStyle = '#000000';
      octx.fill(buildPath(el.mask.contours), 'evenodd');
    }

    ctx.save();
    ctx.globalAlpha = opacity;
    if (el.shadow) {
      // 对最终剪影只投一次（贴回时携带）
      ctx.shadowOffsetX = el.shadow.dx;
      ctx.shadowOffsetY = el.shadow.dy;
      ctx.shadowBlur = el.shadow.blur;
      ctx.shadowColor = el.shadow.color;
    }
    ctx.drawImage(off, 0, 0);
    ctx.restore();
  }

  drawContent(ctx, el) {
    if (el.type === 'text') this.drawText(ctx, el);
    else if (el.type === 'image') this.drawImage(ctx, el);
    else if (el.type === 'shape') this.drawShape(ctx, el);
  }

  drawText(ctx, el) {
    const style = { bold: el.bold, italic: el.italic, letterSpacing: el.letterSpacing, lineHeightRatio: el.lineHeightRatio };
    const layout = layoutText(ctx, el.text, el.fontSize, el.width, style);
    ctx.save();
    // 文本按自身外接盒裁剪（spec §9.1-5）
    ctx.beginPath();
    ctx.rect(el.x, el.y, el.width, el.height);
    ctx.clip();
    ctx.fillStyle = el.color;
    ctx.textBaseline = 'top';
    const align = el.align || 'left';
    layout.lines.forEach((ln, i) => {
      if (!ln) return;
      const w = layout.lineWidths[i];
      const dx = align === 'center' ? (el.width - w) / 2 : align === 'right' ? el.width - w : 0;
      ctx.fillText(ln, el.x + dx, el.y + i * layout.lineHeight);
    });
    ctx.restore();
  }

  drawImage(ctx, el) {
    const url = this.resolveSrc(el.src);
    const rec = this.imageCache.get(url);
    if (!rec || rec.status !== 'ok') return; // 未加载完/失败：空层
    const img = rec.img;
    const sx = el.sx === undefined ? 0 : el.sx;
    const sy = el.sy === undefined ? 0 : el.sy;
    const sw = el.sw === undefined ? img.naturalWidth : el.sw;
    const sh = el.sh === undefined ? img.naturalHeight : el.sh;
    try {
      ctx.drawImage(img, sx, sy, sw, sh, el.x, el.y, el.width, el.height);
    } catch (e) {
      // 源区域非法：按空层处理（容错）
    }
  }

  drawShape(ctx, el) {
    const path = buildPath(normalizeShape(el));
    ctx.save();
    if (el.strokeDash) ctx.setLineDash(el.strokeDash);
    if (el.fill !== undefined) {
      ctx.fillStyle = resolvePaint(ctx, el.fill);
      ctx.fill(path, el.fillRule === 'evenodd' ? 'evenodd' : 'nonzero');
    }
    if (el.stroke !== undefined) {
      ctx.strokeStyle = resolvePaint(ctx, el.stroke);
      ctx.lineWidth = el.strokeWidth === undefined ? 1 : el.strokeWidth;
      ctx.stroke(path);
    }
    ctx.restore();
  }
}

// ---------- 辅助 ----------

function resolvePaint(ctx, paint) {
  if (typeof paint === 'string') return paint;
  if (paint.type === 'linear') {
    const g = ctx.createLinearGradient(paint.x0, paint.y0, paint.x1, paint.y1);
    for (const s of paint.stops) g.addColorStop(s.offset, s.color);
    return g;
  }
  if (paint.type === 'radial') {
    const g = ctx.createRadialGradient(paint.x0, paint.y0, paint.r0, paint.x1, paint.y1, paint.r1);
    for (const s of paint.stops) g.addColorStop(s.offset, s.color);
    return g;
  }
  return '#000000';
}

function describeElement(el, index) {
  if (el.op === 'def') {
    return `#${index} def "${el.name}"`;
  }
  const base = `#${index} ${el.type}`;
  const fx = [];
  if (el.mask) fx.push(`mask:${el.mask.op}`);
  if (el.blur !== undefined) fx.push(`blur:${el.blur}`);
  if (el.shadow) fx.push('shadow');
  const fxStr = fx.length ? ` [${fx.join(',')}]` : '';
  if (el.type === 'text') {
    const t = el.text.length > 12 ? el.text.slice(0, 12) + '…' : el.text;
    return `${base} "${t}" @(${el.x},${el.y}) ${el.width}×${el.height}${fxStr}`;
  }
  if (el.type === 'image') {
    return `${base} ${el.src} @(${el.x},${el.y}) ${el.width}×${el.height}${fxStr}`;
  }
  if (el.type === 'shape') {
    const geo = Array.isArray(el.contours) ? `contours×${el.contours.length}` : `${el.shape} @(${el.x},${el.y}) ${el.width}×${el.height}`;
    return `${base} ${geo}${fxStr}`;
  }
  return base;
}

// 导出（浏览器全局 + 便于测试）
if (typeof window !== 'undefined') {
  window.CanvasRenderer = CanvasRenderer;
  window.DaVinciUI = {
    validateInstruction,
    resolveInstruction,
    layoutText,
    buildPath,
    tokenizeForWrap,
    LINE_HEIGHT_RATIO,
  };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CanvasRenderer, validateInstruction, resolveInstruction, layoutText, tokenizeForWrap, LINE_HEIGHT_RATIO };
}
