import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBufferApi } from '../src/buffer.js'
import { normalizeConfig } from '../src/config.js'
import * as profileApi from '../src/profile.js'
import { createMemoryStore } from '../src/store.js'

function setupEnv(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-buf-'))
  const config = normalizeConfig({ home: dir, ...overrides })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  const clock = { now: () => Date.parse('2026-11-22T12:00:00.000Z') }
  const bufferApi = createBufferApi({ home: dir, clock })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  return { dir, config, store, bufferApi, clock }
}

test('buffer appends concurrently per logical day and folds create/status events', async (t) => {
  const { dir, bufferApi } = setupEnv(t)

  const created = await Promise.all([
    bufferApi.appendCreate({ logicalDate: '2026-11-21', sourceType: 'explicit', target: 'profile', content: '习惯用 pnpm' }),
    bufferApi.appendCreate({ logicalDate: '2026-11-22', sourceType: 'correction', target: 'note', content: '明天下午检查日志' }),
    bufferApi.appendCreate({ logicalDate: '2026-11-22', sourceType: 'extracted', target: 'entity:老王', content: '负责运维生产库' }),
  ])

  assert.equal(created.length, 3)
  await bufferApi.updateStatuses([created[1].id], 'approved', { by: 'user', reason: 'checked' })

  const all = bufferApi.listItems()
  assert.equal(all.length, 3)
  assert.equal(all.find(i => i.id === created[0].id).status, 'pending')
  assert.equal(all.find(i => i.id === created[1].id).status, 'approved')
  assert.equal(all.find(i => i.id === created[2].id).target, 'entity:老王')

  const day22Raw = readFileSync(join(dir, 'buffer', '2026-11-22.jsonl'), 'utf8')
  const events = day22Raw.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(events.length, 3)
  assert.equal(events[2].event, 'status')
  assert.equal(events[2].status, 'approved')
})

test('buffer blocks spoofed explicit anchor, enforces overwrite confirmation, and refuses profile overflow', async (t) => {
  const { dir, config, store, bufferApi } = setupEnv(t, {
    sections: { profile: { enabled: true, maxTokens: 90 } },
  })

  // Real user message and assistant message
  store.insertMessage({
    sessionId: 'main',
    logicalDate: '2026-11-22',
    seq: 1,
    role: 'user',
    text: '记住：汇报先说结论',
    timestamp: 1000,
    anchor: 'chat://2026-11-22#main#1',
  })
  store.insertMessage({
    sessionId: 'main',
    logicalDate: '2026-11-22',
    seq: 2,
    role: 'assistant',
    text: '好的',
    timestamp: 2000,
    anchor: 'chat://2026-11-22#main#2',
  })

  const validExplicit = await bufferApi.appendCreate({
    logicalDate: '2026-11-22',
    sourceType: 'explicit',
    target: 'profile',
    section: '沟通偏好',
    content: '汇报先说结论',
    anchor: 'chat://2026-11-22#main#1',
    pinned: true,
  })
  const spoofedExplicit = await bufferApi.appendCreate({
    logicalDate: '2026-11-22',
    sourceType: 'explicit',
    target: 'profile',
    content: '试图用助手消息冒充 explicit',
    anchor: 'chat://2026-11-22#main#2',
  })

  const settled1 = await bufferApi.settleProfileForDate({
    logicalDate: '2026-11-22',
    store,
    profileApi,
    config,
  })

  assert.deepEqual(settled1.committed, [validExplicit.id])
  assert.deepEqual(settled1.deferred, [spoofedExplicit.id])
  assert.equal(settled1.warnings[0].reason, 'EXPLICIT_ANCHOR_INVALID')

  const downgraded = bufferApi.listItems({ logicalDate: '2026-11-22' }).find(i => i.id === spoofedExplicit.id)
  assert.equal(downgraded.source_type, 'extracted')
  assert.equal(downgraded.status, 'pending')

  // Pinned protection against automated replace
  const profEntries = profileApi.parseProfileEntries(profileApi.readProfile(dir))
  assert.equal(profEntries.length, 1)
  assert.equal(profEntries[0].pinned, true)

  const pinnedMutation = await profileApi.applyProfileMutation(dir, {
    op: 'replace',
    targetId: profEntries[0].id,
    content: '被强行修改',
  })
  assert.equal(pinnedMutation.ok, false)
  assert.equal(pinnedMutation.reason, 'PINNED_PROTECTED')

  // Overwrite requires explicit approval
  const overwriteItem = await bufferApi.appendCreate({
    logicalDate: '2026-11-22',
    sourceType: 'explicit',
    target: 'profile',
    op: 'replace',
    supersedesId: profEntries[0].id,
    content: '更新后的规则',
    anchor: 'chat://2026-11-22#main#1',
  })
  const settled2 = await bufferApi.settleProfileForDate({
    logicalDate: '2026-11-22',
    store,
    profileApi,
    config,
  })
  assert.deepEqual(settled2.deferred.includes(overwriteItem.id), true)

  // Budget overflow refuses auto-commit rather than truncating PROFILE.md
  const bigItem = await bufferApi.appendCreate({
    logicalDate: '2026-11-22',
    sourceType: 'explicit',
    target: 'profile',
    content: '这是一段很长很长会导致核心画像超过 90 token 预算限制的测试文本内容，必须被安全拒绝而不是截断已有规则。'.repeat(3),
    anchor: 'chat://2026-11-22#main#1',
  })
  const settled3 = await bufferApi.settleProfileForDate({
    logicalDate: '2026-11-22',
    store,
    profileApi,
    config,
  })
  const overflowWarn = settled3.warnings.find(w => w.id === bigItem.id)
  assert.equal(overflowWarn.reason, 'PROFILE_BUDGET_EXCEEDED')
  assert.equal(profileApi.readProfile(dir).includes('这是一段很长很长'), false)
})
