import { checkDuplicateContent, detectSecret } from './guard.js'
import { clipText, estimateTokens, logicalDateOf } from './util.js'

export const ONBOARDING_DIMENSIONS = [
  {
    id: 'identity',
    section: '基本身份与环境',
    title: '称呼与工作环境',
    question: '希望我怎么称呼你？常用的操作系统、技术栈或默认工作环境是什么？',
    placeholder: '例如：称呼我为阿杰；主力环境 Windows 11 + Node.js v24 + pnpm',
    defaultPinned: false,
  },
  {
    id: 'preferences',
    section: '沟通与工作偏好',
    title: '沟通与输出偏好',
    question: '你偏好怎样的沟通风格和汇报格式（如先说结论、简洁/详细、语言偏好）？',
    placeholder: '例如：汇报先说结论再讲过程，尽量简洁，中文回复',
    defaultPinned: false,
  },
  {
    id: 'rules',
    section: '长期规矩与边界',
    title: '长期规矩与红线',
    question: '有哪些必须长期遵守的规矩或绝对禁区（建议锁定为 pinned）？',
    placeholder: '例如：输出破坏性命令前必须先说明风险并确认；绝不修改全局默认模型配置',
    defaultPinned: true,
  },
  {
    id: 'entities',
    section: '高频关键人/项目',
    title: '高频关键人、项目或服务器',
    question: '有哪些经常提到的人、项目或服务器需要建档（可附简短说明）？',
    placeholder: '例如：老王: 负责生产服务器运维；dsh-memory: 按日期记忆插件',
    defaultPinned: false,
  },
]

const SKIP_ANSWERS = new Set(['跳过', '跳过此项', '暂不填写', 'skip', 'skip this'])

function metaKey(scope) {
  return `onboarding:${scope}`
}

function normalizeMetaState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const status = src.status === 'completed' || src.status === 'skipped' ? src.status : 'pending'
  const promptedSessions = Array.isArray(src.promptedSessions)
    ? src.promptedSessions.filter(item => typeof item === 'string' && item !== '')
    : []
  return {
    status,
    updatedAt: typeof src.updatedAt === 'number' ? src.updatedAt : null,
    completedAt: typeof src.completedAt === 'number' ? src.completedAt : null,
    skippedAt: typeof src.skippedAt === 'number' ? src.skippedAt : null,
    reason: typeof src.reason === 'string' ? src.reason : null,
    promptedSessions,
  }
}

function toStringList(value) {
  if (Array.isArray(value)) {
    return value.map(v => String(v ?? '').trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map(line => line.replace(/^[-*]\s+/, '').trim())
      .filter(Boolean)
  }
  return []
}

function normalizeOnboardingInput(input = {}) {
  const profileItems = []
  const entityItems = []
  const defaultPinned = input.pinned === true
  const pinRules = input.pinRules !== false

  if (Array.isArray(input.entries)) {
    for (const rawEntry of input.entries) {
      if (typeof rawEntry === 'string') {
        const clean = rawEntry.trim()
        if (clean) {
          profileItems.push({ section: '其他长期事实', content: clean, pinned: defaultPinned })
        }
      } else if (rawEntry && typeof rawEntry === 'object') {
        const clean = String(rawEntry.content ?? '').trim()
        if (clean) {
          const section = String(rawEntry.section ?? '其他长期事实').trim() || '其他长期事实'
          const pinned = rawEntry.pinned !== undefined
            ? rawEntry.pinned === true
            : (section === '长期规矩与边界' ? pinRules : defaultPinned)
          profileItems.push({ section, content: clean, pinned })
        }
      }
    }
  }

  for (const item of toStringList(input.identity)) {
    profileItems.push({ section: '基本身份与环境', content: item, pinned: defaultPinned })
  }
  for (const item of toStringList(input.preferences)) {
    profileItems.push({ section: '沟通与工作偏好', content: item, pinned: defaultPinned })
  }
  for (const item of toStringList(input.rules)) {
    profileItems.push({ section: '长期规矩与边界', content: item, pinned: pinRules })
  }

  const rawEntities = Array.isArray(input.entities)
    ? input.entities
    : typeof input.entities === 'string'
      ? input.entities.split(/\r?\n|[；;]/).map(s => s.trim()).filter(Boolean)
      : []

  for (const rawEnt of rawEntities) {
    if (typeof rawEnt === 'string') {
      const sepMatch = /^([^:：]+)[:：]\s*(.+)$/.exec(rawEnt)
      if (sepMatch) {
        entityItems.push({
          name: sepMatch[1].trim(),
          type: 'general',
          aliases: [],
          content: sepMatch[2].trim(),
          pinned: defaultPinned,
        })
      } else if (rawEnt.trim()) {
        entityItems.push({
          name: rawEnt.trim(),
          type: 'general',
          aliases: [],
          content: `核心关联实体（冷启动建档）`,
          pinned: defaultPinned,
        })
      }
    } else if (rawEnt && typeof rawEnt === 'object') {
      const name = String(rawEnt.name ?? '').trim()
      if (!name) continue
      entityItems.push({
        name,
        type: typeof rawEnt.type === 'string' && rawEnt.type.trim() !== '' ? rawEnt.type.trim() : 'general',
        aliases: Array.isArray(rawEnt.aliases) ? rawEnt.aliases.map(a => String(a ?? '').trim()).filter(Boolean) : [],
        content: String(rawEnt.content ?? '').trim() || `核心关联实体（冷启动建档）`,
        pinned: rawEnt.pinned === true || defaultPinned,
      })
    }
  }

  return { profileItems, entityItems }
}

function answerTextOf(answer) {
  if (!answer || typeof answer !== 'object') return ''
  const selected = Array.isArray(answer.selected)
    ? answer.selected.map(s => String(s ?? '').trim()).filter(s => s !== '' && !SKIP_ANSWERS.has(s.toLowerCase()))
    : []
  const custom = typeof answer.custom === 'string' ? answer.custom.trim() : ''
  const parts = [...selected]
  if (custom && !SKIP_ANSWERS.has(custom.toLowerCase())) {
    parts.push(custom)
  }
  return parts.join('；').trim()
}

export function createOnboardingApi({
  ctx,
  config,
  store,
  profileApi,
  bufferApi,
  entityApi,
  contextApi,
  clock = { now: () => Date.now() },
  warn = () => {},
}) {
  function currentLogicalDate() {
    return logicalDateOf(clock.now(), {
      timeZone: config.timeZone,
      dayStartHour: config.dayStartHour,
    })
  }

  function getState({ scope = 'default' } = {}) {
    const meta = normalizeMetaState(store.getMeta(metaKey(scope)))
    const profileRaw = profileApi.readProfile(config.home)
    const entries = profileApi.parseProfileEntries(profileRaw)
    const profileEntryCount = entries.length
    const profileTokens = estimateTokens(profileRaw)
    const enabled = config.onboarding?.enabled !== false
    const needsOnboarding = enabled && meta.status === 'pending' && profileEntryCount === 0

    return {
      status: meta.status,
      enabled,
      needsOnboarding,
      profileEntryCount,
      profileTokens,
      maxProfileTokens: config.sections.profile.maxTokens,
      promptedSessions: meta.promptedSessions,
      updatedAt: meta.updatedAt,
      completedAt: meta.completedAt,
      skippedAt: meta.skippedAt,
      reason: meta.reason,
      dimensions: ONBOARDING_DIMENSIONS,
    }
  }

  function shouldPromptForSession(sessionId, scope = 'default') {
    if (!sessionId) return false
    const state = getState({ scope })
    if (!state.needsOnboarding) return false
    return !state.promptedSessions.includes(sessionId)
  }

  function markSessionPrompted(sessionId, scope = 'default') {
    if (!sessionId) return
    const prev = normalizeMetaState(store.getMeta(metaKey(scope)))
    const nextSessions = prev.promptedSessions.includes(sessionId)
      ? prev.promptedSessions
      : [...prev.promptedSessions, sessionId].slice(-50)
    store.setMeta(
      metaKey(scope),
      {
        ...prev,
        updatedAt: clock.now(),
        promptedSessions: nextSessions,
      },
      clock.now(),
    )
  }

  function buildPromptNotice({ scope = 'default', uiMode = 'text' } = {}) {
    let uiHint = '请在完成本轮回复后，附带以下 4 个维度的简短引导问题（并明确告知可直接跳过/稍后填写）；收到用户答复或跳过意愿后，调用 `memory_onboarding`（`action: "submit"` 或 `"skip"`）持久化。'
    if (uiMode === 'show_view') {
      uiHint = '若用户当前请求已处理完毕，可借助 `show_view` 展示初始画像填写卡片（或用 `ask_user` 询问是否立即建档），并保留“跳过/稍后填写”选项；收到表单/问卷回复后调用 `memory_onboarding`（`action: "submit"` 或 `"skip"`）。'
    } else if (uiMode === 'ask_user') {
      uiHint = '可在完成本轮正事后用 `ask_user` 询问用户是否现在填写初始画像或跳过；收到选择后逐步采集并调用 `memory_onboarding`（`action: "submit"` 或 `"skip"`）。'
    } else if (uiMode === 'ask_user_question') {
      uiHint = '可调用 `memory_onboarding`（`action: "prompt"`）或 `ask_user_question` 向用户弹出简短的初始画像采集卡片（支持跳过），随后用 `memory_onboarding`（`action: "submit"` 或 `"skip"`）保存。'
    }

    return [
      `## 初始画像冷启动引导（dsh-memory · ${scope}）`,
      '检测到当前 `PROFILE.md` 核心画像为空，且尚未完成/跳过初始引导。',
      '**重要原则：先正常回应用户当前的实际请求，绝不阻塞主对话；再友好引导用户可选建档（支持跳过）。**',
      uiHint,
      '建议覆盖 4 个核心维度：',
      ...ONBOARDING_DIMENSIONS.map((d, idx) => `${idx + 1}. **${d.title}**（写入 \`${d.section}\`）：${d.question}`),
      '注：长期规矩与红线可标记为 `pinned` 锁定；若用户表示跳过，请务必调用 `memory_onboarding({ action: "skip" })` 以免后续重复提示。',
    ].join('\n')
  }

  async function submit(input = {}) {
    const scope = input.scope || 'default'
    const sessionId = input.sessionId
    const { profileItems, entityItems } = normalizeOnboardingInput(input)

    if (profileItems.length === 0 && entityItems.length === 0) {
      return { ok: false, reason: 'EMPTY_ONBOARDING_INPUT' }
    }

    for (const item of profileItems) {
      const secret = detectSecret(item.content)
      if (secret.detected) {
        return { ok: false, reason: secret.code, kind: secret.kind, message: secret.message }
      }
    }
    for (const ent of entityItems) {
      const secret = detectSecret(`${ent.name} ${ent.content}`)
      if (secret.detected) {
        return { ok: false, reason: secret.code, kind: secret.kind, message: secret.message }
      }
    }

    const logicalDate = currentLogicalDate()
    const maxTokens = config.sections.profile.maxTokens
    const currentProfileRaw = profileApi.readProfile(config.home)
    const currentEntries = profileApi.parseProfileEntries(currentProfileRaw)
    const boundAnchor = sessionId ? (store.getLatestUserOrCardMessage?.(sessionId)?.anchor ?? store.getLatestUserMessage?.(sessionId)?.anchor ?? null) : null

    const uniqueProfileItems = []
    for (const item of profileItems) {
      const dup = checkDuplicateContent({
        content: item.content,
        scope,
        target: 'profile',
        section: item.section,
        op: 'add',
        bufferItems: [],
        profileEntries: [...currentEntries, ...uniqueProfileItems],
      })
      if (!dup.duplicate) {
        uniqueProfileItems.push(item)
      }
    }

    const dryRun = profileApi.previewProfileBatch(
      currentProfileRaw,
      uniqueProfileItems.map(item => ({
        op: 'add',
        section: item.section,
        content: item.content,
        added: logicalDate,
        source: boundAnchor || 'onboarding',
        pinned: item.pinned,
      })),
      { maxTokens, allowPinned: true },
    )

    if (!dryRun.ok) {
      return dryRun
    }

    const hasSnapshot = Boolean(sessionId && contextApi?.hasSnapshot?.(sessionId, logicalDate))
    let resolvedMode = input.writeMode
    let downgradedForCache = false

    if (resolvedMode === 'direct') {
      if (hasSnapshot && input.forceDirect !== true) {
        resolvedMode = 'buffer'
        downgradedForCache = true
      }
    } else if (resolvedMode !== 'buffer') {
      resolvedMode = hasSnapshot ? 'buffer' : 'direct'
    }

    const committedProfileIds = []
    const committedEntitySlugs = []
    const bufferedIds = []

    if (resolvedMode === 'direct') {
      if (uniqueProfileItems.length > 0) {
        const applied = await profileApi.applyProfileBatch(
          config.home,
          uniqueProfileItems.map(item => ({
            op: 'add',
            section: item.section,
            content: item.content,
            added: logicalDate,
            source: boundAnchor || 'onboarding',
            pinned: item.pinned,
          })),
          { maxTokens, allowPinned: true },
        )
        if (!applied.ok) return applied
        committedProfileIds.push(...applied.applied.map(a => a.id))
      }

      if (entityApi && entityItems.length > 0) {
        for (const ent of entityItems) {
          const res = await entityApi.upsertEntity(config.home, {
            name: ent.name,
            type: ent.type,
            aliases: ent.aliases,
            op: 'add',
            content: ent.content,
            added: logicalDate,
            source: boundAnchor || 'onboarding',
            pinned: ent.pinned,
            allowPinned: true,
          })
          if (res.ok) committedEntitySlugs.push(res.slug)
        }
      }

      if (uniqueProfileItems.length > 0) {
        contextApi?.invalidateSnapshots?.()
      }
    } else {
      for (const item of uniqueProfileItems) {
        const created = await bufferApi.appendCreate({
          logicalDate,
          scope,
          sourceType: 'explicit',
          target: 'profile',
          op: 'add',
          section: item.section,
          content: item.content,
          anchor: boundAnchor,
          pinned: item.pinned,
          producer: 'onboarding',
        })
        if (!created.duplicate) {
          if (!boundAnchor) {
            await bufferApi.appendStatus({
              id: created.id,
              logicalDate,
              status: 'approved',
              by: 'user',
              reason: 'onboarding submission without session message anchor',
            })
          }
          bufferedIds.push(created.id)
        }
      }

      for (const ent of entityItems) {
        if (entityApi && (ent.type !== 'general' || ent.aliases.length > 0)) {
          await entityApi.upsertEntity(config.home, {
            name: ent.name,
            type: ent.type,
            aliases: ent.aliases,
            op: 'add',
            content: '',
          })
        }
        const created = await bufferApi.appendCreate({
          logicalDate,
          scope,
          sourceType: 'explicit',
          target: `entity:${ent.name}`,
          op: 'add',
          content: ent.content,
          anchor: boundAnchor,
          pinned: ent.pinned,
          producer: 'onboarding',
        })
        if (!created.duplicate) {
          if (!boundAnchor) {
            await bufferApi.appendStatus({
              id: created.id,
              logicalDate,
              status: 'approved',
              by: 'user',
              reason: 'onboarding entity submission without session message anchor',
            })
          }
          bufferedIds.push(created.id)
        }
      }
    }

    const prev = normalizeMetaState(store.getMeta(metaKey(scope)))
    const now = clock.now()
    store.setMeta(
      metaKey(scope),
      {
        ...prev,
        status: 'completed',
        updatedAt: now,
        completedAt: now,
        reason: input.reason ? String(input.reason) : 'user submitted onboarding profile',
      },
      now,
    )

    return {
      ok: true,
      scope,
      writeMode: resolvedMode,
      downgradedForCache,
      estimatedProfileTokens: dryRun.estimatedTokens,
      maxProfileTokens: maxTokens,
      committedProfileIds,
      committedEntitySlugs,
      bufferedIds,
    }
  }

  function skip({ scope = 'default', reason = 'user skipped onboarding' } = {}) {
    const prev = normalizeMetaState(store.getMeta(metaKey(scope)))
    const now = clock.now()
    store.setMeta(
      metaKey(scope),
      {
        ...prev,
        status: 'skipped',
        updatedAt: now,
        skippedAt: now,
        reason: String(reason),
      },
      now,
    )
    return { ok: true, scope, status: 'skipped', skippedAt: now }
  }

  function reset({ scope = 'default' } = {}) {
    const now = clock.now()
    store.setMeta(
      metaKey(scope),
      {
        status: 'pending',
        updatedAt: now,
        completedAt: null,
        skippedAt: null,
        reason: null,
        promptedSessions: [],
      },
      now,
    )
    return { ok: true, scope, status: 'pending' }
  }

  async function promptInteractive({ agent, signal, scope = 'default', writeMode } = {}) {
    const userQuestions = typeof ctx?.get === 'function' ? ctx.get('userQuestions') : ctx?.userQuestions
    if (!userQuestions?.ask) {
      return {
        ok: false,
        reason: 'USER_QUESTIONS_UNAVAILABLE',
        dimensions: ONBOARDING_DIMENSIONS,
      }
    }

    const questions = ONBOARDING_DIMENSIONS.map(dim => ({
      id: dim.id,
      header: clipText(dim.title, 20),
      question: `${dim.question}（示例：${dim.placeholder}）`,
      options: [{ label: '跳过此项', description: '暂不填写该维度，可后续随时补充' }],
    }))

    const response = await userQuestions.ask({
      questions,
      ...(agent ? { agent } : {}),
      ...(signal ? { signal } : {}),
    })

    const byId = new Map((response?.answers ?? []).map(ans => [ans.id, answerTextOf(ans)]))
    const identity = byId.get('identity') || ''
    const preferences = byId.get('preferences') || ''
    const rules = byId.get('rules') || ''
    const entities = byId.get('entities') || ''

    if (!identity && !preferences && !rules && !entities) {
      const skipped = skip({ scope, reason: 'user skipped interactive onboarding' })
      return { ...skipped, skipped: true }
    }

    return await submit({
      identity,
      preferences,
      rules,
      entities,
      writeMode,
      sessionId: agent?.id,
      scope,
      reason: 'interactive onboarding questionnaire',
    })
  }

  return {
    dimensions: ONBOARDING_DIMENSIONS,
    getState,
    shouldPromptForSession,
    markSessionPrompted,
    buildPromptNotice,
    submit,
    skip,
    reset,
    promptInteractive,
  }
}
