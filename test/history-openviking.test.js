import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBufferApi } from '../src/buffer.js'
import { normalizeConfig } from '../src/config.js'
import { createContextApi } from '../src/context.js'
import { createHistoryApi, rebuildGlobalAbstract } from '../src/history.js'
import * as journalApi from '../src/journal.js'
import * as profileApi from '../src/profile.js'
import { createMemoryStore } from '../src/store.js'
import { createToolsApi } from '../src/tools.js'

function createHistoryCtx(handler) {
  const registered = new Map()
  return {
    registered,
    effect(fn) {
      return fn()
    },
    systemPrompt: {
      section() { return () => {} },
    },
    on() { return () => {} },
    tools: {
      register(def) {
        registered.set(def.name, def)
        return () => registered.delete(def.name)
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
        const text = await handler(request)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}

test('OpenViking history layer builds single-hop L0/L1, validates anchors, budgets global L0, and supports lossless rebuild', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-hist-'))
  const clock = { now: () => Date.parse('2026-12-01T10:00:00+08:00') }
  const config = normalizeConfig({
    home: dir,
    timeZone: 'Asia/Shanghai',
    sections: {
      historyOverview: { enabled: true, maxTokens: 45 },
    },
  })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  // Populate archive anchors across two months
  store.insertMessage({
    sessionId: 'main',
    logicalDate: '2026-10-05',
    seq: 1,
    role: 'user',
    text: '决定使用 PostgreSQL 作为主库',
    timestamp: Date.parse('2026-10-05T10:00:00+08:00'),
    anchor: 'chat://2026-10-05#main#1',
  })
  store.insertMessage({
    sessionId: 'main',
    logicalDate: '2026-11-02',
    seq: 4,
    role: 'user',
    text: '启动 M2 记忆层开发',
    timestamp: Date.parse('2026-11-02T10:00:00+08:00'),
    anchor: 'chat://2026-11-02#main#4',
  })

  await journalApi.writeJournalAtomic(dir, '2026-10-05', '# 2026-10-05 日报\n## 做出的决定\n- [chat://2026-10-05#main#1] 选型 PostgreSQL\n')
  await journalApi.writeJournalAtomic(dir, '2026-11-02', '# 2026-11-02 日报\n## 发生了什么\n- [chat://2026-11-02#main#4] 启动 M2 开发\n')

  const ctx = createHistoryCtx(async (req) => {
    const prompt = req.messages[0].content[0].text
    if (prompt.includes('2026-10')) {
      return [
        '===L0_ABSTRACT===',
        '十月确定了数据库选型并搭好基础设施骨架，同时补充了若干环境调试细节。',
        '===L1_OVERVIEW===',
        '# 2026-10 月度概览',
        '',
        '## 关键决策',
        '- [2026-10-05] [chat://2026-10-05#main#1] 选型 PostgreSQL',
        '- [2026-10-05] [chat://2026-10-05#main#999] 幻觉锚点',
        '- [2026-10-05] [chat://2026-11-02#main#4] 跨月错放锚点',
      ].join('\n')
    }
    return [
      '===L0_ABSTRACT===',
      '十一月启动了 M2 历史与实体档案系统研发。',
      '===L1_OVERVIEW===',
      '# 2026-11 月度概览',
      '',
      '## 核心事件索引',
      '- [2026-11-02] [chat://2026-11-02#main#4] 启动 M2 开发',
    ].join('\n')
  })

  const bufferApi = createBufferApi({ home: dir, clock })
  const historyApi = createHistoryApi({ ctx, config, store, journalApi })
  const contextApi = createContextApi({ ctx, config, store, profileApi, journalApi, bufferApi, clock })

  // Graceful degradation before history/ exists
  const beforePrompt = contextApi.sectionFor('s1')
  assert.equal(beforePrompt.includes('历史总览地图'), false)

  // Full rebuild creates L0 + L1 and validates anchors per month
  const rebuilt = await historyApi.rebuildAllHistory()
  assert.equal(rebuilt.months.length, 2)

  const oct = historyApi.readHistory({ month: '2026-10', level: 'L1' })
  assert.equal(oct.overview.includes('[chat://2026-10-05#main#1]'), true)
  assert.equal(oct.overview.includes('main#999'), false)
  assert.equal(oct.overview.includes('2026-11-02#main#4'), false)
  assert.equal(oct.overview.includes('[unverified] 幻觉锚点'), true)
  assert.equal(oct.overview.includes('[unverified] 跨月错放锚点'), true)
  assert.deepEqual(oct.journalDates, ['2026-10-05'])

  // Global L0 honors maxTokens budget (keeps newest month 2026-11 and drops older 2026-10)
  const globalData = historyApi.readHistory()
  assert.equal(globalData.global.includes('2026-11'), true)
  assert.equal(globalData.global.includes('2026-10'), false)

  // Frozen prompt picks up history/.abstract.md once present (with larger budget)
  const wideGlobal = await rebuildGlobalAbstract(dir, { maxTokens: 1000 })
  assert.equal(wideGlobal.months.length, 2)
  contextApi.invalidateSnapshots()
  const afterPrompt = contextApi.sectionFor('s1')
  assert.equal(afterPrompt.includes('## 历史总览地图'), true)
  assert.equal(afterPrompt.includes('2026-11'), true)

  // Delete history/ completely and rebuild cleanly from journals/
  rmSync(join(dir, 'history'), { recursive: true, force: true })
  assert.equal(historyApi.listHistoryMonths().length, 0)

  const toolsApi = createToolsApi({
    ctx,
    config,
    store,
    bufferApi,
    journalApi,
    digestApi: {},
    contextApi,
    historyApi,
    clock,
  })
  toolsApi.install()
  const browseTool = ctx.registered.get('memory_history_browse')

  const rebuildMsg = await browseTool.execute({ action: 'rebuild' }, { agent: { id: 's1' }, signal: new AbortController().signal })
  assert.equal(rebuildMsg.includes('Rebuilt history index for 2 month(s)'), true)

  const listMsg = await browseTool.execute({ action: 'list' }, { agent: { id: 's1' }, signal: new AbortController().signal })
  assert.equal(listMsg.includes('2026-11'), true)

  const readL1 = await browseTool.execute({ action: 'read', month: '2026-11', level: 'L1' }, { agent: { id: 's1' }, signal: new AbortController().signal })
  assert.equal(readL1.includes('L2 daily journals in 2026-11: 2026-11-02'), true)
})
