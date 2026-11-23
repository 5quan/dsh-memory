import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBufferApi } from '../src/buffer.js'
import { normalizeConfig } from '../src/config.js'
import { createDigestApi } from '../src/digest.js'
import * as journalApi from '../src/journal.js'
import * as profileApi from '../src/profile.js'
import { createRolloverApi } from '../src/rollover.js'
import { createMemoryStore } from '../src/store.js'

function mockLlmCtx(handler) {
  const emitted = []
  return {
    emitted,
    emit(name, payload) {
      emitted.push({ name, payload })
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'mock', model: 'mock-flash' }),
    },
    llm: {
      async* stream(request) {
        const text = await handler(request)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}

test('rollover respects dayStartHour & idleMinutes, retries failures, runs startup catch-up, and is idempotent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-rollover-'))
  let nowMs = Date.parse('2026-11-21T01:55:00+08:00')
  const clock = { now: () => nowMs }
  const config = normalizeConfig({
    home: dir,
    timeZone: 'Asia/Shanghai',
    dayStartHour: 2,
    idleMinutes: 30,
  })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  let failOnce = true
  let llmCalls = 0
  const ctx = mockLlmCtx(async () => {
    llmCalls += 1
    if (failOnce) {
      failOnce = false
      throw new Error('temporary network failure')
    }
    return `# 2026-11-20 日报\n\n## 发生了什么\n- [chat://2026-11-20#main#1] 讨论了按日切分逻辑。\n\n## 做出的决定\n- （无）\n\n## 新建/变更的事项\n- （无）\n\n## 纠正与教训\n- （无）\n\n## 悬而未决的问题\n- （无）\n\n## 提到的实体\n- dsh-memory`
  })

  const bufferApi = createBufferApi({ home: dir, clock })
  const digestApi = createDigestApi({ ctx, config, store, bufferApi, profileApi, journalApi, clock })
  const hookEvents = []
  const rolloverApi = createRolloverApi({
    ctx,
    config,
    store,
    digestApi,
    clock,
    onRollover: evt => hookEvents.push(evt),
  })

  // Chat at 01:55 on 2026-11-21 belongs to logical date 2026-11-20
  store.insertMessage({
    sessionId: 'main',
    logicalDate: '2026-11-20',
    seq: 1,
    role: 'user',
    text: '深夜讨论切日逻辑',
    timestamp: nowMs,
    anchor: 'chat://2026-11-20#main#1',
  })
  rolloverApi.touchActivity(nowMs)

  // At 01:55 logical date is still 2026-11-20 -> no rollover
  const r1 = await rolloverApi.checkAndRollover({ isStartup: false })
  assert.deepEqual(r1.rolledOver, [])
  assert.equal(llmCalls, 0)

  // At 02:10 logical date is 2026-11-21, but idle is only 15m (< 30m) -> waitingIdle
  nowMs = Date.parse('2026-11-21T02:10:00+08:00')
  const r2 = await rolloverApi.checkAndRollover({ isStartup: false })
  assert.equal(r2.waitingIdle, true)
  assert.equal(llmCalls, 0)

  // At 02:35 idle is 40m (>= 30m) -> first attempt fails and records failed state
  nowMs = Date.parse('2026-11-21T02:35:00+08:00')
  const r3 = await rolloverApi.checkAndRollover({ isStartup: false })
  assert.equal(r3.failed.length, 1)
  assert.equal(store.getRolloverState('2026-11-20').status, 'failed')
  assert.equal(journalApi.readJournal(dir, '2026-11-20'), '')

  // Retry succeeds (or startup catch-up)
  const r4 = await rolloverApi.checkAndRollover({ isStartup: false })
  assert.equal(r4.rolledOver.length, 1)
  assert.equal(r4.rolledOver[0].date, '2026-11-20')
  assert.equal(store.getRolloverState('2026-11-20').status, 'done')
  assert.equal(hookEvents.length, 1)
  assert.equal(ctx.emitted[0].name, 'dsh-memory/day-rolled-over')

  // Idempotent on repeat
  const r5 = await rolloverApi.checkAndRollover({ isStartup: true })
  assert.deepEqual(r5.rolledOver, [])
  assert.equal(llmCalls, 2)

  // Startup catch-up ignores idle wait for missed day
  store.insertMessage({
    sessionId: 'main',
    logicalDate: '2026-11-19',
    seq: 9,
    role: 'user',
    text: '前天遗漏的消息',
    timestamp: Date.parse('2026-11-19T12:00:00+08:00'),
    anchor: 'chat://2026-11-19#main#9',
  })
  rolloverApi.touchActivity(nowMs)
  const r6 = await rolloverApi.checkAndRollover({ isStartup: true })
  assert.equal(r6.rolledOver[0].date, '2026-11-19')
})

test('digest chunks long transcripts (map-reduce), strips fabricated anchors, closes notes, and supports force rebuild', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-digest-'))
  const clock = { now: () => Date.parse('2026-11-22T03:00:00+08:00') }
  const config = normalizeConfig({
    home: dir,
    timeZone: 'Asia/Shanghai',
    digest: { maxChunkTokens: 40 },
  })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  for (let i = 1; i <= 4; i += 1) {
    store.insertMessage({
      sessionId: 'main',
      logicalDate: '2026-11-21',
      seq: i,
      role: i % 2 === 1 ? 'user' : 'assistant',
      text: `第 ${i} 条相当长的对话内容，用于触发日内分块抽取功能并且验证真实锚点保留。`,
      timestamp: Date.parse('2026-11-21T10:00:00+08:00') + i * 1000,
      anchor: `chat://2026-11-21#main#${i}`,
    })
  }

  const bufferApi = createBufferApi({ home: dir, clock })
  const noteItem = await bufferApi.appendCreate({
    logicalDate: '2026-11-21',
    sourceType: 'explicit',
    target: 'note',
    content: '今天确定周五发版',
  })

  const prompts = []
  const ctx = mockLlmCtx(async (req) => {
    prompts.push(req.messages[0].content[0].text)
    if (req.system.includes('对话切片')) {
      return '- [chat://2026-11-21#main#1] 分块要点'
    }
    return [
      '# 2026-11-21 日报',
      '## 发生了什么',
      '- [chat://2026-11-21#main#1] 真实锚点记录',
      '- [chat://2026-11-21#main#999] 幻觉编造锚点记录',
      '- [chat://2026-11-20#main#1] 跨日错误锚点记录',
      '- 周五发版备忘已整合',
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
  })

  const digestApi = createDigestApi({ ctx, config, store, bufferApi, profileApi, journalApi, clock })
  const res = await digestApi.generateDailyDigest('2026-11-21')

  // Strict Cordis ctx test: direct property access throws, only ctx.get('agentDefaultModel') works
  const strictCtx = {
    get agentDefaultModel() { throw new Error('cannot access un-injected service directly') },
    get agents() { throw new Error('cannot access un-injected service directly') },
    get: name => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'strict-p', model: 'strict-m' }) } : undefined),
  }
  const strictDigest = createDigestApi({ ctx: strictCtx, config, store, bufferApi, profileApi, journalApi, clock })
  assert.deepEqual(strictDigest.resolveModelSelection(), { provider: 'strict-p', model: 'strict-m' })

  assert.equal(res.chunks > 1, true)
  assert.equal(prompts.length, res.chunks + 1)
  assert.deepEqual(res.unverifiedAnchors, ['chat://2026-11-21#main#999', 'chat://2026-11-20#main#1'])
  assert.deepEqual(res.closedNotes, [noteItem.id])

  const journalText = journalApi.readJournal(dir, '2026-11-21')
  assert.equal(journalText.includes('[chat://2026-11-21#main#1]'), true)
  assert.equal(journalText.includes('main#999'), false)
  assert.equal(journalText.includes('[unverified] 幻觉编造锚点记录'), true)
  assert.equal(journalText.includes('[unverified] 跨日错误锚点记录'), true)

  const closedNote = bufferApi.listItems({ logicalDate: '2026-11-21' }).find(i => i.id === noteItem.id)
  assert.equal(closedNote.status, 'committed')

  // Does not overwrite without force, overwrites with force: true
  const skipped = await digestApi.generateDailyDigest('2026-11-21')
  assert.equal(skipped.skipped, true)
  const rebuilt = await digestApi.generateDailyDigest('2026-11-21', { force: true })
  assert.equal(rebuilt.skipped, false)
})
