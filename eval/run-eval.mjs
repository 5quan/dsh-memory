import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBufferApi } from '../src/buffer.js'
import { normalizeConfig } from '../src/config.js'
import { createContextApi } from '../src/context.js'
import * as entityApi from '../src/entities.js'
import * as journalApi from '../src/journal.js'
import * as lessonApi from '../src/lessons.js'
import * as profileApi from '../src/profile.js'
import { createMemoryStore } from '../src/store.js'
import { estimateTokens } from '../src/util.js'
import { createVectorApi, rrfMerge } from '../src/vector.js'

const DEFAULT_DATASET_PATH = resolve(import.meta.dirname, 'dataset.json')

function scoreAnswer(answerText, expectedFacts) {
  const lower = String(answerText ?? '').toLowerCase()
  let hits = 0
  for (const fact of expectedFacts) {
    if (lower.includes(String(fact).toLowerCase())) hits += 1
  }
  return expectedFacts.length > 0 ? hits / expectedFacts.length : 1
}

function extractSearchTerms(question) {
  const stopWords = new Set(['什么', '哪个', '多少', '以前', '现在', '怎么', '应该', '如何', '我们', '之前', '时候', '具体', '文件', '路径'])
  const terms = []
  const seen = new Set()
  const add = (term) => {
    const clean = term.trim()
    if (!clean || clean.length < 2 || stopWords.has(clean)) return
    const lower = clean.toLowerCase()
    if (seen.has(lower)) return
    seen.add(lower)
    terms.push(clean)
  }

  for (const m of String(question ?? '').matchAll(/[A-Za-z0-9_.-]{2,}/g)) {
    add(m[0])
  }
  const cjkSpans = String(question ?? '').match(/[\u3400-\u9FFF]{2,}/g) ?? []
  for (const span of cjkSpans) {
    for (let i = 0; i <= span.length - 2; i += 2) {
      add(span.slice(i, i + 2))
    }
    if (span.length >= 2) {
      add(span.slice(-2))
    }
  }
  return terms.slice(0, 10).join(' ')
}

function buildDshMemoryContextForCase(env, item, { useVector = false } = {}) {
  const t0 = performance.now()
  const frozen = env.contextApi.sectionFor('eval-session')
  const matchedEntities = entityApi.matchEntitiesInText(env.dir, item.question)
  const entityText = matchedEntities
    .map(m => entityApi.formatEntityCardForPrompt(m.entity))
    .join('\n\n')
  const matchedLessons = lessonApi.matchLessonsInText(env.dir, item.question)
  const lessonText = matchedLessons
    .map(m => lessonApi.formatLessonCardForPrompt(m.lesson))
    .join('\n\n')

  const terms = extractSearchTerms(item.question)

  const msgHits = terms ? env.store.searchMessages({ query: terms, limit: 3 }) : []
  const journalHits = terms ? journalApi.searchJournals(env.dir, { query: terms, limit: 3 }) : []
  const entityBodyHits = terms ? entityApi.searchEntities(env.dir, { query: terms, limit: 2 }) : []
  const lessonBodyHits = terms ? lessonApi.searchLessons(env.dir, { query: terms, limit: 2 }) : []

  const searchBlocks = []
  for (const c of [...entityBodyHits, ...lessonBodyHits]) {
    searchBlocks.push(`[Card ${c.kind}:${c.name}] ${c.snippet}`)
  }
  for (const j of journalHits) {
    searchBlocks.push(`[Journal ${j.date}] ${j.line}`)
  }
  for (const m of msgHits) {
    const ctxWin = env.store.getMessageContext({ anchor: m.anchor, before: 1, after: 1 })
    const rows = ctxWin ? ctxWin.messages : [m]
    searchBlocks.push(rows.map(r => `[${r.anchor}] (${r.role}) ${r.text}`).join('\n'))
  }

  if (useVector && env.vectorApi) {
    const vecHits = env.vectorApi.search({ query: item.question, limit: 3, autoSync: false })
    const ftsKeys = [
      ...entityBodyHits.map(h => ({ key: `entity:${h.slug}`, snippet: h.snippet, sourceChannel: 'card' })),
      ...lessonBodyHits.map(h => ({ key: `lesson:${h.slug}`, snippet: h.snippet, sourceChannel: 'card' })),
      ...journalHits.map(h => ({ key: `journal:${h.date}`, snippet: h.line, sourceChannel: 'journal' })),
      ...msgHits.map(h => ({ key: `msg:${h.anchor}`, snippet: h.text, sourceChannel: 'fts5' })),
    ]
    const fused = rrfMerge([
      ftsKeys,
      vecHits.map(vh => ({
        key: vh.docKey,
        snippet: vh.snippet,
        vectorScore: vh.score,
        sourceChannel: 'vector',
      })),
    ], { k: env.config.retrieval.vector.rrfK, limit: 4 })
    for (const f of fused) {
      if (f.sources.includes('vector')) {
        searchBlocks.push(`[Vector+RRF ${f.key} score=${f.rrfScore.toFixed(4)}] ${f.snippet}`)
      }
    }
  }

  return {
    frozenPrompt: frozen,
    dynamicContext: [entityText, lessonText, searchBlocks.join('\n')].filter(Boolean).join('\n\n'),
    latencyMs: performance.now() - t0,
  }
}

async function seedDatasetIntoHome(dir, dataset) {
  const clock = { now: () => Date.parse(`${dataset.todayDate}T09:00:00+08:00`) }
  const config = normalizeConfig({
    home: dir,
    timeZone: dataset.timeZone || 'Asia/Shanghai',
  })
  const store = createMemoryStore(join(dir, 'archive.sqlite'))

  await profileApi.applyProfileBatch(
    dir,
    (dataset.profile ?? []).map(p => ({
      op: 'add',
      section: p.section,
      content: p.content,
      added: p.added,
      source: p.source,
      pinned: p.pinned === true,
    })),
    { maxTokens: config.sections.profile.maxTokens },
  )

  for (const ent of dataset.entities ?? []) {
    for (const fact of ent.facts ?? []) {
      await entityApi.upsertEntity(dir, {
        name: ent.name,
        type: ent.type,
        aliases: ent.aliases ?? [],
        op: 'add',
        content: fact.content,
        added: fact.added,
        source: fact.source,
      })
    }
  }

  for (const lesson of dataset.lessons ?? []) {
    for (const entry of lesson.entries ?? []) {
      await lessonApi.upsertLesson(dir, {
        name: lesson.name,
        tags: lesson.tags ?? [],
        triggers: lesson.triggers ?? [],
        op: 'add',
        content: entry.content,
        added: entry.added,
        source: entry.source,
        pinned: entry.pinned === true,
      })
    }
  }

  for (const jr of dataset.journals ?? []) {
    await journalApi.writeJournalAtomic(dir, jr.date, jr.markdown)
  }

  for (const msg of dataset.messages ?? []) {
    store.insertMessage({
      scope: 'default',
      sessionId: msg.sessionId,
      logicalDate: msg.logicalDate,
      seq: msg.seq,
      role: msg.role,
      text: msg.text,
      timestamp: Date.parse(msg.timestamp),
      anchor: `chat://${msg.logicalDate}#${msg.sessionId}#${msg.seq}`,
    })
  }

  const bufferApi = createBufferApi({ home: dir, config, profileApi, lessonApi, clock })
  const vectorApi = createVectorApi({
    config,
    store,
    journalApi,
    entityApi,
    lessonApi,
    profileApi,
    clock,
  })
  vectorApi.syncIndex({ scope: 'default' })

  const contextApi = createContextApi({
    ctx: { effect() {}, on() {}, systemPrompt: { section() {} } },
    config,
    store,
    profileApi,
    journalApi,
    bufferApi,
    entityApi,
    lessonApi,
    vectorApi,
    clock,
  })

  return { dir, config, store, bufferApi, vectorApi, contextApi }
}

async function callOpenAiCompatible({ baseUrl, apiKey, model, system, prompt }) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
    }),
  })
  if (!res.ok) {
    throw new Error(`Eval LLM HTTP ${res.status}: ${await res.text()}`)
  }
  const data = await res.json()
  return {
    text: data?.choices?.[0]?.message?.content ?? '',
    promptTokens: data?.usage?.prompt_tokens ?? null,
    cachedTokens: data?.usage?.prompt_tokens_details?.cached_tokens ?? 0,
  }
}

export async function runAblationEval({
  datasetPath = DEFAULT_DATASET_PATH,
  dryRun = true,
  baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
  apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
  model = process.env.LLM_MODEL || 'gpt-4o-mini',
} = {}) {
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'))
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-eval-'))
  let env

  try {
    env = await seedDatasetIntoHome(dir, dataset)
    const arms = ['no-memory', 'dsh-memory', 'gold-memory']
    const results = Object.fromEntries(arms.map(a => [a, { scores: [], inputTokens: [], cachedTokens: [], details: [] }]))

    for (const item of dataset.cases) {
      const dshCtx = buildDshMemoryContextForCase(env, item)
      const payloads = {
        'no-memory': { system: '你是一个个人助理，只根据已知信息如实回答，不知则说明不知道。', dynamic: '', cachedPrefix: 0 },
        'dsh-memory': { system: dshCtx.frozenPrompt, dynamic: dshCtx.dynamicContext, cachedPrefix: estimateTokens(dshCtx.frozenPrompt) },
        'gold-memory': { system: '你是一个个人助理，请根据提供的黄金记忆准确回答问题。', dynamic: item.goldMemory, cachedPrefix: 0 },
      }

      for (const arm of arms) {
        const p = payloads[arm]
        const userPrompt = p.dynamic ? `补充记忆：\n${p.dynamic}\n\n问题：${item.question}` : `问题：${item.question}`
        const estPromptTokens = estimateTokens(p.system) + estimateTokens(userPrompt)

        if (dryRun) {
          const combinedContext = `${p.system}\n${p.dynamic}`
          const contextRecall = scoreAnswer(combinedContext, item.expectedFacts)
          results[arm].scores.push(contextRecall)
          results[arm].inputTokens.push(estPromptTokens)
          results[arm].cachedTokens.push(p.cachedPrefix)
          results[arm].details.push({ id: item.id, category: item.category, score: contextRecall, tokens: estPromptTokens })
        } else {
          const reply = await callOpenAiCompatible({ baseUrl, apiKey, model, system: p.system, prompt: userPrompt })
          const acc = scoreAnswer(reply.text, item.expectedFacts)
          const totalIn = reply.promptTokens ?? estPromptTokens
          const cached = reply.cachedTokens || p.cachedPrefix
          results[arm].scores.push(acc)
          results[arm].inputTokens.push(totalIn)
          results[arm].cachedTokens.push(cached)
          results[arm].details.push({ id: item.id, category: item.category, score: acc, tokens: totalIn, answer: reply.text })
        }
      }
    }

    const avg = arr => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
    const summary = arms.map((arm) => {
      const r = results[arm]
      const avgInput = avg(r.inputTokens)
      const avgCached = avg(r.cachedTokens)
      // Model effective uncached token equivalent (cached prefix weighted at 0.1x)
      const effectiveTokens = Math.max(0, avgInput - avgCached) + avgCached * 0.1
      return {
        arm,
        cases: r.scores.length,
        accuracy: Number((avg(r.scores) * 100).toFixed(1)),
        avgInputTokens: Math.round(avgInput),
        avgCachedPrefixTokens: Math.round(avgCached),
        effectiveUncachedTokens: Math.round(effectiveTokens),
        details: r.details,
      }
    })

    // Offline retrieval ablation: FTS5-only vs FTS5 + Local Float32Array Vector (RRF)
    const ftsScores = []
    const ftsLatencies = []
    const rrfScores = []
    const rrfLatencies = []
    for (const item of dataset.cases) {
      const ftsCtx = buildDshMemoryContextForCase(env, item, { useVector: false })
      ftsScores.push(scoreAnswer(`${ftsCtx.frozenPrompt}\n${ftsCtx.dynamicContext}`, item.expectedFacts))
      ftsLatencies.push(ftsCtx.latencyMs)

      const rrfCtx = buildDshMemoryContextForCase(env, item, { useVector: true })
      rrfScores.push(scoreAnswer(`${rrfCtx.frozenPrompt}\n${rrfCtx.dynamicContext}`, item.expectedFacts))
      rrfLatencies.push(rrfCtx.latencyMs)
    }

    return {
      dryRun,
      caseCount: dataset.cases.length,
      summary,
      retrievalAblation: {
        ftsOnly: {
          accuracy: Number((avg(ftsScores) * 100).toFixed(1)),
          avgLatencyMs: Number(avg(ftsLatencies).toFixed(2)),
        },
        hybridRrf: {
          accuracy: Number((avg(rrfScores) * 100).toFixed(1)),
          avgLatencyMs: Number(avg(rrfLatencies).toFixed(2)),
        },
      },
    }
  } finally {
    try { env?.store?.close() } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  }
}

function isDirectCliRun() {
  if (!process.argv[1]) return false
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href
}

if (isDirectCliRun()) {
  const args = new Set(process.argv.slice(2))
  const hasApiKey = Boolean(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY)
  const dryRun = args.has('--dry-run') || !hasApiKey
  if (!dryRun && !hasApiKey) {
    console.error('Missing LLM_API_KEY or OPENAI_API_KEY; pass --dry-run for offline evaluation.')
    process.exit(1)
  }

  const report = await runAblationEval({ dryRun })
  console.log(`dsh-memory 3-way ablation (${report.dryRun ? 'OFFLINE DRY-RUN (context recall)' : 'LIVE LLM'}, ${report.caseCount} cases):`)
  console.table(report.summary.map(row => ({
    Arm: row.arm,
    'Accuracy/Recall (%)': row.accuracy,
    'Avg Input Tokens': row.avgInputTokens,
    'Cached Prefix Tokens': row.avgCachedPrefixTokens,
    'Effective Cost Tokens': row.effectiveUncachedTokens,
  })))
  if (report.retrievalAblation) {
    console.log('Retrieval ablation (FTS5+Keyword only vs FTS5+Local Vector RRF):')
    console.table([
      {
        Mode: 'fts-only (default)',
        'Recall (%)': report.retrievalAblation.ftsOnly.accuracy,
        'Avg Latency (ms)': report.retrievalAblation.ftsOnly.avgLatencyMs,
      },
      {
        Mode: 'fts+vector (RRF)',
        'Recall (%)': report.retrievalAblation.hybridRrf.accuracy,
        'Avg Latency (ms)': report.retrievalAblation.hybridRrf.avgLatencyMs,
      },
    ])
  }
}
