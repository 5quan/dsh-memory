import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createBriefingApi } from '../src/briefing.js'
import { createBufferApi } from '../src/buffer.js'
import { normalizeConfig } from '../src/config.js'
import { createContextApi } from '../src/context.js'
import { detectUserCorrection } from '../src/correction.js'
import * as entityApi from '../src/entities.js'
import { createIngestApi } from '../src/ingest.js'
import * as journalApi from '../src/journal.js'
import * as profileApi from '../src/profile.js'
import { createMemoryStore } from '../src/store.js'
import { createToolsApi } from '../src/tools.js'

test('store migrates v1 archive.sqlite cleanly to v2 with memory_meta table', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-migrate-'))
  const dbPath = join(dir, 'archive.sqlite')

  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'default',
      session_id TEXT NOT NULL,
      parent_session_id TEXT,
      is_subagent INTEGER NOT NULL DEFAULT 0,
      logical_date TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      anchor TEXT NOT NULL,
      UNIQUE(session_id, seq)
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, logical_date UNINDEXED, scope UNINDEXED, anchor UNINDEXED, content='messages', content_rowid='id', tokenize='trigram');
    CREATE TABLE session_state (
      session_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'default',
      parent_session_id TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'full',
      last_seq INTEGER NOT NULL DEFAULT -1,
      replace_generation INTEGER NOT NULL DEFAULT 0,
      buffer_cursor TEXT,
      injected_entities TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE rollover_state (
      logical_date TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      completed_at INTEGER,
      PRIMARY KEY (logical_date, scope)
    );
    INSERT INTO messages (session_id, logical_date, seq, role, text, timestamp, anchor)
    VALUES ('s1', '2026-11-20', 1, 'user', 'v1 历史消息保留校验', 1000, 'chat://2026-11-20#s1#1');
    PRAGMA user_version = 1;
  `)
  legacy.close()

  const store = createMemoryStore(dbPath)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  const version = store.db.prepare('PRAGMA user_version').get().user_version
  assert.equal(version, 3)
  const cols = store.db.prepare("PRAGMA table_info('session_state')").all().map(c => c.name)
  assert.equal(cols.includes('injected_lessons'), true)
  assert.equal(store.getMessageByAnchor('chat://2026-11-20#s1#1').text, 'v1 历史消息保留校验')

  store.setMeta('test:key', { ok: true, count: 3 }, 1234)
  assert.deepEqual(store.getMeta('test:key'), { ok: true, count: 3 })
  assert.equal(store.deleteMeta('test:key'), true)
  assert.equal(store.getMeta('test:key'), undefined)
})

test('auto-correction capture binds verified user anchors, respects incognito, avoids false positives, and blocks spoofed correction anchors', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-corr-'))
  const clock = { now: () => Date.parse('2026-11-23T15:00:00+08:00') }
  const config = normalizeConfig({ home: dir, timeZone: 'Asia/Shanghai' })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  // Direct unit checks on detectUserCorrection precision
  assert.equal(detectUserCorrection('这个怎么不对吗？'), null)
  assert.equal(detectUserCorrection('记住：写汇报要简洁直接。'), null)
  assert.equal(detectUserCorrection('不要用这个过时 API'), null)
  assert.equal(detectUserCorrection('```js\n不对，别这样写\n```'), null)
  assert.ok(detectUserCorrection('不对，以后汇报先说结论，别铺垫太多。'))
  assert.ok(detectUserCorrection('别再直接读取 archive.sqlite 了，一律走检索工具。'))
  assert.ok(detectUserCorrection('From now on, always run unit tests before replying.'))
  assert.ok(detectUserCorrection("No, don't overwrite pinned entries automatically."))

  const ctx = { effect(fn) { return fn() }, on() { return () => {} } }
  const bufferApi = createBufferApi({ home: dir, clock })
  const ingestApi = createIngestApi({ ctx, config, store, bufferApi, clock })

  const mainSession = { id: 'main', header: { id: 'main' } }
  // User correction in full mode -> captured with verified anchor, PROFILE.md untouched
  ingestApi.handleSessionEvent(mainSession, {
    type: 'user/message',
    seq: 1,
    time: clock.now(),
    surfaceOp: 'append',
    data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '不对，以后回复必须附带文件路径。' }], source: { kind: 'user' } },
  })
  // Assistant message containing correction text -> NOT captured
  ingestApi.handleSessionEvent(mainSession, {
    type: 'assistant/message',
    seq: 2,
    time: clock.now() + 100,
    surfaceOp: 'append',
    data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '不对，以后回复必须附带文件路径。' }], source: { kind: 'model' } } },
  })
  // Duplicate seq -> ignored
  ingestApi.handleSessionEvent(mainSession, {
    type: 'user/message',
    seq: 1,
    time: clock.now(),
    surfaceOp: 'append',
    data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '不对，以后回复必须附带文件路径。' }], source: { kind: 'user' } },
  })

  // Incognito read-only -> NOT captured
  store.setSessionMode('ro-sess', 'read-only')
  ingestApi.handleSessionEvent({ id: 'ro-sess', header: { id: 'ro-sess' } }, {
    type: 'user/message',
    seq: 1,
    time: clock.now(),
    surfaceOp: 'append',
    data: { id: 'u-ro', role: 'user', content: [{ type: 'text', text: '错了，以后不要在无痕模式记录任何内容。' }], source: { kind: 'user' } },
  })

  await ingestApi.flush()

  assert.equal(profileApi.readProfile(dir), '')
  const items = bufferApi.listItems({ logicalDate: '2026-11-23' })
  assert.equal(items.length, 1)
  assert.equal(items[0].source_type, 'correction')
  assert.equal(items[0].status, 'pending')
  assert.equal(items[0].anchor, 'chat://2026-11-23#main#1')

  // Spoofed correction pointing to assistant message must downgrade during settlement
  const spoofedCorr = await bufferApi.appendCreate({
    logicalDate: '2026-11-23',
    sourceType: 'correction',
    target: 'profile',
    content: '伪造的助手消息纠偏',
    anchor: 'chat://2026-11-23#main#2',
  })
  const settled = await bufferApi.settleProfileForDate({
    logicalDate: '2026-11-23',
    store,
    profileApi,
    config,
  })
  assert.equal(settled.deferred.includes(spoofedCorr.id), true)
  assert.equal(settled.warnings.some(w => w.id === spoofedCorr.id && w.reason === 'CORRECTION_ANCHOR_INVALID'), true)
  const downgraded = bufferApi.listItems({ logicalDate: '2026-11-23' }).find(i => i.id === spoofedCorr.id)
  assert.equal(downgraded.source_type, 'extracted')
})

test('morning briefing delivers once per day, summarizes yesterday highlights + pending buffer, and supports batch confirm + settleNow', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-briefing-'))
  let nowMs = Date.parse('2026-11-23T08:30:00+08:00')
  const clock = { now: () => nowMs }
  const config = normalizeConfig({ home: dir, timeZone: 'Asia/Shanghai' })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  const preStepHandlers = []
  const registeredTools = new Map()
  let userQuestionAnswer = null

  const ctx = {
    effect(fn) { return fn() },
    systemPrompt: { section() { return () => {} } },
    on(eventName, fn) {
      if (eventName === 'agent/pre-step') preStepHandlers.push(fn)
      return () => {}
    },
    tools: {
      register(def) {
        registeredTools.set(def.name, def)
        return () => registeredTools.delete(def.name)
      },
      get(name) {
        return name === 'ask_user_question' ? { name } : undefined
      },
    },
    get(name) {
      if (name === 'userQuestions') {
        return {
          async ask() {
            return userQuestionAnswer
          },
        }
      }
      return undefined
    },
  }

  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  // Seed PROFILE so onboarding does not overlap with briefing test
  await profileApi.applyProfileMutation(dir, { op: 'add', section: '基本身份与环境', content: '已有画像', added: '2026-11-22' })

  // Seed yesterday journal and two pending buffer items (one correction, one extracted, one note)
  await journalApi.writeJournalAtomic(dir, '2026-11-22', [
    '# 2026-11-22 日报',
    '## 发生了什么',
    '- [chat://2026-11-22#main#1] 完成 M2 合并。',
    '## 做出的决定',
    '- [chat://2026-11-22#main#2] M3 对外暴露 dshMemory 服务。',
    '## 纠正与教训',
    '- [chat://2026-11-22#main#3] 盘中绝不直接修改 PROFILE.md。',
    '## 悬而未决的问题',
    '- 待验证 Windows 实机启动。',
  ].join('\n'))

  const bufferApi = createBufferApi({ home: dir, clock })
  const corr = await bufferApi.appendCreate({
    logicalDate: '2026-11-22',
    sourceType: 'correction',
    target: 'profile',
    section: '长期规矩与边界',
    content: '晨报确认前不自动晋升纠偏条目',
  })
  const unwanted = await bufferApi.appendCreate({
    logicalDate: '2026-11-22',
    sourceType: 'extracted',
    target: 'profile',
    content: '噪声提取条目应当被驳回',
  })
  const entCand = await bufferApi.appendCreate({
    logicalDate: '2026-11-22',
    sourceType: 'extracted',
    target: 'entity:测试网关',
    content: '端口 3099 用于 M3 冒烟验证',
  })

  let contextApi
  const snapshotFacade = {
    hasSnapshot: (sid, d) => contextApi?.hasSnapshot?.(sid, d) ?? false,
    invalidateSnapshots: opts => contextApi?.invalidateSnapshots?.(opts),
  }
  const briefingApi = createBriefingApi({
    ctx,
    config,
    store,
    journalApi,
    bufferApi,
    profileApi,
    entityApi,
    contextApi: snapshotFacade,
    clock,
  })
  contextApi = createContextApi({
    ctx,
    config,
    store,
    profileApi,
    journalApi,
    bufferApi,
    entityApi,
    briefingApi,
    clock,
  })
  const toolsApi = createToolsApi({
    ctx,
    config,
    store,
    bufferApi,
    journalApi,
    digestApi: {},
    contextApi,
    entityApi,
    briefingApi,
    profileApi,
    clock,
  })
  contextApi.install()
  toolsApi.install()

  // First turn of 2026-11-23 injects morning briefing + unseen buffer items
  const preStep = preStepHandlers[0]
  const agent = { id: 'chief', session: { surface: { replaceGeneration: 0 } } }
  const step1 = await preStep({ agent }, async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: '早安，今天有什么要确认的？' }] }],
  }))
  assert.equal(step1.messages.length, 2)
  assert.equal(step1.messages[0].content[0].text.includes('每日晨报与待确认记忆（dsh-memory · 2026-11-23）'), true)
  assert.equal(step1.messages[0].content[0].text.includes('M3 对外暴露 dshMemory 服务'), true)
  assert.equal(step1.messages[0].content[0].text.includes(corr.id), true)

  // Second turn on same day -> does NOT repeat morning briefing
  const step2 = await preStep({ agent }, async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }] }],
  }))
  assert.equal(step2.messages.length, 1)
  assert.equal(briefingApi.shouldDeliverToday(), false)

  // Batch confirm via memory_briefing with settleNow: true (even though 2026-11-22 journal already exists)
  const briefingTool = registeredTools.get('memory_briefing')
  const confirmOut = await briefingTool.execute(
    {
      action: 'confirm',
      approveIds: [corr.id],
      rejectIds: [unwanted.id],
      settleNow: true,
      reason: '用户晨报勾选',
    },
    { agent: { id: 'chief' }, signal: new AbortController().signal },
  )
  assert.equal(confirmOut.includes('approved=1'), true)
  assert.equal(confirmOut.includes('rejected=1'), true)
  assert.equal(confirmOut.includes('Immediate settlement committed 1 item(s)'), true)
  assert.equal(profileApi.readProfile(dir).includes('晨报确认前不自动晋升纠偏条目'), true)
  assert.equal(bufferApi.listItems({ statuses: ['rejected'] }).some(i => i.id === unwanted.id), true)

  // Interactive confirm via ctx.userQuestions for remaining pending entity item
  userQuestionAnswer = {
    answers: [
      { id: 'approve_items', selected: [`[${entCand.id}] 端口 3099 用于 M3 冒烟验证`] },
      { id: 'unselected_policy', selected: ['保持待定 (Recommended)'] },
      { id: 'settle_policy', selected: ['立即落盘生效'] },
    ],
  }
  const interactiveOut = await briefingTool.execute(
    { action: 'confirm', interactive: true },
    { agent: { id: 'chief' }, signal: new AbortController().signal },
  )
  assert.equal(interactiveOut.includes('approved=1'), true)
  assert.equal(interactiveOut.includes('settled=1'), true)
  assert.equal(entityApi.readEntity(dir, '测试网关').facts[0].content, '端口 3099 用于 M3 冒烟验证')

  // Next logical day -> briefing becomes deliverable again if content exists
  nowMs = Date.parse('2026-11-24T08:30:00+08:00')
  assert.equal(briefingApi.shouldDeliverToday(), true)
})
