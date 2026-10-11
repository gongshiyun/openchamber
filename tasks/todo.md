# Claude Code 后端（feat/claude-code-backend）— 进度跟踪

计划全文：`docs/superpowers/plans/2026-10-11-claude-code-backend.md`
设计文档：`docs/superpowers/specs/2026-10-10-claude-code-backend-design.md`

## 环境
- [x] 源码就位（上游 main 快照，基线提交 7bd52e1）
- [x] git 初始化 + 特性分支
- [x] bun 升级到 1.4.3（≥1.4.2）
- [x] `bun install` 完成（1533 包，锁定文件保持上游格式）+ 聚焦测试可跑（T1/T2 已实测通过）
- Node 24.14：命令级 PATH 前置 `D:\software\nodejs`

## 任务
- [x] T1 ids.js（`ses_`/`msg_` id 生成）— 已提交 06529cb
- [x] T2 cli-resolution.js（claude CLI 定位与启动规格）— 已提交 3ca1a80
- [x] T3 translator.js — 已提交 d0e3c10（25 测试通过，含跨包形状契约测试）
- [x] T6 routes.js（HTTP 子集）— 已提交 bc05c64（24 测试，含真实 @opencode/client 端到端集成）
- [x] T4 transcript.js — 已提交 90e1d14（16 测试 + 真实翻译器链路验证；纠正 wire 形状为 type 而非 role）
- [x] T5 runner.js（SDK 会话进程 + 权限回调）— 已提交 abf4790（19+27 测试；含 translator.fail 扩展）
- [x] T7a runtime/registry（index.js）— 已提交 b03212c（16 测试 + 目录回归 124 全绿）
- [~] T7b 服务端接线 + /api/event 多路复用 — 实现代理运行中
- [x] T8 claudeBinary 设置项 — 已提交 d344fa6（19 文件：registry、双快照、settings-helpers 闸门、13 locale）
- [x] T9 UI（后端选择器 + 请求头通道 + 徽标）— 已提交 ad7497d（含 13 locale；SDK 原生 per-request headers 方案）
- [x] T9b 已开会话的 Claude 模型控件与发送路径 — 已提交 3423a00（resolveSendSelection 对 Claude 返回空选择；会话级 Claude 模型控件）
- [x] T10 依赖与锁文件 — 已提交 15a9cd5（SDK 0.3.296；锁文件按上游约定归一化；frozen-lockfile 通过；真实 SDK 冒烟通过）
- [x] T11 模块文档与 owning 文档 — 已提交 c3946cc（4 份：claude-code 主文档 + event-stream/opencode/openchamber-sessions）
- [x] T12 Windows Desktop 集成验收 + 全量门禁 — 服务端全链路 PASS、UI 浏览器验证通过、`check:changed --base 7bd52e1` 全绿（anti-slop 修复提交 44fe458）

## 完成记录（2026-10-11）
- 全部 12 个任务完成；提交链见 `git log --oneline 7bd52e1..HEAD`（13 个功能/修复提交 + 基线）。
- 验证：各模块聚焦测试（129 个 claude-code 测试）；真实 SDK 单回合冒烟（认证 + 流形状 + 翻译器）；服务端 E2E（创建/流式/权限审批 once/工具写文件/列表/消息/元数据）；UI 浏览器（后端选择器、Claude 模型控件、OpenCode 控件隐藏）。
- 已知事项：`buildClaudeLaunchSpec` 无生产调用方（文档已注明）；`settings-helpers` 打包测试与 `lib/opencode` 部分用例为 Windows 环境既有失败；移动端 composer 不在 v1。

## 收尾冲刺（P1/P2/P3，2026-10-11 起）
- [x] P1.1 不支持的入口对 Claude 会话隐藏 — 提交 e66bdee（命令菜单/shell/fork/compact/goals/multi-run/walkthrough + 运行时防护）
- [x] P1.2 挂起权限的恢复 — 提交 a5f0c33（`GET /api/permission/request` 合并；UI 既有重同步路径自动生效）
- [x] P1.3 品牌文案按会话后端显示 — 提交 1cb2d52（8 键 × 13 locale）
- [x] P1.4 停止埋点 + 权限挂起 30 分钟安全网 — 1cb2d52（埋点）+ 317e6e9（park timeout）
- [x] P1.5 Goals / 定时任务 / multi-run / walkthrough 入口隐藏 — e66bdee（Goals/multi-run/walkthrough 已隐藏；定时任务为全局面板、无会话级入口）
- [x] P2.1 首回合冷启动提示 — 提交 1cb2d52（"Claude Code is starting…"）
- [x] P2.2 用量与成本接入 — 提交 6567791（cost 替换/tokens 累计 + session.usage.updated）
- [x] P2.3 标题模型化 — 提交 6567791（首行兜底 + haiku 生成，不覆盖用户改名）
- [x] P2.4 权限模式与 effort — 317e6e9（服务端端点）+ e66bdee（composer 控件，13 键 × 13 locale）
- [x] P2.5 附件支持 — 317e6e9（图片/文本块、256KB/5MB 上限、其余跳过注记）；@agent/skills 提及维持纯文本（无害，意图明确）
- [x] P3.3 CORS 允许头回归测试 — 提交 8c60b42（提取共享模块 + 12 头钉住）
- [x] P3.4 claude CLI 可用性探测 — 提交 50f119d（真实 CLI 验证 2.1.283，不阻塞启动）
- [x] P3.5 上游提案文档（317b9ee）+ VS Code 验证（type-check/build 0 错误；webview 产物含后端选择器与 Claude 控件；测试 59/62 文件通过，3 个失败为 git/版本解析环境性既有失败——分支仅改过 settings-registry.json 一条目，失败文件不依赖它）
- [x] 总验证：全量 check:changed（106+ 文件，全部 0）+ 试用版重打包 + 实机验收 sprint-check（创建/权限模式/effort/generate/用量/标题/挂起权限列表/中断清理，全部 PASS）
- [x] 实机验收暴露并修复：中断时挂起审批即刻作废（permission.replied reject + 出列表）；陈旧停靠（回合结束后遗留）由空闲回收器拒绝并回收，不再形成僵尸
- [x] 本地 tag `claude-code-backend-v1`（23c06b4，42 提交）；推送等用户确认（用户规则：推送前检查确认）
- 排除项（用户确认）：终端面板（需 VS Spectre 库）、移动端 composer

## 记录
- 2026-10-11 计划评审结束；设计文档经终审修订（f0a8d53）。
- 实现规则：并行 subagent 只碰各自文件、只跑单测；门禁由主会话合并后串行跑一次；不推送远端。
