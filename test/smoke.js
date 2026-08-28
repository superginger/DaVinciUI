// DaVinciUI v1.1 — probe-first 冒烟测试（Node 侧，无浏览器依赖）
// 锁定三条规则：
//   1) 判别字段全局统一为 type：probe 项用旧字段 kind 必须被拒（spec §4.5 公理）
//   2) probe 豁免 init 门槛：首条即 probe 可正常测量并回 fact（spec §4.1）
//   3) init 门槛未放松：init 之前的 add/def 仍被跳过
// 运行：node test/smoke.js

const assert = require('assert');

// 浏览器全局桩：Node 无 Path2D，构建路径的方法一律 no-op（本冒烟不验证像素）
if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class { constructor() { return new Proxy(this, { get: (t, k) => (k in t ? t[k] : () => {}) }); } };
}

const { CanvasRenderer, validateInstruction } = require('../renderer/renderer.js');

// 最小 2D 上下文桩：度量走确定性近似（每字符宽 = fontSize × 0.5），渲染方法一律 no-op
function makeCtx() {
  const base = {
    font: '',
    save() {},
    restore() {},
    measureText(t) {
      const m = String(this.font).match(/([\d.]+)px/);
      const fs = m ? +m[1] : 16;
      return { width: [...t].length * fs * 0.5, actualBoundingBoxAscent: fs * 0.8, actualBoundingBoxDescent: fs * 0.2 };
    },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
  };
  return new Proxy(base, { get(t, k) { return k in t ? t[k] : () => {}; } });
}

function makeCanvasStub() {
  const ctx = makeCtx();
  return { width: 0, height: 0, getContext: () => ctx };
}

(async () => {
  // 1) 校验层：type 合法，kind 已废
  assert.ok(!validateInstruction({ op: 'probe', items: [{ type: 'textBBox', text: '杭州', fontSize: 28 }] }, {}),
    'probe 项 type 字段应通过校验');
  const kindErr = validateInstruction({ op: 'probe', items: [{ kind: 'textBBox', text: '杭州', fontSize: 28 }] }, {});
  assert.ok(kindErr && /不支持/.test(kindErr), `probe 项旧字段 kind 应被拒，实际：${kindErr}`);

  // 2) 执行层：probe-first（init 之前）可测并回 fact
  const r = new CanvasRenderer(makeCanvasStub());
  const first = await r.apply({ op: 'probe', items: [{ type: 'textBBox', text: '杭州 · 出行提示', fontSize: 28, bold: true }] });
  assert.strictEqual(first.status, 'fact', 'init 前 probe 应豁免门槛并返回 fact');
  assert.ok(first.fact.items[0].ok && first.fact.items[0].width > 0, 'fact 应携带有效测量值');

  // 3) init 门槛未放松：init 前 add/def 仍跳过
  const addEarly = r.apply({ op: 'add', type: 'shape', shape: 'rect', x: 0, y: 0, width: 10, height: 10, fill: '#000000' });
  assert.strictEqual(addEarly.status, 'skipped', 'init 前 add 应跳过');
  const defEarly = r.apply({ op: 'def', name: '$x', value: '#F00' });
  assert.strictEqual(defEarly.status, 'skipped', 'init 前 def 应跳过');

  // 4) init 之后恢复正常
  assert.strictEqual(r.apply({ op: 'init', width: 750, height: 480, background: '#0F172A' }).status, 'applied');
  assert.strictEqual(r.apply({ op: 'add', type: 'shape', shape: 'rect', x: 0, y: 0, width: 10, height: 10, fill: '#000000' }).status, 'applied');

  console.log('smoke: 全部通过（4 组断言）');
})().catch((e) => { console.error('smoke 失败:', e.message); process.exit(1); });
