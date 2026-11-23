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

test('E2E workflow across all 9 M1+M2 tools including buffer, digest, history, entities, search, mode switch, and forget', async (t) => {
  let nowMs = Date.parse('2026-11-21T16:00:00+08:00')
  const clock = { now: () => nowMs }
  const { rt, tools, emitSessionEvent, runTool } = createE2eHarness(t, clock)

  assert.deepEqual([...tools.keys()].sort(), [
    'memory_buffer_add',
    'memory_buffer_manage',
    'memory_digest_now',
    'memory_entity_manage',
    'memory_forget',
    'memory_history_browse',
    'memory_journal_read',
    'memory_mode_set',
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

  // 4. Search archive + journal
  const searchOut = await runTool('memory_search', { query: 'TempSecretToken' })
  assert.equal(searchOut.includes('Journal Matches'), true)
  assert.equal(searchOut.includes('Archive Matches'), true)

  // 5. Forget TempSecretToken -> deletes archive + redacts journal, entity, and history + invalidates snapshot
  rt.contextApi.sectionFor('main')
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
})
