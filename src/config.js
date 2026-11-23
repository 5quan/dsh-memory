import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const VALID_MEMORY_MODES = new Set(['full', 'read-only', 'off'])
export const VALID_SUBAGENT_POLICIES = new Set(['user-only', 'ignore', 'all'])

export function expandHome(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '~') return homedir()
  if (/^~[\\/]/.test(trimmed)) return join(homedir(), trimmed.slice(2))
  return trimmed
}

export function dshHomeOf(envValue = process.env.DSH_HOME) {
  const expanded = expandHome(envValue)
  return resolve(expanded || join(homedir(), '.dsh'))
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function nonNegativeHour(value, fallback) {
  return Number.isInteger(value) && value >= 0 && value <= 23 ? value : fallback
}

function stringList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  return value.map(item => String(item ?? '').trim()).filter(Boolean)
}

function sectionConfig(rawSection, defaults) {
  const src = rawSection && typeof rawSection === 'object' ? rawSection : {}
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : defaults.enabled,
    maxTokens: positiveInt(src.maxTokens, defaults.maxTokens),
    ...(defaults.days !== undefined ? { days: positiveInt(src.days, defaults.days) } : {}),
  }
}

export function normalizeConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const dshHome = dshHomeOf()
  const home = typeof src.home === 'string' && src.home.trim() !== ''
    ? resolve(expandHome(src.home))
    : join(dshHome, 'daily-memory')

  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const timeZone = typeof src.timeZone === 'string' && src.timeZone.trim() !== ''
    ? src.timeZone.trim()
    : systemTz

  const defaultMode = VALID_MEMORY_MODES.has(src.defaultMode) ? src.defaultMode : 'full'
  const rawIngest = src.ingest && typeof src.ingest === 'object' ? src.ingest : {}
  const subagentPolicy = VALID_SUBAGENT_POLICIES.has(rawIngest.subagentPolicy)
    ? rawIngest.subagentPolicy
    : 'user-only'
  const includeScopes = stringList(rawIngest.includeScopes, ['default'])
  const rawDigest = src.digest && typeof src.digest === 'object' ? src.digest : {}
  const rawSections = src.sections && typeof src.sections === 'object' ? src.sections : {}
  const rawBuffer = src.buffer && typeof src.buffer === 'object' ? src.buffer : {}
  const rawOnboarding = src.onboarding && typeof src.onboarding === 'object' ? src.onboarding : {}
  const rawBriefing = src.briefing && typeof src.briefing === 'object' ? src.briefing : {}
  const rawCorrection = src.correction && typeof src.correction === 'object' ? src.correction : {}
  const rawLlm = src.llm && typeof src.llm === 'object' ? src.llm : {}

  return {
    home,
    timeZone,
    dayStartHour: nonNegativeHour(src.dayStartHour, 2),
    idleMinutes: typeof src.idleMinutes === 'number' && Number.isFinite(src.idleMinutes) && src.idleMinutes > 0
      ? src.idleMinutes
      : 30,
    rolloverCheckIntervalMs: positiveInt(src.rolloverCheckIntervalMs, 60_000),
    defaultMode,
    ingest: {
      subagentPolicy,
      includeScopes: includeScopes.length > 0 ? includeScopes : ['default'],
      excludeSessionIds: stringList(rawIngest.excludeSessionIds, []),
    },
    digest: {
      maxChunkTokens: positiveInt(rawDigest.maxChunkTokens, 24_000),
    },
    sections: {
      profile: sectionConfig(rawSections.profile, { enabled: true, maxTokens: 2000 }),
      yesterday: sectionConfig(rawSections.yesterday, { enabled: true, maxTokens: 1500 }),
      recentDays: sectionConfig(rawSections.recentDays, { enabled: true, days: 7, maxTokens: 2000 }),
      historyOverview: sectionConfig(rawSections.historyOverview, { enabled: true, maxTokens: 1000 }),
      entities: sectionConfig(rawSections.entities, { enabled: true, maxTokens: 1500 }),
    },
    buffer: {
      autoCommitSources: stringList(rawBuffer.autoCommitSources, ['explicit']),
      requireConfirmOnOverwrite: typeof rawBuffer.requireConfirmOnOverwrite === 'boolean'
        ? rawBuffer.requireConfirmOnOverwrite
        : true,
    },
    onboarding: {
      enabled: typeof rawOnboarding.enabled === 'boolean' ? rawOnboarding.enabled : true,
    },
    briefing: {
      enabled: typeof rawBriefing.enabled === 'boolean' ? rawBriefing.enabled : true,
    },
    correction: {
      autoCapture: typeof rawCorrection.autoCapture === 'boolean' ? rawCorrection.autoCapture : true,
      defaultSection: typeof rawCorrection.defaultSection === 'string' && rawCorrection.defaultSection.trim() !== ''
        ? rawCorrection.defaultSection.trim()
        : '长期规矩与边界',
    },
    llm: {
      provider: typeof rawLlm.provider === 'string' && rawLlm.provider.trim() !== '' ? rawLlm.provider.trim() : undefined,
      model: typeof rawLlm.model === 'string' && rawLlm.model.trim() !== '' ? rawLlm.model.trim() : undefined,
    },
  }
}
