import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const VALID_MEMORY_MODES = new Set(['full', 'read-only', 'off'])
export const VALID_SUBAGENT_POLICIES = new Set(['user-only', 'ignore', 'all'])

const VOLATILE_WRITE_SYM = Symbol.for('cosmokit.volatile.write')

export const Config = z.object({
  home: z.string().description('记忆数据根目录（留空默认使用 $DSH_HOME/daily-memory）'),
  timeZone: z.string().description('逻辑日与日报日期时区（留空使用本机系统时区）'),
  rolloverCheckIntervalMs: z.number().step(1000).min(0).default(60_000).description('后台空闲切日巡检周期（毫秒）'),
  defaultMode: z.union([
    z.const('full').description('全读写模式'),
    z.const('read-only').description('只读模式（不写入新记忆）'),
    z.const('off').description('完全关闭（无痕模式）'),
  ]).default('full').volatile().description('新会话默认记忆模式'),
  dayStartHour: z.number().step(1).min(0).max(23).default(2).volatile().description('逻辑日边界小时（0-23，默认凌晨 02:00 之前算前一天）'),
  idleMinutes: z.number().min(1).default(30).volatile().description('自动触发昨日日结所需的连续空闲分钟数'),
  ingest: z.object({
    subagentPolicy: z.union(['user-only', 'ignore', 'all']).default('user-only').description('子代理会话采集策略'),
    includeScopes: z.array(z.string()).default(['default']).description('纳入采集与检索的 scope 白名单'),
    excludeSessionIds: z.array(z.string()).default([]).description('显式排除采集的会话 ID 列表'),
  }).description('原文采集范围与子会话过滤'),
  digest: z.object({
    maxChunkTokens: z.number().step(1).min(1).default(24_000).description('日报抽取单块 Token 上限（超出自动日内分块）'),
  }).description('日报抽取分块配置'),
  onboarding: z.object({
    enabled: z.boolean().default(true).volatile().description('是否在空画像首次进入正常会话时自动触发冷启动问卷'),
  }).description('初始画像冷启动引导'),
  briefing: z.object({
    enabled: z.boolean().default(true).volatile().description('是否在每日首次正常交互时推送晨报与待确认缓冲清单'),
  }).description('每日记忆晨报'),
  correction: z.object({
    autoCapture: z.boolean().default(true).volatile().description('是否启用轻量规则自动捕获用户纠偏写入当日缓冲区'),
    defaultSection: z.string().default('长期规矩与边界').volatile().description('自动捕获纠偏条目的默认 PROFILE.md 分节'),
  }).description('轻量纠偏自动捕获'),
  dream: z.object({
    enabled: z.boolean().default(true).volatile().description('是否启用后台 Dream 整理（关闭后自动做梦完全停用）'),
    useLlm: z.boolean().default(false).volatile().description('做梦时是否启用 LLM 语义整理（默认关闭，仅运行确定性规则层）'),
    intervalDays: z.number().step(1).min(1).default(7).volatile().description('自动做梦所需的最小间隔天数'),
    minNewJournals: z.number().step(1).min(0).default(3).volatile().description('自动做梦所需累计新增日报数量阈值'),
    maxChangeRatio: z.number().min(0).max(1).step(0.05).default(0.2).volatile().description('单次做梦对非锁定画像条目的最大提案比例'),
    rejectCooldownDays: z.number().step(1).min(0).default(30).volatile().description('用户驳回某 Dream 提案后的免重提冷却天数'),
    instructions: z.string().default('').volatile().description('可选自然语言做梦整理目标（告知关注重点）'),
  }).description('Dream 后台巩固整理（M4）'),
  sections: z.object({
    profile: z.object({
      enabled: z.boolean().default(true).volatile().description('是否在冻结前缀注入核心画像 PROFILE.md'),
      maxTokens: z.number().step(100).min(100).default(2000).volatile().description('核心画像 Token 预算上限'),
    }).description('核心画像段落'),
    yesterday: z.object({
      enabled: z.boolean().default(true).volatile().description('是否在冻结前缀注入昨日完整日报'),
      maxTokens: z.number().step(100).min(100).default(1500).volatile().description('昨日日报 Token 预算上限'),
    }).description('昨日日报段落'),
    recentDays: z.object({
      enabled: z.boolean().default(true).volatile().description('是否在冻结前缀注入近 N 天日报精华'),
      days: z.number().step(1).min(1).default(7).volatile().description('近 N 天日报窗口天数'),
      maxTokens: z.number().step(100).min(100).default(2000).volatile().description('近 N 天精华 Token 预算上限'),
    }).description('近期日报精华段落'),
    historyOverview: z.object({
      enabled: z.boolean().default(true).volatile().description('是否在冻结前缀注入跨月历史 L0 总览地图'),
      maxTokens: z.number().step(100).min(100).default(1000).volatile().description('历史总览 Token 预算上限'),
    }).description('跨月历史总览（M2）'),
    entities: z.object({
      enabled: z.boolean().default(true).volatile().description('是否启用实体档案卡别名动态增量注入'),
      maxTokens: z.number().step(100).min(100).default(1500).volatile().description('单轮实体档案增量注入 Token 上限'),
    }).description('实体档案卡动态召回（M2）'),
    lessons: z.object({
      enabled: z.boolean().default(true).volatile().description('是否启用避坑经验卡触发词/标签动态增量注入'),
      maxTokens: z.number().step(100).min(100).default(1500).volatile().description('单轮避坑经验增量注入 Token 上限'),
    }).description('避坑经验动态召回（M5）'),
  }).description('上下文各记忆段开关与预算'),
  buffer: z.object({
    autoCommitSources: z.array(z.string()).default(['explicit']).volatile().description('日结允许自动落盘的缓冲区来源类型'),
    requireConfirmOnOverwrite: z.boolean().default(true).volatile().description('覆盖/淘汰或修改锁定条目时是否强制人工确认'),
  }).description('每日缓冲区准入策略'),
  llm: z.object({
    provider: z.string().default('').volatile().description('日结/做梦专用模型提供方（留空继承默认模型）'),
    model: z.string().default('').volatile().description('日结/做梦专用模型 ID（留空继承默认模型）'),
  }).description('后台整理模型覆盖'),
})

export function isVolatileRef(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.get === 'function'
    && (VOLATILE_WRITE_SYM in value || value.__volatile === true)
}

function unwrap(value) {
  return isVolatileRef(value) ? value.get() : value
}

export function defineLiveField(target, prop, rawValue, normalizeFn) {
  if (isVolatileRef(rawValue)) {
    let override
    Object.defineProperty(target, prop, {
      enumerable: true,
      configurable: true,
      get() {
        const liveRaw = rawValue.get()
        if (override !== undefined) {
          if (liveRaw !== override.baseAtSet) {
            override = undefined
          } else {
            return override.value
          }
        }
        return normalizeFn(liveRaw)
      },
      set(nextVal) {
        override = {
          value: normalizeFn(nextVal),
          baseAtSet: rawValue.get(),
        }
      },
    })
    return target
  }

  let current = normalizeFn(rawValue)
  Object.defineProperty(target, prop, {
    enumerable: true,
    configurable: true,
    get() {
      return current
    },
    set(nextVal) {
      current = normalizeFn(nextVal)
    },
  })
  return target
}

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

const positiveInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback)
const nonNegativeInt = (value, fallback) => (Number.isInteger(value) && value >= 0 ? value : fallback)
const nonNegativeHour = (value, fallback) => (Number.isInteger(value) && value >= 0 && value <= 23 ? value : fallback)
const positiveNumber = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback)
const boolOr = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
const stringOr = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
const trimmedString = (value, fallback) => (typeof value === 'string' ? value.trim() : fallback)
const stringList = (value, fallback) => (
  Array.isArray(value) ? value.map(item => String(item ?? '').trim()).filter(Boolean) : [...fallback]
)

function buildLiveSection(rawSection, defaults) {
  const src = rawSection && typeof rawSection === 'object' ? rawSection : {}
  const section = {}
  defineLiveField(section, 'enabled', src.enabled, v => boolOr(v, defaults.enabled))
  defineLiveField(section, 'maxTokens', src.maxTokens, v => positiveInt(v, defaults.maxTokens))
  if (defaults.days !== undefined) {
    defineLiveField(section, 'days', src.days, v => positiveInt(v, defaults.days))
  }
  return section
}

export function normalizeConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const dshHome = dshHomeOf()
  const rawHome = unwrap(src.home)
  const home = typeof rawHome === 'string' && rawHome.trim() !== ''
    ? resolve(expandHome(rawHome))
    : join(dshHome, 'daily-memory')

  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const rawTz = unwrap(src.timeZone)
  const timeZone = typeof rawTz === 'string' && rawTz.trim() !== '' ? rawTz.trim() : systemTz

  const rawIngest = unwrap(src.ingest)
  const ingestObj = rawIngest && typeof rawIngest === 'object' ? rawIngest : {}
  const subagentRaw = unwrap(ingestObj.subagentPolicy)
  const subagentPolicy = VALID_SUBAGENT_POLICIES.has(subagentRaw) ? subagentRaw : 'user-only'
  const includeScopes = stringList(unwrap(ingestObj.includeScopes), ['default'])

  const rawDigest = unwrap(src.digest)
  const digestObj = rawDigest && typeof rawDigest === 'object' ? rawDigest : {}

  const rawSections = unwrap(src.sections) ?? {}
  const rawBuffer = unwrap(src.buffer) ?? {}
  const rawOnboarding = unwrap(src.onboarding) ?? {}
  const rawBriefing = unwrap(src.briefing) ?? {}
  const rawCorrection = unwrap(src.correction) ?? {}
  const rawDream = unwrap(src.dream) ?? {}
  const rawLlm = unwrap(src.llm) ?? {}

  const rawRolloverInterval = unwrap(src.rolloverCheckIntervalMs)

  const config = {
    home,
    timeZone,
    rolloverCheckIntervalMs: Number.isInteger(rawRolloverInterval) && rawRolloverInterval >= 0 ? rawRolloverInterval : 60_000,
    ingest: {
      subagentPolicy,
      includeScopes: includeScopes.length > 0 ? includeScopes : ['default'],
      excludeSessionIds: stringList(unwrap(ingestObj.excludeSessionIds), []),
    },
    digest: {
      maxChunkTokens: positiveInt(unwrap(digestObj.maxChunkTokens), 24_000),
    },
    sections: {
      profile: buildLiveSection(rawSections.profile, { enabled: true, maxTokens: 2000 }),
      yesterday: buildLiveSection(rawSections.yesterday, { enabled: true, maxTokens: 1500 }),
      recentDays: buildLiveSection(rawSections.recentDays, { enabled: true, days: 7, maxTokens: 2000 }),
      historyOverview: buildLiveSection(rawSections.historyOverview, { enabled: true, maxTokens: 1000 }),
      entities: buildLiveSection(rawSections.entities, { enabled: true, maxTokens: 1500 }),
      lessons: buildLiveSection(rawSections.lessons, { enabled: true, maxTokens: 1500 }),
    },
    buffer: {},
    onboarding: {},
    briefing: {},
    correction: {},
    dream: {},
    llm: {},
  }

  defineLiveField(config, 'defaultMode', src.defaultMode, v => (VALID_MEMORY_MODES.has(v) ? v : 'full'))
  defineLiveField(config, 'dayStartHour', src.dayStartHour, v => nonNegativeHour(v, 2))
  defineLiveField(config, 'idleMinutes', src.idleMinutes, v => positiveNumber(v, 30))

  defineLiveField(config.buffer, 'autoCommitSources', rawBuffer.autoCommitSources, v => stringList(v, ['explicit']))
  defineLiveField(config.buffer, 'requireConfirmOnOverwrite', rawBuffer.requireConfirmOnOverwrite, v => boolOr(v, true))

  defineLiveField(config.onboarding, 'enabled', rawOnboarding.enabled, v => boolOr(v, true))
  defineLiveField(config.briefing, 'enabled', rawBriefing.enabled, v => boolOr(v, true))

  defineLiveField(config.correction, 'autoCapture', rawCorrection.autoCapture, v => boolOr(v, true))
  defineLiveField(config.correction, 'defaultSection', rawCorrection.defaultSection, v => stringOr(v, '长期规矩与边界'))

  defineLiveField(config.dream, 'enabled', rawDream.enabled, v => boolOr(v, true))
  defineLiveField(config.dream, 'useLlm', rawDream.useLlm, v => boolOr(v, false))
  defineLiveField(config.dream, 'intervalDays', rawDream.intervalDays, v => positiveInt(v, 7))
  defineLiveField(config.dream, 'minNewJournals', rawDream.minNewJournals, v => nonNegativeInt(v, 3))
  defineLiveField(
    config.dream,
    'maxChangeRatio',
    rawDream.maxChangeRatio,
    v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.2),
  )
  defineLiveField(config.dream, 'rejectCooldownDays', rawDream.rejectCooldownDays, v => nonNegativeInt(v, 30))
  defineLiveField(config.dream, 'instructions', rawDream.instructions, v => trimmedString(v, ''))

  defineLiveField(config.llm, 'provider', rawLlm.provider, v => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined))
  defineLiveField(config.llm, 'model', rawLlm.model, v => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined))

  return config
}

export function snapshotLiveConfig(config) {
  return {
    home: config.home,
    timeZone: config.timeZone,
    defaultMode: config.defaultMode,
    dayStartHour: config.dayStartHour,
    idleMinutes: config.idleMinutes,
    onboarding: { enabled: config.onboarding.enabled },
    briefing: { enabled: config.briefing.enabled },
    correction: {
      autoCapture: config.correction.autoCapture,
      defaultSection: config.correction.defaultSection,
    },
    dream: {
      enabled: config.dream.enabled,
      useLlm: config.dream.useLlm,
      intervalDays: config.dream.intervalDays,
      minNewJournals: config.dream.minNewJournals,
      maxChangeRatio: config.dream.maxChangeRatio,
      rejectCooldownDays: config.dream.rejectCooldownDays,
      instructions: config.dream.instructions,
    },
    sections: {
      profile: { enabled: config.sections.profile.enabled, maxTokens: config.sections.profile.maxTokens },
      yesterday: { enabled: config.sections.yesterday.enabled, maxTokens: config.sections.yesterday.maxTokens },
      recentDays: {
        enabled: config.sections.recentDays.enabled,
        days: config.sections.recentDays.days,
        maxTokens: config.sections.recentDays.maxTokens,
      },
      historyOverview: { enabled: config.sections.historyOverview.enabled, maxTokens: config.sections.historyOverview.maxTokens },
      entities: { enabled: config.sections.entities.enabled, maxTokens: config.sections.entities.maxTokens },
      lessons: { enabled: config.sections.lessons.enabled, maxTokens: config.sections.lessons.maxTokens },
    },
    buffer: {
      autoCommitSources: [...config.buffer.autoCommitSources],
      requireConfirmOnOverwrite: config.buffer.requireConfirmOnOverwrite,
    },
    llm: {
      provider: config.llm.provider ?? null,
      model: config.llm.model ?? null,
    },
  }
}
