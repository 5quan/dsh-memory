import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMemoryStore } from '../src/store.js'

function openTempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-store-'))
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  return store
}

test('store creates tables, prevents duplicate seqs, and searches Chinese trigram + short LIKE terms', (t) => {
  const store = openTempStore(t)

  const first = store.insertMessage({
    scope: 'default',
    sessionId: 'main',
    logicalDate: '2026-11-21',
    seq: 1,
    role: 'user',
    text: '请把老王的服务器部署脚本改成先备份数据库。',
    timestamp: 1000,
    anchor: 'chat://2026-11-21#main#1',
  })
  assert.equal(first.inserted, true)

  const dup = store.insertMessage({
    scope: 'default',
    sessionId: 'main',
    logicalDate: '2026-11-21',
    seq: 1,
    role: 'user',
    text: 'duplicate should be ignored',
    timestamp: 1001,
    anchor: 'chat://2026-11-21#main#1',
  })
  assert.equal(dup.inserted, false)

  store.insertMessage({
    scope: 'default',
    sessionId: 'main',
    logicalDate: '2026-11-22',
    seq: 2,
    role: 'assistant',
    text: '好的，已经记录部署规范并通知老王检查 AI 网关。',
    timestamp: 2000,
    anchor: 'chat://2026-11-22#main#2',
  })

  // 3+ char Chinese trigram search
  const trigramHits = store.searchMessages({ query: '备份数据库' })
  assert.equal(trigramHits.length, 1)
  assert.equal(trigramHits[0].anchor, 'chat://2026-11-21#main#1')

  // Short term (<3 chars) LIKE fallback combined with trigram
  const mixedHits = store.searchMessages({ query: '老王 AI' })
  assert.equal(mixedHits.length, 1)
  assert.equal(mixedHits[0].anchor, 'chat://2026-11-22#main#2')

  // Date range filter
  const dateHits = store.searchMessages({ query: '老王', dateFrom: '2026-11-22', dateTo: '2026-11-22' })
  assert.equal(dateHits.length, 1)
  assert.equal(dateHits[0].logical_date, '2026-11-22')

  // Anchor validation
  assert.equal(store.hasAnchorForDate('chat://2026-11-21#main#1', '2026-11-21'), true)
  assert.equal(store.hasAnchorForDate('chat://2026-11-21#main#1', '2026-11-22'), false)
  assert.equal(store.hasAnchorForDate('chat://2026-11-21#main#999', '2026-11-21'), false)

  // Latest user message ignores assistant messages
  const latestUser = store.getLatestUserMessage('main')
  assert.equal(latestUser.anchor, 'chat://2026-11-21#main#1')
})

test('deleteMessages removes rows physically and keeps FTS5 trigram in sync', (t) => {
  const store = openTempStore(t)

  store.insertMessage({
    sessionId: 's1',
    logicalDate: '2026-11-22',
    seq: 1,
    role: 'user',
    text: '临时密钥配置测试内容 AlphaSecret',
    timestamp: 1000,
    anchor: 'chat://2026-11-22#s1#1',
  })
  store.insertMessage({
    sessionId: 's1',
    logicalDate: '2026-11-22',
    seq: 2,
    role: 'user',
    text: '普通会议纪要正常保留',
    timestamp: 2000,
    anchor: 'chat://2026-11-22#s1#2',
  })

  assert.equal(store.searchMessages({ query: 'AlphaSecret' }).length, 1)

  const deleted = store.deleteMessages({ anchor: 'chat://2026-11-22#s1#1' })
  assert.equal(deleted.deletedCount, 1)
  assert.deepEqual(deleted.deletedAnchors, ['chat://2026-11-22#s1#1'])
  assert.deepEqual(deleted.affectedDates, ['2026-11-22'])

  // Trigger keeps FTS5 clean
  assert.equal(store.searchMessages({ query: 'AlphaSecret' }).length, 0)
  assert.equal(store.searchMessages({ query: '会议纪要' }).length, 1)

  // rebuildFts stays healthy
  store.rebuildFts()
  assert.equal(store.searchMessages({ query: '会议纪要' }).length, 1)
})
