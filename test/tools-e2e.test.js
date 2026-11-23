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
  const runTool = async (name, args, sessionId = 'main') => {
    const tool = tools.get(name)
    assert.ok(tool, `tool ${name} should be registered`)
    return await tool.execute(args, { agent: { id: sessionId }, signal: new AbortController().signal })
  }

  return { home, rt, tools, promptSections, emitSessionEvent, runTool }
}

test('E2E workflow across all 14 M1-M4 tools including context expansion, guard, dream, rollback, onboarding, briefing, correction, buffer, digest, history, entities, search, mode switch, and forget', async (t) => {
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
})
