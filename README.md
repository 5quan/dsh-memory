# `dsh-memory` 功能清单与使用说明书

面向 DeepSeek Harness（DSH）个人秘书体系的独立按日期持久化记忆插件（Cordis Plugin `dsh-memory`）。

---

## 1. 定位与在整个系统中的角色

- **核心定位**：**纯本地 Markdown + `node:sqlite` 的按日期记忆系统**，**零 `ds-bot` 依赖**、**零外部向量数据库**、零原生 C++ 编译依赖。
- **职责边界（做什么 / 不做什么）**：
  - **负责**：用户核心画像（`PROFILE.md`）、对话原文归档（`archive.sqlite`）、6 段式不可变每日日报（`journals/`）、跨月渐进历史索引（`history/`）、实体档案卡（`entities/`）、避坑经验卡（`lessons/`）、每日缓冲审核流（`buffer/`）、冷启动建档、每日晨报、后台 Dream 整理与 9 层主动遗忘/回滚。
  - **不负责**：Ticket 任务队列、Worker 派工编排、工作群路由、可执行技能包（`SKILL.md` / MCP / 工具权限挂载）。这些属于执行层或上层 `dsh-ctrl`。
- **在 DSH / `dsh-ctrl` 体系中的协作角色**：
  - **在原版 DSH 中**：开箱独立运行（注册 15 个 `memory_*` 工具、自动切日、晨报与冷启动、DSH 原生设置面板实时开关）。
  - **搭配 `dsh-ctrl` / `ds-bot` 时**：保持单向解耦——`ds-bot` 侧配置 `memory: false`（同步静音自带 `MEMORY.md` 与 `learning.js`），通过 Cordis 服务 **`dshMemory`** 与标准事件 **`dsh-memory/day-rolled-over`** 单向消费 `dsh-memory`，实现轻量换段、统一晨报、Worker 实体/避坑经验拉取以及任务复盘回灌。

### 已完成里程碑总览（M1–M5.5）

| 阶段 | 状态 | 核心能力 |
|---|---|---|
| **M1** | ✅ 已完成 | 原文档案采集（`user-only` 子会话过滤 + 三态无痕）、空闲切日（日内分块 + 锚点核验）与 6 段式不可变日报、按日追加缓冲区、冻结前缀 + 持久化动态增量（Compaction 重置）、基础记忆工具与 `memory_forget` |
| **M2** | ✅ 已完成 | OpenViking 风格 L0/L1/L2 历史索引（`history/`、`memory_history_browse`）与总览注入；`entities/` 实体档案卡、`target: entity:<名称>` 结算、别名精准触发动态注入与 `memory_entity_manage` |
| **M3** | ✅ 已完成 | 初始画像冷启动引导（空画像首次加载触发，多端自适应 `show_view`/`ask_user`/`ask_user_question`/文本，Prefix Cache 保护）、每日晨报汇总与批量确认（`approve`/`reject` + `settleNow`）、轻量纠偏捕获（`source_type: 'correction'`），以及公开 Cordis 服务 `dshMemory` 与 `dsh-memory/day-rolled-over` 事件 |
| **M4** | ✅ 已完成 | 规则 + LLM 双通道 Dream（`dream.lock`、失败不推水位、无证据不动、冲突标 `[CONFLICT]`、`expires` 到期淘汰、`rejectCooldownDays` 冷却期、`maxChangeRatio` 上限与 `retired.jsonl` 通用回滚）、`memory_read_context` 行窗口邻接扩展、`guard.js` 幂等去重与凭据“只记名不记值”拦截、`memory_forget` 补清 `PROFILE.md`/`retired.jsonl`，以及离线/在线消融评测脚本 |
| **M5** | ✅ 已完成 | 避坑经验与程序性记忆（`lessons/*.md`、`target: 'lesson:<名称>'`、标签/触发词动态召回、`memory_lesson_manage`，`dshMemory` 新增 `matchLessons`/`getLesson`/`listLessons` 供 Worker 与原版 DSH 复用；可执行技能留在执行层） |
| **M5.5** | ✅ 已完成 | DSH 原生 `.volatile()` 实时设置开关（`export const Config` 自动投影设置页）、`dream.useLlm` 分级默认关闭策略（`false`）、`dshMemory.getSettingsSnapshot()` 与本使用说明书 |
| **后续规划（Issue `#9`）** | 📝 已记录 | 全系统流程与提示词审查优化（修复 Dream 日报截断 + 借鉴 Anthropic Dreaming/Knowledge Wiki + 精简检索引导）、冻结前缀闲置指纹刷新、可选本地 SQLite 向量+RRF 混合检索、写入侧投毒拦截与红队验收 |

---

## 2. 存储分层与双层上下文框架

运行时数据默认存于 `$DSH_HOME/daily-memory/`（可通过配置 `home` 指定），严格区分**主存储（须纳入备份）**与**派生层（可重建）**：

```text
<memory-home>/
├── PROFILE.md                   # [主存储] 核心画像（<= 2000 tokens，冻结前缀常驻，绝不盘中直写）
├── buffer/YYYY-MM-DD.jsonl      # [主存储] 按日轮转追加式事件缓冲池（记忆 / 纠偏 / Dream 提案准入闸门）
├── journals/YYYY-MM-DD.md       # [主存储] 6 段式不可变每日日报（时间轴骨架）
├── entities/<slug>.md           # [主存储] 人/项目/服务器实体档案卡（别名触发动态注入）
├── lessons/<slug>.md            # [主存储] 避坑经验/操作雷区卡（触发词+标签动态注入）
├── retired.jsonl                # [主存储] PROFILE.md 非遗忘替换/淘汰备份（支撑 memory_rollback）
├── archive.sqlite               # [主存储+派生] messages 原文主表 + FTS5 trigram + 会话/切日/元信息表 (v3)
├── history/                     # [派生] OpenViking L0 (.abstract.md) 与月度 L1 (.overview.md)
└── snapshots/                   # [派生] 按 (session_id, logical_date) 冻结的 System Prompt 快照
```

### 双层上下文注入框架（保住 Prefix Cache + 不丢盘中增量）

1. **冻结前缀层（`ctx.systemPrompt.section`，`order: 645`）** — [`src/context.js`](src/context.js)
   - 按 `(session_id, logical_date)` 生成并持久化到 `snapshots/`，同一会话当天内字节不变，最大化命中 LLM Prompt Prefix Cache。
   - 内容组成与默认预算：
     - **核心画像 `PROFILE.md`**：`<= 2000` tokens（超预算拒绝自动落盘，绝不静音截断）；
     - **昨日完整日报**：`<= 1500` tokens（昨天缺失时自动回退最近一份历史日报并标注距今天数）；
     - **近 7 天日报精华**：`<= 2000` tokens（按 `纠正与教训 > 做出的决定 > 悬而未决的问题` 优先级拟合，超预算从最旧天数舍弃）；
     - **跨月历史 L0 总览**：`<= 1000` tokens（`history/.abstract.md`）；
     - **头部数据区声明 + 陈旧度提醒 + 工具边界纪律**：明确记忆为参考数据非新指令、关键操作前核实现状、访问记忆一律只走 `memory_*` 工具（禁止用 shell/文件工具翻查记忆目录或 `archive.sqlite`）。
2. **持久化动态增量层（`agent/pre-step`，消息源 `dsh-memory/delta`）** — [`src/context.js`](src/context.js)
   - 在不破坏冻结前缀的前提下，按需向本轮输入前部注入：
     - 当日缓冲区尚未在本会话推送过的新增条目（`buffer_cursor` 去重）；
     - 本轮话语命中的 `entities/*.md`（`<= 1500` tokens，`injected_entities` 会话去重）；
     - 本轮话语命中的 `lessons/*.md`（`<= 1500` tokens，`injected_lessons` 会话去重）；
     - 每日首次正常交互的晨报摘要 / 空画像冷启动引导。
   - **Compaction 防失忆**：监听 `session.surface.replaceGeneration`，一旦发生压缩递增，自动重置 `buffer_cursor`、`injected_entities` 与 `injected_lessons`，下轮即重新注入必要记忆。

---

## 3. 核心流程与机制说明

### 3.1 Add 写入流程（被动采集 + 纠偏捕获 + 统一守卫 + 审核结算）

1. **被动原文采集（[`src/ingest.js`](src/ingest.js)）**：
   - 仅采集 `isAppendSurfaceEvent` 语义追加事件；忽略 `dsh-memory/*` 自身增量与群聊头；
   - 子代理会话默认 `subagentPolicy: 'user-only'`，仅保留用户直接发言；
   - 为每条原文生成唯一可追溯锚点 `chat://YYYY-MM-DD#<sessionId>#<seq>` 并入库 `archive.sqlite`（启动时通过 `ctx.sessionQuery` 自动补漏）。
2. **轻量自动纠偏（[`src/correction.js`](src/correction.js)）**：
   - 正则识别明确纠偏与长期规则（如“以后一律不要… / 不对，别这样… / From now on, always…”），排除纯疑问句与代码块，自动绑定当前真实用户锚点以 `source_type: 'correction'` 写入当日缓冲区。
3. **统一写入守卫（[`src/guard.js`](src/guard.js)）与缓冲区（[`src/buffer.js`](src/buffer.js)）**：
   - 模型调 `memory_buffer_add`、外部调 `dshMemory.submitBufferCandidate` 或 Dream 产出提案，统一先经 `guard.js`：
     - **凭据拒写（`SECRET_DETECTED`）**：拦截 `sk-`、`ghp_`、`AKIA...`、PEM 私钥、`Bearer`、显式 `password/api_key/密钥` 赋值及验证码，只允许记录凭据名称或环境变量名；
     - **归一化 `content_hash` 幂等去重**：覆盖活跃 `buffer/`、`PROFILE.md` 与 `lessons/*.md`。
   - 盘中写入一律进入 `buffer/YYYY-MM-DD.jsonl`，**绝不盘中直接改写 `PROFILE.md`**。
4. **准入闸门结算（日结时或 `settleNow: true`）**：
   - **防冒用核验**：`explicit` / `correction` 必须关联 `archive.sqlite` 中真实的 `user` / `card` 锚点，否则降级为 `extracted` 并延后；
   - **自动落盘边界**：仅 `buffer.autoCommitSources`（默认 `['explicit']`）的新增条目可自动入库；覆盖/淘汰、`pinned` 目标以及 `extracted` / `correction` / `dream` 条目一律等待人工 `approve` 后才正式落盘到 `PROFILE.md`、`entities/` 或 `lessons/`。

### 3.2 Search 检索流程（渐进下钻 + 双阶段检索 + 行窗口邻接）

1. **L0 → L1 → L2 跨月时间下钻（[`src/history.js`](src/history.js)）**：先看冻结前缀中的全局 L0 `history/.abstract.md`，再用 `memory_history_browse` 查某月 L1 `.overview.md`，再用 `memory_journal_read` 读具体日期 L2 日报。
2. **`memory_search` 双阶段全文检索（[`src/store.js`](src/store.js)）**：
   - 同时查询 `archive.sqlite` 原文与 `journals/*.md`；
   - **阶段 1（严格 `AND`）**：长度 `>= 3` 的词走 SQLite FTS5 `trigram` + `bm25`，1–2 字短词走 `LIKE` 精确匹配；
   - **阶段 2（多词 `OR` 降级）**：多词严格 `AND` 无命中时自动降级为 `OR`，按“命中词数 > 命中字符数 > 时间倒序”重排；
   - 省略 `query` 时支持按 `dateFrom` / `dateTo` 浏览最近原文；可选传 `contextTurns`（`0..3`）直接附带前后轮。
3. **`memory_read_context` 行窗口邻接扩展（[`src/tools.js`](src/tools.js)）**：
   - 解析 `chat://YYYY-MM-DD#<session>#<seq>` 后按 `(session_id, seq)` 执行前后行窗口 SQL 查询（兼容中间跳号的非连续 `seq`），零 LLM 开销展开完整对话语境。
4. **实体与避坑精准召回（[`src/entities.js`](src/entities.js)、[`src/lessons.js`](src/lessons.js)）**：
   - ASCII 词走边界正则防误触发（`nginx` 不匹配 `mynginx2`），中文走子串；避坑卡支持 `text` + `tags` 双维度，按“文本与标签双命中 > 更多标签命中 > 更早匹配位置”排序。

### 3.3 空闲切日与日结（[`src/rollover.js`](src/rollover.js)、[`src/digest.js`](src/digest.js)）

- 默认凌晨 `02:00`（`dayStartHour: 2`）作为逻辑日分界。
- 定时器每 60 秒巡检，当存在已结束未日结的逻辑日且连续空闲 `>= 30` 分钟（`idleMinutes`）时自动日结（启动时立即执行历史漏日补结；也可 `memory_digest_now` 手动执行）。
- 超长日自动分块 Map-Reduce；严格生成 6 段式不可变日报（强制换算相对时间为绝对 ISO 日期、一等记录助手承诺与已执行动作），逐条核验 `chat://` 锚点并剔除伪造锚点；结算缓冲区并广播 `dsh-memory/day-rolled-over` 事件。

### 3.4 做梦机制（Dream 触发时间、双通道与回滚，[`src/dream.js`](src/dream.js)）

- **自动触发时间**：接在 `rollover` 空闲巡检之后，需**同时满足 4 项**：
  1. `dream.enabled === true`；
  2. 非启动补结，且连续空闲 `>= idleMinutes`（默认 30 分钟）；
  3. 距上次成功做梦 `>= dream.intervalDays`（默认 **7 天**）；
  4. 自上次水位以来新增历史日报 `>= dream.minNewJournals`（默认 **3 份**）。
- **并发与水位安全**：抢占 `dream.lock`（超 30 分钟僵死锁自动回收）；水位 `dream:<scope>` **仅在非 `dryRun` 且 LLM 未失败时推进**，失败保留原水位下次重跑。
- **双通道四阶段（`Orient → Gather → Consolidate → Prune`）**：
  - **规则通道（必跑、零费用）**：清理 `PROFILE.md` / `lessons/` 中 `expires <= today` 到期条、检测三处主存储内归一化完全重复条、诊断预算压力与超大卡片、补建缺失月度 `history/`。
  - **LLM 语义通道（默认关闭 `dream.useLlm: false`）**：未手动开启前不会在后台静默调用 LLM；可通过设置开关开启，或手动运行 `memory_dream_now(dryRun: true, useLlm: true)` 试跑预览，支持自然语言 `dream.instructions`。
- **代码后置安全护栏**：
  - 无证据不动（绝不因久未提及而淘汰）；
  - 绝不修改/淘汰 `pinned` 条目（`PINNED_PROTECTED`）；
  - 冲突保留 `[CONFLICT]` + `conflict: true`，无真实用户/卡片锚点证据不可覆盖 `manual`/`explicit` 等高权威条目（`AUTHORITY_PROTECTED`）；
  - 未关闭提案自动去重，用户驳回进入 `dream.rejectCooldownDays`（默认 30 天）冷却期，单次变更数受 `dream.maxChangeRatio`（默认 `0.2`，保底 1 条）限制；
  - 所有提案统一以 `source_type: 'dream'` 进缓冲区等待审核，绝不静默篡改画像。
- **`retired.jsonl` 备份与 `memory_rollback`**：所有非遗忘的 `PROFILE.md` `replace`/`retire` 均将旧条追加备份至 `retired.jsonl`，随时可用 `memory_rollback(entryId)` 追加恢复并失效快照。

### 3.5 冷启动、每日晨报、9 层主动遗忘与无痕

- **冷启动引导（[`src/onboarding.js`](src/onboarding.js)）**：`PROFILE.md` 为空且处于 `full` 模式时，首次主会话自动触发 4 维度冷启动引导，支持跳过与重填；盘中回答优先进缓冲区以保住前缀缓存。
- **每日晨报（[`src/briefing.js`](src/briefing.js)）**：每天首次正常交互推送“昨日亮点 + `buffer/` 待确认条目”，支持批量或交互式勾选及 `settleNow: true` 立即落盘。
- **9 层主动遗忘（`memory_forget`）**：按 `anchor` / `date` / `keyword` / `sessionId` 跨 `messages` → `messages_fts` → `buffer/` → `journals/` → `entities/` → `lessons/` → `history/` → `PROFILE.md` → `retired.jsonl` 联动清除并失效 `snapshots/`（主动遗忘不进 `retired.jsonl`；命中 `pinned` 默认跳过，传 `force: true` 强删）。
- **三态无痕（`memory_mode_set`）**：支持会话级或全局切换 `full` / `read-only` / `off`。

---

## 4. 全部 15 个模型工具清单（[`src/tools.js`](src/tools.js)）

| 阶段 | 工具名 | 核心职责 | 关键参数 |
|---|---|---|---|
| **M1** | `memory_search` | 双阶段检索原文库（FTS5 + `LIKE` + 多词 `OR`）与日报；无 `query` 时按日期浏览 | `query?`, `dateFrom?`, `dateTo?`, `scope?`, `limit?`, `contextTurns?` |
| **M1** | `memory_journal_read` | 按日期读取完整日报，或列出所有已有日报日期 | `date?` |
| **M1** | `memory_buffer_add` | 向当日缓冲区写入记忆/纠偏/实体事实/避坑经验（自动绑定锚点 + 凭据与去重守卫） | `content`, `sourceType`, `target?`, `section?`, `tags?`, `triggers?`, `op?`, `supersedesId?`, `expires?`, `pinned?` |
| **M1** | `memory_buffer_manage` | 查看、批量 `approve` / `reject` 缓冲区条目，支持 `settleNow: true` | `action`, `ids?`, `date?`, `reason?`, `settleNow?` |
| **M1** | `memory_mode_set` | 切换会话或全局无痕模式 | `mode` (`full`/`read-only`/`off`), `scope?` (`session`/`global`) |
| **M1** | `memory_digest_now` | 手动触发指定逻辑日（默认昨天）日结与缓冲区结算 | `date?`, `force?` |
| **M1** | `memory_forget` | 跨 9 层主动遗忘并失效快照（默认保护 `pinned`） | `anchor?`, `date?`, `keyword?`, `sessionId?`, `force?` |
| **M2** | `memory_history_browse` | 浏览跨月 L0/L1 索引或单跳重建，下钻 L2 日报 | `action` (`list`/`read`/`rebuild`), `month?`, `level?` |
| **M2** | `memory_entity_manage` | 列出、读取、增改或删除 `entities/` 实体卡及 `aliases` | `action`, `name?`, `type?`, `aliases?`, `content?`, `op?`, `supersedesId?`, `pinned?`, `force?` |
| **M3** | `memory_onboarding` | 查看冷启动状态、触发问卷、提交、跳过或重置初始画像 | `action` (`status`/`prompt`/`submit`/`skip`/`reset`), ... |
| **M3** | `memory_briefing` | 拉取晨报摘要、批量/交互勾选确认或标记已送达 | `action` (`get`/`confirm`/`dismiss`), `approveIds?`, `rejectIds?`, `settleNow?`, `interactive?` |
| **M4** | `memory_read_context` | 按 `chat://` 锚点行窗口展开前后 N 轮完整对话 | `anchor`, `before?`, `after?`, `maxCharsPerMessage?`, `maxTotalChars?` |
| **M4** | `memory_dream_now` | 手动运行 Dream 规则/可选 LLM 整理提案（`dryRun` 可预览，失败不推水位） | `dryRun?`, `useLlm?`, `scope?` |
| **M4** | `memory_rollback` | 基于 `retired.jsonl` 追加恢复被替换/淘汰的 `PROFILE.md` 条目 | `entryId` |
| **M5** | `memory_lesson_manage` | 列出、读取、增改或删除 `lessons/` 避坑经验卡及 `tags`/`triggers` | `action`, `name?`, `tags?`, `triggers?`, `content?`, `op?`, `supersedesId?`, `pinned?`, `expires?`, `force?` |

---

## 5. 插件内部实时设置开关与配置（DSH 原生设置页）

`dsh-memory` 在入口导出符合 `@deepseek-ai/schemastery` 的 **`Config`**（见 [`src/config.js`](src/config.js)），关键开关均标记 `.volatile()`：
- 在 DSH 设置界面中会自动生成 `dsh-memory` 表单页，修改后直接写入当前激活 Profile 的 `cordis.patch.yml`，**无需重启即可热生效**；
- 修改 `dream.*`、`briefing.enabled`、`onboarding.enabled`、`correction.autoCapture`、`sections.entities.*`、`sections.lessons.*`、`llm.*` **不会**失效今日 `snapshots/` 冻结前缀，零额外 KV Cache 击穿开销。

| 配置路径 | 默认值 | 实时热生效 | 说明 |
|---|---|---|---|
| `defaultMode` | `'full'` | `.volatile()` | 新会话默认记忆/无痕模式（`full` / `read-only` / `off`） |
| `dayStartHour` | `2` | `.volatile()` | 逻辑日边界小时（0–23） |
| `idleMinutes` | `30` | `.volatile()` | 自动日结所需连续空闲分钟数 |
| `onboarding.enabled` | `true` | `.volatile()` | 空画像冷启动引导开关 |
| `briefing.enabled` | `true` | `.volatile()` | 每日首次正常交互晨报开关 |
| `correction.autoCapture` | `true` | `.volatile()` | 轻量规则自动捕获用户纠偏开关 |
| `correction.defaultSection` | `'长期规矩与边界'` | `.volatile()` | 自动捕获纠偏默认写入分节 |
| `dream.enabled` | `true` | `.volatile()` | 做梦后台整理总开关 |
| `dream.useLlm` | **`false`** | `.volatile()` | 做梦 LLM 语义层开关（默认关闭，仅跑确定性规则；试跑满意后再开启） |
| `dream.intervalDays` | `7` | `.volatile()` | 自动做梦最小间隔天数 |
| `dream.minNewJournals` | `3` | `.volatile()` | 自动做梦所需新增日报数阈值 |
| `dream.maxChangeRatio` | `0.2` | `.volatile()` | 单次做梦最大非锁定画像修改比例 |
| `dream.rejectCooldownDays` | `30` | `.volatile()` | 被驳回 Dream 提案的冷却天数 |
| `dream.instructions` | `''` | `.volatile()` | 可选自然语言做梦整理关注目标 |
| `sections.profile` | `true` / `2000` | `.volatile()` | 核心画像冻结注入开关与 Token 上限 |
| `sections.yesterday` | `true` / `1500` | `.volatile()` | 昨日完整日报冻结注入开关与 Token 上限 |
| `sections.recentDays` | `true` / `7` 天 / `2000` | `.volatile()` | 近 N 天精华冻结注入开关、天数与 Token 上限 |
| `sections.historyOverview` | `true` / `1000` | `.volatile()` | 跨月历史 L0 总览冻结注入开关与 Token 上限 |
| `sections.entities` | `true` / `1500` | `.volatile()` | 实体卡别名动态增量注入开关与上限 |
| `sections.lessons` | `true` / `1500` | `.volatile()` | 避坑经验卡触发词/标签动态注入开关与上限 |
| `buffer.autoCommitSources` | `['explicit']` | `.volatile()` | 日结允许自动落盘的缓冲区来源 |
| `buffer.requireConfirmOnOverwrite` | `true` | `.volatile()` | 覆盖/删除或改写 `pinned` 是否强制人工确认 |
| `llm.provider` / `llm.model` | `''` | `.volatile()` | 后台日结与 Dream 专用模型覆盖（留空继承默认模型） |
| `home` | `$DSH_HOME/daily-memory` | 重载生效 | 记忆根目录 |
| `timeZone` | 系统时区 | 重载生效 | 逻辑日与日报日期格式化时区 |
| `ingest.*` / `digest.maxChunkTokens` | `user-only` / `24000` | 重载生效 | 子会话采集策略、Scope 白名单与分块上限 |

---

## 6. 公开 Cordis 服务契约（`dshMemory`）

- **服务名**：`SERVICE_NAME = 'dshMemory'`（`contractVersion: 1`，零 `ds-bot` 依赖）。
- **标准事件**：`DAY_ROLLED_OVER_EVENT = 'dsh-memory/day-rolled-over'`，载荷 `{ date, scope, journalPath, summary: { title, highlights, pendingBufferCount, text } }`。
- **公开方法（16 个）**：
  - 时间、晨报与配置快照：`getCurrentLogicalDate`、`getMorningBriefing`、`markBriefingDelivered`、`confirmBufferItems`、`getSettingsSnapshot`
  - 实体与避坑检索（供 Worker 拉齐上下文）：`matchEntities`、`getEntity`、`listEntities`、`matchLessons(text, { tags, maxTokens })`、`getLesson`、`listLessons`
  - 安全候选入缓冲（防冒用 + 凭据守卫）：`submitBufferCandidate`（支持 `profile` / `note` / `entity:<名>` / `lesson:<名>` 及 `tags` / `triggers`）
  - 冷启动控制：`getOnboardingState`、`submitOnboarding`、`skipOnboarding`、`resetOnboarding`

---

## 7. 测试、评测与后续规划

- **运行测试**：
  ```bash
  npm test
  ```
- **运行三组消融评测**（对比 `no-memory` vs `dsh-memory` vs `gold-memory` 的准确率与 Token / 缓存成本）：
  ```bash
  npm run eval:llm -- --dry-run   # 零费用离线回归
  npm run eval:llm                # 调用在线模型端到端消融（需主机配妥默认模型或 config.llm）
  ```
- **后续专项梳理与演进方向（已登记于 [Issue #9](https://github.com/5quan/dsh-memory/issues/9) 与 [架构设计说明书 §3.9](docs/DESIGN.md)）**：
  1. 全系统流程合理性专项审查与 Digest / Dream / `USAGE_GUIDANCE` 提示词调优（含修复 Dream 日报头部截断隐患）；
  2. 冻结前缀按闲置时长 + 内容哈希指纹刷新机制（`snapshotRefreshIdleMinutes`）；
  3. 可选本地 SQLite BLOB 向量 + RRF 混合重排派生检索（零外部向量库、默认关闭、由真实消融数据驱动）；
  4. 写入侧记忆投毒 / 提示注入专项拦截与红队验收。

## 延伸文档

- [架构设计说明书](docs/DESIGN.md)
