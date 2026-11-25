import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBufferApi } from '../src/buffer.js'
import { normalizeConfig } from '../src/config.js'
import { createContextApi } from '../src/context.js'
import * as entityApi from '../src/entities.js'
import { createHistoryApi } from '../src/history.js'
import * as journalApi from '../src/journal.js'
import * as profileApi from '../src/profile.js'
import { createMemoryStore } from '../src/store.js'
import { createToolsApi } from '../src/tools.js'

function mockCtx() {
  const preStepHandlers = []
  const registered = new Map()
  return {
    preStepHandlers,
    registered,
    effect(fn) { return fn() },
    systemPrompt: { section() { return () => {} } },
    on(eventName, fn) {
      if (eventName === 'agent/pre-step') preStepHandlers.push(fn)
      return () => {}
    },
    tools: {
      register(def) {
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
    },
  }
}

test('entity cards support CRUD, pinned protection, buffer settlement, and anti-spoofing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-ent-'))
  const clock = { now: () => Date.parse('2026-11-23T10:00:00+08:00') }
  const config = normalizeConfig({ home: dir, timeZone: 'Asia/Shanghai' })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  store.insertMessage({
    sessionId: 'main',
    logicalDate: '2026-11-23',
    seq: 1,
    role: 'user',
    text: '记住老王（LaoWang）负责生产数据库。',
    timestamp: clock.now(),
    anchor: 'chat://2026-11-23#main#1',
  })

  const bufferApi = createBufferApi({ home: dir, clock })
  const validEnt = await bufferApi.appendCreate({
    logicalDate: '2026-11-23',
    sourceType: 'explicit',
    target: 'entity:老王',
    content: '负责生产数据库与备份脚本',
    anchor: 'chat://2026-11-23#main#1',
    pinned: true,
  })
  const spoofedEnt = await bufferApi.appendCreate({
    logicalDate: '2026-11-23',
    sourceType: 'explicit',
    target: 'entity:老王',
    content: '伪造来源的实体信息',
    anchor: 'chat://2026-11-23#main#999',
  })

  const settled = await bufferApi.settleEntitiesForDate({
    logicalDate: '2026-11-23',
    store,
    entityApi,
    config,
  })
  assert.deepEqual(settled.committed, [validEnt.id])
  assert.deepEqual(settled.deferred, [spoofedEnt.id])
  assert.equal(settled.warnings[0].reason, 'EXPLICIT_ANCHOR_INVALID')

  // Add aliases & test pinned delete protection
  await entityApi.upsertEntity(dir, {
    name: '老王',
    type: 'person',
    aliases: ['王总', 'LaoWang', 'X', 'AI'],
  })
  const card = entityApi.readEntity(dir, '王总')
  assert.equal(card.name, '老王')
  assert.equal(card.facts.length, 1)
  assert.equal(card.facts[0].pinned, true)

  const delRefused = await entityApi.deleteEntity(dir, '老王')
  assert.equal(delRefused.ok, false)
  assert.equal(delRefused.reason, 'PINNED_PROTECTED')

  // Precise alias matching: short 1-char 'X' ignored, ASCII 'AI' does not match 'BRAID', 'LaoWang' case-insensitive
  assert.equal(entityApi.matchEntitiesInText(dir, 'X marks BRAID').length, 0)
  assert.equal(entityApi.matchEntitiesInText(dir, '问一下 laowang 备份状态').length, 1)
  assert.equal(entityApi.matchEntitiesInText(dir, '请找王总确认一下').length, 1)
  assert.equal(entityApi.matchEntitiesInText(dir, '这里使用 AI 网关').length, 1)
})

test('agent/pre-step injects matched entity cards once per session without breaking frozen prefix, resets on compaction, and syncs forget', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-ent-ctx-'))
  const clock = { now: () => Date.parse('2026-11-23T11:00:00+08:00') }
  const config = normalizeConfig({
    home: dir,
    timeZone: 'Asia/Shanghai',
    sections: { entities: { enabled: true, maxTokens: 90 } },
  })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  await entityApi.upsertEntity(dir, {
    name: '老王',
    type: 'person',
    aliases: ['王总', 'LaoWang'],
    content: '负责生产服务器机房 A 的运维工作',
    added: '2026-11-23',
    source: 'chat://2026-11-23#main#1',
  })
  await entityApi.upsertEntity(dir, {
    name: '网关项目',
    type: 'project',
    aliases: ['Gateway'],
    content: '基于 Node.js 的反向代理网关服务'.repeat(10),
    added: '2026-11-23',
    source: 'chat://2026-11-23#main#2',
  })

  const ctx = mockCtx()
  const bufferApi = createBufferApi({ home: dir, clock })
  const historyApi = createHistoryApi({ ctx, config, store, journalApi })
  const contextApi = createContextApi({ ctx, config, store, profileApi, journalApi, bufferApi, entityApi, clock })
  contextApi.install()

  const frozenBefore = contextApi.sectionFor('s1')
  const preStep = ctx.preStepHandlers[0]
  const fakeAgent = { id: 's1', session: { surface: { replaceGeneration: 0 } } }

  // Step 1: mention 老王 -> entity injected dynamically, frozen prefix untouched
  const s1 = await preStep(
    { agent: fakeAgent },
    async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '帮我问下王总昨晚备份情况' }], source: { kind: 'user' } }] }),
  )
  assert.equal(s1.messages.length, 2)
  assert.equal(s1.messages[0].source.kind, 'dsh-memory/delta')
  assert.equal(s1.messages[0].content[0].text.includes('## 命中实体档案（dsh-memory）'), true)
  assert.equal(s1.messages[0].content[0].text.includes('生产服务器机房 A'), true)
  assert.equal(contextApi.sectionFor('s1'), frozenBefore)

  // Step 2: mention LaoWang again in same session -> deduplicated, not injected again
  const s2 = await preStep(
    { agent: fakeAgent },
    async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '再给 laowang 发个提醒' }], source: { kind: 'user' } }] }),
  )
  assert.equal(s2.messages.length, 1)

  // Step 3: Compaction happens (replaceGeneration -> 1), mention 老王 first and Gateway second -> resets and respects entity maxTokens budget
  fakeAgent.session.surface.replaceGeneration = 1
  const s3 = await preStep(
    { agent: fakeAgent },
    async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '检查王总那台机器和 Gateway' }], source: { kind: 'user' } }] }),
  )
  assert.equal(s3.messages.length, 2)
  assert.equal(s3.messages[0].content[0].text.includes('老王'), true)
  // Oversized second entity dropped because maxTokens = 90
  assert.equal(s3.messages[0].content[0].text.includes('网关项目'), false)

  // Forget keyword across entities + tools integration
  store.insertMessage({
    sessionId: 's1',
    logicalDate: '2026-11-23',
    seq: 1,
    role: 'user',
    text: '生产服务器机房 A 密码测试',
    timestamp: clock.now(),
    anchor: 'chat://2026-11-23#s1#1',
  })
  const toolsApi = createToolsApi({ ctx, config, store, bufferApi, journalApi, digestApi: {}, contextApi, historyApi, entityApi, clock })
  toolsApi.install()

  const forgetTool = ctx.registered.get('memory_forget')
  const forgetRes = await forgetTool.execute({ keyword: '机房 A' }, { agent: { id: 's1' }, signal: new AbortController().signal })
  assert.equal(forgetRes.includes('Redacted 1 entity card(s): 老王'), true)

  const entAfterForget = entityApi.readEntity(dir, '老王')
  assert.equal(entAfterForget.raw.includes('机房 A'), false)
  assert.equal(entAfterForget.raw.includes('[已按用户要求遗忘 · 2026-11-23]'), true)
})

test('searchEntities searches entity body facts and extra lines with AND priority and OR coverage fallback', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-ent-search-'))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  assert.deepEqual(entityApi.searchEntities(dir, { query: '15432' }), [])
  assert.deepEqual(entityApi.searchEntities(dir, { query: '' }), [])

  await entityApi.upsertEntity(dir, {
    name: 'ProdDB',
    type: 'server',
    aliases: ['主库'],
    content: 'PostgreSQL 运行在端口 15432，数据目录 D:/pgdata',
    added: '2026-11-24',
    source: 'chat://2026-11-24#main#1',
  })
  await entityApi.upsertEntity(dir, {
    name: 'ProdDB',
    content: '每日凌晨 03:00 自动执行 pg_dump 备份',
    added: '2026-11-24',
    source: 'manual',
  })
  await entityApi.upsertEntity(dir, {
    name: 'StagingBox',
    type: 'server',
    aliases: ['测试机'],
    content: '测试环境 PostgreSQL 端口 5432',
    added: '2026-11-24',
    source: 'manual',
  })

  // Hand-written extra note section in markdown file is also searchable
  const prodPath = entityApi.entityPath(dir, 'proddb')
  writeFileSync(prodPath, `${readFileSync(prodPath, 'utf8')}\n## 备注\n手工补充：值班邮箱 ops@example.com\n`, 'utf8')

  // Body-only keyword (not in entity name or aliases)
  const portHits = entityApi.searchEntities(dir, { query: '15432' })
  assert.equal(portHits.length, 1)
  assert.equal(portHits[0].name, 'ProdDB')
  assert.equal(portHits[0].entryId, 'ent_01')
  assert.equal(portHits[0].snippet.includes('15432'), true)

  // Extra hand-written markdown line match
  const noteHits = entityApi.searchEntities(dir, { query: 'ops@example.com' })
  assert.equal(noteHits.length, 1)
  assert.equal(noteHits[0].name, 'ProdDB')
  assert.equal(noteHits[0].snippet.includes('ops@example.com'), true)

  // Cross header + body strict AND match excludes partial match on StagingBox
  const crossHits = entityApi.searchEntities(dir, { query: '主库 15432' })
  assert.equal(crossHits.length, 1)
  assert.equal(crossHits[0].name, 'ProdDB')
  assert.equal(crossHits[0].isAndMatch, true)

  // Multi-term OR coverage fallback: 2 matched terms ranks above 1 matched term
  const orHits = entityApi.searchEntities(dir, { query: 'PostgreSQL 15432 不存在词' })
  assert.equal(orHits.length, 2)
  assert.equal(orHits[0].name, 'ProdDB')
  assert.equal(orHits[1].name, 'StagingBox')

  // Header-only query falls back to summary hit & case-insensitivity works
  const headerOnly = entityApi.searchEntities(dir, { query: '测试机' })
  assert.equal(headerOnly.length, 1)
  assert.equal(headerOnly[0].name, 'StagingBox')
  assert.equal(entityApi.searchEntities(dir, { query: 'POSTGRESQL 15432' })[0].name, 'ProdDB')
})
