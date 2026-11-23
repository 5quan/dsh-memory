import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBufferApi } from '../src/buffer.js'
import { normalizeConfig } from '../src/config.js'
import { createContextApi } from '../src/context.js'
import * as entityApi from '../src/entities.js'
import * as journalApi from '../src/journal.js'
import { createOnboardingApi } from '../src/onboarding.js'
import * as profileApi from '../src/profile.js'
import { createMemoryStore } from '../src/store.js'
import { createToolsApi } from '../src/tools.js'

function createOnboardingEnv(t, { maxProfileTokens = 2000, availableTools = [], userQuestions } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-onb-'))
  let nowMs = Date.parse('2026-11-23T09:00:00+08:00')
  const clock = { now: () => nowMs }
  const config = normalizeConfig({
    home: dir,
    timeZone: 'Asia/Shanghai',
    sections: {
      profile: { enabled: true, maxTokens: maxProfileTokens },
    },
  })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  const preStepHandlers = []
  const registeredTools = new Map()
  const toolSet = new Set(availableTools)

  const ctx = {
    effect(fn) { return fn() },
    systemPrompt: { section() { return () => {} } },
    on(eventName, fn) {
      if (eventName === 'agent/pre-step') preStepHandlers.push(fn)
      return () => {}
    },
    tools: {
      register(def) {
        registeredTools.set(def.name, def)
        return () => registeredTools.delete(def.name)
      },
      get(name) {
        return toolSet.has(name) ? { name } : undefined
      },
    },
    get(name) {
      if (name === 'userQuestions') return userQuestions
      return undefined
    },
  }

  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  const bufferApi = createBufferApi({ home: dir, clock })
  let contextApi
  const snapshotFacade = {
    hasSnapshot: (sid, date) => contextApi?.hasSnapshot?.(sid, date) ?? false,
    invalidateSnapshots: opts => contextApi?.invalidateSnapshots?.(opts),
  }
  const onboardingApi = createOnboardingApi({
    ctx,
    config,
    store,
    profileApi,
    bufferApi,
    entityApi,
    contextApi: snapshotFacade,
    clock,
  })
  contextApi = createContextApi({
    ctx,
    config,
    store,
    profileApi,
    journalApi,
    bufferApi,
    entityApi,
    onboardingApi,
    clock,
  })
  const toolsApi = createToolsApi({
    ctx,
    config,
    store,
    bufferApi,
    journalApi,
    digestApi: {},
    contextApi,
    entityApi,
    onboardingApi,
    profileApi,
    clock,
  })
  contextApi.install()
  toolsApi.install()

  return {
    dir,
    config,
    store,
    bufferApi,
    onboardingApi,
    contextApi,
    registeredTools,
    preStep: preStepHandlers[0],
    setNow: (ms) => { nowMs = ms },
  }
}

test('onboarding triggers once per session when PROFILE.md is empty, adapts UI guidance, and respects subagent/incognito boundaries', async (t) => {
  const env = createOnboardingEnv(t, { availableTools: ['show_view'] })

  assert.equal(env.onboardingApi.getState().needsOnboarding, true)

  // First turn on normal session -> frozen snapshot stays stable while delta injects adaptive show_view onboarding guide
  const snapBefore = env.contextApi.sectionFor('main-1')
  const agent = { id: 'main-1', session: { surface: { replaceGeneration: 0 } } }
  const userMsg = { role: 'user', content: [{ type: 'text', text: '今天帮我规划一下进度' }], source: { kind: 'user' } }

  const step1 = await env.preStep({ agent }, async () => ({ kind: 'enter', messages: [userMsg] }))
  assert.equal(step1.messages.length, 2)
  assert.equal(step1.messages[0].source.kind, 'dsh-memory/delta')
  assert.equal(step1.messages[0].content[0].text.includes('初始画像冷启动引导'), true)
  assert.equal(step1.messages[0].content[0].text.includes('show_view'), true)
  assert.equal(env.contextApi.sectionFor('main-1'), snapBefore)

  // Second turn on same session -> not repeated
  const step2 = await env.preStep({ agent }, async () => ({ kind: 'enter', messages: [userMsg] }))
  assert.equal(step2.messages.length, 1)

  // Compaction on same session -> does NOT re-trigger onboarding prompt
  agent.session.surface.replaceGeneration = 1
  const step3 = await env.preStep({ agent }, async () => ({ kind: 'enter', messages: [userMsg] }))
  assert.equal(step3.messages.length, 1)

  // Subagent and off/read-only sessions do NOT trigger onboarding
  const subStep = await env.preStep(
    { agent: { id: 'sub-1', session: { header: { origin: 'subagent' }, surface: { replaceGeneration: 0 } } } },
    async () => ({ kind: 'enter', messages: [userMsg] }),
  )
  assert.equal(subStep.messages.length, 1)

  env.store.setSessionMode('off-1', 'off')
  const offStep = await env.preStep(
    { agent: { id: 'off-1', session: { surface: { replaceGeneration: 0 } } } },
    async () => ({ kind: 'enter', messages: [userMsg] }),
  )
  assert.equal(offStep.messages.length, 1)

  env.store.setSessionMode('ro-1', 'read-only')
  const roStep = await env.preStep(
    { agent: { id: 'ro-1', session: { surface: { replaceGeneration: 0 } } } },
    async () => ({ kind: 'enter', messages: [userMsg] }),
  )
  assert.equal(roStep.messages.length, 1)
})

test('onboarding supports pre-session direct write, in-session buffer cache protection, budget guard, skip/reset, and non-empty suppression', async (t) => {
  const env = createOnboardingEnv(t, { maxProfileTokens: 160 })

  // 1. Over-budget submission is rejected cleanly before writing anything
  const overBudget = await env.onboardingApi.submit({
    identity: '超级长的个人背景信息，目的是触发 token 上限保护从而验证原子拒绝。'.repeat(12),
  })
  assert.equal(overBudget.ok, false)
  assert.equal(overBudget.reason, 'PROFILE_BUDGET_EXCEEDED')
  assert.equal(profileApi.readProfile(env.dir), '')
  assert.equal(env.bufferApi.listItems().length, 0)

  // 2. Skip persists across check & reset re-enables
  const skipRes = env.onboardingApi.skip({ reason: 'later' })
  assert.equal(skipRes.status, 'skipped')
  assert.equal(env.onboardingApi.getState().needsOnboarding, false)

  const newSessionStep = await env.preStep(
    { agent: { id: 'main-2', session: { surface: { replaceGeneration: 0 } } } },
    async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
  )
  assert.equal(newSessionStep.messages.length, 1)

  env.onboardingApi.reset()
  assert.equal(env.onboardingApi.getState().needsOnboarding, true)

  // 3. In-session submit protects existing snapshot by downgrading direct -> buffer
  const snapFrozen = env.contextApi.sectionFor('main-3')
  const inSessionRes = await env.onboardingApi.submit({
    sessionId: 'main-3',
    writeMode: 'direct',
    preferences: '汇报先说结论',
    rules: '不修改全局模型覆盖',
    entities: [{ name: '老王', type: 'person', aliases: ['王总'], content: '负责运维' }],
  })
  assert.equal(inSessionRes.ok, true)
  assert.equal(inSessionRes.writeMode, 'buffer')
  assert.equal(inSessionRes.downgradedForCache, true)
  assert.equal(profileApi.readProfile(env.dir), '')
  assert.equal(env.contextApi.sectionFor('main-3'), snapFrozen)
  assert.equal(env.bufferApi.listItems({ statuses: ['approved'] }).length, 3)

  // 4. Pre-session submit (no snapshot for sessionId) writes directly to PROFILE.md with rules pinned
  env.onboardingApi.reset()
  const preSessionRes = await env.onboardingApi.submit({
    sessionId: 'brand-new-pre-session',
    identity: '使用 Windows 11',
    rules: '绝不直接改写 node_modules',
  })
  assert.equal(preSessionRes.ok, true)
  assert.equal(preSessionRes.writeMode, 'direct')
  const entries = profileApi.parseProfileEntries(profileApi.readProfile(env.dir))
  assert.equal(entries.length, 2)
  assert.equal(entries.find(e => e.section === '长期规矩与边界').pinned, true)
  assert.equal(env.onboardingApi.getState().needsOnboarding, false)

  // 5. Non-empty PROFILE.md suppresses automatic onboarding even if onboarding status is reset to pending
  env.onboardingApi.reset()
  assert.equal(env.onboardingApi.getState().needsOnboarding, false)
})

test('onboarding interactive prompt uses ctx.userQuestions when available and skips when all dimensions skipped', async (t) => {
  let askedRequests = 0
  let answerBatch = []
  const env = createOnboardingEnv(t, {
    availableTools: ['ask_user_question'],
    userQuestions: {
      async ask(req) {
        askedRequests += 1
        assert.equal(req.questions.length, 4)
        return { answers: answerBatch }
      },
    },
  })

  // Case A: all skipped -> marks skipped
  answerBatch = [
    { id: 'identity', selected: ['跳过此项'] },
    { id: 'preferences', selected: [] },
    { id: 'rules', selected: ['跳过此项'] },
    { id: 'entities', selected: [] },
  ]
  const onbTool = env.registeredTools.get('memory_onboarding')
  const skippedOut = await onbTool.execute({ action: 'prompt' }, { agent: { id: 'q-sess' }, signal: new AbortController().signal })
  assert.equal(askedRequests, 1)
  assert.equal(skippedOut.includes('skipped'), true)
  assert.equal(env.onboardingApi.getState().status, 'skipped')

  // Case B: reset and fill interactively -> completes and saves
  await onbTool.execute({ action: 'reset' }, { agent: { id: 'q-sess' }, signal: new AbortController().signal })
  answerBatch = [
    { id: 'identity', selected: [], custom: '称呼阿杰，Node.js v24' },
    { id: 'preferences', selected: [], custom: '简洁直接，中文沟通' },
    { id: 'rules', selected: [], custom: '危险命令先确认' },
    { id: 'entities', selected: ['跳过此项'] },
  ]
  const filledOut = await onbTool.execute({ action: 'prompt' }, { agent: { id: 'q-sess' }, signal: new AbortController().signal })
  assert.equal(askedRequests, 2)
  assert.equal(filledOut.includes('writeMode=direct'), true)
  assert.equal(env.onboardingApi.getState().status, 'completed')
  assert.equal(profileApi.readProfile(env.dir).includes('称呼阿杰'), true)
})
