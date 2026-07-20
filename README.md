# 格式助手

一个 SillyTavern（酒馆）扩展：在每轮对话接收完整（含 MVU 变量解析、额外模型生成）之后，自动修复模型输出里的格式问题，让带变量的角色卡不再渲染崩坏。

核心是**三级流水线**，从轻到重逐级兜底：

```
消息接收完成（MVU 变量解析后）
  ├─ 1. detag          （零成本正则）思考区危险 tag 去掉 <>
  ├─ 2. 规则结构修复    （零成本正则）代码块迁移 + 正文容器重包裹
  └─ 3. LLM 格式修复    （可选，需配置）规则修不了的语义/结构问题
                       自动检测+询问 → diff 确认 → 指纹校验 → 写回
```

**自动与手动都只处理最近一条 AI 回复**，不碰历史消息。

---

## 为什么需要

带 MVU 变量、依赖 Kemini Dramatron / Izumi 等预设的角色卡，模型常在 `<think>` 思考块里输出 `<now_plot>`、`<状态>`、`<UpdateVariable>` 等自定义 tag。酒馆默认 `encode_tags` 关闭 + showdown 透传 HTML + DOMPurify 解析未知标签，未闭合或非 ASCII 的 tag 会让浏览器重排 DOM，导致整条消息渲染崩坏、格式错乱、代码块无法被酒馆助手转成 iframe。

此外模型还会把正文写到 `<now_plot>` 外、用 ``` 代码块包正文、变量块 JSON 语法写错--这些 detag 修不了，本插件用规则 + LLM 两级兜底处理。

## 安装

酒馆 → **扩展 (Extensions) → 安装扩展 (Install Extension)**，输入：

```
https://github.com/smallmj/format-assistant
```

刷新页面，在扩展设置里找到 **格式助手**。

> 仓库根即插件目录（`manifest.json` / `index.js` 在根），酒馆 clone 后直接加载。支持扩展自动更新。
> 老用户（Think Detagger）点扩展更新即可，旧链接自动跳转，**所有设置保留**。

---

## 1. detag：思考区去 tag（零成本）

把思考内容里的"危险 tag"去掉 `<>`（如 `<now_plot>` → `now_plot`），保留文字，防止未知 tag 被当 HTML 解析而崩渲染。

- **思考区识别**（以闭标签为锚）：
  - 标准配对 `<think>...</think>` / `<thinking>...</thinking>`
  - 仅收尾 `...</think>`（无开标签，部分模型/预设如此）
  - 无闭标签则不处理（无法判断边界，避免误伤正文）
- **思考标签可自定义**：默认 `think` / `thinking`，可加 `reasoning` / `cot` 等
- **边界标签保留**：`<think>`/`</think>` 本身不去 `<>`，原生折叠与预设自定义折叠正常
- **危险 tag 白名单 + 智能发现**：内置常见危险 tag；手动触发后自动扫描思考内容里"存在但没在名单"的 tag，弹窗问你是否加入白名单并自动重处理（排除 `<b>`/`<i>` 等合法 HTML）

**去尖括号示例**：`<now_plot>` → `now_plot`；`</now_plot>` → `/now_plot`；`<StatusPlaceHolderImpl/>` → `StatusPlaceHolderImpl/`；`<now_plot attr="x">` → `now_plot attr="x"`（保留属性文字）。

## 2. 规则结构修复（零成本）

detag 之后、LLM 之前的一层纯规则修复，处理确定性的结构问题，修得了就不必调 LLM：

- **代码块迁移**：把正文容器标签（默认 `<now_plot>`）内的成对 ``` 代码块整个移到 `</now_plot>` 之后，落单围栏删除。AI 误用代码块包正文时，既保留代码内容又不破坏正文美化。
- **正文容器重包裹**：当正文容器标签**完全缺失**、且有 `</think>` 闭标签和尾部锚点（`<summary>`/`<update>`/`<UpdateVariable>`/`<TimePeriod>` 等）时，把 `</think>` 后到锚点前的正文包进 `<now_plot>`。已有容器对 / 无锚点 / 无闭标签时不处理（交给 LLM）。
- **正文容器标签可自定义**：默认 `now_plot`，预设用 `<story>`/`<正文>` 也能配。

## 3. LLM 格式修复（可选，需配置）

规则修不了的语义/结构问题（tag 名错、变量块 JSON 语法错、复杂的正文错位等），用**独立连接的 LLM** 结合你指定的格式要求兜底修复。默认关闭，需在设置里启用并配置连接。

### 修什么 / 不修什么
- ✅ 未闭合结构补全、tag 名修正、变量块内部 JSON 语法、正文重排进容器
- ❌ 思考内容（由 detag 管）、变量值/路径语义（保留）、生图 tag（`<image>`/`<pic>` 原样）

### 独立修复连接
单独配 API URL / API Key / Model / max_tokens / temperature，**推荐用便宜快速模型**（如 `gemini-2.5-flash`），避免主模型预设高温干扰。
- **刷新模型按钮**：点"刷新模型"从 `{API URL}/models` 拉取模型列表，模型输入框变下拉选择（拉取失败可手动填，如遇 CORS 限制属正常）。
- **max_tokens 自动放大**：按原文实际 token 数 ×1.3 + buffer，与用户配置取较大值，长回复不截断。

### 格式要求来源（全手动，可多选）
- ☐ **世界书条目**：列出角色卡内嵌书 + 绑定全局书 + 全局勾选书的条目，勾选作为格式要求来源（带搜索框筛选）
- ☐ **预设 prompt**：列出当前预设的 prompt（按 `prompt_order` enabled），勾选作为格式要求来源（带搜索框筛选）
- ☐ **手动填写**：textarea 手写完整格式要求

### 触发（谨慎设计，不自动执行）
- **自动检测+询问**：开启后每轮检测到格式问题会**弹窗询问**是否修复（不自动执行），确认才进入修复流程；同一条只问一次
- **手动**：悬浮球右半 / `/fix-format` 命令 / 设置面板"立即 LLM 修复最近一条"按钮
- **修复前确认窗口**：LLM 返回并通过指纹校验后，弹出**行级 diff 高亮**（删除红/新增绿/未变灰）+ 修改原因，**确认才写回**，取消保留原文

### 指纹校验（保护正文）
- 指纹只比对**正文叙事文字**：剥离变量块（`<UpdateVariable>`/`<update>`/`<json_patch>`）与生图 tag 后，去 tag/标记/空白
- LLM 重排正文、修 tag 名、修变量块内部语法 → 正文叙事不变 → 通过
- LLM 润色正文 → 指纹变 → **拒绝，保留原文**
- 思考内容包含在指纹里，LLM 若违规改思考也会被拒

### 变量块策略
多个变量块是**正常的**（额外模型解析/其他插件会追加），LLM **不删除**，只修内部 JSON 语法（括号/引号/op 名/字段完整性），不改 path/value 语义。MVU 在 LLM 修复前已解析落盘，改变量块不影响已存变量。

### 依赖
- 装了**酒馆助手**（JS-Slash-Runner）：用其 `generateRaw` 走独立连接 + `json_schema` 约束输出（推荐）
- 未装：回退 ST 原生 `generateRaw`（无 json_schema，靠 prompt + 指纹兜底）

---

## 触发与时机

- **自动**（开启"自动模式"后每轮触发，只处理最近一条 AI 回复）：
  - 装了 MVU：优先监听 `VARIABLE_UPDATE_ENDED`（变量已落盘的最精确信号，立即执行）
  - 兜底 `MESSAGE_RECEIVED` / `GENERATION_ENDED`；装了 MVU 时延迟执行（默认 2s 可调）让 MVU 先写回
  - `MESSAGE_EDITED`：手动编辑消息后重新跑 detag + 规则修复
- **手动**：见下方"命令与悬浮球"

> detag + 规则修复是零成本自动跑的；LLM 修复默认只检测询问，不会自动执行。

## 命令与悬浮球

| 入口 | 作用 |
|---|---|
| 悬浮球**左半**（去标） | 手动 detag 最近一条 |
| 悬浮球**右半**（修复） | 手动 LLM 修复最近一条（含 diff 确认） |
| `/detag` | 手动 detag 最近一条 |
| `/fix-format` | detag + LLM 修复最近一条 |
| 设置面板"立即处理最近一条" | 手动 detag |
| 设置面板"立即 LLM 修复最近一条" | 手动 LLM 修复 |

悬浮球可拖动改位置（Pointer Events，手机/触屏也能拖）。detag 后会 toast 列出去掉了哪些 tag；发现未知 tag 会弹窗问是否加入白名单。

## 设置项一览

所有设置**改完即时生效**（实时自动保存，无保存按钮）。

**detag 区**
- 自动模式（总开关）/ 处理原生 reasoning / 显示悬浮球
- 思考内容标签（边界标签，一行一个）
- 危险 tag 白名单（一行一个）
- 正文容器标签（默认 `now_plot`）
- 自动模式延迟（秒）

**LLM 格式修复区**
- 启用 LLM 格式修复 / 自动检测询问
- 修复超时（秒）
- 独立修复连接（API URL / Key / Model + 刷新模型下拉 / max_tokens / temperature）
- 格式要求来源（世界书条目勾选 + 搜索 / 预设 prompt 勾选 + 搜索 / 手动填写）

### 默认危险 tag 白名单

```
now_plot, plot, prev_plot, next_plot
UpdateVariable, Analysis, StatusPlaceHolderImpl, CharView
action, summary, DiceCombat, disclaimer, pic, thought, reasoning
状态, 剧情, 行动, 思考, 变量
```

覆盖 MVU 格式壳、剧情变量、常见预设结构块、中文非 ASCII tag。不同预设请按需增删。

---

## 处理示例

| 形态 | 输入 | 输出 |
|---|---|---|
| detag 标准配对 | `<think>推演 <now_plot>教堂</now_plot></think>正文` | `<think>推演 now_plot教堂/now_plot</think>正文` |
| detag 仅收尾 | `推演 <now_plot>教堂</now_plot></think>正文` | `推演 now_plot教堂/now_plot</think>正文` |
| detag 自定义思考标签 | `<reason>推演 <now_plot>教堂</now_plot></reason>正文` | `<reason>推演 now_plot教堂/now_plot</reason>正文` |
| 规则：代码块迁移 | `<now_plot>文 ```code``` 续</now_plot>` | `<now_plot>文  续</now_plot>\n\n```code``` |
| 规则：正文重包裹 | `思</think>\n正文\n<summary>要</summary>` | `思</think>\n<now_plot>\n正文\n</now_plot>\n<summary>要</summary>` |
| 正文 HTML | `<b>粗体</b>`（不在白名单） | 不动 |
| MVU 命令 | `_.set('a',1,2)//原因` | 不动 |

## 兼容性

- **MVU**：排在 `VARIABLE_UPDATE_ENDED` 之后，不会被 MVU `setChatMessages` 覆盖。MVU 用 `_.set()` 存变量不回溯重解析，去 tag 不影响变量正确性。
- **原生 reasoning**：`auto_parse` 关闭时 `<think>` 留在正文也能处理；开启抽到 `extra.reasoning` 时由"处理 reasoning"覆盖。
- **酒馆助手**：不冲突，只改文本不碰 iframe 渲染。LLM 修复优先用酒馆助手 `generateRaw`。
- **合法 HTML**：白名单外 tag（`<b>`/`<i>`/`<br>` 等）不动。
- **swipe**：修复写回 `mes` + `swipes[当前]`，swipe 切换不丢失。

## 已知边界

1. **非 MVU 的"每次渲染重新提取变量"预设**：若预设靠每次渲染从 think 文本正则提取变量（而非像 MVU 存变量），去 tag 可能破坏其提取。缓解：把白名单缩小到只含纯展示性 tag。
2. **无闭标签不处理**：仅 `<think>` 无 `</think>` 时无法判断边界，detag 不处理（避免误伤正文）。
3. **仅收尾模式不补开标签**：只去 tag 防崩，不为仅收尾消息补 `<think>` 开标签。
4. **MVU 晚加载**：轮询等待 `window.Mvu` 最多 10s，超时仅用 `MESSAGE_RECEIVED` + `GENERATION_ENDED` 兜底。
5. **规则修复有限**：代码块迁移 + 正文重包裹只处理确定性子集；tag 名错、JSON 语法错、复杂语义错位仍需 LLM。
6. **LLM 修复非万能**：指纹校验保守，LLM 做等价改写（同义词替换）也会被拒（安全优先）；整文重写有成本/延迟。

## 开发与测试

纯逻辑在 `core.js`（detag/思考区识别/未知 tag 扫描）与 `fixer.js`（指纹/问题检测/规则修复/diff/prompt 构建），均不依赖酒馆，可独立测试：

```bash
npm test          # 跑全部 111 个用例
node test/core.test.mjs     # detag / findThinkRegions / detagMes / findUnknownTags
node test/fixer.test.mjs    # 指纹 / detectIssues / lineDiff / ruleFixStructure
```

覆盖：开/闭/自闭合/带属性/中文 tag/幂等/标准配对/仅收尾/多块混合/无闭标签/自定义思考标签/代码块迁移/正文重包裹/指纹不变与变化/diff 等。

## License

MIT
