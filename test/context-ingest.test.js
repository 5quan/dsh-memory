import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBriefingApi } from '../src/briefing.js'
import { createBufferApi } from '../src/buffer.js'
import { normalizeConfig } from '../src/config.js'
import { createContextApi } from '../src/context.js'
import * as entityApi from '../src/entities.js'
import { createIngestApi } from '../src/ingest.js'
import * as journalApi from '../src/journal.js'
import * as lessonApi from '../src/lessons.js'
import { createOnboardingApi } from '../src/onboarding.js'
import * as profileApi from '../src/profile.js'
import { createMemoryStore } from '../src/store.js'

function mockHookCtx() {
  const sections = []
  const preStepHandlers = []
  const sessionEventHandlers = []
  return {
    sections,
    preStepHandlers,
    sessionEventHandlers,
    effect(fn) {
      return fn()
    },
    systemPrompt: {
      section(def) {
        sections.push(def)
        return () => {}
      },
    },
    on(eventName, fn) {
      if (eventName === 'agent/pre-step') preStepHandlers.push(fn)
      if (eventName === 'session/event') sessionEventHandlers.push(fn)
      return () => {}
    },
  }
}

test('context freezes snapshot per (session_id, logical_date), refreshes on new day, and prioritizes recent-day budget', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-ctx-'))
  let nowMs = Date.parse('2026-11-22T10:00:00+08:00')
  const clock = { now: () => nowMs }
  const config = normalizeConfig({
    home: dir,
    timeZone: 'Asia/Shanghai',
    dayStartHour: 2,
    sections: {
      recentDays: { enabled: true, days: 7, maxTokens: 130 },
    },
  })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  await profileApi.applyProfileMutation(dir, {
    op: 'add',
    section: '偏好',
    content: '初始画像规则',
    added: '2026-11-21',
  })
  await journalApi.writeJournalAtomic(dir, '2026-11-18', `# 2026-11-18 日报\n## 做出的决定\n- 早期决定内容应当在预算不足时首先被整体淘汰 ${'长文本'.repeat(80)}\n## 纠正与教训\n- 早期教训\n`)
  await journalApi.writeJournalAtomic(dir, '2026-11-20', `# 2026-11-20 日报\n## 做出的决定\n- 较近的决定\n## 纠正与教训\n- 较近的纠偏\n`)
  await journalApi.writeJournalAtomic(dir, '2026-11-21', `# 2026-11-21 日报\n## 发生了什么\n- 昨天做了设计评审\n`)

  const ctx = mockHookCtx()
  const bufferApi = createBufferApi({ home: dir, clock })
  const contextApi = createContextApi({ ctx, config, store, profileApi, journalApi, bufferApi, clock })
  contextApi.install()

  // Same logical day: frozen even after out-of-band PROFILE edit
  const snap1 = contextApi.sectionFor('chief-session')
  assert.equal(snap1.includes('当前逻辑日期：2026-11-22（Asia/Shanghai）'), true)
  assert.equal(snap1.includes('## 2026-11-21（昨天）'), true)
  assert.equal(snap1.includes('### 2026-11-20（2 天前）'), true)
  assert.equal(snap1.includes('2026-11-18'), false) // dropped earliest day under tight 130 token budget
  assert.equal(existsSync(join(dir, 'snapshots', 'chief-session__2026-11-22.md')), true)

  // Single recent day exceeding budget keeps priority: 纠正与教训 > 做出的决定 > 悬而未决的问题
  const tightSingle = journalApi.renderRecentDays({
    home: dir,
    todayDate: '2026-11-22',
    yesterdayDate: '2026-11-21',
    recentDaysCount: 7,
    maxTokens: 20,
  })
  assert.equal(tightSingle.includes('较近的纠偏'), true)
  assert.equal(tightSingle.includes('较近的决定'), false)

  await profileApi.applyProfileMutation(dir, {
    op: 'add',
    section: '偏好',
    content: '当天盘中新增画像不应破坏当天前缀缓存',
    added: '2026-11-22',
  })
  const snap2 = contextApi.sectionFor('chief-session')
  assert.equal(snap2, snap1)

  // Cross into next logical day (2026-11-23 02:05) -> automatically creates new day snapshot & prunes old one
  nowMs = Date.parse('2026-11-23T02:05:00+08:00')
  await journalApi.writeJournalAtomic(dir, '2026-11-22', `# 2026-11-22 日报\n## 发生了什么\n- 昨晚完成 M1 编码\n`)
  const snapNextDay = contextApi.sectionFor('chief-session')
  assert.equal(snapNextDay.includes('当前逻辑日期：2026-11-23（Asia/Shanghai）'), true)
  assert.equal(snapNextDay.includes('## 2026-11-22（昨天）'), true)
  assert.equal(snapNextDay.includes('当天盘中新增画像不应破坏当天前缀缓存'), true)

  const snapFiles = readdirSync(join(dir, 'snapshots'))
  assert.deepEqual(snapFiles, ['chief-session__2026-11-23.md'])
})

test('agent/pre-step injects delta once per buffer item and re-injects after compaction replaceGeneration bump', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-delta-'))
  const clock = { now: () => Date.parse('2026-11-22T14:00:00+08:00') }
  const config = normalizeConfig({ home: dir, timeZone: 'Asia/Shanghai' })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  const ctx = mockHookCtx()
  const bufferApi = createBufferApi({ home: dir, clock })
  const contextApi = createContextApi({ ctx, config, store, profileApi, journalApi, bufferApi, clock })
  contextApi.install()

  await bufferApi.appendCreate({
    logicalDate: '2026-11-22',
    sourceType: 'explicit',
    target: 'profile',
    content: '所有测试必须带真实断言',
    anchor: 'chat://2026-11-22#s1#1',
  })

  const preStep = ctx.preStepHandlers[0]
  const fakeAgent = { id: 's1', session: { surface: { replaceGeneration: 0 } } }
  const userMsg = { role: 'user', content: [{ type: 'text', text: 'hello' }] }

  const step1 = await preStep({ agent: fakeAgent }, async () => ({ kind: 'enter', messages: [userMsg] }))
  assert.equal(step1.messages.length, 2)
  assert.equal(step1.messages[0].source.kind, 'dsh-memory/delta')
  assert.equal(step1.messages[0].content[0].text.includes('所有测试必须带真实断言'), true)

  // Next step with no new items -> no duplicate injection
  const step2 = await preStep({ agent: fakeAgent }, async () => ({ kind: 'enter', messages: [userMsg] }))
  assert.equal(step2.messages.length, 1)

  // Compaction occurs: replaceGeneration increments to 1 -> cursor resets & active item is re-injected
  fakeAgent.session.surface.replaceGeneration = 1
  const step3 = await preStep({ agent: fakeAgent }, async () => ({ kind: 'enter', messages: [userMsg] }))
  assert.equal(step3.messages.length, 2)
  assert.equal(step3.messages[0].source.kind, 'dsh-memory/delta')
})

test('ingest keeps user messages in subagent threads, ignores replacement events, and honors read-only / off incognito modes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-ingest-'))
  const clock = { now: () => Date.parse('2026-11-22T15:00:00+08:00') }
  const config = normalizeConfig({ home: dir, timeZone: 'Asia/Shanghai' })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  const ctx = mockHookCtx()
  const bufferApi = createBufferApi({ home: dir, clock })
  const contextApi = createContextApi({ ctx, config, store, profileApi, journalApi, bufferApi, clock })
  const ingestApi = createIngestApi({ ctx, config, store, clock })
  contextApi.install()
  ingestApi.install()

  const emitEvent = (session, event) => ctx.sessionEventHandlers.forEach(fn => fn(session, event))

  // Subagent session: user-only policy preserves user message and drops assistant message
  const subSession = { id: 'sub-1', header: { id: 'sub-1', origin: 'subagent', parentSession: 'main' } }
  emitEvent(subSession, {
    type: 'user/message',
    seq: 0,
    time: clock.now(),
    surfaceOp: 'append',
    data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '<system-reminder>ignore</system-reminder>不要用这个过时 API' }], source: { kind: 'user' } },
  })
  emitEvent(subSession, {
    type: 'assistant/message',
    seq: 1,
    time: clock.now() + 100,
    surfaceOp: 'append',
    data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '海量 worker 输出噪声' }], source: { kind: 'model', provider: 'p', model: 'm' } } },
  })

  // Replacement event & delta self-message are ignored on main session
  const mainSession = { id: 'main', header: { id: 'main' } }
  emitEvent(mainSession, {
    type: 'user/message',
    seq: 0,
    time: clock.now(),
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
    data: { id: 'u-comp', role: 'user', content: [{ type: 'text', text: 'compaction copy' }], source: { kind: 'user' } },
  })
  emitEvent(mainSession, {
    type: 'user/message',
    seq: 1,
    time: clock.now(),
    surfaceOp: 'append',
    data: { id: 'u-delta', role: 'user', content: [{ type: 'text', text: 'delta echo' }], source: { kind: 'dsh-memory/delta' } },
  })

  const subMsgs = store.getMessagesForDate('2026-11-22')
  assert.equal(subMsgs.length, 1)
  assert.equal(subMsgs[0].role, 'user')
  assert.equal(subMsgs[0].text, '不要用这个过时 API')
  assert.equal(subMsgs[0].is_subagent, 1)

  // Incognito modes: read-only reads but doesn't write; off neither reads nor writes
  store.setSessionMode('ro-sess', 'read-only')
  emitEvent({ id: 'ro-sess', header: { id: 'ro-sess' } }, {
    type: 'user/message',
    seq: 0,
    time: clock.now(),
    surfaceOp: 'append',
    data: { id: 'u-ro', role: 'user', content: [{ type: 'text', text: '无痕只读测试消息' }], source: { kind: 'user' } },
  })
  assert.equal(store.searchMessages({ query: '无痕只读' }).length, 0)

  store.setSessionMode('off-sess', 'off')
  assert.equal(contextApi.sectionFor('off-sess'), '')

  // Cold-start directory with empty PROFILE.md & journals/ still provides usage guidance
  const emptyDir = mkdtempSync(join(tmpdir(), 'dsh-memory-cold-'))
  const emptyStore = createMemoryStore(join(emptyDir, 'archive.sqlite'))
  t.after(() => {
    emptyStore.close()
    rmSync(emptyDir, { recursive: true, force: true, maxRetries: 5 })
  })
  const emptyConfig = normalizeConfig({ home: emptyDir, timeZone: 'Asia/Shanghai' })
  const emptyContextApi = createContextApi({
    ctx: mockHookCtx(),
    config: emptyConfig,
    store: emptyStore,
    profileApi,
    journalApi,
    bufferApi: createBufferApi({ home: emptyDir, clock }),
    clock,
  })
  const coldPrompt = emptyContextApi.sectionFor('fresh-sess')
  assert.equal(coldPrompt.includes('dsh-memory'), true)
  assert.equal(coldPrompt.includes('当前逻辑日期：2026-11-22（Asia/Shanghai）'), true)
  assert.equal(coldPrompt.includes('memory_buffer_add'), true)
  assert.equal(coldPrompt.includes('核心画像与历史日报尚为空'), true)
  emptyStore.setSessionMode('cold-off', 'off')
  assert.equal(emptyContextApi.sectionFor('cold-off'), '')
})

test('subagent sessions skip frozen snapshot and delta injection by default while keeping user-only ingest and auto-correction, and restore injection when enabled', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-subagent-ctx-'))
  const nowMs = Date.parse('2026-11-23T10:00:00+08:00')
  const clock = { now: () => nowMs }
  const config = normalizeConfig({ home: dir, timeZone: 'Asia/Shanghai' })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  await journalApi.writeJournalAtomic(dir, '2026-11-22', '# 2026-11-22 日报\n## 发生了什么\n- 昨日完成基线测试。\n')
  await entityApi.upsertEntity(dir, {
    name: 'ProdDB',
    type: 'server',
    aliases: ['pg-main'],
    content: '端口 15432',
    added: '2026-11-22',
    source: 'manual',
  })
  await lessonApi.upsertLesson(dir, {
    name: '部署检查',
    tags: ['deploy'],
    triggers: ['nginx'],
    content: '先跑 nginx -t 再 reload',
    added: '2026-11-22',
    source: 'manual',
  })

  const ctx = mockHookCtx()
  const bufferApi = createBufferApi({ home: dir, profileApi, lessonApi, clock })
  await bufferApi.appendCreate({
    logicalDate: '2026-11-23',
    sourceType: 'extracted',
    target: 'profile',
    content: '主会话待确认规则',
  })

  let contextApi
  const snapshotFacade = {
    hasSnapshot: (sid, date) => contextApi?.hasSnapshot?.(sid, date) ?? false,
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
    lessonApi,
    contextApi: snapshotFacade,
    clock,
  })
  const onboardingApi = createOnboardingApi({
    ctx,
    config,
    store,
    profileApi,
    bufferApi,
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
    lessonApi,
    onboardingApi,
    briefingApi,
    clock,
  })
  const ingestApi = createIngestApi({ ctx, config, store, bufferApi, clock })
  contextApi.install()
  ingestApi.install()

  assert.equal(config.ingest.injectSubagentContext, false)

  const subSession = { id: 'sub-1', header: { id: 'sub-1', origin: 'subagent', parentSession: 'main-1' } }
  const subAgent = {
    id: 'sub-1',
    session: {
      header: { id: 'sub-1', origin: 'subagent', parentSession: 'main-1' },
      surface: { replaceGeneration: 0 },
    },
  }
  const promptSection = ctx.sections[0]
  const preStep = ctx.preStepHandlers[0]

  // Default: subagent skips frozen system prompt, leaves zero snapshots, and skips pre-step delta
  assert.equal(contextApi.sectionFor('sub-1', { isSubagent: true }), '')
  assert.equal(promptSection.text({ agent: subAgent }), '')
  assert.deepEqual(existsSync(join(dir, 'snapshots')) ? readdirSync(join(dir, 'snapshots')) : [], [])

  const subStepDefault = await preStep(
    { agent: subAgent, step: 1 },
    async () => ({
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: '用 pg-main 和 nginx 部署' }], source: { kind: 'user' } }],
    }),
  )
  assert.equal(subStepDefault.messages.length, 1)
  assert.equal(briefingApi.shouldDeliverToday(), true)
  assert.equal(onboardingApi.shouldPromptForSession('main-1'), true)

  // Normal non-subagent session still gets frozen prefix and writes snapshot
  const mainSnap = promptSection.text({
    agent: { id: 'main-1', session: { header: { id: 'main-1' } } },
  })
  assert.equal(mainSnap.includes('昨日完成基线测试'), true)
  assert.deepEqual(readdirSync(join(dir, 'snapshots')), ['main-1__2026-11-23.md'])

  // Subagent user-only ingest + auto-correction still captures human messages while dropping assistant replies
  ingestApi.handleSessionEvent(subSession, {
    type: 'user/message',
    seq: 0,
    time: nowMs,
    surfaceOp: 'append',
    data: { id: 'u-sub', role: 'user', content: [{ type: 'text', text: '不对，以后回复必须附带日志路径。' }], source: { kind: 'user' } },
  })
  ingestApi.handleSessionEvent(subSession, {
    type: 'assistant/message',
    seq: 1,
    time: nowMs + 100,
    surfaceOp: 'append',
    data: { message: { id: 'a-sub', role: 'assistant', content: [{ type: 'text', text: '子会话内部输出噪声' }], source: { kind: 'model' } } },
  })
  await ingestApi.flush()

  const archived = store.getMessagesForDate('2026-11-23')
  assert.equal(archived.length, 1)
  assert.equal(archived[0].role, 'user')
  assert.equal(archived[0].is_subagent, 1)
  assert.equal(archived[0].anchor, 'chat://2026-11-23#sub-1#0')

  const corrItem = bufferApi.listItems({ logicalDate: '2026-11-23' }).find(i => i.source_type === 'correction')
  assert.ok(corrItem)
  assert.equal(corrItem.anchor, 'chat://2026-11-23#sub-1#0')
  assert.equal(corrItem.content.includes('附带日志路径'), true)

  // Enabling ingest.injectSubagentContext restores frozen prefix & delta (still suppressing briefing/onboarding)
  config.ingest.injectSubagentContext = true
  const subFrozenEnabled = promptSection.text({ agent: subAgent })
  assert.equal(subFrozenEnabled.includes('昨日完成基线测试'), true)
  assert.equal(existsSync(join(dir, 'snapshots', 'sub-1__2026-11-23.md')), true)

  const subStepEnabled = await preStep(
    { agent: subAgent, step: 1 },
    async () => ({
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: '用 pg-main 和 nginx 部署' }], source: { kind: 'user' } }],
    }),
  )
  assert.equal(subStepEnabled.messages.length, 2)
  const deltaText = subStepEnabled.messages[0].content[0].text
  assert.equal(deltaText.includes('主会话待确认规则'), true)
  assert.equal(deltaText.includes('端口 15432'), true)
  assert.equal(deltaText.includes('先跑 nginx -t 再 reload'), true)
  assert.equal(deltaText.includes('每日晨报与待确认记忆'), false)
  assert.equal(deltaText.includes('初始画像冷启动引导'), false)
  assert.equal(briefingApi.shouldDeliverToday(), true)
  assert.equal(onboardingApi.shouldPromptForSession('main-1'), true)
})
