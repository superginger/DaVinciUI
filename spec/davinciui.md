# DaVinciUI v1.1 规范

一种面向生成式 UI 的画布协议：在已知尺寸的画布上，按到达顺序逐层叠加绝对定位的内容。

> v1 → v1.1 变更：新增 `def` 指令与 `$` 值引用（§4.3、§8）；形状新增 `roundedRect` 轮廓与 `strokeDash`（§6）；文本新增 `bold`/`italic`/`align`/`letterSpacing`/`lineHeightRatio`（§4.2.1）；元素新增 `blur`/`shadow` 效果（§9.3）；探测注册表新增 `textBBox`、移除字体清单（§4.5）。

---

## 1. 设计原则

1. **画布先行**：画布尺寸由 `init` 声明，所有内容生活在同一固定坐标系内。
2. **顺序即层级**：没有显式 z-index。指令按到达顺序执行，先画的在底层，后画的覆盖先画的。
3. **绝对定位**：每个内容元素自带画布内的绝对坐标与尺寸。协议不存在居中、平分、自适应、百分比等布局概念——生成方说什么位置就是什么位置。
4. **确定性优先**：渲染端没有自由裁量。凡绘制时需要的信息，要么由指令提供，要么由探测（probe）提前获得。同一份指令流在同一客户端上渲染结果唯一。
5. **只写展示**：协议是单向的"生成方 → 渲染端"内容展示，不含用户输入交互。探测是协议内部的测量协同，不属于用户交互。
6. **容错执行**：非法指令跳过并继续，不中断整条流。

## 2. 载体与传输

- **编码**：JSONL（JSON Lines）。每条指令一个独立的 JSON 对象，独占一行，UTF-8。
- **执行**：严格按到达顺序逐行执行。
- **传输建议**：
  - 下行（生成方 → 客户端）：SSE 流式推送指令行；
  - 上行（客户端 → 生成方）：普通 HTTP 回传 `fact` 应答。
  - 传输层与协议语义解耦，WebSocket 等亦可。
  - **能力协商**（字体族清单、可选特性开关等会话级事实）在传输/编排层完成，不属于画布指令流；画布内只保留绘制所需的测量探测（§4.5）。

## 3. 坐标系与通用约定

- **坐标系**：画布左上角为原点 `(0, 0)`，x 轴向右，y 轴向下。
- **画布单位**：抽象像素。渲染端负责将画布**等比缩放**到实际视口，指令中的数值不受视口影响。
- **裁剪**：任何内容超出画布区域的部分按交集裁剪（含负坐标部分）。
- **颜色**：十六进制字符串 `#RRGGBB` 或 `#RRGGBBAA`。
- **数值**：几何坐标与尺寸为画布单位数值；`width`/`height` 必须 > 0。
- **字体**：v1.1 不暴露字体族选择，统一使用系统 sans-serif；字重/字形仅 `bold`/`italic` 布尔开关（§4.2.1）。由此保证同一客户端上"文本测量 = 文本渲染"。

## 4. 指令

指令共六类：`init` / `add` / `def` / `rollback` / `probe` / `fact`。前五类为生成方产出，`fact` 为渲染端应答。

### 4.1 `init` — 声明画布

```json
{ "op": "init", "width": 750, "height": 1334, "background": "#FFFFFF",
  "defs": { "hint": { "fontSize": 13, "color": "#64748B" } } }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `width` / `height` | 是 | 画布尺寸，> 0 |
| `background` | 否 | paint 类型（见 §5），默认 `#FFFFFF` |
| `defs` | 否 | 命名值批量声明（见 §8），随画布定义一次到达 |

规则：

- 必须是流中的第一条绘制指令；`init` 之前出现的 `add`/`def`/`rollback` 一律跳过。`probe` 豁免（无副作用、不碰栈，§4.5）：先测后画首轮可先 `probe` 后 `init`。
- **重复收到 `init` = 重置画布、清空内容栈、清空命名注册表**（多轮场景下的"整幅重画"入口）。

### 4.2 `add` — 追加内容

追加一个内容元素到栈顶。三类元素：`text` / `image` / `shape`。

公共字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | 是 | `"text"` / `"image"` / `"shape"` |
| `opacity` | 否 | 0~1，默认 1 |
| `mask` | 否 | 见 §7，任意元素均可携带 |
| `blur` | 否 | 数值 ≥ 0，对称高斯模糊半径，作用于元素内容（§9.3） |
| `shadow` | 否 | `{dx, dy, blur, color}`，轮廓投影（§9.3） |
| `$ref` | 否 | 样式包引用（§8.2） |

#### 4.2.1 文本

```json
{ "op": "add", "type": "text",
  "x": 48, "y": 100, "width": 654, "height": 62,
  "text": "明日多云转晴，适合出行。", "fontSize": 22, "color": "#333333",
  "bold": false, "italic": false, "align": "left", "letterSpacing": 0, "lineHeightRatio": 1.4 }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `x` / `y` / `width` / `height` | 是 | 文本外接盒 |
| `text` | 是 | 文本内容 |
| `fontSize` | 是 | > 0 |
| `color` | 是 | 颜色字符串（v1.1 文本不支持渐变填充） |
| `bold` / `italic` | 否 | 布尔，默认 false |
| `align` | 否 | `"left"` / `"center"` / `"right"`，默认 left。**盒内行级对齐**：只改变每行起点的 x 偏移（三个精确公式，§9.1），不影响折行，不引入裁量 |
| `letterSpacing` | 否 | 字符间距，画布单位数值，默认 0 |
| `lineHeightRatio` | 否 | 行高系数，> 0，默认 1.4 |

布局规则（确定性算法，见 §9.1）：从外接盒左上角开始，按盒宽自动折行，超出盒高的行裁剪。单行是多行的特例（盒高给一行即可）。

#### 4.2.2 图片

```json
{ "op": "add", "type": "image",
  "x": 48, "y": 200, "width": 330, "height": 220,
  "src": "https://example.com/a.png",
  "sx": 0, "sy": 0, "sw": 240, "sh": 160 }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `x` / `y` / `width` / `height` | 是 | 目标盒（画布绝对坐标） |
| `src` | 是 | 图片地址 |
| `sx` / `sy` / `sw` / `sh` | 否 | 源区域；省略 = 整张原图 |

语义：**源区域拉伸映射到目标盒**（drawImage 语义），无隐式宽高比保持。原始尺寸未知时，先经 `probe` 的 `image` 项测得（见 §4.5）。加载失败时该层渲染为空，但**保留栈位**，保证顺序语义不因网络状态漂移。圆角照片等裁切需求用 `mask.keep` + `roundedRect` 轮廓表达，不设专门字段。

#### 4.2.3 形状

见 §6（简单记法 + 复合轮廓两种形态）。

### 4.3 `def` — 命名声明

给一个**值**起名，供后续指令以 `$名字` 引用（引用机制见 §8）。

```json
{ "op": "def", "name": "brand", "value": { "type": "linear", "x0": 0, "y0": 0, "x1": 300, "y1": 0,
  "stops": [ { "offset": 0, "color": "#38BDF8" }, { "offset": 1, "color": "#818CF8" } ] } }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 非空字符串 |
| `value` | 是 | 按本质存储的类型化值：几何值、paint、样式包等任意协议值 |

规则：

- **声明即指令**：`def` 可插入流中任意位置（`init` 之后），到达即注册，**自该点起**可被引用；不回溯——引用出现在声明之前按非法指令跳过。
- `def` 压入**同一条内容栈**：`rollback` 统一弹出、重放确定性成立、画布清单天然携带存活声明。不引入第二套状态。
- 同名后声明者覆盖；`init` 重置时注册表一并清空（`init.defs` 在重置后重新生效）。
- `def` 本身无渲染副作用，但会改变其后引用它的元素的渲染结果。
- `def` 不存"元素模板"：值就是值（几何值没有位置绑定，引用端照旧写全绝对坐标）。

### 4.4 `rollback` — 弹出栈顶

```json
{ "op": "rollback", "count": 2 }
```

- `count` ≥ 1；省略或非法时按 1 处理。
- 弹出对象是**内容栈的一切条目**：`add` 的元素与 `def` 声明同等对待。
- `count` 超过当前栈深 → 清空全部内容（画布定义与 `init.defs` 保留）。
- `rollback` 不改变画布定义（`init`）。

### 4.5 `probe` — 测量探测（生成方 → 渲染端）

探测是**一级指令**：类型化、可批量、无渲染副作用、不碰内容栈。发出探测意味着本轮生成到此中断，等待 `fact` 应答后开始下一轮生成（时序见 §11）。

```json
{ "op": "probe", "items": [
    { "type": "text",  "text": "明日多云转晴，适合出行。", "fontSize": 22, "maxWidth": 654 },
    { "type": "textBBox", "text": "26°", "fontSize": 64, "bold": true },
    { "type": "image", "src": "https://example.com/a.png" }
] }
```

v1.1 探测类型注册表：

| type | 参数 | 回答 | 用途 |
|---|---|---|---|
| `text` | `text`、`fontSize`、`maxWidth`（必填）；`bold`/`italic`/`letterSpacing`/`lineHeightRatio`（可选，与绘制同参数） | `lines`（行数）、`lineWidths`（每行实测宽度）、`height`（= 行数 × fontSize × lineHeightRatio） | 折行模拟：文本块实际占多高，决定其下方内容如何摆放 |
| `textBBox` | `text`、`fontSize`（必填）；`bold`/`italic`/`letterSpacing`（可选） | `width`（不折行单行实测宽）、`ascent` / `descent`（基线上下实测高） | 单行文本精确定位（居中、右对齐、与图形对位） |
| `image` | `src` | `width` / `height`（原始尺寸） | 画前得知原图尺寸，才能给出不变形的源区域/目标盒 |

扩展保留（v2+）：`path` bbox、字体度量细目、错误回执。字体族可用性清单属于会话级能力协商，在传输/编排层完成（§2），不进探测注册表。

要求：

- **探测的实现必须与渲染共用同一套引擎**（尤其文本折行），测得值必然等于渲染值——这是"先测后画"不翻车的结构性保证。
- 一次 `probe` = 一次中断 = 一个 `fact` 应答；`items` 内各项并行测量。
- 协议判别字段全局统一为 `type`：add 元素、probe/fact 项、paint 渐变同用，不设其他判别字段名。

### 4.6 `fact` — 事实应答（渲染端 → 生成方）

```json
{ "op": "fact", "items": [
    { "type": "text",  "ok": true, "lines": 2, "lineWidths": [286, 220], "height": 61.6 },
    { "type": "image", "ok": true, "width": 240, "height": 160 }
] }
```

- `items` 与触发它的 `probe.items` **按下标配对**：`fact.items[i]` 对应 `probe.items[i]`。
- 失败项在原位置返回 `{ "type": ..., "ok": false, "error": "..." }`，保持对齐。
- `fact` 不是渲染指令：渲染端不执行它，它作为上下文注入生成方的下一轮模型访问。

## 5. paint 类型（颜色与渐变）

`paint` 是联合类型，可用于：`shape.fill`、`shape.stroke`、`init.background`。

```
paint := 颜色字符串 "#RRGGBB" / "#RRGGBBAA"
      |  线性渐变
      |  径向渐变
```

**线性渐变**：

```json
{ "type": "linear", "x0": 0, "y0": 0, "x1": 300, "y1": 300,
  "stops": [ { "offset": 0, "color": "#FFD54F" }, { "offset": 1, "color": "#FF7043" } ] }
```

**径向渐变**：

```json
{ "type": "radial", "x0": 150, "y0": 150, "r0": 20, "x1": 150, "y1": 150, "r1": 160,
  "stops": [ { "offset": 0, "color": "#FFFFFF" }, { "offset": 1, "color": "#1677FF" } ] }
```

- 渐变端点/半径均为**画布绝对坐标**（等价于 SVG 的 userSpaceOnUse 一种模式，不存在包围盒相对模式）。
- `stops`：`offset` ∈ [0,1] 升序，至少 2 个；`color` 为颜色字符串。
- 保留扩展：角向渐变（conic）。

## 6. 形状与几何值

### 6.1 几何值（geometry）——一等公民

```json
{ "contours": [ { "shape": "rect", "x": 0, "y": 0, "width": 300, "height": 300 },
                { "shape": "rect", "x": 100, "y": 100, "width": 100, "height": 100 } ],
  "fillRule": "evenodd" }
```

- `contours`：轮廓列表，至少 1 个。每个轮廓为 `rect` / `roundedRect` / `ellipse` / `path`，几何均为画布绝对坐标：
  - `rect`：`x, y, width, height`
  - `roundedRect`：`x, y, width, height, radius`；`radius` 为数值（四角同值）或四元数组 `[左上, 右上, 右下, 左下]`，≥ 0，超过半边长时自动收敛
  - `ellipse`：`x, y, width, height`（外接盒）
  - `path`：`d` 为 **SVG path 数据串**（接受完整 SVG path 语法，含 `M/L/H/V/C/S/Q/T/A/Z`），坐标为画布绝对坐标
- `fillRule`：可省略，默认 `"evenodd"`。v1.1 只定义 evenodd——它与轮廓绕行方向无关，生成方无需控制方向。（nonzero 依赖方向，排除。）
- 外接包围盒由渲染端对轮廓求并自动得出，**生成方不输出**。

几何值有两个消费位（协议表达统一，渲染实现各走各的）：

1. **画出来**：作为 shape 元素的几何（§6.2）；
2. **当 mask**：作为任意元素的 mask 几何（§7）。

几何值还可以被 `def` 命名后多处引用（§8）——引用传递的是几何本身，位置仍由轮廓坐标决定。

### 6.2 shape 元素的两种记法

**简单记法**（单轮廓糖，等价于只含一个轮廓的复合形状）：

```json
{ "op": "add", "type": "shape", "shape": "roundedRect",
  "x": 24, "y": 200, "width": 702, "height": 320, "radius": 24,
  "fill": "#FFF7E6", "stroke": "#FFA940", "strokeWidth": 2, "strokeDash": [10, 6] }
```

**完整记法**（复合轮廓，不携带元素级 x/y/width/height）：

```json
{ "op": "add", "type": "shape", "fillRule": "evenodd", "fill": "#1677FF",
  "contours": [ { "shape": "rect", "x": 0, "y": 0, "width": 300, "height": 300 },
                { "shape": "rect", "x": 100, "y": 100, "width": 100, "height": 100 } ] }
```

- `shape`（简单记法）：`rect` / `roundedRect` / `ellipse`；`roundedRect` 需携带 `radius`。
- `fill` / `stroke`：paint 类型，均可选（可只填不描、只描不填）。
- `strokeWidth`：默认 1。
- `strokeDash`：可选，正数数组（如 `[10, 6]`），描边虚实交替的画布单位长度；省略 = 实线。仅作用于描边。
- `opacity`：见 §9.4。
- 描边作用于**所有轮廓**（外沿与洞沿）。

### 6.3 even-odd 语义

填充判定采用射线法：从点发任意方向射线，数与所有轮廓的交点数，**奇数 = 内部（填充），偶数 = 外部**。

由此：

- 外轮廓内嵌套洞轮廓 → 洞区不填，**透出下层内容**（不伤下层，非穿透）。
- 多孔、孔中套孔（岛）天然成立。
- 数学本质是各轮廓的**对称差（XOR）**：洞轮廓若凸出外轮廓，凸出部分也会被填充。纯"减法"预期要求洞轮廓完全包含于外轮廓；如需严格纯减法，用 mask（§7）。

## 7. mask 语义

任意 `add` 元素（text / image / shape）可携带 `mask` 属性：

```json
{ "op": "add", "type": "image", "x": 0, "y": 100, "width": 300, "height": 300, "src": "...",
  "mask": { "op": "remove", "fillRule": "evenodd",
            "contours": [ { "shape": "ellipse", "x": 110, "y": 180, "width": 80, "height": 80 } ] } }
```

- `mask.op`：
  - `"remove"`：挖洞。结果 = 内容 ∖ 轮廓区（destination-out）；
  - `"keep"`：只留。结果 = 内容 ∩ 轮廓区（destination-in）。
- `mask.contours` / `fillRule`：与几何值同构（可复合、可 evenodd、可 roundedRect）。轮廓为**画布绝对坐标**。
- mask 只作用于该元素自身（离屏合成后贴回），**不擦除、不改变下层任何内容**。
- 图片挖洞、文字挖洞、文字/图片只留洞、圆角照片（keep + roundedRect），均由 mask 承载（文字与图片无法参与矢量布尔）。

### 7.1 even-odd 与 mask 的关系与分叉

"矩形 A 挖洞矩形 B"两种写法都合法。当 **B 完全在 A 内且不关心描边**时二者像素级等价；两处分叉必须知晓：

| 分叉点 | even-odd（完整记法 shape） | mask remove |
|---|---|---|
| 描边 | 洞沿被描边（所有轮廓都 stroke） | 洞沿无描边（纯擦除） |
| B 凸出 A | XOR：凸出部分也被填充 | 纯减法：凸出部分无影响 |

选用准则：

- 描述**自足复合图形**（圆环、镂空框、带洞图标）且要洞沿描边 → even-odd；
- 从**已有内容挖掉一块**（尤其图片/文字）、要纯减法、不要洞沿描边 → mask。
- 编排层宜给生成方固定默认偏好，避免同一幅画混用两种写法（属生成引导，不进协议）。

## 8. 值引用（`$` 与 `$ref`）

命名是**值的一层皮肤**：`def`/`init.defs` 起名，引用端消费。解析是流前缀的纯函数，无级联、无继承、无递归。

### 8.1 `$名字` —— 值引用

以下字段位置出现以 `$` 开头的字符串时，按名字从注册表取值替换（一层解析）：

| 可引用位置 | 期望的值类型 |
|---|---|
| `init.background`、`shape.fill`、`shape.stroke`、`text.color` | paint |
| `shape.contours`、`mask` 整体 | 几何值 / mask 值 |

- `shape.contours` 引用几何值 `{contours, fillRule}` 时：取其 `contours`；其 `fillRule` 在元素未自带时作为默认。
- 引用未定义的名字 = 非法指令，跳过。
- `text`（内容）、`src`、`d` 等语义字段**不解析**引用，`$` 就是字面字符。

### 8.2 `$ref` —— 样式包展开

`add` 元素可携带 `"$ref": "$名字"`，指向一个**样式包**（普通对象，其键为该元素合法的样式字段，如 `fontSize`/`color`/`bold`/`align`/`fill`/`stroke` 等）。展开规则：

- 样式包字段作为基底，元素自身同名字段**覆盖**基底；
- 展开后再做常规校验——必填字段（如 `fontSize`）可以完全来自样式包；
- `$ref` 目标必须是对象，否则非法。

```json
{ "op": "def", "name": "hint", "value": { "fontSize": 13, "color": "#64748B" } }
{ "op": "add", "type": "text", "$ref": "$hint", "x": 48, "y": 1284, "width": 654, "height": 22,
  "text": "页脚说明" }
```

### 8.3 确定性与编排含义

- 引用解析只依赖"已到达的声明"，同一前缀解析结果唯一；声明被 `rollback` 弹出后，其名字回到未定义态。
- 画布清单（§12）必须携带当前活跃的命名注册表——清单是指令流的物化视图，声明自然在其中。

## 9. 渲染规则

### 9.1 文本布局（确定性折行算法）

1. 字体：`[italic] [bold] {fontSize}px sans-serif`（按 `italic`/`bold` 开关拼合）；字符间距 `letterSpacing`（默认 0）。
2. 行高 = `fontSize × lineHeightRatio`（默认 1.4）；首行顶边对齐外接盒 `y`。
3. 折行：贪心。断行机会 = 任意 CJK 字符之后、空格处；西文单词（连续非空格非 CJK 串）保持整体；单个单元超盒宽时逐字符强制断行；行首不保留空格。折行度量含 `letterSpacing`。
4. 对齐：每行宽度 `w` 折行完成后已确定，行起点 x 偏移按 `align` 取精确值——`left: 0`，`center: (width − w)/2`，`right: width − w`。无裁量。
5. 折行边界 = 外接盒 `width`；超出外接盒 `height` 的行裁剪（文本按自身外接盒裁剪，非仅画布）。
6. 该算法与 `probe` 的 `text`/`textBBox` 测量**共用同一实现**。

### 9.2 图片映射

`drawImage(源区域 → 目标盒)` 拉伸。越界部分按画布裁剪。

### 9.3 元素效果（blur 与 shadow）

两者均为任意 `add` 元素的可选属性，语义对文本/图片/形状一致：

- **`blur`**：数值 ≥ 0。对元素内容施加**对称高斯模糊**（半径 = 值）。只定义对称模糊——非对称、方向性滤镜不在协议内。
- **`shadow`**：`{dx, dy, blur, color}` 全必填。语义是**轮廓投影**（drop-shadow），不是外接盒投影（box-shadow）：影子形状 = 元素最终合成后的 alpha 轮廓，挖了洞的元素投出带洞的影子。
- 单元素合成顺序（固定）：**内容 → blur → mask → shadow → opacity 贴回**。即：模糊先于裁切（mask 切的是模糊后的内容）；投影最后成形，对最终剪影**只投一次**（fill+stroke 不得各自带影子叠加）。
- 端能力缺失时（如无 filter 支持）按无效果降级渲染，不报错（容错见 §10）。

### 9.4 叠加绘制

自底向上遍历内容栈，对每个元素：

1. 无 mask/blur/shadow：以 `globalAlpha = opacity` 直接绘制；
2. 有其一：将元素内容绘制到同尺寸离屏缓冲（有 blur 时带模糊滤镜）→ 有 mask 则以 `destination-out`（remove）或 `destination-in`（keep）套用 mask 轮廓（evenodd 填充）→ 有 shadow 则贴回时携带投影 → 以 `opacity` 贴回画布。
3. 形状：先 `fill(path, "evenodd")`（若有 fill），后 `stroke(path)`（若有 stroke，携带 `strokeDash`）。
4. 文本/形状/图片绘制一律受画布区域裁剪。

## 10. 容错规则

| 情形 | 处理 |
|---|---|
| 行 JSON 解析失败 | 跳过该行，继续 |
| 字段缺失、类型错误、非法颜色、非法枚举 | 跳过该条指令，继续 |
| `$` 引用未定义的名字、`$ref` 目标非对象 | 跳过该条指令，继续 |
| `init` 之前收到 `add` / `def` / `rollback` | 跳过（`probe` 豁免，可正常执行） |
| 坐标/尺寸越界 | 不报错，裁剪渲染 |
| 图片加载失败 | 渲染为空层，保留栈位 |
| `rollback.count` 省略/非法 | 按 1 处理 |
| `rollback.count` 超栈深 | 清空全部 |
| `probe` 项测量失败 | 在 fact 对应位置回 `ok:false` + `error` |
| blur/shadow 端能力缺失 | 按无该效果渲染 |

## 11. 探测时序（编排层）

v1.1 采用**纯先测后画**：无乐观绘制，不允许在不确定状态下生成。凡被画出的，都是拿到事实之后才画的。

```
每一轮模型访问：
  ① 画出当前已知、不依赖测量的内容（确定的底层）
  ② 发出 probe（类型化、批量）——本轮到此结束
        ↓ 客户端测量，按序回 fact
下一轮模型访问：
  ① fact 作为上下文注入，变成知识，把原先不确定的元素画对
  ② 继续画新的确定内容 + 新的 probe
  ……直到画完
```

要点：

- **轮数 = 测量依赖的深度，不是元素个数**：同一轮的探测批量并行、一次应答。
- 单次模型访问无法中途注入信息；"探测 → 应答 → 续画"的循环由 harness 用多次模型访问完成（探测映射为工具调用，客户端是测量后端）。
- `probe` 无渲染副作用；`fact` 只进生成方上下文，不进渲染流。

## 12. 生成编排原则（接力即兴模式）

协议对生成策略保持中立。v1.1 推荐的编排模式：

1. **每轮输入三件套**：原始意图提示词（恒定，每轮同文，不用首轮加工过的二手思路）＋ 全量已确认画布清单 ＋ 本轮 fact。
2. **画布清单**：已确认元素的紧凑结论态描述，是**指令流的物化视图**——由系统执行指令流 + 合并 fact 计算得出；唯一事实源是指令流本身，清单不会漂移。清单对已确认元素信息完备（几何 + 事实 + 活跃命名注册表），"紧凑"指去掉 rollback 死分支，不是减覆盖。
3. **每轮都当自己是最后一个画师**：尽力画，画到必须探测为止；不预留远期意图，不关心有没有接力者。任意停点，画面自洽可用。
4. **接力者纪律**：读得出已有内容的风格意图就延续；读不出就无责任继承，可整幅重启（`rollback` 全部 + 重新 `init`，仍在同一原始意图主题下）。
5. **完整性责任在意图提示词**：必要要素写进 brief，每轮自带完成度判据。

## 13. v1.1 范围与明确不做

**v1.1 范围**：六类指令（含 `def`）；`$` 值引用与 `$ref` 样式包；JSONL 载体；text（确定性折行、bold/italic、盒内 align、letterSpacing、lineHeightRatio）/ image（源区域映射）/ shape（rect、roundedRect、ellipse、SVG path 轮廓）；复合轮廓 + evenodd；mask（remove/keep）；paint（纯色、线性渐变、径向渐变）；strokeDash；opacity；blur / shadow（轮廓投影）；探测注册表（text 折行、textBBox、image 原始尺寸）。

**明确不做**（写死边界，防止漂移）：

- 用户交互（点击/输入/事件）——本协议纯展示；
- 动画与时间轴——时间维度会杀死"确定性快照"；流式到达本身就是天然动效；
- 响应式布局（居中/平分/百分比/相对定位）——无布局是哲学不是缺口；
- 混合模式与穿透式挖洞（blend/erase）——布尔只走 even-odd 与 mask，不伤下层；
- 变换与旋转（transform/rotate）——一切绝对坐标；
- 滤镜全家桶——只收对称 blur 与轮廓 shadow 两种固定效果；
- nonzero 填充规则、角向渐变、字体族选择。

**扩展保留位**：探测类型（path bbox、字体度量细目、错误回执）；conic 渐变；`rollback` 命名锚点；几何复用（stamp/平移，与绝对坐标原则的相容性另行论证）。

---

## 附录 A：完整指令流示例

```json
{"op":"init","width":750,"height":400,"background":"#F5F5F5","defs":{"hint":{"fontSize":14,"color":"#8C8C8C"}}}
{"op":"add","type":"shape","shape":"roundedRect","x":0,"y":0,"width":750,"height":88,"radius":0,"fill":"#1677FF"}
{"op":"add","type":"text","x":24,"y":24,"width":400,"height":46,"text":"杭州 · 晴","fontSize":32,"color":"#FFFFFF","bold":true}
{"op":"add","type":"shape","shape":"roundedRect","x":24,"y":120,"width":702,"height":240,"radius":24,"fill":"#FFFFFF","shadow":{"dx":0,"dy":6,"blur":16,"color":"#00000022"}}
{"op":"add","type":"text","x":48,"y":144,"width":654,"height":128,"text":"明天多云转晴，适合出行。紫外线较强，注意防晒。","fontSize":24,"color":"#333333","lineHeightRatio":1.5}
{"op":"add","type":"text","$ref":"$hint","x":48,"y":300,"width":654,"height":22,"text":"数据更新于 08:00"}
```

## 附录 B：运行参考渲染器

```bash
cd DaVinciUI
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000/renderer/
```
