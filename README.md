# 格式助手

一个 SillyTavern（酒馆）扩展：在每轮对话接收完整（含 MVU 变量解析、额外模型生成）之后，自动把模型输出中思考内容里的"危险 tag"去掉 `<>`（如 `<now_plot>` -> `now_plot`），保留文字内容，防止酒馆助手 / 浏览器把未知 tag 当 HTML 解析而破坏渲染。

**自动模式与手动模式都只处理最近一条 AI 回复**，不会改动历史消息。

## 为什么需要

带 MVU 变量、依赖 Kemini Dramatron / Izumi 等预设的角色卡，模型常在 `<think>` 思考块里输出 `<now_plot>`、`<状态>`、`<UpdateVariable>` 等自定义 tag。酒馆默认 `encode_tags` 关闭 + showdown 透传 HTML + DOMPurify 解析未知标签，未闭合或非 ASCII 的 tag 会让浏览器重排 DOM，导致整条消息渲染崩坏、格式错乱、或代码块无法被酒馆助手转成 iframe。

本插件在变量解析完成后，把这些 tag 的 `<>` 去掉（保留文字），让它们变成纯文本，从根源上消除渲染破坏，同时保留思考内容可读性与思考块折叠结构。

## 安装

在酒馆中：**扩展 (Extensions) -> 安装扩展 (Install Extension)**，输入本仓库的 GitHub 地址：

```
https://github.com/smallmj/format-assistant
```

安装后刷新页面，在扩展设置里找到 **格式助手**。

> 仓库根目录即插件目录（`manifest.json` / `index.js` 在根），酒馆 clone 后直接作为第三方扩展加载。

## 工作原理

1. **触发时机**（自动模式）：
   - 检测到 **MVU**（MagVarUpdate）时，监听其 `VARIABLE_UPDATE_ENDED` 事件--这是"变量已落盘"的最精确信号，保证在 MVU 解析（含额外模型二次生成）之后再处理，立即执行。
   - 同时监听 `MESSAGE_RECEIVED` / `GENERATION_ENDED` 作为兜底；装了 MVU 时延迟执行（默认 2s，可调），让 MVU 先写回，避免被覆盖；未装 MVU 时立即执行。
2. **思考区段识别**（以闭标签为锚，支持两种形态）：
   - 标准配对：`<think>...</think>` / `<thinking>...</thinking>`（或你自定义的思考标签）
   - 仅收尾：`...</think>`（无开标签，部分模型/预设如此）
   - **无闭标签则不处理**（无法判断思考/正文边界，避免误伤正文）
3. **去尖括号**：对每个白名单 tag，匹配 `<tag...>` / `</tag...>` / `<tag.../>`，替换为去掉首尾 `<` `>` 后的中间内容（保留 `/` 与属性文字）。例：`<now_plot>` -> `now_plot`，`</now_plot>` -> `/now_plot`，`<StatusPlaceHolderImpl/>` -> `StatusPlaceHolderImpl/`。
4. **边界标签保留**：思考内容标签（`<think>` / `</think>` 等）本身不去 `<>`，原生 reasoning `auto_parse` 与预设自定义折叠仍能正常识别。
5. **持久化**：写回 `chat[id].mes`（及 `extra.reasoning`），调 `saveChatDebounced()` 存盘、`updateMessageBlock()` 重渲。操作幂等，重复触发安全。
6. **处理范围**：自动与手动都只处理**最近一条 AI 回复**。

## 处理示例

| 形态 | 输入 | 输出 |
|---|---|---|
| 标准配对 | `<think>推演 <now_plot>教堂</now_plot></think>正文` | `<think>推演 now_plot教堂/now_plot</think>正文` |
| 仅收尾 | `推演 <now_plot>教堂</now_plot></think>正文` | `推演 now_plot教堂/now_plot</think>正文` |
| 自定义思考标签 | `<reason>推演 <now_plot>教堂</now_plot></reason>正文` | `<reason>推演 now_plot教堂/now_plot</reason>正文` |
| 正文 HTML | `<b>粗体</b>`（不在白名单） | 不动 |
| MVU 命令 | `_.set('a',1,2)//原因` | 不动（非白名单 tag） |

## 设置面板

- **自动模式**：每轮对话接收完整后（含额外模型解析）自动去标签的总开关
- **同时处理原生 reasoning**：是否处理模型 API 返回的思考字段（`extra.reasoning`）
- **显示悬浮球**：显示/隐藏手动触发的悬浮球（可拖动）
- **思考内容标签**：边界标签，一行一个（默认 `think` / `thinking`；可加 `reasoning` / `cot` 等预设自定义的思考标签）。这些标签本身保留，只处理其**内部**的 tag
- **危险 tag 白名单**：一行一个 tag 名。思考内容标签勿重复加入。可按预设增删
- **自动模式延迟（秒）**：装了 MVU 时等待变量解析的延迟，0=立即
- **立即处理最近一条**：手动处理最近一条 AI 回复
- 斜杠命令：`/detag` 同上

### 默认白名单

```
now_plot, plot, prev_plot, next_plot
UpdateVariable, Analysis, StatusPlaceHolderImpl, CharView
action, summary, DiceCombat, disclaimer, pic, thought, reasoning
状态, 剧情, 行动, 思考, 变量
```

覆盖 MVU 格式壳、剧情变量、常见预设结构块、中文非 ASCII tag。不同预设 tag 不同，请按需调整。

## 手动模式

手动模式只处理**最近一条 AI 回复**，入口：
- **悬浮球**：页面右下角圆形，**左半 detag（去标签）/ 右半 LLM 修复格式**，可拖动改位置
- 设置面板"立即处理最近一条"按钮（detag）/ "立即 LLM 修复最近一条"按钮
- 斜杠命令 `/detag`（仅去标签）/ `/fix-format`（detag + LLM 修复）

detag 触发后会给出详细提示：列出本次去掉了哪些 tag 的尖括号，或提示"无需处理"；并自动扫描思考内容中**存在但未在危险名单**的 tag（排除 `<b>`/`<i>` 等常见合法 HTML），弹窗询问是否加入白名单并自动重新处理一遍。

## LLM 格式修复（v0.4.0，可选）

detag 只能处理思考区里的 tag（去 `<>` 防崩），修不了正文区的结构格式错误（如正文写在 `<now_plot>` 外、`<now_plot>` 为空、tag 名错、代码块未配对、变量块 JSON 语法错）。LLM 格式修复模块用**独立连接的 LLM** 结合你指定的格式要求做兜底修复。

### 工作方式（detag + LLM 接力）
1. detag 先处理思考区 tag（零成本）
2. `detectIssues` 检测正文区结构问题（now_plot 空/正文在外/代码块未配对/json_patch 语法错/未知 tag）
3. 检测到问题才调 LLM（整文重写）
4. **指纹校验**：只比对"正文叙事文字"（剥离变量块 `<UpdateVariable>/<update>/<json_patch>` 与生图 `<image>/<pic>` 后），LLM 改了正文叙事则拒绝、回退原文
5. 通过则写回 `mes` + 重渲

### 配置
- **启用 LLM 格式修复**：总开关
- **自动模式**：检测到问题自动调 LLM（关闭则只手动）
- **独立修复连接**：API URL / API Key / Model / max_tokens / temperature（推荐用便宜快速模型如 `gemini-2.5-flash`，避免主模型预设高温干扰）
- **修复超时**：秒
- **格式要求来源**（手动配置，可多选组合）：
  - ☐ **世界书条目**：列出当前角色卡内嵌书 + 绑定全局书 + 全局勾选书的条目，勾选要作为格式要求的条目
  - ☐ **预设 prompt**：列出当前预设的 prompts（按 prompt_order enabled），勾选要作为格式要求的 prompt
  - ☐ **手动填写**：textarea 手写格式要求
  - 刷新按钮：角色卡/预设切换后重新加载列表（勾选状态按 uid/identifier 保留）

### 触发（谨慎设计，不自动执行）
- **自动检测+询问**：开启"自动检测"后，每轮检测到格式问题会**弹窗询问**是否修复（不自动执行），确认后才进入修复流程；同一条消息只询问一次
- **手动**：悬浮球右半 / `/fix-format` 命令 / 设置面板"立即 LLM 修复最近一条"按钮
- **修复前确认**：LLM 返回修复结果并通过指纹校验后，弹出**确认窗口**显示行级 diff（删除行红、新增行绿、未变灰）和修改原因，用户**确认才写回**，取消则保留原文

### 指纹校验与变量块
- **指纹只比对正文叙事文字**：剥离变量块和生图 tag 后，去 tag/标记/空白。LLM 重排正文、修 tag 名、修变量块内部语法都不改变正文叙事 -> 通过；LLM 润色正文 -> 指纹变 -> 拒绝。
- **变量块保留**：多个变量块是正常的（额外模型解析/其他插件会追加），LLM 不删除，只修内部 JSON 语法（括号/引号/op 名/字段完整性），不改 path/value 语义。MVU 在 LLM 修复前已解析落盘，改变量块不影响已存变量。
- **思考内容**：LLM 不修改（`</think>` 之前），由 detag 管；指纹含思考文字，LLM 若违规改思考会被拒绝。

### 依赖
- 装了**酒馆助手**（JS-Slash-Runner）：用其 `generateRaw` 走独立连接 + `json_schema` 约束输出（推荐）。
- 未装酒馆助手：回退 ST 原生 `generateRaw`（无 json_schema，靠 prompt + 指纹校验兜底）。

## 兼容性

- **MVU**：排在 `VARIABLE_UPDATE_ENDED` 之后，不会被 MVU 的 `setChatMessages` 覆盖。MVU 用 `_.set()` 存变量，不回溯重解析历史消息，去 tag 不影响变量正确性。
- **原生 reasoning**：默认 `auto_parse` 关闭时 `<think>` 留在正文也能处理；开启 `auto_parse` 抽到 `extra.reasoning` 时由"处理 reasoning"选项覆盖。
- **酒馆助手 (JS-Slash-Runner)**：不冲突。本插件只改文本不碰 iframe 渲染。
- **合法 HTML**：白名单外 tag（`<b>` `<i>` `<br>` 等）不动。

## 已知边界

1. **非 MVU 的"每次渲染重新提取变量"预设**：若某预设靠每次渲染从 think 文本正则提取变量（而非像 MVU 存变量），去 tag 可能破坏其提取。缓解：把白名单缩小到只含纯展示性 tag。
2. **无闭标签不处理**：仅 `<think>` 无 `</think>` 时无法判断边界，插件不处理（避免误伤正文）。
3. **仅收尾模式不补开标签**：只做"去 tag 化防崩"，不为仅收尾消息补开标签（避免改变预设预期显示）。思考内容仍留在正文但不再破坏渲染。
4. **MVU 晚加载**：轮询等待 `window.Mvu` 最多 10s，超时仅用 `MESSAGE_RECEIVED` + `GENERATION_ENDED` 兜底。
5. **只处理最近一条**：自动与手动都只处理最近一条 AI 回复，不回溯历史。历史消息若需清理，可手动逐条切到该条后用 `/detag`（切到某条后该条即"最近"）。
6. **编辑后的消息**：未监听 `MESSAGE_EDITED`，手动编辑加回的 tag 不会被自动处理，可用 `/detag` 重新处理最近一条。

## 开发与测试

核心逻辑在 `core.js`（纯函数，不依赖酒馆，可独立测试）：

```bash
node test/core.test.mjs
# 或
npm test
```

测试覆盖 `detag` / `findThinkRegions` / `detagMes` / `detagReasoning` 的各种形态（开/闭/自闭合/带属性/中文 tag/幂等/标准配对/仅收尾/多块混合/无闭标签/自定义思考标签）。

## License

MIT
