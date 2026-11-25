import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMemoryRuntime } from '../index.js'

function createE2eHarness(t, clock) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-memory-e2e-'))
  const disposers = []
  const tools = new Map()
  const listeners = new Map()
  const promptSections = new Map()

  const ctx = {
    logger: { warn() {}, info() {} },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') disposers.push(cleanup)
      return cleanup
    },
    on(eventName, fn) {
      listeners.set(eventName, [...(listeners.get(eventName) ?? []), fn])
      return () => {}
    },
    emit(eventName, payload) {
      for (const fn of listeners.get(eventName) ?? []) fn(payload)
    },
    systemPrompt: {
      section(def) {
        promptSections.set(def.name, def)
        return () => promptSections.delete(def.name)
      },
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'mock', model: 'mock-flash' }) }
      }
      return undefined
    },
    llm: {
      async* stream(request) {
        const promptText = request?.messages?.[0]?.content?.[0]?.text ?? ''
        const text = promptText.includes('目标月份')
          ? [
            '===L0_ABSTRACT===',
            '十一月记录了汇报偏好并测试了遗忘清理流程。',
            '===L1_OVERVIEW===',
            '# 2026-11 月度概览',
            '',
            '## 核心事件索引',
            '- [2026-11-21] [chat://2026-11-21#main#1] 记录汇报风格偏好。',
            '- [2026-11-21] [chat://2026-11-21#main#2] 测试机密字段 TempSecretToken 记录。',
          ].join('\n')
          : [
            '# 2026-11-21 日报',
            '## 发生了什么',
            '- [chat://2026-11-21#main#1] 用户要求记住汇报风格偏好与删除测试机密。',
            '- [chat://2026-11-21#main#2] 测试机密字段 TempSecretToken 被记录过。',
            '## 做出的决定',
            '- （无）',
            '## 新建/变更的事项',
            '- （无）',
            '## 纠正与教训',
            '- （无）',
            '## 悬而未决的问题',
            '- （无）',
            '## 提到的实体',
            '- （无）',
          ].join('\n')
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }

  const rt = createMemoryRuntime(ctx, { home, timeZone: 'Asia/Shanghai' }, {
    clock,
    startTimer: false,
    autoCatchUp: false,
  })

  t.after(async () => {
    for (const cleanup of disposers.reverse()) {
      try { await cleanup() } catch {}
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  const emitSessionEvent = (session, event) => {
    for (const fn of listeners.get('session/event') ?? []) fn(session, event)
  }
  const runTool = async (name, args, sessionId = 'main', sessionHeader) => {
    const tool = tools.get(name)
    assert.ok(tool, `tool ${name} should be registered`)
    const agent = sessionHeader
      ? { id: sessionId, session: { header: sessionHeader } }
      : { id: sessionId }
    return await tool.execute(args, { agent, signal: new AbortController().signal })
  }

  return { home, rt, tools, promptSections, emitSessionEvent, runTool }
}

test('E2E workflow across all 15 M1-M5 tools including lessons, context expansion, guard, dream, rollback, onboarding, briefing, correction, buffer, digest, history, entities, search, mode switch, and forget', async (t) => {
  let nowMs = Date.parse('2026-11-21T16:00:00+08:00')
  const clock = { now: () => nowMs }
  const { rt, tools, emitSessionEvent, runTool } = createE2eHarness(t, clock)

  assert.deepEqual([...tools.keys()].sort(), [
    'memory_briefing',
    'memory_buffer_add',
    'memory_buffer_manage',
    'memory_digest_now',
    'memory_dream_now',
    'memory_entity_manage',
    'memory_forget',
    'memory_history_browse',
    'memory_journal_read',
    'memory_lesson_manage',
    'memory_mode_set',
    'memory_onboarding',
    'memory_read_context',
    'memory_rollback',
    'memory_search',
  ])

  const mainSession = { id: 'main', header: { id: 'main' } }
  emitSessionEvent(mainSession, {
    type: 'user/message',
    seq: 1,
    time: nowMs,
    surfaceOp: 'append',
    data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '记住：写汇报要简洁直接。' }], source: { kind: 'user' } },
  })
  emitSessionEvent(mainSession, {
    type: 'user/message',
    seq: 2,
    time: nowMs + 1000,
    surfaceOp: 'append',
    data: { id: 'u2', role: 'user', content: [{ type: 'text', text: '临时测试密钥 TempSecretToken 请勿外泄。' }], source: { kind: 'user' } },
  })

  // 1. Add two buffer entries (user anchor bound automatically to latest user message seq=2)
  const addOut = await runTool('memory_buffer_add', {
    content: '写汇报要简洁直接',
    sourceType: 'explicit',
    section: '沟通风格',
  })
  assert.equal(addOut.includes('sourceType=explicit'), true)
  assert.equal(addOut.includes('chat://2026-11-21#main#2'), true)

  const addExtracted = await runTool('memory_buffer_add', {
    content: '需要定期检查构建',
    sourceType: 'extracted',
    target: 'profile',
  })
  assert.equal(addExtracted.includes('sourceType=extracted'), true)

  // 2. Manage buffer: list + approve extracted item
  const listed = await runTool('memory_buffer_manage', { action: 'list' })
  assert.equal(listed.includes('写汇报要简洁直接'), true)
  assert.equal(listed.includes('需要定期检查构建'), true)

  const extractedId = rt.bufferApi.listItems({ logicalDate: '2026-11-21' }).find(i => i.content === '需要定期检查构建').id
  const approvedMsg = await runTool('memory_buffer_manage', {
    action: 'approve',
    ids: [extractedId],
    reason: '用户确认通过',
  })
  assert.equal(approvedMsg.includes('approved'), true)
  assert.equal(approvedMsg.includes('daily rollover') && approvedMsg.includes('memory_digest_now'), true)

  // Advance clock to next logical day (2026-11-22) and run manual digest for yesterday (2026-11-21)
  nowMs = Date.parse('2026-11-22T10:00:00+08:00')
  const digestOut = await runTool('memory_digest_now', {})
  assert.equal(digestOut.includes('Generated journal for 2026-11-21'), true)
  assert.equal(digestOut.includes('Profile committed: 2'), true)

  // 3. Read journal & browse OpenViking history + manage entities
  const datesList = await runTool('memory_journal_read', {})
  assert.equal(datesList.includes('2026-11-21'), true)
  const journalBody = await runTool('memory_journal_read', { date: '2026-11-21' })
  assert.equal(journalBody.includes('TempSecretToken'), true)

  const histList = await runTool('memory_history_browse', { action: 'list' })
  assert.equal(histList.includes('2026-11'), true)
  const histRead = await runTool('memory_history_browse', { action: 'read', month: '2026-11', level: 'L1' })
  assert.equal(histRead.includes('L2 daily journals in 2026-11: 2026-11-21'), true)

  const entUpsert = await runTool('memory_entity_manage', {
    action: 'upsert',
    name: '测试服务器',
    type: 'server',
    aliases: ['TestBox'],
    content: '包含测试凭据 TempSecretToken',
  })
  assert.equal(entUpsert.includes('Updated entity'), true)
  const entList = await runTool('memory_entity_manage', { action: 'list' })
  assert.equal(entList.includes('测试服务器'), true)

  // 4. Search archive + journal (exact, multi-term OR fallback, and date browse without query)
  const searchOut = await runTool('memory_search', { query: 'TempSecretToken' })
  assert.equal(searchOut.includes('Journal Matches'), true)
  assert.equal(searchOut.includes('Archive Matches'), true)

  const fallbackSearchOut = await runTool('memory_search', { query: 'TempSecretToken 不存在的词' })
  assert.equal(fallbackSearchOut.includes('Journal Matches'), true)
  assert.equal(fallbackSearchOut.includes('Archive Matches'), true)

  const browseByDateOut = await runTool('memory_search', { dateFrom: '2026-11-21', dateTo: '2026-11-21' })
  assert.equal(browseByDateOut.includes('Archive Matches'), true)
  assert.equal(browseByDateOut.includes('chat://2026-11-21#main#2'), true)
  const browseDefaultOut = await runTool('memory_search', {})
  assert.equal(browseDefaultOut.includes('Archive Matches'), true)

  // 5. Forget TempSecretToken -> deletes archive + redacts journal, entity, and history + invalidates snapshot
  const snapshotText = rt.contextApi.sectionFor('main')
  assert.equal(snapshotText.includes('严禁使用 shell/文件工具'), true)
  const forgetOut = await runTool('memory_forget', { keyword: 'TempSecretToken' })
  assert.equal(forgetOut.includes('Forgot 1 archived message(s)'), true)
  assert.equal(forgetOut.includes('Redacted 1 daily journal(s): 2026-11-21'), true)
  assert.equal(forgetOut.includes('Redacted 1 entity card(s): 测试服务器'), true)
  assert.equal(forgetOut.includes('Redacted 1 history month(s): 2026-11'), true)

  const afterSearch = await runTool('memory_search', { query: 'TempSecretToken' })
  assert.equal(afterSearch.includes('No memory matches found'), true)
  const afterJournal = await runTool('memory_journal_read', { date: '2026-11-21' })
  assert.equal(afterJournal.includes('TempSecretToken'), false)
  assert.equal(afterJournal.includes('[已按用户要求遗忘 · 2026-11-22]'), true)

  // 6. Mode switch to read-only refuses buffer writes, off disables search/read
  const roOut = await runTool('memory_mode_set', { mode: 'read-only', scope: 'session' })
  assert.equal(roOut.includes('read-only'), true)
  const blockedAdd = await runTool('memory_buffer_add', { content: 'test', sourceType: 'explicit' })
  assert.equal(blockedAdd.includes('Cannot write'), true)

  await runTool('memory_mode_set', { mode: 'off', scope: 'session' })
  const blockedSearch = await runTool('memory_search', { query: '汇报' })
  assert.equal(blockedSearch.includes('disabled'), true)

  // 7. M3 workflow on active session: onboarding, auto-correction capture, morning briefing & immediate settlement
  const m3Session = { id: 'm3-session', header: { id: 'm3-session' } }
  const onbStatus = await runTool('memory_onboarding', { action: 'status' }, 'm3-session')
  assert.equal(onbStatus.includes('Onboarding status: pending'), true)

  const onbSubmit = await runTool('memory_onboarding', {
    action: 'submit',
    identity: '使用 Windows 11 开发环境',
    rules: '绝不直接改写已冻结的 PROFILE.md',
    writeMode: 'buffer',
  }, 'm3-session')
  assert.equal(onbSubmit.includes('Onboarding completed'), true)
  assert.equal(onbSubmit.includes('queued 2 explicit item(s)'), true)

  emitSessionEvent(m3Session, {
    type: 'user/message',
    seq: 1,
    time: nowMs + 2000,
    surfaceOp: 'append',
    data: { id: 'u3', role: 'user', content: [{ type: 'text', text: '不对，以后一律先运行测试再总结。' }], source: { kind: 'user' } },
  })
  await rt.ingestApi.flush()

  const briefingGet = await runTool('memory_briefing', { action: 'get' }, 'm3-session')
  assert.equal(briefingGet.includes('每日记忆晨报'), true)
  assert.equal(briefingGet.includes('不对，以后一律先运行测试再总结'), true)

  const corrItem = rt.bufferApi.listItems({ statuses: ['pending'] }).find(i => i.source_type === 'correction')
  assert.ok(corrItem)
  assert.equal(corrItem.anchor, 'chat://2026-11-22#m3-session#1')

  const briefingConfirm = await runTool('memory_briefing', {
    action: 'confirm',
    approveIds: [corrItem.id],
    settleNow: true,
    reason: '晨报勾选确认',
  }, 'm3-session')
  assert.equal(briefingConfirm.includes('approved=1'), true)
  assert.equal(briefingConfirm.includes('Immediate settlement committed'), true)
  assert.equal(rt.profileApi.readProfile(rt.config.home).includes('以后一律先运行测试再总结'), true)

  // 8. M4 workflow: adjacent context expansion, guard secret refusal, Dream dry-run & retire, and rollback
  emitSessionEvent(m3Session, {
    type: 'user/message',
    seq: 4,
    time: nowMs + 3000,
    surfaceOp: 'append',
    data: { id: 'u4', role: 'user', content: [{ type: 'text', text: '相邻上下文目标消息：确认发版窗口在周三。' }], source: { kind: 'user' } },
  })
  emitSessionEvent(m3Session, {
    type: 'assistant/message',
    seq: 8,
    time: nowMs + 4000,
    surfaceOp: 'append',
    data: { message: { id: 'a4', role: 'assistant', content: [{ type: 'text', text: '已确认周三下午 15:00 发版。' }], source: { kind: 'model' } } },
  })

  const ctxOut = await runTool('memory_read_context', { anchor: 'chat://2026-11-22#m3-session#4', before: 1, after: 1 }, 'm3-session')
  assert.equal(ctxOut.includes('以后一律先运行测试再总结'), true)
  assert.equal(ctxOut.includes('>>> [chat://2026-11-22#m3-session#4]'), true)
  assert.equal(ctxOut.includes('周三下午 15:00 发版'), true)

  const searchCtxOut = await runTool('memory_search', { query: '发版窗口', contextTurns: 1 }, 'm3-session')
  assert.equal(searchCtxOut.includes('周三下午 15:00 发版'), true)

  const secretBlocked = await runTool('memory_buffer_add', { content: 'token: sk-proj-abcdef1234567890abcdef', sourceType: 'explicit' }, 'm3-session')
  assert.equal(secretBlocked.includes('SECRET_DETECTED'), true)

  const addedTemp = await runTool('memory_buffer_add', {
    content: '本周临时值班规则',
    sourceType: 'explicit',
    section: '长期规矩与边界',
    expires: '2026-11-20',
  }, 'm3-session')
  assert.equal(addedTemp.includes('Buffered item'), true)
  const tempBufId = rt.bufferApi.listItems({ statuses: ['pending'] }).find(i => i.content === '本周临时值班规则').id
  await runTool('memory_buffer_manage', { action: 'approve', ids: [tempBufId], settleNow: true }, 'm3-session')
  const tempEntry = rt.profileApi.parseProfileEntries(rt.profileApi.readProfile(rt.config.home)).find(e => e.content === '本周临时值班规则')
  assert.ok(tempEntry)

  const dreamOut = await runTool('memory_dream_now', { dryRun: false, useLlm: false }, 'm3-session')
  assert.equal(dreamOut.includes('Dream completed'), true)
  assert.equal(dreamOut.includes('到期淘汰'), true)

  const dreamItem = rt.bufferApi.listItems({ statuses: ['pending'] }).find(i => i.source_type === 'dream' && i.supersedes_id === tempEntry.id)
  assert.ok(dreamItem)
  await runTool('memory_buffer_manage', { action: 'approve', ids: [dreamItem.id], settleNow: true }, 'm3-session')
  assert.equal(rt.profileApi.readProfile(rt.config.home).includes('本周临时值班规则'), false)

  const rollbackOut = await runTool('memory_rollback', { entryId: tempEntry.id }, 'm3-session')
  assert.equal(rollbackOut.includes(`Rolled back profile entry ${tempEntry.id}`), true)
  assert.equal(rt.profileApi.readProfile(rt.config.home).includes('本周临时值班规则'), true)

  // 9. M5 workflow: memory_lesson_manage CRUD, lesson buffer target settlement, forget redaction
  const lesUpsert = await runTool('memory_lesson_manage', {
    action: 'upsert',
    name: 'Windows 测试脚本',
    tags: ['windows', 'sqlite'],
    triggers: ['node --test', 'EPERM'],
    content: '清理临时目录前必须先调用 store.close()',
  }, 'm3-session')
  assert.equal(lesUpsert.includes('Updated lesson'), true)

  const lesList = await runTool('memory_lesson_manage', { action: 'list' }, 'm3-session')
  assert.equal(lesList.includes('Windows 测试脚本'), true)

  const bufLes = await runTool('memory_buffer_add', {
    target: 'lesson:Windows 测试脚本',
    sourceType: 'explicit',
    tags: ['e2e'],
    triggers: ['rmSync'],
    content: '使用 rmSync 时设置 maxRetries: 5',
  }, 'm3-session')
  assert.equal(bufLes.includes('target=lesson:Windows 测试脚本'), true)

  const lesBufId = rt.bufferApi.listItems({ statuses: ['pending'] }).find(i => i.target === 'lesson:Windows 测试脚本').id
  const lesSettled = await runTool('memory_buffer_manage', {
    action: 'approve',
    ids: [lesBufId],
    settleNow: true,
  }, 'm3-session')
  assert.equal(lesSettled.includes('Immediate settlement committed 1 item(s)'), true)
  assert.equal(rt.lessonApi.readLesson(rt.config.home, 'Windows 测试脚本').entries.some(e => e.content.includes('maxRetries: 5')), true)

  const lesRead = await runTool('memory_lesson_manage', { action: 'read', name: 'Windows 测试脚本' }, 'm3-session')
  assert.equal(lesRead.includes('store.close()'), true)
})

test('memory_search searches entities/ and lessons/ bodies with AND priority, OR fallback, and Card Matches grouping', async (t) => {
  const nowMs = Date.parse('2026-11-24T10:00:00+08:00')
  const clock = { now: () => nowMs }
  const { rt, emitSessionEvent, runTool } = createE2eHarness(t, clock)

  emitSessionEvent({ id: 'main', header: { id: 'main' } }, {
    type: 'user/message',
    seq: 1,
    time: nowMs,
    surfaceOp: 'append',
    data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '今日同步了例行巡检计划。' }], source: { kind: 'user' } },
  })
  await rt.journalApi.writeJournalAtomic(rt.config.home, '2026-11-23', '# 2026-11-23 日报\n## 发生了什么\n- 例行巡检记录。\n')

  await rt.entityApi.upsertEntity(rt.config.home, {
    name: '数据库主机',
    type: 'server',
    aliases: ['ProdDB'],
    content: 'PostgreSQL 端口 15432，主备同步。',
    added: '2026-11-24',
    source: 'manual',
  })
  await rt.lessonApi.upsertLesson(rt.config.home, {
    name: '代理排障',
    tags: ['proxy'],
    triggers: ['gateway'],
    content: '遇到 ECONNREFUSED 时核对端口 15432 配置。',
    added: '2026-11-24',
    source: 'manual',
  })

  // Single-term card-body match returns both entity and lesson under Card Matches
  const portSearch = await runTool('memory_search', { query: '15432' })
  assert.equal(portSearch.includes('### Card Matches'), true)
  assert.equal(portSearch.includes('[entity:数据库主机'), true)
  assert.equal(portSearch.includes('[lesson:代理排障'), true)

  // Card-only match works even when archive and journals have 0 hits
  const errSearch = await runTool('memory_search', { query: 'ECONNREFUSED' })
  assert.equal(errSearch.includes('### Card Matches'), true)
  assert.equal(errSearch.includes('[lesson:代理排障'), true)
  assert.equal(errSearch.includes('### Journal Matches'), false)
  assert.equal(errSearch.includes('### Archive Matches'), false)

  // Strict AND across header + body filters out partial match on other card
  const strictAnd = await runTool('memory_search', { query: 'ProdDB 15432' })
  assert.equal(strictAnd.includes('[entity:数据库主机'), true)
  assert.equal(strictAnd.includes('[lesson:代理排障'), false)

  // Multi-term OR coverage fallback ranks 2-term lesson match above 1-term entity match
  const orSearch = await runTool('memory_search', { query: 'ECONNREFUSED 15432 不存在词' })
  const lesIdx = orSearch.indexOf('[lesson:代理排障')
  const entIdx = orSearch.indexOf('[entity:数据库主机')
  assert.equal(lesIdx !== -1 && entIdx !== -1 && lesIdx < entIdx, true)

  // Empty-query browse by date skips cards
  const browseOut = await runTool('memory_search', { dateFrom: '2026-11-24', dateTo: '2026-11-24' })
  assert.equal(browseOut.includes('### Archive Matches'), true)
  assert.equal(browseOut.includes('### Card Matches'), false)

  // Redacting card body via memory_forget removes it from memory_search
  await runTool('memory_forget', { keyword: 'ECONNREFUSED' })
  const afterForget = await runTool('memory_search', { query: 'ECONNREFUSED' })
  assert.equal(afterForget.includes('No memory matches found'), true)
})

test('subagent sessions enforce read-only boundary across all 15 memory_* tools', async (t) => {
  const nowMs = Date.parse('2026-11-24T11:00:00+08:00')
  const clock = { now: () => nowMs }
  const { rt, emitSessionEvent, runTool } = createE2eHarness(t, clock)

  const mainSession = { id: 'main', header: { id: 'main' } }
  emitSessionEvent(mainSession, {
    type: 'user/message',
    seq: 1,
    time: nowMs,
    surfaceOp: 'append',
    data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '核心数据库端口 15432 用于只读验收。' }], source: { kind: 'user' } },
  })
  await rt.journalApi.writeJournalAtomic(rt.config.home, '2026-11-23', '# 2026-11-23 日报\n## 发生了什么\n- [chat://2026-11-23#main#1] 初始化测试日记。\n')
  await rt.historyApi.rebuildAllHistory()
  await rt.entityApi.upsertEntity(rt.config.home, {
    name: 'ProdDB',
    type: 'server',
    aliases: ['主库'],
    content: 'PostgreSQL 端口 15432',
    added: '2026-11-24',
    source: 'manual',
  })
  await rt.lessonApi.upsertLesson(rt.config.home, {
    name: '代理排障',
    tags: ['proxy'],
    triggers: ['502'],
    content: '检查端口 15432 是否开启',
    added: '2026-11-24',
    source: 'manual',
  })
  const addedProf = await rt.profileApi.applyProfileMutation(rt.config.home, {
    op: 'add',
    section: '长期规矩与边界',
    content: '保留旧规则用于回滚基线',
    added: '2026-11-23',
    source: 'manual',
  })
  await rt.profileApi.applyProfileMutation(rt.config.home, {
    op: 'retire',
    targetId: addedProf.id,
    nowIso: '2026-11-24T00:00:00.000Z',
  })
  const bufItem = await rt.bufferApi.appendCreate({
    logicalDate: '2026-11-24',
    sourceType: 'extracted',
    target: 'profile',
    content: '主会话待审核条目',
  })

  const subSid = 'sub-readonly-1'
  const subHeader = { id: subSid, origin: 'subagent', parentSession: 'main' }

  // 1. All 6 read-only tool operations succeed in subagent sessions
  const searchRes = await runTool('memory_search', { query: '15432' }, subSid, subHeader)
  assert.equal(searchRes.includes('### Card Matches'), true)
  assert.equal(searchRes.includes('### Archive Matches'), true)

  const ctxRes = await runTool('memory_read_context', { anchor: 'chat://2026-11-24#main#1' }, subSid, subHeader)
  assert.equal(ctxRes.includes('核心数据库端口 15432'), true)

  const jrListRes = await runTool('memory_journal_read', {}, subSid, subHeader)
  assert.equal(jrListRes.includes('2026-11-23'), true)
  const jrReadRes = await runTool('memory_journal_read', { date: '2026-11-23' }, subSid, subHeader)
  assert.equal(jrReadRes.includes('初始化测试日记'), true)

  const histListRes = await runTool('memory_history_browse', { action: 'list' }, subSid, subHeader)
  assert.equal(histListRes.includes('2026-11'), true)
  const histReadRes = await runTool('memory_history_browse', { action: 'read', month: '2026-11' }, subSid, subHeader)
  assert.equal(histReadRes.includes('2026-11 History'), true)

  const entListRes = await runTool('memory_entity_manage', { action: 'list' }, subSid, subHeader)
  assert.equal(entListRes.includes('ProdDB'), true)
  const entReadRes = await runTool('memory_entity_manage', { action: 'read', name: 'ProdDB' }, subSid, subHeader)
  assert.equal(entReadRes.includes('15432'), true)

  const lesListRes = await runTool('memory_lesson_manage', { action: 'list' }, subSid, subHeader)
  assert.equal(lesListRes.includes('代理排障'), true)
  const lesReadRes = await runTool('memory_lesson_manage', { action: 'read', name: '代理排障' }, subSid, subHeader)
  assert.equal(lesReadRes.includes('15432'), true)

  // 2. All write/delete/admin tool operations return Refused and leave state untouched
  const refusedCalls = [
    ['memory_forget', { keyword: '15432' }],
    ['memory_buffer_add', { content: 'subagent 试图写入', sourceType: 'explicit' }],
    ['memory_buffer_manage', { action: 'list' }],
    ['memory_buffer_manage', { action: 'approve', ids: [bufItem.id], settleNow: true }],
    ['memory_buffer_manage', { action: 'reject', ids: [bufItem.id] }],
    ['memory_mode_set', { mode: 'off', scope: 'session' }],
    ['memory_mode_set', { mode: 'off', scope: 'global' }],
    ['memory_digest_now', { date: '2026-11-24' }],
    ['memory_onboarding', { action: 'status' }],
    ['memory_onboarding', { action: 'submit', identity: 'hijack' }],
    ['memory_onboarding', { action: 'skip' }],
    ['memory_onboarding', { action: 'reset' }],
    ['memory_briefing', { action: 'get' }],
    ['memory_briefing', { action: 'confirm', approveIds: [bufItem.id] }],
    ['memory_briefing', { action: 'dismiss' }],
    ['memory_dream_now', { dryRun: true }],
    ['memory_dream_now', { dryRun: false }],
    ['memory_rollback', { entryId: addedProf.id }],
    ['memory_history_browse', { action: 'rebuild' }],
    ['memory_entity_manage', { action: 'upsert', name: 'ProdDB', content: 'tampered' }],
    ['memory_entity_manage', { action: 'delete', name: 'ProdDB', force: true }],
    ['memory_lesson_manage', { action: 'upsert', name: '代理排障', content: 'tampered' }],
    ['memory_lesson_manage', { action: 'delete', name: '代理排障', force: true }],
  ]

  for (const [toolName, args] of refusedCalls) {
    const out = await runTool(toolName, args, subSid, subHeader)
    assert.equal(out.startsWith('Refused:'), true, `${toolName}(${JSON.stringify(args)}) should be refused in subagent, got: ${out}`)
  }

  // Verify zero mutations occurred
  assert.equal(rt.store.getMessagesForDate('2026-11-24').length, 1)
  assert.equal(rt.bufferApi.listItems({ logicalDate: '2026-11-24' }).length, 1)
  assert.equal(rt.bufferApi.listItems({ logicalDate: '2026-11-24' })[0].status, 'pending')
  assert.equal(rt.config.defaultMode, 'full')
  assert.equal(rt.store.getSessionState(subSid)?.memoryMode, undefined)
  assert.equal(rt.entityApi.readEntity(rt.config.home, 'ProdDB').facts.length, 1)
  assert.equal(rt.lessonApi.readLesson(rt.config.home, '代理排障').entries.length, 1)
  assert.equal(rt.profileApi.readProfile(rt.config.home).includes('保留旧规则'), false)
  assert.equal(rt.journalApi.readJournal(rt.config.home, '2026-11-24'), '')
  assert.equal(rt.briefingApi.shouldDeliverToday(), true)
})
