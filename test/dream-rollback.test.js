import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBufferApi } from '../src/buffer.js'
import { normalizeConfig } from '../src/config.js'
import { createContextApi } from '../src/context.js'
import { createDigestApi } from '../src/digest.js'
import { createDreamApi } from '../src/dream.js'
import * as entityApi from '../src/entities.js'
import * as journalApi from '../src/journal.js'
import * as profileApi from '../src/profile.js'
import { createRolloverApi } from '../src/rollover.js'
import { createMemoryStore } from '../src/store.js'
import { createToolsApi } from '../src/tools.js'

function setupDreamEnv(t, { dreamConfig = {}, llmHandler } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-dream-'))
  let nowMs = Date.parse('2026-11-25T10:00:00+08:00')
  const clock = { now: () => nowMs }
  assert.equal(normalizeConfig({ home: dir }).dream.useLlm, false)
  const config = normalizeConfig({
    home: dir,
    timeZone: 'Asia/Shanghai',
    dayStartHour: 2,
    idleMinutes: 30,
    dream: {
      enabled: true,
      useLlm: true,
      intervalDays: 7,
      minNewJournals: 1,
      maxChangeRatio: 0.2,
      rejectCooldownDays: 30,
      ...dreamConfig,
    },
  })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  const registered = new Map()
  const llmRequests = []

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
        llmRequests.push(req)
        const text = llmHandler
          ? await llmHandler(req)
          : JSON.stringify({ proposals: [] })
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
  const dreamApi = createDreamApi({ ctx, config, store, profileApi, journalApi, bufferApi, entityApi, clock })
  const digestApi = createDigestApi({ ctx, config, store, bufferApi, profileApi, journalApi, entityApi, clock })
  const contextApi = createContextApi({ ctx, config, store, profileApi, journalApi, bufferApi, entityApi, clock })
  const rolloverApi = createRolloverApi({ ctx, config, store, digestApi, contextApi, journalApi, bufferApi, dreamApi, clock })
  const toolsApi = createToolsApi({ ctx, config, store, bufferApi, journalApi, digestApi, contextApi, entityApi, profileApi, dreamApi, clock })
  toolsApi.install()

  return {
    dir,
    config,
    store,
    bufferApi,
    dreamApi,
    rolloverApi,
    contextApi,
    llmRequests,
    setNow: (ms) => { nowMs = ms },
    advanceDays: (days) => { nowMs += days * 86_400_000 },
    runTool: (name, args) => registered.get(name).execute(args, { agent: { id: 'main' }, signal: new AbortController().signal }),
  }
}

test('Dream rules handle expires/dups while respecting absence-of-evidence, pinned, ratio cap, cooldown, lock, and failure watermark', async (t) => {
  let failLlm = false
  let nextLlmResponse = JSON.stringify({
    proposals: [
      {
        target: 'profile',
        op: 'retire',
        targetId: 'prof_01',
        content: '尝试误删锁定条目',
        reason: 'should be blocked by pinned',
      },
      {
        target: 'profile',
        op: 'retire',
        targetId: 'prof_02',
        content: '试图无锚点覆盖 manual 条目',
        reason: 'should be blocked by authority check',
      },
      {
        target: 'profile',
        op: 'replace',
        targetId: 'prof_02',
        content: '[CONFLICT] 2026-11-23 日报建议改用 yarn（旧 manual 规则用 pnpm）[chat://2026-11-24#main#1]',
        reason: 'conflicting preference requires human decision',
        evidenceAnchor: 'chat://2026-11-24#main#1',
        conflict: true,
      },
      {
        target: 'profile',
        op: 'retire',
        targetId: 'prof_99',
        content: '不存在的条目',
        reason: 'invalid id',
      },
    ],
  })

  const env = setupDreamEnv(t, {
    dreamConfig: {
      instructions: '重点关注包管理器与发版时间冲突',
      maxChangeRatio: 0.2,
      minNewJournals: 1,
      rejectCooldownDays: 30,
    },
    llmHandler: async () => {
      if (failLlm) throw new Error('LLM outage')
      return nextLlmResponse
    },
  })

  // Seed PROFILE with 1 pinned + 6 non-pinned entries (1 expired, 1 duplicate, 4 stable/quiet)
  await profileApi.applyProfileBatch(env.dir, [
    { op: 'add', section: '长期规矩与边界', content: '绝对不修改桌面配置', added: '2026-10-01', source: 'manual', pinned: true },
    { op: 'add', section: '沟通与工作偏好', content: '包管理器默认使用 pnpm', added: '2026-10-01', source: 'manual' },
    { op: 'add', section: '阶段事项', content: '十一月临时冲刺窗口', added: '2026-11-01', source: 'manual', expires: '2026-11-20' },
    { op: 'add', section: '其他长期事实', content: '旧事实：常用 Windows 11', added: '2026-10-01', source: 'manual' },
    { op: 'add', section: '其他长期事实', content: '旧事实：常用 Windows 11', added: '2026-10-02', source: 'extracted' },
    { op: 'add', section: '其他长期事实', content: '很久未提到的安静事实 A', added: '2026-10-01', source: 'manual' },
    { op: 'add', section: '其他长期事实', content: '很久未提到的安静事实 B', added: '2026-10-01', source: 'manual' },
  ])
  await journalApi.writeJournalAtomic(env.dir, '2026-11-24', '# 2026-11-24 日报\n## 发生了什么\n- 测试推进\n')

  // 1. Dry-run succeeds first, verifies instructions passed & absence-of-evidence leaves quiet entries untouched & ratio cap=1 (6*0.2=1)
  const dryRun = await env.dreamApi.runDream({ scope: 'default', dryRun: true })
  assert.equal(dryRun.llmStatus, 'ok')
  assert.equal(dryRun.maxProfileProposals, 1)
  assert.equal(dryRun.proposals.length, 1)
  assert.equal(dryRun.proposals[0].targetId, 'prof_03') // rule-channel expired entry prioritized
  assert.equal(dryRun.writtenProposals.length, 0)
  assert.equal(env.dreamApi.getWatermark('default'), undefined)
  assert.equal(env.llmRequests.at(-1).messages[0].content[0].text.includes('重点关注包管理器与发版时间冲突'), true)
  assert.equal(env.llmRequests.at(-1).system.includes('Absence of evidence != staleness'), true)

  // 2. LLM failure degrades gracefully and does NOT advance watermark
  failLlm = true
  const failedRun = await env.dreamApi.runDream({ scope: 'default', dryRun: false })
  assert.equal(failedRun.llmStatus, 'failed')
  assert.equal(failedRun.degraded, true)
  assert.equal(env.dreamApi.getWatermark('default'), undefined)
  failLlm = false

  // 3. Re-running sees prof_03 is already open in buffer (ALREADY_OPEN_IN_BUFFER) and falls through to next rule proposal (prof_05 dup), then advances watermark
  const realRun = await env.dreamApi.runDream({ scope: 'default', dryRun: false })
  assert.equal(realRun.skippedReasons.some(s => s.candidate.targetId === 'prof_03' && s.reason === 'ALREADY_OPEN_IN_BUFFER'), true)
  assert.equal(realRun.writtenProposals.length, 1)
  assert.equal(realRun.writtenProposals[0].supersedes_id, 'prof_05')
  const wm1 = env.dreamApi.getWatermark('default')
  assert.equal(wm1.totalRuns, 1)
  assert.equal(wm1.lastProcessedJournalDate, '2026-11-24')

  // 5. Rejecting prof_03 proposal enforces 30-day rejectCooldownDays
  const prof03Item = env.bufferApi.listItems({ statuses: ['pending'] }).find(i => i.supersedes_id === 'prof_03')
  await env.bufferApi.updateStatuses([prof03Item.id], 'rejected', { by: 'user', reason: 'still needed' })

  env.advanceDays(10) // only 10 days (< 30)
  const cooldownRun = await env.dreamApi.runDream({ scope: 'default', dryRun: true })
  assert.equal(cooldownRun.skippedReasons.some(s => s.candidate.targetId === 'prof_03' && s.reason === 'REJECT_COOLDOWN'), true)

  env.advanceDays(25) // 35 days total (>= 30)
  const afterCooldownRun = await env.dreamApi.runDream({ scope: 'default', dryRun: true })
  assert.equal(afterCooldownRun.proposals.some(p => p.targetId === 'prof_03'), true)

  // 6. Active dream.lock blocks concurrent runs; stale lock (>30m) is recovered
  const lockPath = join(env.dir, 'dream.lock')
  writeFileSync(lockPath, JSON.stringify({ pid: 99999 }), 'utf8')
  const lockedRes = await env.dreamApi.runDream({ dryRun: true })
  assert.equal(lockedRes.skipped, true)
  assert.equal(lockedRes.reason, 'DREAM_LOCKED')

  const staleTime = new Date(Date.now() - 45 * 60_000)
  utimesSync(lockPath, staleTime, staleTime)
  const recoveredRes = await env.dreamApi.runDream({ dryRun: true })
  assert.equal(recoveredRes.ok, true)
  assert.equal(recoveredRes.skipped, false)

  // 7. Verified LLM conflict proposal with evidenceAnchor is accepted when cap allows
  env.store.insertMessage({
    sessionId: 'main',
    logicalDate: '2026-11-24',
    seq: 1,
    role: 'user',
    text: '也许改用 yarn？',
    timestamp: Date.parse('2026-11-24T12:00:00+08:00'),
    anchor: 'chat://2026-11-24#main#1',
  })
  env.config.dream.maxChangeRatio = 1
  const conflictDry = await env.dreamApi.runDream({ dryRun: true })
  assert.equal(conflictDry.proposals.some(p => p.conflict === true && p.targetId === 'prof_02'), true)
  assert.equal(conflictDry.skippedReasons.some(s => s.reason === 'PINNED_PROTECTED'), true)
  assert.equal(conflictDry.skippedReasons.some(s => s.reason === 'AUTHORITY_PROTECTED'), true)
})

test('retired.jsonl archives every replace/retire and memory_rollback restores with append-only audit and snapshot invalidation', async (t) => {
  const env = setupDreamEnv(t)

  await profileApi.applyProfileMutation(env.dir, {
    op: 'add',
    section: '沟通与工作偏好',
    content: '初版规则 A',
    added: '2026-11-20',
    source: 'manual',
  })
  const firstEntries = profileApi.parseProfileEntries(profileApi.readProfile(env.dir))
  assert.equal(firstEntries[0].id, 'prof_01')

  // Replace prof_01 -> prof_02 (archives prof_01 to retired.jsonl)
  const replaced = await profileApi.applyProfileMutation(env.dir, {
    op: 'replace',
    targetId: 'prof_01',
    content: '改版规则 B',
    added: '2026-11-22',
    source: 'manual',
    reason: 'manual update',
  })
  assert.equal(replaced.ok, true)
  assert.equal(replaced.id, 'prof_02')

  const snap1 = env.contextApi.sectionFor('s1')
  assert.equal(snap1.includes('改版规则 B'), true)

  // Rollback prof_01 via tool -> retires prof_02 to retired.jsonl, restores prof_01, invalidates snapshots
  const rbOut = await env.runTool('memory_rollback', { entryId: 'prof_01' })
  assert.equal(rbOut.includes('Rolled back profile entry prof_01'), true)
  assert.equal(rbOut.includes('retired replacement prof_02'), true)

  const profileNow = profileApi.readProfile(env.dir)
  assert.equal(profileNow.includes('初版规则 A'), true)
  assert.equal(profileNow.includes('改版规则 B'), false)

  const snap2 = env.contextApi.sectionFor('s1')
  assert.equal(snap2.includes('初版规则 A'), true)

  const records = profileApi.readRetiredRecords(env.dir)
  assert.equal(records.some(r => r.event === 'retired' && r.entry?.id === 'prof_02' && r.reason === 'rollback:prof_01'), true)
  assert.equal(records.some(r => r.event === 'rollback_restore' && r.restored_id === 'prof_01'), true)

  // Duplicate rollback fails cleanly because prof_01 is already active
  const dupRb = await env.runTool('memory_rollback', { entryId: 'prof_01' })
  assert.equal(dupRb.includes('ENTRY_ALREADY_ACTIVE'), true)
})

test('rollover triggers idle Dream automatically once intervalDays & minNewJournals are met', async (t) => {
  const env = setupDreamEnv(t, {
    dreamConfig: { intervalDays: 7, minNewJournals: 2 },
  })

  await profileApi.applyProfileMutation(env.dir, {
    op: 'add',
    section: '阶段事项',
    content: '可过期任务规则',
    added: '2026-11-01',
    expires: '2026-11-20',
  })
  await journalApi.writeJournalAtomic(env.dir, '2026-11-23', '# 2026-11-23 日报\n## 发生了什么\n- Day 1\n')
  await journalApi.writeJournalAtomic(env.dir, '2026-11-24', '# 2026-11-24 日报\n## 发生了什么\n- Day 2\n')

  env.rolloverApi.touchActivity(Date.parse('2026-11-25T10:00:00+08:00'))
  env.setNow(Date.parse('2026-11-25T10:45:00+08:00')) // 45m idle >= 30m

  const res = await env.rolloverApi.checkAndRollover({ isStartup: false })
  assert.ok(res.dream)
  assert.equal(res.dream.writtenProposals.length, 1)
  assert.equal(env.bufferApi.listItems({ statuses: ['pending'] }).some(i => i.source_type === 'dream'), true)
})
