import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as dshMemoryPlugin from '../index.js'
import { createBufferApi } from '../src/buffer.js'
import { normalizeConfig } from '../src/config.js'
import { createContextApi } from '../src/context.js'
import { createDigestApi } from '../src/digest.js'
import { createDreamApi } from '../src/dream.js'
import * as entityApi from '../src/entities.js'
import * as journalApi from '../src/journal.js'
import * as lessonApi from '../src/lessons.js'
import * as profileApi from '../src/profile.js'
import { createMemoryStore } from '../src/store.js'
import { createToolsApi } from '../src/tools.js'

test('store migrates v2 archive.sqlite cleanly to v3 with injected_lessons column and Compaction reset', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-v3-'))
  const dbPath = join(dir, 'archive.sqlite')

  const v2 = new DatabaseSync(dbPath)
  v2.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'default',
      session_id TEXT NOT NULL,
      parent_session_id TEXT,
      is_subagent INTEGER NOT NULL DEFAULT 0,
      logical_date TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      anchor TEXT NOT NULL,
      UNIQUE(session_id, seq)
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, logical_date UNINDEXED, scope UNINDEXED, anchor UNINDEXED, content='messages', content_rowid='id', tokenize='trigram');
    CREATE TABLE session_state (
      session_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'default',
      parent_session_id TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'full',
      last_seq INTEGER NOT NULL DEFAULT -1,
      replace_generation INTEGER NOT NULL DEFAULT 0,
      buffer_cursor TEXT,
      injected_entities TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE rollover_state (
      logical_date TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      completed_at INTEGER,
      PRIMARY KEY (logical_date, scope)
    );
    CREATE TABLE memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO session_state (session_id, injected_entities, updated_at) VALUES ('s-old', '["ent-a"]', 1000);
    PRAGMA user_version = 2;
  `)
  v2.close()

  const store = createMemoryStore(dbPath)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4)
  const cols = store.db.prepare("PRAGMA table_info('session_state')").all().map(c => c.name)
  assert.equal(cols.includes('injected_lessons'), true)
  assert.equal(cols.includes('scene_mode'), true)
  const embTable = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'").get()
  assert.equal(embTable?.name, 'embeddings')

  const oldRow = store.getSessionState('s-old')
  assert.deepEqual(oldRow.injectedEntities, ['ent-a'])
  assert.deepEqual(oldRow.injectedLessons, [])

  store.upsertSessionState('s-old', { injectedLessons: ['nginx-deploy'] })
  assert.deepEqual(store.getSessionState('s-old').injectedLessons, ['nginx-deploy'])

  store.resetSessionDeltaCursor('s-old', 1, 2000)
  const reset = store.getSessionState('s-old')
  assert.deepEqual(reset.injectedEntities, [])
  assert.deepEqual(reset.injectedLessons, [])
})

test('lessons CRUD, slug safety, secret guard, duplicate idempotency, pinned/expires, and dual-hit matchLessonsInText', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-les-crud-'))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  assert.equal(lessonApi.lessonSlug('con'), 'les-con')
  assert.equal(lessonApi.lessonSlug('Nginx 部署指南'), 'nginx-部署指南')

  const blocked = await lessonApi.upsertLesson(dir, {
    name: 'Nginx 部署',
    content: 'api_key=sk-proj-1234567890abcdef1234567890',
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'SECRET_DETECTED')

  const created = await lessonApi.upsertLesson(dir, {
    name: 'Nginx 部署',
    tags: ['deploy', 'nginx'],
    triggers: ['nginx -t', '反代'],
    content: '重载前必须先跑 nginx -t 校验配置语法。',
    added: '2026-11-20',
    source: 'manual',
    pinned: true,
    expires: '2026-12-31',
  })
  assert.equal(created.ok, true)
  assert.equal(created.entryId, 'les_01')

  const dup = await lessonApi.upsertLesson(dir, {
    name: 'Nginx 部署',
    content: '重载前必须先跑 nginx -t 校验配置语法',
  })
  assert.equal(dup.ok, true)
  assert.equal(dup.duplicate, true)
  assert.equal(dup.entryId, 'les_01')

  await lessonApi.upsertLesson(dir, {
    name: 'dsh-ctrl 构建',
    tags: ['build', 'dsh-ctrl'],
    triggers: ['npm run build'],
    content: '禁止直接跑 npm run build，改用 node scripts/build-client.mjs。',
    added: '2026-11-21',
    source: 'manual',
  })

  const pinnedDeleteBlocked = await lessonApi.deleteLesson(dir, 'Nginx 部署')
  assert.equal(pinnedDeleteBlocked.ok, false)
  assert.equal(pinnedDeleteBlocked.reason, 'PINNED_PROTECTED')

  const pinnedReplaceBlocked = await lessonApi.upsertLesson(dir, {
    name: 'Nginx 部署',
    op: 'replace',
    targetId: 'les_01',
    content: '尝试未经允许改写',
  })
  assert.equal(pinnedReplaceBlocked.ok, false)
  assert.equal(pinnedReplaceBlocked.reason, 'PINNED_PROTECTED')

  const forcedReplace = await lessonApi.upsertLesson(dir, {
    name: 'Nginx 部署',
    op: 'replace',
    targetId: 'les_01',
    content: '重载前必须执行 nginx -t 并检查端口冲突。',
    allowPinned: true,
  })
  assert.equal(forcedReplace.ok, true)
  assert.equal(forcedReplace.lesson.entries[0].supersedes, 'les_01')
  assert.equal(forcedReplace.lesson.entries[0].expires, '2026-12-31')

  // Boundary check: mynginx2 does NOT trigger ASCII word 'nginx'
  assert.equal(lessonApi.matchLessonsInText(dir, 'check mynginx2 container').length, 0)

  // Tags-only matching works
  const tagOnly = lessonApi.matchLessonsInText(dir, '', { tags: ['BUILD'] })
  assert.equal(tagOnly.length, 1)
  assert.equal(tagOnly[0].lesson.slug, 'dsh-ctrl-构建')

  // Dual hit (tag + text trigger) ranks before single-dimension match even if later in text
  const ranked = lessonApi.matchLessonsInText(dir, 'npm run build 之后要看下 nginx -t 报错', { tags: ['deploy'] })
  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].lesson.slug, 'nginx-部署')
  assert.equal(ranked[0].matchedTags.includes('deploy'), true)
})

test('agent/pre-step injects matched lessons once without invalidating frozen prefix, resets on compaction, and skips off mode', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-les-ctx-'))
  const nowMs = Date.parse('2026-11-23T14:00:00+08:00')
  const config = normalizeConfig({
    home: dir,
    timeZone: 'Asia/Shanghai',
    sections: { lessons: { enabled: true, maxTokens: 120 } },
    onboarding: { enabled: false },
    briefing: { enabled: false },
  })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  const registeredListeners = new Map()
  const ctx = {
    effect: fn => fn(),
    on: (name, fn) => {
      registeredListeners.set(name, fn)
      return () => registeredListeners.delete(name)
    },
    systemPrompt: { section: () => () => {} },
  }

  const bufferApi = createBufferApi({ home: dir, profileApi, lessonApi, clock: { now: () => nowMs } })
  const contextApi = createContextApi({
    ctx,
    config,
    store,
    profileApi,
    journalApi,
    bufferApi,
    entityApi,
    lessonApi,
    clock: { now: () => nowMs },
  })
  contextApi.install()

  const snapBefore = contextApi.sectionFor('sess-1')
  assert.equal(snapBefore.includes('memory_lesson_manage'), true)

  await lessonApi.upsertLesson(dir, {
    name: '生产发布守则',
    tags: ['release'],
    triggers: ['上线发布', 'pm2'],
    content: '切勿在高峰期直接重启主进程，先切流量。',
    added: '2026-11-22',
    source: 'manual',
  })

  // Frozen snapshot must remain byte-identical after lessons/ updates
  assert.equal(contextApi.sectionFor('sess-1'), snapBefore)

  const preStep = registeredListeners.get('agent/pre-step')
  const agent = {
    id: 'sess-1',
    session: { surface: { replaceGeneration: 0 }, header: { origin: 'user' } },
  }

  const first = await preStep({ agent }, async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: '准备用 pm2 上线发布新版本' }] }],
  }))
  assert.equal(first.messages.length, 2)
  assert.equal(first.messages[0].source.kind, 'dsh-memory/delta')
  assert.equal(first.messages[0].content[0].text.includes('## 命中避坑经验（dsh-memory）'), true)
  assert.equal(first.messages[0].content[0].text.includes('先切流量'), true)
  assert.deepEqual(store.getSessionState('sess-1').injectedLessons, ['生产发布守则'])

  // Second turn mentioning same trigger must NOT re-inject
  const second = await preStep({ agent }, async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: '再次检查 pm2 状态' }] }],
  }))
  assert.equal(second.messages.length, 1)

  // Compaction bumps replaceGeneration -> resets injected_lessons -> re-injects once
  agent.session.surface.replaceGeneration = 1
  const afterCompact = await preStep({ agent }, async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: '压缩后继续检查 pm2' }] }],
  }))
  assert.equal(afterCompact.messages.length, 2)
  assert.equal(afterCompact.messages[0].content[0].text.includes('先切流量'), true)

  // Mode 'off' blocks lesson injection
  store.setSessionMode('sess-off', 'off', nowMs)
  const offRes = await preStep(
    { agent: { id: 'sess-off', session: { surface: { replaceGeneration: 0 }, header: { origin: 'user' } } } },
    async () => ({
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'pm2 上线发布' }] }],
    }),
  )
  assert.equal(offRes.messages.length, 1)
})

test('buffer settlement, daily digest, Dream governance, memory_forget, and public dshMemory.matchLessons full loop', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-les-loop-'))
  let nowMs = Date.parse('2026-11-23T12:00:00+08:00')
  const clock = { now: () => nowMs }

  const root = new Context()
  const tools = new Map()
  root.provide('llm', {
    async* stream(req) {
      const prompt = req?.messages?.[0]?.content?.[0]?.text ?? ''
      let text
      if (prompt.includes('Dream') || req.system?.includes('Dream Consolidator')) {
        text = JSON.stringify({
          proposals: [
            { target: 'lesson:Nginx部署', op: 'retire', targetId: 'les_99', content: '不存在', reason: 'missing' },
            { target: 'lesson:Nginx部署', op: 'retire', targetId: 'les_01', content: '试图淘汰锁定避坑条', reason: 'pinned' },
            { target: 'lesson:Nginx部署', op: 'retire', targetId: 'les_02', content: '无锚点试图删去高权威条', reason: 'no anchor' },
            {
              target: 'lesson:Nginx部署',
              op: 'replace',
              targetId: 'les_02',
              content: '[CONFLICT] 改为直接 reload？（旧规则禁止未测 reload）[chat://2026-11-22#s1#1]',
              reason: 'verified conflict proposal',
              evidenceAnchor: 'chat://2026-11-22#s1#1',
              conflict: true,
            },
          ],
        })
      } else {
        text = [
          '# 2026-11-22 日报',
          '## 发生了什么',
          '- [chat://2026-11-22#s1#1] 梳理了 Nginx 部署与回滚避坑。',
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
      }
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
    apply(ctx, cfg) {
      rt = dshMemoryPlugin.createMemoryRuntime(ctx, cfg, {
        clock,
        startTimer: false,
        autoCatchUp: false,
      })
    },
  }, { home: dir, timeZone: 'Asia/Shanghai' })
  await fork

  t.after(async () => {
    try { await root.fiber.dispose() } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  const svc = root.get(dshMemoryPlugin.SERVICE_NAME)
  assert.ok(svc)

  rt.store.insertMessage({
    sessionId: 's1',
    logicalDate: '2026-11-22',
    seq: 1,
    role: 'user',
    text: '注意：Nginx 部署绝不能跳过 nginx -t',
    timestamp: Date.parse('2026-11-22T12:00:00+08:00'),
    anchor: 'chat://2026-11-22#s1#1',
  })

  // Submit verified explicit + spoofed explicit lesson candidate via public service
  const goodCand = await svc.submitBufferCandidate({
    target: 'lesson:Nginx部署',
    sourceType: 'explicit',
    logicalDate: '2026-11-22',
    tags: ['deploy', 'nginx'],
    triggers: ['nginx', '反向代理'],
    content: '绝不能跳过 nginx -t 直接 reload。',
    anchor: 'chat://2026-11-22#s1#1',
    pinned: true,
    producer: 'worker-deploy',
  })
  assert.equal(goodCand.ok, true)
  assert.equal(goodCand.sourceType, 'explicit')

  const spoofedCand = await svc.submitBufferCandidate({
    target: 'lesson:Nginx部署',
    sourceType: 'explicit',
    logicalDate: '2026-11-22',
    content: '没有合法锚点不能直接写死',
    anchor: 'chat://2026-11-22#s1#999',
  })
  assert.equal(spoofedCand.ok, true)
  assert.equal(spoofedCand.downgraded, true)
  assert.equal(spoofedCand.sourceType, 'extracted')

  // Daily digest settles verified explicit item into lessons/nginx部署.md
  const digRes = await rt.digestApi.generateDailyDigest('2026-11-22', { scope: 'default' })
  assert.equal(digRes.lessonSettlement.committed.length, 1)
  assert.equal(digRes.lessonSettlement.deferred.length, 1)

  // Duplicate lesson candidate blocked by guard against committed lessons/*.md
  const dupAfterCommit = await svc.submitBufferCandidate({
    target: 'lesson:Nginx部署',
    sourceType: 'explicit',
    logicalDate: '2026-11-23',
    content: '绝不能跳过 nginx -t 直接 reload',
    anchor: 'chat://2026-11-22#s1#1',
  })
  assert.equal(dupAfterCommit.ok, true)
  assert.equal(dupAfterCommit.duplicate, true)
  assert.equal(dupAfterCommit.duplicateIn, 'lesson')

  // Seed extra entries (normal + expired + duplicate) for Dream & public API budget checks
  await rt.lessonApi.upsertLesson(dir, {
    name: 'Nginx部署',
    content: '禁止无备份覆盖线上 nginx.conf',
    added: '2026-11-20',
    source: 'manual',
  })
  await rt.lessonApi.upsertLesson(dir, {
    name: 'Nginx部署',
    content: '十月临时调试端口避坑条款',
    added: '2026-10-01',
    expires: '2026-11-10',
    source: 'extracted',
  })
  await rt.lessonApi.upsertLesson(dir, {
    name: 'Nginx部署',
    content: '禁止无备份覆盖线上 nginx.conf',
    added: '2026-11-21',
    source: 'extracted',
    allowDuplicate: true,
  })
  await rt.lessonApi.upsertLesson(dir, {
    name: '大体积额外经验',
    tags: ['deploy'],
    content: '用于触发公共服务预算裁剪的冗长避坑经验条目。'.repeat(20),
    added: '2026-11-22',
    source: 'manual',
  })

  // Public service matchLessons checks dual-hit ranking + maxTokens trimming + getLesson/listLessons
  const svcMatch = svc.matchLessons('上线 nginx 反代检查', { tags: ['deploy'], maxTokens: 160 })
  assert.equal(svcMatch.totalMatched, 2)
  assert.equal(svcMatch.matches.length, 1)
  assert.equal(svcMatch.matches[0].name, 'Nginx部署')
  assert.ok(svc.getLesson('nginx部署'))
  assert.equal(svc.listLessons().length, 2)

  // Dream processes rule (expires + duplicate) & LLM proposals (pinned/authority/not_found/conflict)
  const dreamDry = await rt.dreamApi.runDream({ dryRun: true, force: true, useLlm: true })
  assert.equal(dreamDry.llmStatus, 'ok')
  assert.equal(dreamDry.proposals.some(p => p.target === 'lesson:Nginx部署' && p.targetId === 'les_03'), true)
  assert.equal(dreamDry.proposals.some(p => p.target === 'lesson:Nginx部署' && p.targetId === 'les_04'), true)
  assert.equal(dreamDry.proposals.some(p => p.conflict === true && p.targetId === 'les_02'), true)
  assert.equal(dreamDry.skippedReasons.some(s => s.reason === 'TARGET_NOT_FOUND' && s.candidate.targetId === 'les_99'), true)
  assert.equal(dreamDry.skippedReasons.some(s => s.reason === 'PINNED_PROTECTED' && s.candidate.targetId === 'les_01'), true)
  assert.equal(dreamDry.skippedReasons.some(s => s.reason === 'AUTHORITY_PROTECTED' && s.candidate.targetId === 'les_02'), true)

  // memory_forget respects pinned unless force=true
  const forgetSafe = await tools.get('memory_forget').execute(
    { anchor: 'chat://2026-11-22#s1#1' },
    { agent: { id: 's1' }, signal: new AbortController().signal },
  )
  assert.equal(forgetSafe.includes('skipped pinned: nginx部署:les_01'), true)

  const forgetForced = await tools.get('memory_forget').execute(
    { keyword: 'nginx -t', force: true },
    { agent: { id: 's1' }, signal: new AbortController().signal },
  )
  assert.equal(forgetForced.includes('Redacted 1 lesson card(s): nginx部署'), true)
  assert.equal(rt.lessonApi.readLesson(dir, 'Nginx部署').entries.some(e => e.content.includes('已按用户要求遗忘')), true)
})

test('searchLessons searches lesson body entries with AND priority and OR coverage fallback', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-les-search-'))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  assert.deepEqual(lessonApi.searchLessons(dir, { query: 'ECONNREFUSED' }), [])
  assert.deepEqual(lessonApi.searchLessons(dir, { query: '' }), [])

  await lessonApi.upsertLesson(dir, {
    name: '反向代理排查',
    tags: ['proxy', 'network'],
    triggers: ['502', 'upstream'],
    content: '出现 ECONNREFUSED 时先检查上游服务 18080 端口是否监听。',
    added: '2026-11-24',
    source: 'chat://2026-11-24#main#3',
  })
  await lessonApi.upsertLesson(dir, {
    name: '本地构建说明',
    tags: ['build'],
    triggers: ['build'],
    content: '上游服务端口冲突时先清理占用进程。',
    added: '2026-11-24',
    source: 'manual',
  })

  // Body-only error code match (not in card title/tags/triggers)
  const bodyHits = lessonApi.searchLessons(dir, { query: 'ECONNREFUSED' })
  assert.equal(bodyHits.length, 1)
  assert.equal(bodyHits[0].name, '反向代理排查')
  assert.equal(bodyHits[0].entryId, 'les_01')

  // Cross header + body strict AND match
  const crossHits = lessonApi.searchLessons(dir, { query: 'proxy 18080' })
  assert.equal(crossHits.length, 1)
  assert.equal(crossHits[0].name, '反向代理排查')
  assert.equal(crossHits[0].isAndMatch, true)

  // Multi-term OR coverage fallback: 2 matched terms ranks above 1 matched term
  const orHits = lessonApi.searchLessons(dir, { query: '上游服务 ECONNREFUSED 不存在词' })
  assert.equal(orHits.length, 2)
  assert.equal(orHits[0].name, '反向代理排查')
  assert.equal(orHits[1].name, '本地构建说明')

  // Case-insensitive match
  const caseHits = lessonApi.searchLessons(dir, { query: 'econnrefused' })
  assert.equal(caseHits.length, 1)
  assert.equal(caseHits[0].name, '反向代理排查')
})
