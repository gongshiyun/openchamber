# Claude Code 后端集成设计（OpenChamber 分叉）

日期：2026-10-10
状态：已评审（设计节 1-3 已由用户确认）
目标分支：`feat/claude-code-backend`（基线 `main` 提交 `7bd52e1`）

## 1. 背景与目标

OpenChamber 目前只支持 OpenCode 作为 agent 后端。本设计的目标是在 UI 中按会话选择后端：OpenCode 或 Claude Code。Claude Code 以完整 agent 后端形态接入，使用它自己的工具、权限体系、CLAUDE.md、skills 与子代理。

已确认的边界：

- 定位：先自用验证，架构保持干净；日后若贡献上游，可参考仓库已有的 `provides: ["browser"]` 先例，提案给 SDK 增加 `provides: ["agent"]` 角色，本适配器即第一个实现。
- 选择粒度：会话级。新建会话时选择后端，会话绑定后端；列表混排并标注来源。
- v1 范围：核心闭环。新建会话、流式对话（含思维链与工具卡片）、权限审批、中断、模型选择、会话恢复与历史。Goals、multi-run、walkthrough、配额、定时任务不在 v1。
- 主要形态：Windows Desktop（Electron）为主；Web 同可用（改动在服务端与共享 UI）。
- 认证：完全复用本机 `claude` CLI 自身配置（当前为 API Key），OpenChamber 不读、不存、不传任何凭证。
- 交付方式：修改核心代码（分叉），不是扩展面板。已评估并排除扩展路线，理由见第 2 节。

## 2. 调研结论（决定方案的关键事实）

1. OpenChamber 服务端以 HTTP 代理方式转发 `/api/*` 到 `opencode serve`（`packages/web/server/lib/opencode/proxy.js`，目标解析在 `resolveProxyTarget`）。这是第二后端最自然的接缝；服务器是 Web、Desktop、Mobile、VS Code 的共同上游。
2. UI 的消息与事件形状集中在 `packages/ui/src/lib/opencode/`（`events.ts` 的 `translateWireEvent`、`projection.ts`、`model.ts`、`client.ts`）。只要服务端产出同形状的 wire 事件与数据，聊天渲染、工具卡片、审批组件全部可以直接复用。
3. UI 对服务端的会话生命周期调用是无状态的 REST 加事件流：`session.create/list/get/update/remove`、`message.list`、`session.prompt`、`session.interrupt`、`session.switchModel/switchAgent`、`permission.reply`，事件走 WS 主通道（`/api/global/event/ws`，由服务端 `global-hub` 供数）与 SSE 降级通道（`/api/event`，当前为上游直连代理）。
4. `createSession` 已在 UI 侧支持 `metadata` 参数并透传到服务端（`sync/session-actions.ts`、`lib/opencode/client.ts`），可作为"后端选择"的携带通道，不新增创建端点。
5. 扩展系统（`packages/sdk`）无法替换聊天后端；第三方集成（`@openchamber/opencode-claude`）是 OpenCode 的模型提供商插件，机制为"Claude 出脑子、OpenCode 出工具"，且明确拒绝 API Key。两者都不满足"完整 agent 后端"的语义。
6. Electron 桌面端在主进程内启动服务端；`lib/opencode/env-runtime.js`（CLI 探测、Windows shim 处理）与 `lib/opencode/managed-process-registry.js`（孤儿进程治理）提供可直接复用的模式。

## 3. 架构

```text
浏览器 UI（wire 形状不变，仅新增"后端选择"入口与来源徽标）
   │  /api/*（现有同源代理）
   ▼
OpenChamber 服务端
   ├── 现有代理 ──────────► opencode serve（默认后端，行为不变）
   └── 新模块 claude-code（本次新增）
         ├── HTTP 子集路由：命中 Claude 会话的请求由它应答
         ├── 事件翻译：Claude SDK 消息流 → OpenCode v2 wire 事件 → 注入事件总线
         ├── 会话存储：每会话一个 JSONL（消息、模型、Claude resume uuid、权限记忆）
         └── 进程管理：每活跃会话一个 claude 子进程（流式输入，可中断）
```

关键决策：

1. 模块位置：`packages/web/server/lib/claude-code/`，放服务端，四端共享；职责划分对照现有 `lib/opencode/`。
2. 会话身份：适配器生成与 OpenCode 同格式的 `ses_` 时间可排序 id（格式来源 `packages/ui/src/lib/opencode/ids.ts`）。代理入口按"会话登记表"分流：命中 Claude 会话的 `/api/session/...`、`/api/message/...`、`/api/permission/...` 请求交给适配器，其余原样转发 OpenCode。
3. 创建通道：新建会话时 UI 在 `createSession` 的 `metadata` 里带 `openchamber.backend = "claude"`；代理识别该标记后转适配器创建。Claude 的 resume uuid 由适配器生成并单独记录。
4. 事件通道：适配器产出 OpenCode v2 形状事件（`message.updated`、`message.part.updated`、`session.idle`、`session.error`、`permission.asked`、`permission.replied` 等），注入 `global-hub`。WS 主通道即覆盖；SSE 降级通道 `/api/event` 改为"透传 OpenCode 上游帧 + 并入 Claude 事件"的多路复用。浏览器端 `events.ts` 及渲染逻辑不改。
5. 历史与恢复：适配器自存 JSONL；`message.list`、`session.get` 从它分页应答；会话恢复用登记的 Claude session uuid 走 SDK `resume`。
6. 权限：SDK 的 `canUseTool` 回调对接现有 `permission.asked` / `permission.reply` 链路；`always` 决策记在会话级。
7. 进程模型：每活跃 Claude 会话一个长驻 `claude` 子进程（SDK 流式输入模式），空闲 15 分钟回收，回收后下条消息用 `resume` 拉回；服务退出时全部终止，启动时清理残留，复用 `managed-process-registry`。
8. 默认不变：不选 Claude 时一切照旧；Claude 会话与 OpenCode 会话在同一项目列表混排。

## 4. 组件与文件级改动

### 新模块 `packages/web/server/lib/claude-code/`（全部新增）

| 文件 | 职责 |
|---|---|
| `index.js` | 模块入口，装配路由、事件注入、生命周期 |
| `cli-resolution.js` | 定位 `claude` CLI：环境变量覆盖 → PATH 探测（复用 `searchPathFor` 模式，含 PATHEXT）→ 常见安装位置；Windows `.cmd` shim 走 ComSpec 包装；settings 支持 `claudeBinary` 手动指定。参照 `lib/opencode/env-runtime.js` |
| `runner.js` | 会话进程管理：Agent SDK `query()` 流式输入模式；发送、中断、切模型、切权限模式；`canUseTool` 权限回调；空闲回收；退出清理；注册 `managed-process-registry` |
| `translator.js` | SDK 消息流 → OpenCode v2 wire 事件与 part 形状。纯函数，单测重点 |
| `session-store.js` | 每会话 JSONL + 目录级索引；`message.list` 分页；重启恢复 |
| `routes.js` | HTTP 子集：session 增删改查、message.list、prompt、interrupt、switchModel/switchAgent、permission.reply、provider/model 与 agent 列表（伪 `claude-code` provider） |
| `events-feed.js` | 翻译后事件注入服务端事件总线 |
| `DOCUMENTATION.md` | 模块文档，按仓库惯例 |

### 对现有文件的薄编辑

1. `lib/opencode/proxy.js`：入口分流函数（命中会话登记表，或 `POST /api/session` 带 `metadata.openchamber.backend = "claude"`）；`GET /api/session` 列表处理合并 Claude 会话。
2. `lib/event-stream/`（hub 或上游读取器）：暴露注入接口；若 hub 已有发布侧接口则直接复用。
3. `lib/opencode/proxy.js` 的 `/api/event` 路由：改为上游帧透传 + Claude 事件并入的多路复用。
4. 服务端装配处（`server-utils-runtime.js` 或 `index.js`）：实例化模块；读取 `claudeBinary` 设置（对照 `applyOpencodeBinaryFromSettings`）。
5. UI：
   - `sync/session-actions.ts`、`sync/session-ui-store.ts`：新建会话时把后端选择放进 metadata 通道。
   - 新建会话草稿的控制行（参照 `ModelControls.tsx`）：新增"后端"下拉；选 Claude 时显示 Claude 模型下拉（Opus / Sonnet / Haiku 等）。
   - 会话列表与聊天头部：小徽标，读取 metadata 中的 backend 标记。
6. `packages/web/package.json`：新增依赖 `@anthropic-ai/claude-agent-sdk`（已获用户批准）。

### 工程准备

- `git init` + 基线提交 `7bd52e1` + 特性分支 `feat/claude-code-backend`（已完成）。
- 上游 remote：`upstream` 指向 `openchamber/openchamber`，将来以 rebase 方式跟进。
- 本地专属产物（`.claude/skills` junction、`CLAUDE.md` 副本）通过 `.git/info/exclude` 排除，不进提交。

## 5. 运行细节

### 认证

- 完全复用 `claude` CLI 自身配置；适配器不读、不存、不传凭证。
- API Key 场景要求 `ANTHROPIC_API_KEY` 存在于服务进程环境（Desktop 启动时从 shell/注册表恢复用户环境，通常已满足；中转的 `ANTHROPIC_BASE_URL` 同理透传）。
- 可用性探测：启动时尝试 `claude --version`；开会话失败时把 claude 原始 stderr 呈现给用户。

### 进程与生命周期

- 每活跃会话一个 `claude` 子进程；一个会话同时只跑一轮，多余消息排队；不同会话可并发。
- 空闲 15 分钟回收；下条消息用 `resume` 拉回，会话不丢。
- 服务退出全部终止；启动清理残留（复用 `managed-process-registry`）。
- 单会话崩溃不影响其他会话；错误以 `session.error` 进入会话流，UI 现有错误样式直接显示。

### 事件接线

- 主通道：Claude 事件注入 `global-hub`，WS 通道覆盖。
- 降级通道：`/api/event` 多路复用（上游帧原样透传，Claude 事件并流），保持心跳与时序不变。

### Windows

- npm 安装的 `claude` 为 `.cmd` shim，走 ComSpec 包装；原生安装为 `claude.exe` 直接执行。
- 全链路参数数组式 spawn，不拼命令行字符串；路径含空格或中文不受影响。

## 6. v1 功能矩阵

| 能力 | v1 状态 |
|---|---|
| 新建会话选后端（OpenCode / Claude Code） | 支持 |
| 流式文本、思维链、工具卡片 | 支持 |
| 权限审批（once / always / reject），always 记会话级 | 支持 |
| 中断、重命名、删除、移动（换项目）、列表混排 | 支持 |
| 模型选择（Opus / Sonnet / Haiku 等），创建时与会话内切换 | 支持 |
| 重启后恢复会话与历史 | 支持 |
| 文件 diff 面板、终端、Preview | 支持（走工作区自身能力，与后端无关） |
| 子代理（Task 工具） | 以工具卡片展示，不做嵌套面板 |
| Goals / multi-run / walkthrough / 定时任务 / 配额卡片 | 不支持，UI 入口对 Claude 会话隐藏 |
| Plan / acceptEdits / bypass 权限模式切换 | 不支持，固定"按需询问"；后续迭代 |
| 用量与成本展示 | 暂不显示（SDK 有数据，后续接） |

多端说明：服务端实现加共享 UI，Web 与 Desktop 直接可用；VS Code 与手机端未纳入 v1 验证范围。

## 7. 测试与验收

- 单测：`translator`（SDK 消息样本 → 断言 wire 事件序列）、`session-store`（分页、崩溃恢复）、`cli-resolution`（Windows shim 分支）。
- 集成：路由处理器接假 runner；事件总线注入冒烟；`/api/event` 多路复用冒烟。
- 仓库检查：通过仓库既有检查（type-check、lint、knip 零发现、anti-slop 棘轮）。
- 手工验收（Windows Desktop + 真 claude + API Key）：
  1. 新建 Claude 会话，发一个包含文件编辑与 shell 命令的任务；观察流式文本、思维链、工具卡片。
  2. 审批一次 `once`、一次 `always`、一次 `reject`，验证行为与记忆。
  3. 中断运行中的任务。
  4. 重启应用：会话仍在列表、历史可加载、下条消息可恢复。
  5. 同一项目里 OpenCode 会话不受影响；列表混排与徽标正确。
  6. 重命名、删除 Claude 会话。

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| OpenCode wire 形状细节漂移 | 形状以 `events.ts` / `projection.ts` / `client.ts` 为规范源，实现时逐项确认；translator 单测覆盖 |
| hub 注入接口不齐 | 加薄注入函数，不影响现有 subscriber；先确认 `global-hub` 现状 |
| `/api/event` 多路复用改变 SSE 行为 | OpenCode 帧保持透传，仅追加 Claude 事件；冒烟测试覆盖 |
| SDK 与用户 CLI 版本耦合 | 优先指向用户已装 CLI（`pathToClaudeCodeExecutable`）；版本过旧给明确提示 |
| 审批语义差异（Claude 默认模式自动放行只读工具） | 行为对齐 Claude 原生并写入模块文档 |
| 会话列表分页限制 | v1 把 Claude 会话并入首屏，cursor 分页仅覆盖 OpenCode 侧；作为已知限制记录 |

## 9. 后续迭代

- 权限模式切换（plan / acceptEdits / bypass）、用量与成本显示、子代理嵌套面板。
- Goals、定时任务、multi-run 对 Claude 会话的接线（依赖各模块对会话后端的路由）。
- 上游提案：按 `provides: ["browser"]` 先例，向 `@openchamber/sdk` 提案 `provides: ["agent"]` 角色，本适配器作为参考实现。

## 10. 决策记录

| 问题 | 决定 |
|---|---|
| 最终目标 | 先自用验证，架构干净，日后可考虑上游 |
| 选择粒度 | 会话级 |
| v1 范围 | 核心闭环 |
| 主要形态 | Windows Desktop |
| 认证环境 | 已装 claude CLI，API Key |
| 交付路线 | 改核心（路线 3，完整 agent 后端）；排除扩展面板与第三方集成路线 |
| 新增依赖 | `@anthropic-ai/claude-agent-sdk`，已批准 |
| 版本控制 | git 基线 + 特性分支，已批准 |

## 附录 A：适配器 v1 接口子集

- 会话：`session.list`（合并贡献）、`session.create`（带 backend 标记）、`session.get`、`session.update`（重命名）、`session.remove`、`session.move`（更新存储目录）
- 消息：`message.list`（分页从 JSONL）、`session.prompt`、`session.interrupt`
- 配置：`session.switchModel`、`session.switchAgent`（接受并记录）、伪 `claude-code` provider 与模型列表（供选择器）、agent 列表
- 权限：`permission.reply`（once / always / reject）
- 事件（产出）：`session.created`、`session.updated`、`message.updated`、`message.part.updated`、`session.idle`、`session.error`、`permission.asked`、`permission.replied`
- 事件（消费）：`/api/event` 多路复用输出

具体 wire 字段以 `packages/ui/src/lib/opencode/events.ts`、`projection.ts`、`client.ts` 为准，实现时逐项核对。

## 附录 B：已知限制

- Claude 会话固定"按需询问"权限模式，无模式切换 UI。
- 无用量与成本展示。
- 会话列表分页：Claude 会话并入首屏，历史游标分页只覆盖 OpenCode 会话。
- 子代理以工具卡片呈现，无嵌套视图。
- VS Code 与手机端未验证。
