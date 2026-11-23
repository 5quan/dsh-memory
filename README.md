# dsh-memory

面向 DeepSeek Harness（DSH）个人秘书体系的独立按日期记忆插件（Cordis Plugin）。

## 项目定位

- **纯记忆系统**：只负责“人、事、偏好、决定、纠偏教训与时间轴”，不耦合 Ticket 任务进度、工作群或实施者调度。
- **主存储与派生索引分层（零向量）**：`PROFILE.md`、`buffer/`、`journals/`、`entities/` 与 `archive.sqlite` 的 `messages` 原文表共同构成**主存储（须纳入备份）**；FTS5 `trigram` 虚表、按 `(session, logical_date)` 冻结的 `snapshots/` 与 M2 `history/` 索引为可重建派生层，**不引入外部向量数据库**。
- **时间框架为主轴 + 缓存友好**：采用“核心画像 + 昨日完整日报 + 近 N 天日报精华 + 历史总览（M2）”的按 `(session_id, logical_date)` 冻结前缀结构；盘中新增记忆与纠偏一律先写入按日轮转的追加式缓冲区（`buffer/YYYY-MM-DD.jsonl`），通过 `agent/pre-step` 持久化动态增量（Compaction 后自动重置游标）注入，既保护 Prompt Prefix Cache 又防止压缩失忆。
- **精细隔离与可控遗忘**：子会话默认仅保留用户本人直接发言（`subagentPolicy: 'user-only'`），提供三态无痕模式（`full` / `read-only` / `off`）与主动遗忘工具 `memory_forget`。
- **独立可插拔**：严格基于 `@deepseek-ai/dsh` 与 `@deepseek-ai/cordis` 公开插件 API 开发，可独立运行于原版 DSH，也可配合 `ds-bot`（配置 `memory: false`）使用。

## 核心能力规划

| 阶段 | 状态 | 核心内容 |
|---|---|---|
| **M1** | ✅ 已完成 | 原文档案采集（`user-only` 子会话过滤 + 三态无痕）、空闲切日（日内分块 + 锚点核验）与 6 段式不可变日报、按日追加缓冲区、按 `(session, logical_date)` 冻结前缀 + 持久化动态增量（Compaction 重置）、7 个基础记忆工具（含 `memory_forget`） |
| **M2** | ✅ 已完成 | 历史记忆层引入 OpenViking L0/L1/L2 渐进披露（无向量单跳派生、`memory_history_browse`）与总览注入；`entities/` 实体档案卡、`target: entity:<名称>` 结算、别名精准触发动态注入与 `memory_entity_manage` |
| **M3** | ✅ 已完成 | 初始画像冷启动引导（空画像首次加载触发、多端自适应 `show_view` / `ask_user` / `ask_user_question` / 文本问卷、跳过与重填、Prefix Cache 保护）、每日晨报确认体验（昨日亮点 + 批量 `approve`/`reject` + `settleNow`）、轻量纠偏捕获（`source_type: 'correction'` + 真实用户锚点），以及公开 Cordis 服务 `dshMemory` 与标准事件 `dsh-memory/day-rolled-over` |
| **M4** | 📋 规划中 | Dream 后台异步整理（去重、矛盾确认、`expires` 过期提案与 `retired.jsonl` 回滚）、`memory_read_context` 邻接上下文扩展、写入 `content_hash` 幂等去重与凭据拦截、日结绝对时间与助手承诺增强、`memory_forget` 补清 `PROFILE.md`，以及分环节评测与黄金记忆消融集 |
| **后续（最后实现）** | 📝 已记录 | 写入侧记忆投毒 / 提示注入拦截与红队验收（当前由数据区声明与缓冲确认兜底，最后实现） |

## 架构目录规划（运行时数据，默认 `$DSH_HOME/daily-memory/`）

```text
<memory-home>/
├── PROFILE.md                           # [主存储] 核心画像（冻结前缀，<= 2k tokens）
├── buffer/YYYY-MM-DD.jsonl              # [主存储] 按日轮转追加式缓冲区（显式记忆 / 纠偏 / 提案）
├── journals/                            # [主存储] 不可变每日日报（YYYY-MM-DD.md）
├── entities/                            # [主存储 · M2/M3] 实体档案卡（别名触发动态增量注入）
├── history/                             # [派生 · M2] OpenViking L0/L1 历史总览索引
├── snapshots/                           # [派生] 按 (session_id, logical_date) 冻结的前缀快照
├── retired.jsonl                        # [主存储 · M4] 被取代/归档条目备份（可回滚）
└── archive.sqlite                       # [主存储 + FTS 派生] messages 原文主表 + FTS5 trigram + 状态/元信息表
```

## 公开 Cordis 服务契约（`dshMemory`）

- **服务名**：`SERVICE_NAME = 'dshMemory'`（通过 `ctx.provide('dshMemory', service)` 注册，零 `ds-bot` 依赖）。
- **标准事件**：`DAY_ROLLED_OVER_EVENT = 'dsh-memory/day-rolled-over'`，载荷 `{ date, scope, journalPath, summary: { title, highlights, pendingBufferCount, text } }`。
- **公开方法**：`getCurrentLogicalDate`、`getMorningBriefing`、`markBriefingDelivered`、`confirmBufferItems`、`matchEntities`、`getEntity`、`listEntities`、`submitBufferCandidate`、`getOnboardingState`、`submitOnboarding`、`skipOnboarding`、`resetOnboarding`。

## 文档

- [架构设计说明书](docs/DESIGN.md)
