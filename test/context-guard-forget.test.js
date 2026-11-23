import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBufferApi } from '../src/buffer.js'
import { normalizeConfig } from '../src/config.js'
import { createContextApi } from '../src/context.js'
import { createDigestApi } from '../src/digest.js'
import * as entityApi from '../src/entities.js'
import { computeContentHash, detectSecret, MemoryGuardError, normalizeContentForHash } from '../src/guard.js'
import { createHistoryApi } from '../src/history.js'
import * as journalApi from '../src/journal.js'
import * as profileApi from '../src/profile.js'
import { createMemoryStore } from '../src/store.js'
import { createToolsApi } from '../src/tools.js'

function setupEnv(t, { maxProfileTokens = 2000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-cgf-'))
  const clock = { now: () => Date.parse('2026-11-24T10:00:00+08:00') }
  const config = normalizeConfig({
    home: dir,
    timeZone: 'Asia/Shanghai',
    sections: { profile: { enabled: true, maxTokens: maxProfileTokens } },
  })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  const registered = new Map()
  const prompts = []
  const ctx = {
    effect(fn) { return fn() },
    on() { return () => {} },
    systemPrompt: { section() { return () => {} } },
    tools: {
      register(def) {
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
      get(name) { return registered.get(name) },
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'mock', model: 'mock-flash' }) }
      return undefined
    },
    llm: {
      async* stream(req) {
        prompts.push(req)
        const text = '# 2026-11-23 日报\n## 发生了什么\n- 正常整理\n## 做出的决定\n- （无）\n## 新建/变更的事项\n- （无）\n## 纠正与教训\n- （无）\n## 悬而未决的问题\n- （无）\n## 提到的实体\n- （无）'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }

  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  const bufferApi = createBufferApi({ home: dir, profileApi, clock })
  const historyApi = createHistoryApi({ ctx, config, store, journalApi })
  const digestApi = createDigestApi({ ctx, config, store, bufferApi, profileApi, journalApi, entityApi, historyApi, clock })
  const contextApi = createContextApi({ ctx, config, store, profileApi, journalApi, bufferApi, entityApi, clock })
  const toolsApi = createToolsApi({ ctx, config, store, bufferApi, journalApi, digestApi, contextApi, historyApi, entityApi, profileApi, clock })
  contextApi.install()
  toolsApi.install()

  const runTool = (name, args, sessionId = 's1') =>
    registered.get(name).execute(args, { agent: { id: sessionId }, signal: new AbortController().signal })

  return { dir, config, store, bufferApi, digestApi, contextApi, historyApi, prompts, runTool, clock }
}

test('memory_read_context and memory_search.contextTurns expand non-contiguous seq windows within char budgets', async (t) => {
  const env = setupEnv(t)

  // Insert messages with gaps in seq (simulating skipped tool events at seq 2,3,4,6,7,10,11)
  const msgs = [
    { seq: 1, role: 'user', text: '第1轮：我想了解部署脚本的准备前提。' },
    { seq: 5, role: 'assistant', text: '第2轮：准备前需要先检查 node 与 sqlite 版本。' },
    { seq: 8, role: 'user', text: '第3轮核心锚点：请核对生产端口配置。' },
    { seq: 9, role: 'assistant', text: '第4轮：生产端口已确定为 3085，不要改动。' },
    { seq: 15, role: 'user', text: '第5轮：收到，多谢，这轮只是收尾确认。' },
  ]
  for (const m of msgs) {
    env.store.insertMessage({
      sessionId: 's1',
      logicalDate: '2026-11-23',
      seq: m.seq,
      role: m.role,
      text: m.text,
      timestamp: 1000 + m.seq * 100,
      anchor: `chat://2026-11-23#s1#${m.seq}`,
    })
  }

  // Row-window before=1, after=1 around seq=8 hits seq=5 and seq=9 despite seq gaps
  const out = await env.runTool('memory_read_context', {
    anchor: 'chat://2026-11-23#s1#8',
    before: 1,
    after: 1,
  })
  assert.equal(out.includes('第1轮'), false)
  assert.equal(out.includes('第2轮：准备前需要先检查'), true)
  assert.equal(out.includes('>>> [chat://2026-11-23#s1#8]'), true)
  assert.equal(out.includes('第4轮：生产端口已确定为 3085'), true)
  assert.equal(out.includes('第5轮'), false)

  // Explicit before=0, after=0 returns only target
  const exactZero = await env.runTool('memory_read_context', {
    anchor: 'chat://2026-11-23#s1#8',
    before: 0,
    after: 0,
  })
  assert.equal(exactZero.includes('before=0, after=0'), true)
  assert.equal(exactZero.includes('第2轮'), false)
  assert.equal(exactZero.includes('第4轮'), false)

  // Search with contextTurns=1 attaches surrounding lines
  const searchOut = await env.runTool('memory_search', { query: '生产端口配置', contextTurns: 1 })
  assert.equal(searchOut.includes('第2轮：准备前需要先检查'), true)
  assert.equal(searchOut.includes('>>> [chat://2026-11-23#s1#8]'), true)
  assert.equal(searchOut.includes('第4轮：生产端口已确定为 3085'), true)
})

test('guard.js enforces normalized content_hash deduplication and high-confidence secret rejection without false positives', async (t) => {
  const env = setupEnv(t)

  // Safe technical strings MUST pass without false positives
  const safeStrings = [
    '当前主力环境为 Node.js v24.9.0 与 dsh 0.2.2-rc.5',
    '上个提交哈希 c736fb6a93bc8402e7f48120a1b2c3d4e5f60718 已验证通过',
    '本地开发服务运行在端口 3085，API Key 放在环境变量 GITHUB_TOKEN 中',
    '临时标识符 TempSecretToken 与 AlphaSecret 仅作测试词',
    'Token 占位符写成 Bearer <token> 或 password: ${MY_PASSWORD}',
  ]
  for (const safe of safeStrings) {
    assert.equal(detectSecret(safe).detected, false, `Unexpected false positive on: ${safe}`)
  }

  // High-confidence secrets MUST be rejected
  const secrets = [
    'sk-proj-1234567890abcdefABCDEF',
    'ghp_1234567890abcdef1234567890abcdef',
    'github_pat_1234567890_abcdef1234567890abcdef',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-1234567890-1234567890-abcdef',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIE...',
    'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc',
    '数据库 password: MyActualPassword99!',
    '登录验证码：482910，两分钟有效',
  ]
  for (const s of secrets) {
    assert.equal(detectSecret(s).detected, true, `Missed secret: ${s}`)
    await assert.rejects(
      () => env.bufferApi.appendCreate({ logicalDate: '2026-11-24', sourceType: 'explicit', content: s }),
      err => err instanceof MemoryGuardError && err.code === 'SECRET_DETECTED',
    )
    const toolRefusal = await env.runTool('memory_buffer_add', { content: s, sourceType: 'explicit' })
    assert.equal(toolRefusal.includes('SECRET_DETECTED'), true)
  }

  // Normalized content_hash deduplication across whitespace, case, and trailing punctuation
  assert.equal(normalizeContentForHash('  Use   PNPM!!  '), 'use pnpm')
  assert.equal(computeContentHash('  汇报先说结论。 '), computeContentHash('汇报先说结论'))

  const first = await env.bufferApi.appendCreate({
    logicalDate: '2026-11-24',
    sourceType: 'explicit',
    target: 'profile',
    section: '沟通与工作偏好',
    content: '  汇报先说结论。 ',
  })
  assert.equal(Boolean(first.duplicate), false)

  const dupInBuffer = await env.bufferApi.appendCreate({
    logicalDate: '2026-11-24',
    sourceType: 'explicit',
    target: 'profile',
    section: '沟通与工作偏好',
    content: '汇报先说结论',
  })
  assert.equal(dupInBuffer.duplicate, true)
  assert.equal(dupInBuffer.duplicateIn, 'buffer')
  assert.equal(dupInBuffer.id, first.id)

  // Different section is allowed; same content already in PROFILE.md is deduplicated
  await profileApi.applyProfileMutation(env.dir, {
    op: 'add',
    section: '长期规矩与边界',
    content: 'Always keep code DRY.',
    added: '2026-11-23',
  })
  const dupInProfile = await env.bufferApi.appendCreate({
    logicalDate: '2026-11-24',
    sourceType: 'explicit',
    target: 'profile',
    section: '长期规矩与边界',
    content: 'always   keep code dry!',
  })
  assert.equal(dupInProfile.duplicate, true)
  assert.equal(dupInProfile.duplicateIn, 'profile')

  // Prompt discipline checks in digest & context
  env.store.insertMessage({
    sessionId: 's1',
    logicalDate: '2026-11-23',
    seq: 1,
    role: 'user',
    text: '测试日结提示词纪律',
    timestamp: Date.parse('2026-11-23T10:00:00+08:00'),
    anchor: 'chat://2026-11-23#s1#1',
  })
  await env.digestApi.generateDailyDigest('2026-11-23')
  assert.equal(env.prompts[0].system.includes('绝对 ISO 日期'), true)
  assert.equal(env.prompts[0].system.includes('助手承诺与已执行动作'), true)
  assert.equal(env.contextApi.sectionFor('s1').includes('记忆可能滞后于当前现实状态'), true)
})

test('memory_forget completes 8-layer closure including PROFILE.md (respecting pinned/force) and retired.jsonl without false-deleting manual entries', async (t) => {
  const env = setupEnv(t)

  // Messages
  env.store.insertMessage({
    sessionId: 's1',
    logicalDate: '2026-11-23',
    seq: 1,
    role: 'user',
    text: '敏感代号 ProjectShadow 需要彻底遗忘。',
    timestamp: Date.parse('2026-11-23T10:00:00+08:00'),
    anchor: 'chat://2026-11-23#s1#1',
  })
  env.store.insertMessage({
    sessionId: 's1',
    logicalDate: '2026-11-23',
    seq: 2,
    role: 'user',
    text: '普通公开消息应当安全保留。',
    timestamp: Date.parse('2026-11-23T10:05:00+08:00'),
    anchor: 'chat://2026-11-23#s1#2',
  })

  // Buffer item
  await env.bufferApi.appendCreate({
    logicalDate: '2026-11-24',
    sourceType: 'explicit',
    content: 'ProjectShadow 待确认记录',
    anchor: 'chat://2026-11-23#s1#1',
  })

  // Journal, Entity, History
  await journalApi.writeJournalAtomic(env.dir, '2026-11-23', '# 2026-11-23 日报\n## 发生了什么\n- [chat://2026-11-23#s1#1] 提及 ProjectShadow。\n- [chat://2026-11-23#s1#2] 普通记录。\n')
  await entityApi.upsertEntity(env.dir, {
    name: 'ShadowBox',
    aliases: ['SB'],
    content: '关联 ProjectShadow 测试节点',
    added: '2026-11-23',
    source: 'chat://2026-11-23#s1#1',
  })
  await profileApi.applyProfileBatch(env.dir, [
    { op: 'add', section: '其他长期事实', content: '同日手动条目不应被按日期/锚点误杀', added: '2026-11-23', source: 'manual' },
    { op: 'add', section: '其他长期事实', content: '来源命中锚点的常规条目', added: '2026-11-23', source: 'chat://2026-11-23#s1#1' },
    { op: 'add', section: '长期规矩与边界', content: '含 ProjectShadow 的锁定条目', added: '2026-11-23', source: 'manual', pinned: true },
  ])
  // Seed retired.jsonl with an old version of ProjectShadow
  await profileApi.appendRetiredRecord(env.dir, {
    event: 'retired',
    retired_at: '2026-11-23T12:00:00Z',
    reason: 'test',
    op: 'retire',
    replaced_by: null,
    entry: { id: 'prof_99', section: '其他长期事实', content: '旧版 ProjectShadow 记录', source: 'chat://2026-11-23#s1#1', pinned: false },
  })
  env.contextApi.sectionFor('s1') // create snapshot

  // 1. First forget by anchor -> deletes message seq=1, buffer, journal, entity, prof_02, and retired.jsonl, WITHOUT deleting same-day source=manual prof_01!
  const res1 = await env.runTool('memory_forget', { anchor: 'chat://2026-11-23#s1#1' })
  assert.equal(res1.includes('Forgot 1 archived message(s)'), true)
  assert.equal(res1.includes('Removed 1 profile entry(s)'), true)
  assert.equal(res1.includes('Purged 1 retired record(s)'), true)

  const profileAfter1 = profileApi.readProfile(env.dir)
  assert.equal(profileAfter1.includes('同日手动条目不应被按日期/锚点误杀'), true)
  assert.equal(profileAfter1.includes('来源命中锚点的常规条目'), false)
  assert.equal(profileAfter1.includes('含 ProjectShadow 的锁定条目'), true)
  assert.equal(profileApi.readRetiredRecords(env.dir).length, 0)

  // 2. Forget by keyword without force -> skips pinned prof_03 and warns
  const res2 = await env.runTool('memory_forget', { keyword: 'ProjectShadow' })
  assert.equal(res2.includes('skipped pinned: prof_03'), true)
  assert.equal(profileApi.readProfile(env.dir).includes('含 ProjectShadow 的锁定条目'), true)

  // 3. Forget by keyword with force=true -> deletes pinned entry too, never writes to retired.jsonl
  const res3 = await env.runTool('memory_forget', { keyword: 'ProjectShadow', force: true })
  assert.equal(res3.includes('Removed 1 profile entry(s)'), true)
  assert.equal(profileApi.readProfile(env.dir).includes('ProjectShadow'), false)
  assert.equal(profileApi.readRetiredRecords(env.dir).length, 0)
})
