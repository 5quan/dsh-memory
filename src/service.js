import { snapshotLiveConfig } from './config.js'
import { MemoryGuardError } from './guard.js'
import { estimateTokens, logicalDateOf } from './util.js'

export const SERVICE_NAME = 'dshMemory'
export const DAY_ROLLED_OVER_EVENT = 'dsh-memory/day-rolled-over'

const ALLOWED_EXTERNAL_SOURCES = new Set(['explicit', 'correction', 'extracted', 'dream'])

export function createPublicService({
  config,
  store,
  bufferApi,
  entityApi,
  lessonApi,
  briefingApi,
  onboardingApi,
  clock = { now: () => Date.now() },
}) {
  function getCurrentLogicalDate() {
    return logicalDateOf(clock.now(), {
      timeZone: config.timeZone,
      dayStartHour: config.dayStartHour,
    })
  }

  function getMorningBriefing(options = {}) {
    return briefingApi.getMorningBriefing(options)
  }

  function markBriefingDelivered(options = {}) {
    return briefingApi.markDelivered(options)
  }

  async function confirmBufferItems(options = {}) {
    return await briefingApi.confirmItems(options)
  }

  function packMatchedCards(rawHits, { maxTokens, formatCard, toMatch }) {
    const kept = []
    const blocks = []
    let usedTokens = 0

    for (const hit of rawHits) {
      const cardText = formatCard(hit)
      const cost = estimateTokens(cardText)
      if (maxTokens > 0 && usedTokens + cost > maxTokens && kept.length > 0) {
        continue
      }
      kept.push(toMatch(hit, cardText))
      blocks.push(cardText)
      usedTokens += cost
    }

    return {
      totalMatched: rawHits.length,
      matches: kept,
      text: blocks.join('\n\n'),
      estimatedTokens: usedTokens,
    }
  }

  function matchEntities(text, { maxTokens = config.sections.entities.maxTokens } = {}) {
    if (!entityApi) {
      return { matches: [], text: '', totalMatched: 0, estimatedTokens: 0 }
    }
    const rawHits = entityApi.matchEntitiesInText(config.home, text)
    return packMatchedCards(rawHits, {
      maxTokens,
      formatCard: hit => entityApi.formatEntityCardForPrompt(hit.entity),
      toMatch: (hit, cardText) => ({
        slug: hit.entity.slug,
        name: hit.entity.name,
        type: hit.entity.type,
        aliases: [...hit.entity.aliases],
        matchedTrigger: hit.matchedTrigger,
        matchIndex: hit.matchIndex,
        facts: hit.entity.facts.map(f => ({
          id: f.id,
          content: f.content,
          added: f.added,
          source: f.source,
          pinned: f.pinned === true,
        })),
        cardText,
      }),
    })
  }

  function getEntity(nameOrSlug) {
    return entityApi?.readEntity(config.home, nameOrSlug)
  }

  function listEntities() {
    return entityApi ? entityApi.listEntities(config.home) : []
  }

  function matchLessons(text = '', { tags = [], maxTokens = config.sections.lessons?.maxTokens ?? 1500 } = {}) {
    if (!lessonApi) {
      return { matches: [], text: '', totalMatched: 0, estimatedTokens: 0 }
    }
    const rawHits = lessonApi.matchLessonsInText(config.home, text, { tags })
    return packMatchedCards(rawHits, {
      maxTokens,
      formatCard: hit => lessonApi.formatLessonCardForPrompt(hit.lesson),
      toMatch: (hit, cardText) => ({
        slug: hit.lesson.slug,
        name: hit.lesson.name,
        tags: [...hit.lesson.tags],
        triggers: [...hit.lesson.triggers],
        matchedTrigger: hit.matchedTrigger,
        matchIndex: hit.matchIndex,
        matchedTags: [...hit.matchedTags],
        entries: hit.lesson.entries
          .filter(e => !e.rawOnly)
          .map(e => ({
            id: e.id,
            content: e.content,
            added: e.added,
            source: e.source,
            ...(e.expires ? { expires: e.expires } : {}),
            pinned: e.pinned === true,
          })),
        cardText,
      }),
    })
  }

  function getLesson(nameOrSlug) {
    return lessonApi?.readLesson(config.home, nameOrSlug)
  }

  function listLessons() {
    return lessonApi ? lessonApi.listLessons(config.home) : []
  }

  async function submitBufferCandidate(input = {}) {
    const content = String(input.content ?? '').trim()
    if (content === '') {
      return { ok: false, reason: 'CONTENT_REQUIRED' }
    }

    const target = input.target ?? 'profile'
    const validTarget = (
      target === 'profile'
      || target === 'note'
      || (typeof target === 'string' && target.startsWith('entity:') && target.slice('entity:'.length).trim().length > 0)
      || (typeof target === 'string' && target.startsWith('lesson:') && target.slice('lesson:'.length).trim().length > 0)
    )
    if (!validTarget) {
      return { ok: false, reason: 'INVALID_TARGET', target }
    }

    const requestedSource = ALLOWED_EXTERNAL_SOURCES.has(input.sourceType) ? input.sourceType : 'extracted'
    let effectiveSource = requestedSource
    let downgraded = false

    let candidateAnchor = typeof input.anchor === 'string' && input.anchor.trim() !== '' ? input.anchor.trim() : null
    if (!candidateAnchor && input.sessionId) {
      candidateAnchor = store.getLatestUserOrCardMessage?.(input.sessionId)?.anchor ?? store.getLatestUserMessage?.(input.sessionId)?.anchor ?? null
    }

    if (effectiveSource === 'explicit' || effectiveSource === 'correction') {
      const msg = candidateAnchor ? store.getMessageByAnchor(candidateAnchor) : undefined
      if (!msg || (msg.role !== 'user' && msg.role !== 'card')) {
        effectiveSource = 'extracted'
        downgraded = true
      }
    }

    const logicalDate = input.logicalDate || getCurrentLogicalDate()
    let created
    try {
      created = await bufferApi.appendCreate({
        logicalDate,
        scope: input.scope ?? 'default',
        sourceType: effectiveSource,
        target,
        op: input.op === 'replace' || input.op === 'retire' ? input.op : 'add',
        section: input.section ?? '其他长期事实',
        content,
        supersedesId: input.supersedesId ?? null,
        anchor: candidateAnchor,
        pinned: input.pinned === true && !downgraded,
        ...(Array.isArray(input.tags) ? { tags: input.tags } : {}),
        ...(Array.isArray(input.triggers) ? { triggers: input.triggers } : {}),
        ...(typeof input.expires === 'string' && input.expires.trim() !== '' ? { expires: input.expires.trim() } : {}),
        producer: typeof input.producer === 'string' && input.producer.trim() !== '' ? input.producer.trim() : 'external-service',
      })
    } catch (error) {
      if (error instanceof MemoryGuardError) {
        return {
          ok: false,
          reason: error.code,
          message: error.message,
          details: error.details,
        }
      }
      throw error
    }

    return {
      ok: true,
      id: created.id,
      status: created.status,
      sourceType: created.source_type,
      downgraded,
      ...(created.duplicate ? { duplicate: true, duplicateIn: created.duplicateIn } : {}),
      item: created,
    }
  }

  function getOnboardingState(options = {}) {
    return onboardingApi.getState(options)
  }

  async function submitOnboarding(input = {}) {
    return await onboardingApi.submit(input)
  }

  function skipOnboarding(options = {}) {
    return onboardingApi.skip(options)
  }

  function resetOnboarding(options = {}) {
    return onboardingApi.reset(options)
  }

  return Object.freeze({
    contractVersion: 1,
    serviceName: SERVICE_NAME,
    dayRolledOverEvent: DAY_ROLLED_OVER_EVENT,
    home: config.home,
    getCurrentLogicalDate,
    getMorningBriefing,
    markBriefingDelivered,
    confirmBufferItems,
    matchEntities,
    getEntity,
    listEntities,
    matchLessons,
    getLesson,
    listLessons,
    submitBufferCandidate,
    getOnboardingState,
    submitOnboarding,
    skipOnboarding,
    resetOnboarding,
    getSettingsSnapshot: () => snapshotLiveConfig(config),
  })
}
