# Changelog

## v1.0.2（2026-07-21）- tag 补全 + 误报修复 + LLM 规则修复

- **detectIssues 加 checkGlobalTagBalance**：全文 tag 开闭配对检测，报漏开/漏闭（覆盖正文区 plotTag 外），打通 LLM 补全触发。
- **ruleFixStructure 加 completePlotTag**：规则补全 plotTag 漏开/漏闭（零成本），修掉 rewrapPlot 漏开的双闭畸形 bug。
- **buildFixPrompt 规则 5 显式化**：补全缺失的开标签 `<xxx>` 或闭标签 `</xxx>`。
- 其他结构性 tag 漏开/漏闭：detectIssues 检测后触发 LLM 补全（已有流程，指纹对结构性 tag 通过）。
- 变量块/生图 tag 漏闭：暂不支持（指纹保护变量块内容）。
- **initvar 误报修复**：含 `<initvar>` 的变量初始化消息跳过 plotTag 缺失检测，避免 first_mes 误报。
- **LLM prompt 规则修复**：规则2 允许清理变量块内误嵌的非变量结构（image 生成代码/构思过程 tag）；规则3 允许清理 image 块内构思过程，只保留 image###prompt###。修复 LLM 对"变量块内误嵌 image"返回 changed=false 的问题。
- 175 测试通过（fixer 102 + core 73）。

## v1.0.1（2026-07-21）— bug 修复

三批 bug 修复（高/中/低严重，共约 44 项），162 测试通过。

- **主 bug**：think 内出现 tag 不再误触发"是否启用 LLM"询问。`detectIssues` 入口先剥离 think 区内容再检测，think 内的 tag/落单代码围栏/json_patch 语法错不再进 LLM 路径（LLM 本就改不了 think）。
- **悬浮球手机不显示**：z-index 提到 9999999 + 媒体查询上移避开底部输入栏。
- **M7 改回**：手动修复（悬浮球右半/`/fix-format`）恢复调 LLM 前 confirm，取消时不浪费 LLM 调用。
- 高严重（H1-H7）：think 标签带属性/空白识别、rewrapPlot 双重包裹、fixCrossingTags 大小写、getTavernHelper 误判 ST 原生、未装酒馆助手时 fetch 兜底独立连接、CHAT_CHANGED 状态污染。
- 中严重（M1-M18）：自动模式白名单 toast 提示、findUnknownTags 全文模式扫 reasoning、规则修复（带属性 plotTag/嵌套同名/落单围栏）、指纹保留引号、swipe 写回越界/切 swipe、双重确认、temperature NaN、防抖等。
- 低严重：findThinkRegions 幽灵 region、ESC 关闭 diff 窗口、diff 超 500 行限流、悬浮球中缝不误触、悬浮球位置持久化、MESSAGE_EDITED 重处理、LONE_FENCE 中文语言名、lineDiff 内存阈值等。

## v1.0.0（2026-07-20）— 改名"格式助手" + 规则结构修复

- 改名 Think Detagger → **格式助手**，仓库 → `smallmj/format-assistant`（旧链接自动跳转，老用户设置保留）。
- **规则结构修复**（detag → 规则 → LLM 三级流水线）：代码块迁移（plotTag 内 ``` 移出）、plotTag 重包裹（正文在外则包进）、跨越 tag 修正（开在内闭在外的 tag 移到外）。
- swipe 写回（修复不被 swipe 切换丢失）。
- 监听 MESSAGE_EDITED，编辑后重新 detag + 规则修复。
- README 按三级流水线重构，补全最新功能。
- examples 测试文本脱敏。

## v0.4.0（2026-07-20）— LLM 格式修复模块

- **LLM 格式修复**（可选）：独立修复连接、自动检测+询问（不自动执行）、diff 确认窗口（行级高亮）、指纹校验（保护正文叙事）、变量块保留只修内部 JSON 语法。
- **格式要求来源**（全手动配置）：世界书条目勾选 + 预设 prompt 勾选 + 手动填写，带搜索框筛选。
- 模型刷新下拉（从 API 拉取模型列表）。
- 设置实时自动保存（无保存按钮）。
- 悬浮球分两半（左 detag / 右 LLM 修复）。
- max_tokens 按原文长度动态放大，长回复不截断。
- 正文容器标签（plotTag）自定义。
- 列表搜索框、按钮横排、输入标注。

## v0.3.0（2026-07-20）— 详细提示 + 未知 tag 发现

- detag 返回 removedTags，手动后详细 toast 列出去掉的 tag。
- findUnknownTags 发现思考内容里"存在但未在白名单"的 tag，弹窗询问是否加入白名单并自动重处理。
- 按钮横排修复。

## v0.2.0（2026-07-20）— 自定义标签 + 自动模式 + 悬浮球

- 自定义思考内容标签（thinkTags）。
- 自动模式：MVU `VARIABLE_UPDATE_ENDED` 优先 + `MESSAGE_RECEIVED`/`GENERATION_ENDED` 防抖兜底。
- 悬浮球（可拖动，Pointer Events 触屏支持）。
- 自动与手动都只处理最近一条 AI 回复。
- 设置写回持久化修复（getSettings 返回引用而非副本）。

## v0.1.0（2026-07-20）— 初始版本

- detag：把思考内容里的危险 tag 去掉 `<>`（如 `<now_plot>` → `now_plot`），防未知 tag 破坏渲染。
- 危险 tag 白名单（可配置）。
- 思考区识别：标准配对 `<think>...</think>` + 仅收尾 `...</think>`。
- 边界标签保留，原生折叠不受影响。
