# Claude Code 后端实现计划（OpenChamber 分叉）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 OpenChamber 中按会话接入 Claude Code 作为第二 agent 后端（v1 核心闭环）。

**Architecture:** 服务端新增 `packages/web/server/lib/claude-code/` 模块：Claude Agent SDK 驱动 `claude` 子进程，翻译成 OpenCode v2 wire 事件经 `global-hub.injectEvent` 注入现有事件通道；代理在就绪闸门之前按会话登记表分流；浏览器 UI 仅新增后端选择入口与来源徽标。

**Tech Stack:** Bun 1.4.2（工作区管理）、Node 24.14（脚本运行时）、Express 5、vitest（web/ui 测试）、`@anthropic-ai/claude-agent-sdk`（新增依赖）。

**设计依据：** `docs/superpowers/specs/2026-10-10-claude-code-backend-design.md`（2026-10-11 修订版）。

## Global Constraints

- 本机命令 PATH 前置：`$env:PATH = "D:\software\nodejs;$env:PATH"`（Node 24.14 在 `D:\software\nodejs`；默认 PATH 指向 node22）。
- 提交前门禁：每个涉及源码的提交前运行 `bun run check:changed`（type-check、lint、knip、anti-slop）。迭代期间只跑聚焦测试。
- 并行 subagent 规则（仓库要求）：并行期间每个 agent 只编辑自己的文件、只跑单测文件；type-check/lint/全量套件由协调者（主会话）在合并后串行运行一次。`tsc -b` 在 packages/ui 上很重，不要并行跑。
- 不推送远端；提交留在本地分支 `feat/claude-code-backend`。
- 不改无关代码；每个任务只触碰自己列出的文件。
- 每任务涉及区域必须先读对应仓库技能：事件/流式→`relay-transport`；OpenCode 路由/消息形状→`opencode-v2`；UI 同步→`sync-state-invariants`；UI 数据获取→`ui-api-decoupling`；设置→`settings-ui-patterns`；UI 组件/样式→`theme-system`。
- wire 形状的规范源：`packages/ui/src/lib/opencode/events.ts`（212-907）、`projection.ts`、`model.ts`、`client.ts`。实现时以这些为准逐项核对。
- 新增依赖 `@anthropic-ai/claude-agent-sdk` 必须同步 `bun.lock`（CI 用 `--frozen-lockfile`）。

---

### Task 0: 环境与工具链验证

**Files:** 无源码改动（可能更新 `bun.lock`）。

**Steps:**

- [ ] 升级 bun 到 ≥1.4.2 并验证：`bun --version`（后台 `bun upgrade` 已在执行；若失败，winget 安装或从 https://bun.sh 重装）。
- [ ] 安装依赖（工作区根目录，网络慢时后台执行）：
  ```powershell
  $env:PATH = "D:\software\nodejs;$env:PATH"; bun install
  ```
  期望：成功；`git status` 除 `bun.lock` 外无变化。若 `bun.lock` 因 bun 版本被改写，单独提交 `chore: refresh lockfile with bun 1.4.2`。
- [ ] 验证聚焦测试可运行（选一个已有 web 测试文件）：
  ```powershell
  $env:PATH = "D:\software\nodejs;$env:PATH"; bun run --cwd packages/web test -- server/lib/openchamber-sessions/session-metadata-store.test.js
  ```
  （若该文件不存在，用 `Get-ChildItem packages/web/server/lib -Recurse -Filter "*.test.js" | Select -First 5` 挑一个。）期望：PASS。
- [ ] 验证 UI 测试可运行：`bun run --cwd packages/ui test -- ids`（过滤 `ids` 相关测试）。期望：PASS 或至少 vitest 正常启动。

---

### Task 1: `ids.js`（`ses_`/`msg_` 格式 id）

**Files:**
- Create: `packages/web/server/lib/claude-code/ids.js`
- Test: `packages/web/server/lib/claude-code/ids.test.js`

**Interfaces:**
- Produces: `createSessionId(): string`、`createMessageId(): string`，输出 `ses_`/`msg_` + 12 hex + 14 base62，格式与时间可排序性对齐 `packages/ui/src/lib/opencode/ids.ts`（服务端不能 import UI 包，`relay/e2ee.js:3-4` 先例）。

- [ ] **Step 1: 写失败测试**（断言前缀、长度 4+26=30、两次调用不同、时间前缀单调、字符集）

```js
import { describe, expect, test } from 'vitest';
import { createSessionId, createMessageId } from './ids.js';

const ID_RE = /^(ses|msg)_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

describe('claude-code ids', () => {
  test('session ids match OpenCode format', () => {
    const id = createSessionId();
    expect(id).toMatch(ID_RE);
    expect(id.startsWith('ses_')).toBe(true);
  });
  test('message ids match OpenCode format', () => {
    expect(createMessageId()).toMatch(ID_RE);
  });
  test('ids are unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createSessionId()));
    expect(ids.size).toBe(200);
  });
  test('time prefix is non-decreasing', () => {
    const a = createSessionId().slice(4, 16);
    const b = createSessionId().slice(4, 16);
    expect(a <= b).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**：`bunx vitest run server/lib/claude-code/ids.test.js`（在 packages/web 目录，PATH 前置）。
- [ ] **Step 3: 实现 `ids.js`**：照 `ids.ts` 算法（毫秒时间戳 × 0x1000 + 计数器 → 6 字节大端 hex；14 位 base62 随机；同毫秒单调）。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(claude-code): add OpenCode-format id helpers"`。

---

### Task 2: `cli-resolution.js`（claude CLI 定位）

**Files:**
- Create: `packages/web/server/lib/claude-code/cli-resolution.js`
- Test: `packages/web/server/lib/claude-code/cli-resolution.test.js`

**Interfaces:**
- Produces: `resolveClaudeCliPath({ env, settings, platform, exists, searchPath }): string | null`；`buildClaudeLaunchSpec(cliPath, { platform, comSpec }): { command, args }`（Windows `.cmd/.bat` → `%ComSpec% /d /s /c call <path>`；`.exe`/无扩展名可执行直接执行；`.js` 需 node 解释——v1 不支持裸 .js，返回 null 并在上层给出明确错误）。
- 依赖注入（`exists`、`searchPath`、`platform`、`comSpec`）保证可测。模式参照 `lib/opencode/env-runtime.js` 的 `searchPathFor`/`resolveManagedOpenCodeLaunchSpec`（只借鉴写法，不 import）。

- [ ] **Step 1: 写失败测试**：settings 覆盖优先；env `CLAUDE_BINARY` 次之；PATH 命中 `claude`（win 带 PATHEXT `.exe/.cmd`）；已知路径回退（`~/.claude/local/claude`、`%APPDATA%\npm\claude.cmd`、`~/.local/bin/claude`）；找不到返回 null；`.cmd` 包装 args 精确匹配 `['/d','/s','/c','call','C:\...\claude.cmd']`；`.exe` 直连。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**（纯函数 + 依赖注入；不做真实 IO）。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(claude-code): resolve the claude CLI and its launch spec"`。

---

### Task 3: `translator.js`（SDK 流 → wire 事件，核心）

**Files:**
- Create: `packages/web/server/lib/claude-code/translator.js`
- Test: `packages/web/server/lib/claude-code/translator.test.js`
- Test（形状契约，关键）: `packages/web/server/lib/claude-code/translator.contract.test.js`

**Interfaces:**
- `createTranslator({ sessionID, directory })` → `{ translate(sdkMessage): WireEvent[], beginTurn({ prompt, assistantMessageID? }): WireEvent[], endTurn(kind, detail?): WireEvent[], currentAssistantMessageID(): string | null }`
- WireEvent 封套：`{ id, type, created, data, location: { directory } }`（`OpenCodeEvent` from `@opencode/client`；`created` 毫秒数）。
- 映射表（SDK → wire）：
  | SDK | wire | data 关键字段 |
  |---|---|---|
  | 用户发送（beginTurn） | `session.execution.started` | `{ sessionID }` |
  | `stream_event: content_block_start(text)` | `session.text.started` | `{ sessionID, assistantMessageID, ordinal }` |
  | `stream_event: content_block_delta(text_delta)` | `session.text.delta` | `+ { delta }` |
  | `stream_event: content_block_stop(text)` | `session.text.ended` | `+ { text }`（累计文本） |
  | `stream_event: content_block_start(thinking)` | `session.reasoning.started` | 同 text，ordinal 独立计数 |
  | `stream_event: content_block_delta(thinking_delta)` | `session.reasoning.delta` | `+ { delta }` |
  | `stream_event: content_block_stop(thinking)` | `session.reasoning.ended` | `+ { text }` |
  | `stream_event: content_block_start(tool_use)` | `session.tool.input.started` | `{ sessionID, assistantMessageID, id: block.id, name: block.name }` |
  | `stream_event: content_block_delta(input_json_delta)` | `session.tool.input.delta` | `+ { delta }` |
  | `stream_event: content_block_stop(tool_use)` | `session.tool.input.ended` | `+ { text: 累计 json }` |
  | SDK `user`（tool_result 块） | `session.tool.success` / `session.tool.failed` | `{ sessionID, assistantMessageID, id: tool_use_id, content, executed: true }`；is_error→failed（error 为结构化错误 `{ message }` 形状按 `structuredErrorText` 消费方要求） |
  | 首个 assistant 内容前 | `session.step.started` | `{ sessionID, assistantMessageID, agent, model: { providerID: 'claude-code', id: <alias> } }` |
  | SDK `result` (success) | `session.step.ended` + `session.execution.succeeded` | step.ended: `{ …, finish: 'stop', cost: total_cost_usd, tokens }`；succeeded: `{ sessionID }` |
  | SDK `result` (error/abort) | `session.step.failed`/`session.execution.interrupted` 或 `session.execution.failed` | `{ sessionID, assistantMessageID, error }` |

- [ ] **Step 1: 写失败测试**：每行映射一个用例（用 SDK 消息形状样例常量），断言产出的 wire 事件 type 与 data 关键字段；比连续事件顺序（step.started 在第一个 text.started 之前）。
- [ ] **Step 2: 形状契约测试（关键，B1 防线）**：直接 import UI 模块做端到端断言——
  ```js
  import { translateWireEvent } from '../../../ui/src/lib/opencode/events.ts';
  ```
  对 translator 产出的每条事件断言 `translateWireEvent(event)` 非空且不含未知类型；对坏名字（如 `message.updated`）断言返回 `[]`（证明该测试能抓住 B1 类错误）。参考 `packages/web/server/lib/relay/cross-compat.test.js` 的跨包 import 先例（bun/vitest 直跑 TS）。
- [ ] **Step 3: 运行确认失败**。
- [ ] **Step 4: 实现 translator**（纯函数，无 IO；ordinal 规则：每个 assistant 消息内 text/reasoning 各自从 0 递增，与 `partIds` 的 `(messageID, ordinal)` 对齐）。
- [ ] **Step 5: 运行两个测试文件确认通过**。
- [ ] **Step 6: 提交**：`git commit -m "feat(claude-code): translate SDK stream messages to OpenCode wire events"`。

---

### Task 4: `transcript.js`（消息记录 + JSONL 持久化）

**Files:**
- Create: `packages/web/server/lib/claude-code/transcript.js`
- Test: `packages/web/server/lib/claude-code/transcript.test.js`

**Interfaces:**
- `createTranscript({ sessionID, directory, filePath, fs })` → `{ beginUserMessage({ text, id }): void, applyWireEvent(event): void, listRecords({ limit, cursor, order }): { items: [{ info, parts }], next }, getRecord(messageID), flush(): Promise<void>, load(): Promise<void>, close() }`
- 持久化格式：JSONL，每行 `{ t: 'u' | 'a-part' | 'a-msg', … }` 增量记录（user 消息、part 更新快照、assistant 消息终态），行内带 `created`；加载时重放生成记录。消息记录必须含 `time.created`，assistant 终态含 `time.completed`（`message-queue` 判活要求）。
- `listRecords` 返回的 `info/parts` 形状对齐 `projection.ts` 期望（text/reasoning/tool part，tool state 为 `pending/running/completed/error` 语义的 wire 形状）。

- [ ] **Step 1: 写失败测试**：apply 一串 wire 事件（Session text/tool 序列样例）后 `listRecords` 返回正确消息数与 part 状态；分页 cursor 行为（倒序、`next` 语义与 `getSessionMessages` 一致）；JSONL 重放后与内存态一致；模拟半行损坏（截断最后一行）仍能加载。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**（原子写：appendFile；加载容忍坏尾行）。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(claude-code): persist session transcripts as JSONL"`。

---

### Task 5: `runner.js`（SDK 会话进程 + 权限）

**Files:**
- Create: `packages/web/server/lib/claude-code/runner.js`
- Test: `packages/web/server/lib/claude-code/runner.test.js`

**Interfaces:**
- `createRunnerFactory({ spawnQuery, transcript, translator, emit, resolveCliPath, cwd, env, idleMs })`
- 每个会话一个 Runner：`{ send({ text }): Promise<void>, interrupt(): Promise<void>, setModel(modelId), resolvePermission(permID, decision), dispose(): Promise<void>, isBusy() }`
- `spawnQuery({ prompt: AsyncIterable, options })` 默认实现 = `@anthropic-ai/claude-agent-sdk` 的 `query`；测试注入 fake。
- options：`{ cwd, pathToClaudeCodeExecutable: <resolved|null>, includePartialMessages: true, canUseTool, resume: <claudeSessionUuid|null>, model, maxTurns?, permissionMode: 'default' }`。
- `canUseTool(toolName, input, { signal })`：生成 permission 请求 id，emit `permission.asked`（data 形状按 `PermissionRequestWire`，字段以 `@opencode/client` 类型与 `permission-auto-accept/runtime.js` 消费为准），等待 `resolvePermission` 的 Promise → 返回 `{ behavior: 'allow', updatedInput }` 或 `{ behavior: 'deny', message }`；`always` 决策按 (sessionID, toolName) 记忆，直接放行。
- 事件流：SDK 消息 → translator → `emit(event)`；同时 `transcript.applyWireEvent(event)`。
- 空闲回收定时器、dispose 中断、进程退出清理。

- [ ] **Step 1: 写失败测试**（fake spawnQuery 推 SDK 样例消息）：send 触发 `session.execution.started` 与 text.delta 流；canUseTool 阻塞直到 `resolvePermission('once')` 放行、`reject` 拒绝、`always` 二次同工具不再询问；`interrupt` 调 SDK interrupt 且发 `session.execution.interrupted`；dispose 后不再 emit。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(claude-code): run claude sessions through the Agent SDK"`。

---

### Task 6: `routes.js`（HTTP 子集）

**Files:**
- Create: `packages/web/server/lib/claude-code/routes.js`
- Test: `packages/web/server/lib/claude-code/routes.test.js`

**Interfaces:**
- `createClaudeRoutes({ registry, respondPermission })`：Express Router。registry 由 `index.js`（Task 7）提供：`{ isClaudeSession(id), createSession({ title, metadata, directory }), getSession(id), renameSession(id, title), removeSession(id), moveSession(id, directory), listSessions({ directory, limit }), sendPrompt(id, params), interrupt(id), switchModel(id, model), switchAgent(id, agent), getMessages(id, query), replyPermission(sessionID, permID, decision) }`
- 路由（对齐 OpenCode v2 SDK 调用面，精确路径以 `client.ts` 实现为准，实现时读 `client.ts:854-1000/1138-1330/1475-1500` 核对）：
  - `POST /api/session`（带 `x-openchamber-backend: claude` 头时创建）
  - `POST /api/session/:id/prompt`、`POST /api/session/:id/interrupt`
  - `POST /api/session/:id/permission/:permID/reply` body `{ decision }`（`permission-auto-accept` 兼容形状）
  - `GET/POST /api/session/:id/model`、`.../agent`（switch 调用按 client.ts 实际路径）
  - `GET /api/session/:id/message`（分页）
- 所有 handler：命中即应答；非 Claude 会话一律 `next()`。

- [ ] **Step 1: 写失败测试**（supertest + fake registry，先例 `openchamber-sessions/routes.test.js`）：非 Claude 会话 next 穿透；prompt 转发；permission reply 形状 `{ decision }` 且 404 仅对未知 permID；分页透传。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`git commit -m "feat(claude-code): serve the OpenCode session route subset"`。

---

### Task 7: 模块入口 + 服务端接线 + 事件多路复用

**Files:**
- Create: `packages/web/server/lib/claude-code/index.js`
- Create: `packages/web/server/lib/claude-code/DOCUMENTATION.md`（初版）
- Modify: `packages/web/server/index.js`（hub 接线：创建 runtime、注册路由、传 dep）
- Modify: `packages/web/server/lib/opencode/server-utils-runtime.js`（setupProxy deps 增加 `mergeClaudeSessionList`）
- Modify: `packages/web/server/lib/opencode/proxy.js`（① 就绪闸门之前注册 Claude 路由：读取 `mergeClaudeSessionList` dep 模式仿 `mergeSpaceSessionList`；② `GET /api/session` 列表合并 Claude 会话；③ `/api/event` 多路复用）
- Test: `packages/web/server/lib/claude-code/index.wiring.test.js`；扩展现有 `packages/web/server/opencode-proxy.test.js` 或多路复用专项测试文件

先读：`relay-transport` 技能、`opencode-v2` 技能、`proxy.js:861-1000`、`openchamber-sessions/routes.js:736-785`。

**Interfaces:**
- `createClaudeCodeRuntime({ dataDir, eventHub, getSettings, logger })` → `{ router, listSessionsForProxy({ directory, limit, search }), start(), stop(), isClaudeSession(id), respondPermission(...) }`
- `emit(event)` = `eventHub.injectEvent({ payload: event, directory: event.location.directory, spaceId: null })`。
- `/api/event` 多路复用：保持上游帧透传字节不变；对 `eventHub.subscribeEvent` 中 `spaceId === null && directory` 属于 Claude 会话的事件，序列化为 `data: <json>\n\n` 追加写入（SSE 客户端解析与上游一致的 `payload` 形状）。
- `/api/openchamber/sessions/:id/metadata`：Claude 会话由模块代理（JSONL 上的等价 merge 语义 + 广播 `openchamber:session-metadata`）。

**Steps:**
- [ ] Step 1: 写接线测试：创建带 `x-openchamber-backend: claude` 头的 `POST /api/session` 不落到上游代理；Claude 会话 prompt 不经过就绪闸门（模拟闸门挂起态断言不受影响）；`GET /api/session` 合并列表含 Claude 会话且普通请求仍走原代理；多路复用注入事件出现在 `/api/event` 输出流而 OpenCode 帧字节不变。
- [ ] Step 2: 确认失败。
- [ ] Step 3: 实现接线与模块入口；`start/stop` 挂到现有服务生命周期（退出时 dispose 全部 runner）。
- [ ] Step 4: 聚焦测试通过；`node --check` 过（server JS）。
- [ ] Step 5: 提交：`git commit -m "feat(claude-code): wire the Claude backend into the server"`。

---

### Task 8: `claudeBinary` 设置项（registry + 快照）

**Files:**
- Modify: `packages/ui/src/lib/settings/registry.ts`（新增 `claudeBinary` 条目，仿既有二进制路径设置；先例行 236 附近）
- Regenerate: `bun run settings-registry:generate`（更新 web/vscode 两份快照）
- Test: `packages/ui/src/lib/settings/registry.test.ts`（运行）；`packages/web/server/lib/settings/settings-helpers.test.js`（如存在）

先读：`settings-ui-patterns` 技能。

**Steps:**
- [ ] Step 1: 在 registry 增加 `claudeBinary`（类型路径、说明文案按 locale 规范：12 个 locale 全覆盖，`locale-ui-patterns` 技能）。
- [ ] Step 2: 运行 `bun run settings-registry:generate`；检查两份快照 diff。
- [ ] Step 3: 服务端读取：模块 `cli-resolution` 的接线处读设置（仿 `applyOpencodeBinaryFromSettings`，env-runtime.js:1127-1207），加单测断言 settings 覆盖 env。
- [ ] Step 4: 聚焦测试通过。
- [ ] Step 5: 提交：`git commit -m "feat(settings): add claudeBinary path setting"`。

---

### Task 9: UI（后端选择器 + 请求头通道 + 徽标）

**Files:**
- Modify: `packages/ui/src/sync/session-actions.ts`、`packages/ui/src/sync/session-ui-store.ts`（后端选择透传）
- Modify: `packages/ui/src/lib/opencode/client.ts`（创建请求携带 `x-openchamber-backend` 头的注入点；若 `@opencode/client` SDK 无 per-request headers，使用"一次性标记 + 包装 fetch 注入"方案，标记由 session-actions 设置、成功后清除）
- Modify: 桌面 composer 控件 `packages/ui/src/components/chat/ComposerFooter.tsx`（后端下拉，仅草稿/新会话态；选 Claude 时显示 Claude 模型下拉：Opus/Sonnet/Haiku/Fable）
- Modify: 会话列表行组件（侧边栏会话项）显示来源徽标（读 session.metadata / `x-opencode-backend` 派生值）
- Test: 对应的 `.test.ts(x)`（vitest）

先读：`ui-api-decoupling`、`sync-state-invariants`、`theme-system`、`locale-ui-patterns` 技能。

**Steps:**
- [ ] Step 1: 写失败测试：createSession 携带标记时请求头注入（fetch mock）；非标记请求不带；选择器组件渲染与状态；徽标渲染条件。
- [ ] Step 2: 确认失败。
- [ ] Step 3: 实现（Claude 模型列表 v1 用静态别名映射 `claude-code/opus|sonnet|haiku|fable`；下拉数据来源最小化，不接入全局 provider store）。
- [ ] Step 4: 聚焦测试通过。
- [ ] Step 5: 提交：`git commit -m "feat(ui): choose the Claude backend for a new session"`。

---

### Task 10: 依赖与锁文件

**Files:**
- Modify: `packages/web/package.json`（`@anthropic-ai/claude-agent-sdk`）
- Regenerate: `bun.lock`

**Steps:**
- [ ] Step 1: `bun add @anthropic-ai/claude-agent-sdk --cwd packages/web`（PATH 前置）。
- [ ] Step 2: 确认锁文件更新、`bun install --frozen-lockfile`（dry 验证：CI 等价命令在根目录跑一遍）。
- [ ] Step 3: 检查 Electron 打包面：`packages/electron/package.json` 打包脚本是否按 workspace 依赖复制 `node_modules`（`packages/electron/scripts`）；如需要，记录并在实现中补齐（先读后改）。
- [ ] Step 4: 提交：`git commit -m "chore(web): add the Claude Agent SDK dependency"`。

---

### Task 11: 模块文档与 owning 文档更新

**Files:**
- Complete: `packages/web/server/lib/claude-code/DOCUMENTATION.md`（模块契约、信任边界、已知限制、审批语义）
- Modify: `packages/web/server/lib/event-stream/DOCUMENTATION.md`（新增注入源与 Claude 事件词汇的契约说明）
- Modify: `packages/web/server/lib/opencode/DOCUMENTATION.md`（代理分流与闸门顺序）
- Modify: `packages/web/server/lib/openchamber-sessions/DOCUMENTATION.md`（metadata 路由双后端语义）

**Steps:**
- [ ] Step 1: 逐份更新，事实与实现一致。
- [ ] Step 2: 提交：`git commit -m "docs(claude-code): document the backend module and its contracts"`。

---

### Task 12: 集成验收（Windows Desktop 手工）

**Steps:**
- [ ] 启动开发服务：`$env:PATH = "D:\software\nodejs;$env:PATH"; bun run --cwd packages/web dev:server`（或 `bun run dev` 全量 HMR），打开 UI。
- [ ] 按设计文档第 7 节手工验收 6 条逐项执行并记录结果（真实 `claude` CLI + API Key）。
- [ ] 修掉验收暴露的问题（各自提交）。
- [ ] 全量门禁：`bun run check:changed` 串行跑一次；报告结果。

## Self-Review

- 覆盖：设计文档 §3-§6 的每项 v1 能力都能对应到 Task 3-9；B1/B2/B3 分别由 Task 3（形状契约测试）、Task 3/5（execution 事件）、Task 6/7（请求头通道 + 数据形状）落实；N2-N9 在 Task 6-11 有落点。
- 无占位符：所有任务含具体文件、接口、测试断言与提交命令；形状细节以列出的代码位置为唯一规范源（实现时读取核对），符合"before editing 先读"的仓库纪律。
- 类型一致性：`createSessionId/createMessageId`、`createTranslator`、`createTranscript`、`createRunnerFactory`、`createClaudeRoutes`、`createClaudeCodeRuntime`、`listSessionsForProxy` 在任务间引用一致。
- 顺序依赖：T1,T2 → T3,T4 → T5 → T6 → T7 → T8,T9,T10 → T11 → T12。T3/T4 可并行（不同文件），T8/T9/T10 可并行。
