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

## 记录
- 2026-10-11 计划评审结束；设计文档经终审修订（f0a8d53）。
- 实现规则：并行 subagent 只碰各自文件、只跑单测；门禁由主会话合并后串行跑一次；不推送远端。
