import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as dshMemoryPlugin from '../index.js'
import * as profileApi from '../src/profile.js'

test('public Cordis service dshMemory and dsh-memory/day-rolled-over contract work standalone in real Cordis without ds-bot', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-contract-'))
  let nowMs = Date.parse('2026-11-22T15:00:00+08:00')
  const clock = { now: () => nowMs }

  const root = new Context()
  const registeredTools = new Map()
  const promptSections = new Map()
  const rolledOverEvents = []

  // Minimal DSH host services (zero ds-bot dependency)
  root.provide('llm', {
    async* stream() {
      const text = [
        '# 2026-11-22 日报',
        '## 发生了什么',
        '- [chat://2026-11-22#main#1] 完成服务契约联调。',
        '## 做出的决定',
        '- [chat://2026-11-22#main#1] 上层 Bot 通过 dshMemory 服务单向绑定记忆插件。',
        '## 新建/变更的事项',
        '- （无）',
        '## 纠正与教训',
        '- （无）',
        '## 悬而未决的问题',
        '- 待上层接入统一晨报。',
        '## 提到的实体',
        '- 服务器A',
      ].join('\n')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  root.provide('tools', {
    register(def) {
      registeredTools.set(def.name, def)
      return () => registeredTools.delete(def.name)
    },
    get(name) {
      return registeredTools.get(name)
    },
  })
  root.provide('systemPrompt', {
    section(def) {
      promptSections.set(def.name, def)
      return () => promptSections.delete(def.name)
    },
  })
  root.provide('sessions', { list: () => [], get: () => undefined })
  root.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock-flash' }) })

  root.on(dshMemoryPlugin.DAY_ROLLED_OVER_EVENT, payload => rolledOverEvents.push(payload))

  let memoryRuntime
  const pluginFork = root.plugin({
    name: 'dsh-memory',
    inject: dshMemoryPlugin.inject,
    apply(ctx, cfg) {
      memoryRuntime = dshMemoryPlugin.createMemoryRuntime(ctx, cfg, {
        clock,
        startTimer: false,
        autoCatchUp: false,
      })
    },
  }, { home: dir, timeZone: 'Asia/Shanghai', dayStartHour: 2, idleMinutes: 30 })

  let dependentServiceRef = null
  const consumerPlugin = {
    name: 'upstream-bot-consumer',
    inject: [dshMemoryPlugin.SERVICE_NAME],
    apply(ctx) {
      dependentServiceRef = ctx.get(dshMemoryPlugin.SERVICE_NAME)
    },
  }
  const consumerFork = root.plugin(consumerPlugin)

  await pluginFork
  await consumerFork
  t.after(async () => {
    try { await root.fiber.dispose() } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  // 1. Service registration & contract identity
  const svc = root.get(dshMemoryPlugin.SERVICE_NAME)
  assert.ok(svc, 'dshMemory Cordis service should be registered')
  assert.equal(dependentServiceRef, svc)
  assert.equal(svc.contractVersion, 1)
  assert.equal(svc.serviceName, 'dshMemory')
  assert.equal(svc.getCurrentLogicalDate(), '2026-11-22')
  assert.equal(registeredTools.size, 11)

  // 2. Onboarding control via public service
  assert.equal(svc.getOnboardingState().needsOnboarding, true)
  const onbDone = await svc.submitOnboarding({
    identity: '个人秘书 Chief 测试账号',
    rules: '所有外部候选中转必须进缓冲池',
  })
  assert.equal(onbDone.ok, true)
  assert.equal(onbDone.writeMode, 'direct')
  assert.equal(svc.getOnboardingState().needsOnboarding, false)

  // 3. Entity alias matching for Worker context assembly (with token budget)
  await memoryRuntime.entityApi.upsertEntity(dir, {
    name: '服务器A',
    type: 'server',
    aliases: ['ProdBox', '生产机A'],
    content: '部署路径 D:/srv/app，端口 8080',
    added: '2026-11-22',
    source: 'manual',
  })
  await memoryRuntime.entityApi.upsertEntity(dir, {
    name: '冗余实体B',
    type: 'project',
    aliases: ['HeavyProj'],
    content: '超长内容用于触发 Worker 实体预算裁剪检查。'.repeat(20),
    added: '2026-11-22',
    source: 'manual',
  })

  const matched = svc.matchEntities('请登录 ProdBox 排查 HeavyProj 问题', { maxTokens: 60 })
  assert.equal(matched.totalMatched, 2)
  assert.equal(matched.matches.length, 1)
  assert.equal(matched.matches[0].name, '服务器A')
  assert.equal(matched.text.includes('8080'), true)

  // 4. External buffer candidate submission safety gate (never writes PROFILE.md directly, downgrades spoofed explicit)
  memoryRuntime.store.insertMessage({
    sessionId: 'main',
    logicalDate: '2026-11-22',
    seq: 1,
    role: 'user',
    text: '记录：完成服务契约联调。',
    timestamp: nowMs,
    anchor: 'chat://2026-11-22#main#1',
  })
  memoryRuntime.rolloverApi.touchActivity(nowMs)

  const profileBefore = profileApi.readProfile(dir)
  const spoofedCandidate = await svc.submitBufferCandidate({
    sourceType: 'explicit',
    target: 'profile',
    content: '未绑定真实用户锚点的外部提案应被降级',
    anchor: 'chat://2026-11-22#main#999',
    producer: 'worker-retrospective',
  })
  assert.equal(spoofedCandidate.ok, true)
  assert.equal(spoofedCandidate.status, 'pending')
  assert.equal(spoofedCandidate.sourceType, 'extracted')
  assert.equal(spoofedCandidate.downgraded, true)

  const verifiedCandidate = await svc.submitBufferCandidate({
    sourceType: 'correction',
    target: 'profile',
    content: '有真实锚点的复盘纠偏保留 correction 来源但仍须等待确认',
    anchor: 'chat://2026-11-22#main#1',
    producer: 'ticket-review',
  })
  assert.equal(verifiedCandidate.ok, true)
  assert.equal(verifiedCandidate.sourceType, 'correction')
  assert.equal(verifiedCandidate.downgraded, false)
  assert.equal(profileApi.readProfile(dir), profileBefore)

  // 5. Idle rollover emits enriched dsh-memory/day-rolled-over event
  nowMs = Date.parse('2026-11-23T02:35:00+08:00')
  const rolled = await memoryRuntime.rolloverApi.checkAndRollover({ isStartup: false })
  assert.equal(rolled.rolledOver.length, 1)
  assert.equal(rolledOverEvents.length, 1)

  const evt = rolledOverEvents[0]
  assert.equal(evt.date, '2026-11-22')
  assert.equal(evt.scope, 'default')
  assert.ok(evt.journalPath.endsWith('2026-11-22.md'))
  assert.equal(evt.summary.highlights.decisions.length, 1)
  assert.equal(evt.summary.pendingBufferCount, 2)
  assert.equal(evt.summary.text.includes('dshMemory'), true)

  // 6. Morning briefing API exposes yesterday highlights + pending buffer items & batch confirm works
  const briefing = svc.getMorningBriefing()
  assert.equal(briefing.date, '2026-11-23')
  assert.equal(briefing.yesterday.date, '2026-11-22')
  assert.equal(briefing.buffer.totalPending, 2)
  assert.equal(briefing.alreadyDelivered, false)

  const confirmed = await svc.confirmBufferItems({
    approveIds: [verifiedCandidate.id],
    rejectIds: [spoofedCandidate.id],
    settleNow: true,
    reason: '上层 Bot 统一晨报批量确认',
  })
  assert.equal(confirmed.approved.length, 1)
  assert.equal(confirmed.rejected.length, 1)
  assert.equal(confirmed.settlement.committedCount, 1)
  assert.equal(profileApi.readProfile(dir).includes('复盘纠偏保留 correction 来源'), true)

  // 7. Disposing plugin fiber cleans up dshMemory Cordis service cleanly
  await pluginFork.dispose()
  assert.equal(root.get(dshMemoryPlugin.SERVICE_NAME), undefined)

  // 8. Direct module plugin entry `ctx.plugin(dshMemoryPlugin, config)` loads & disposes without Invalid effect
  const directFork = root.plugin(dshMemoryPlugin, { home: dir, timeZone: 'Asia/Shanghai' })
  await directFork
  const directSvc = root.get(dshMemoryPlugin.SERVICE_NAME)
  assert.ok(directSvc)
  assert.equal(directSvc.serviceName, 'dshMemory')
  await directFork.dispose()
  assert.equal(root.get(dshMemoryPlugin.SERVICE_NAME), undefined)
})
