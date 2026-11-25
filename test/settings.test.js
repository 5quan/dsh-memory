import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import * as dshMemoryPlugin from '../index.js'
import { Config, normalizeConfig, snapshotLiveConfig } from '../src/config.js'
import * as profileApi from '../src/profile.js'

test('Schemastery Config defines volatile live switches with safe defaults (dream.useLlm and ingest.injectSubagentContext default false)', () => {
  const parsed = Config({})
  assert.equal(isVolatile(parsed.defaultMode), true)
  assert.equal(isVolatile(parsed.ingest.injectSubagentContext), true)
  assert.equal(isVolatile(parsed.dream.enabled), true)
  assert.equal(isVolatile(parsed.dream.useLlm), true)
  assert.equal(isVolatile(parsed.sections.profile.enabled), true)
  assert.equal(isVolatile(parsed.sections.lessons.enabled), true)

  assert.equal(parsed.defaultMode.get(), 'full')
  assert.equal(parsed.ingest.injectSubagentContext.get(), false)
  assert.equal(parsed.dream.enabled.get(), true)
  assert.equal(parsed.dream.useLlm.get(), false)

  const normalized = normalizeConfig(parsed)
  assert.equal(normalized.defaultMode, 'full')
  assert.equal(normalized.ingest.injectSubagentContext, false)
  assert.equal(normalized.dream.enabled, true)
  assert.equal(normalized.dream.useLlm, false)
  assert.equal(normalized.llm.provider, undefined)

  const json = Config.toJSON()
  const refs = Object.values(json.refs ?? {})
  assert.equal(refs.some(node => node?.meta?.volatile === true), true)
})

test('live volatile updates hot-reload switches in real Cordis without breaking frozen prefix unless frozen sections change', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-settings-'))
  let nowMs = Date.parse('2026-11-23T14:00:00+08:00')
  const clock = { now: () => nowMs }

  const rawSchemaConfig = Config({
    home: dir,
    timeZone: 'Asia/Shanghai',
    dream: { intervalDays: 1, minNewJournals: 1 },
  })

  await profileApi.applyProfileMutation(dir, {
    op: 'add',
    section: '基本身份与环境',
    content: '测试实时开关画像条目',
    added: '2026-11-22',
    source: 'manual',
  })
  const root = new Context()
  const tools = new Map()
  let llmDreamCalls = 0

  root.provide('llm', {
    async* stream() {
      llmDreamCalls += 1
      const text = JSON.stringify({ proposals: [] })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  root.provide('tools', {
    register: (def) => {
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
    get: name => tools.get(name),
  })
  root.provide('systemPrompt', { section: () => () => {} })
  root.provide('sessions', { list: () => [], get: () => undefined })
  root.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock-flash' }) })

  let rt
  const fork = root.plugin({
    name: 'dsh-memory',
    inject: dshMemoryPlugin.inject,
    Config,
    apply(ctx) {
      // Pass volatile-backed Config directly to createMemoryRuntime
      rt = dshMemoryPlugin.createMemoryRuntime(ctx, rawSchemaConfig, {
        clock,
        startTimer: false,
        autoCatchUp: false,
      })
    },
  }, {})
  await fork

  t.after(async () => {
    try { await root.fiber.dispose() } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  const svc = root.get(dshMemoryPlugin.SERVICE_NAME)
  assert.ok(svc)
  assert.equal(svc.getSettingsSnapshot().dream.useLlm, false)

  // Seed journal & lesson card
  await rt.journalApi.writeJournalAtomic(dir, '2026-11-22', '# 2026-11-22 日报\n## 发生了什么\n- 联调测试\n')
  await rt.lessonApi.upsertLesson(dir, {
    name: '设置热开关避坑',
    triggers: ['nginx'],
    content: '先跑 nginx -t 再 reload',
    added: '2026-11-22',
    source: 'manual',
  })

  // 1. Dream default useLlm=false -> skips LLM; flipping dream.useLlm -> true live runs LLM
  const dreamSkipped = await rt.dreamApi.runDream({ dryRun: true, force: true })
  assert.equal(dreamSkipped.llmStatus, 'skipped')
  assert.equal(llmDreamCalls, 0)

  updateVolatile(rawSchemaConfig.dream.useLlm, createVolatile(true))
  assert.equal(svc.getSettingsSnapshot().dream.useLlm, true)

  const dreamWithLlm = await rt.dreamApi.runDream({ dryRun: true, force: true })
  assert.equal(dreamWithLlm.llmStatus, 'ok')
  assert.equal(llmDreamCalls, 1)

  // 2. Toggling dream.enabled, briefing.enabled, correction.autoCapture, sections.lessons.enabled live
  // preserves frozen snapshot without invalidation!
  const snap1 = rt.contextApi.sectionFor('sess-live')
  assert.equal(snap1.includes('测试实时开关画像条目'), true)
  assert.equal(rt.dreamApi.shouldRunDream({ isIdle: true }), true)

  updateVolatile(rawSchemaConfig.dream.enabled, createVolatile(false))
  assert.equal(rt.dreamApi.shouldRunDream({ isIdle: true }), false)

  updateVolatile(rawSchemaConfig.sections.lessons.enabled, createVolatile(false))
  updateVolatile(rawSchemaConfig.briefing.enabled, createVolatile(false))
  updateVolatile(rawSchemaConfig.correction.autoCapture, createVolatile(false))

  // Frozen snapshot must still exist and match byte-for-byte
  assert.equal(rt.contextApi.hasSnapshot('sess-live', '2026-11-23'), true)
  assert.equal(rt.contextApi.sectionFor('sess-live'), snap1)

  // Lessons delta suppressed while sections.lessons.enabled=false
  const suppressedDelta = rt.contextApi.buildDeltaForSession('sess-live', 'default', 0, '准备运行 nginx', { isSubagent: false })
  assert.equal(suppressedDelta, undefined)

  // Re-enable lessons -> injects immediately
  updateVolatile(rawSchemaConfig.sections.lessons.enabled, createVolatile(true))
  const activeDelta = rt.contextApi.buildDeltaForSession('sess-live', 'default', 0, '准备运行 nginx', { isSubagent: false })
  assert.ok(activeDelta)
  assert.equal(activeDelta.content[0].text.includes('先跑 nginx -t 再 reload'), true)

  // 3. Toggling a frozen-prefix section (sections.profile.enabled) refreshes snapshot on next read
  updateVolatile(rawSchemaConfig.sections.profile.enabled, createVolatile(false))
  const snapAfterDisableProfile = rt.contextApi.sectionFor('sess-live')
  assert.equal(snapAfterDisableProfile.includes('测试实时开关画像条目'), false)

  updateVolatile(rawSchemaConfig.sections.profile.enabled, createVolatile(true))
  const snapAfterEnableProfile = rt.contextApi.sectionFor('sess-live')
  assert.equal(snapAfterEnableProfile.includes('测试实时开关画像条目'), true)

  // 4. Programmatic global defaultMode override vs external volatile edit precedence
  await tools.get('memory_mode_set').execute(
    { mode: 'read-only', scope: 'global' },
    { agent: { id: 'sess-live' }, signal: new AbortController().signal },
  )
  assert.equal(rt.config.defaultMode, 'read-only')
  assert.equal(snapshotLiveConfig(rt.config).defaultMode, 'read-only')

  // External volatile setting change overrides earlier programmatic global override
  updateVolatile(rawSchemaConfig.defaultMode, createVolatile('off'))
  assert.equal(rt.config.defaultMode, 'off')
  assert.equal(rt.contextApi.sectionFor('brand-new-sess'), '')

  updateVolatile(rawSchemaConfig.defaultMode, createVolatile('full'))
  assert.equal(rt.config.defaultMode, 'full')

  // 5. Live volatile toggle of ingest.injectSubagentContext controls subagent injection without breaking main snapshot
  const snapBeforeSubagentToggle = rt.contextApi.sectionFor('sess-live')
  assert.equal(svc.getSettingsSnapshot().ingest.injectSubagentContext, false)
  const subAgent = {
    id: 'sub-live',
    session: {
      header: { id: 'sub-live', origin: 'subagent', parentSession: 'sess-live' },
      surface: { replaceGeneration: 0 },
    },
  }
  assert.equal(rt.contextApi.sectionFor('sub-live', { agent: subAgent }), '')
  assert.equal(rt.contextApi.buildDeltaForSession('sub-live', 'default', 0, '准备运行 nginx', { agent: subAgent }), undefined)

  updateVolatile(rawSchemaConfig.ingest.injectSubagentContext, createVolatile(true))
  assert.equal(svc.getSettingsSnapshot().ingest.injectSubagentContext, true)
  assert.equal(rt.contextApi.sectionFor('sub-live', { agent: subAgent }).includes('测试实时开关画像条目'), true)
  assert.ok(rt.contextApi.buildDeltaForSession('sub-live', 'default', 0, '准备运行 nginx', { agent: subAgent }))
  assert.equal(rt.contextApi.hasSnapshot('sess-live', '2026-11-23'), true)
  assert.equal(rt.contextApi.sectionFor('sess-live'), snapBeforeSubagentToggle)

  updateVolatile(rawSchemaConfig.ingest.injectSubagentContext, createVolatile(false))
  assert.equal(svc.getSettingsSnapshot().ingest.injectSubagentContext, false)
  assert.equal(rt.contextApi.sectionFor('sub-live', { agent: subAgent }), '')
  assert.equal(rt.contextApi.buildDeltaForSession('sub-live', 'default', 0, '准备运行 nginx', { agent: subAgent }), undefined)
})
