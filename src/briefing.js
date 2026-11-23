import { parseJournalSections } from './journal.js'
import { clipText, logicalDateOf } from './util.js'

function metaKey(scope) {
  return `briefing:${scope}`
}

function cleanBulletLines(body, maxPerSection = 3) {
  if (!body) return []
  const items = []
  for (const rawLine of String(body).split(/\r?\n/)) {
    const cleaned = rawLine.replace(/^[-*]\s+/, '').trim()
    if (!cleaned || cleaned === '（无）' || cleaned === '(无)' || cleaned === '无') continue
    items.push(clipText(cleaned, 180))
    if (items.length >= maxPerSection) break
  }
  return items
}

export function extractJournalHighlights(markdown, { maxPerSection = 3 } = {}) {
  const { title, sections } = parseJournalSections(markdown)
  const happened = cleanBulletLines(sections.get('发生了什么'), maxPerSection)
  const decisions = cleanBulletLines(sections.get('做出的决定'), maxPerSection)
  const changes = cleanBulletLines(sections.get('新建/变更的事项'), maxPerSection)
  const lessons = cleanBulletLines(sections.get('纠正与教训'), maxPerSection)
  const openQuestions = cleanBulletLines(sections.get('悬而未决的问题'), maxPerSection)
  const entities = cleanBulletLines(sections.get('提到的实体'), maxPerSection)

  const hasContent = (
    happened.length > 0
    || decisions.length > 0
    || changes.length > 0
    || lessons.length > 0
    || openQuestions.length > 0
    || entities.length > 0
  )

  return {
    title,
    happened,
    decisions,
    changes,
    lessons,
    openQuestions,
    entities,
    hasContent,
  }
}

function formatBriefingMarkdown({ date, yesterday, pending, approved }) {
  const lines = [`# ${date} 每日记忆晨报`]

  if (yesterday) {
    lines.push('', `### 昨日日报亮点（${yesterday.date}）`)
    const h = yesterday.highlights
    if (h.decisions.length > 0) {
      lines.push('**做出的决定**：', ...h.decisions.map(item => `- ${item}`))
    }
    if (h.lessons.length > 0) {
      lines.push('**纠正与教训**：', ...h.lessons.map(item => `- ${item}`))
    }
    if (h.openQuestions.length > 0) {
      lines.push('**悬而未决的问题**：', ...h.openQuestions.map(item => `- ${item}`))
    }
    if (h.happened.length > 0 && h.decisions.length === 0 && h.lessons.length === 0) {
      lines.push('**发生了什么**：', ...h.happened.map(item => `- ${item}`))
    }
    if (!h.hasContent) {
      lines.push('- （昨日日报无重点摘要）')
    }
  } else {
    lines.push('', '### 昨日日报亮点', '- （暂无历史日报）')
  }

  lines.push('', `### 待确认记忆缓冲区（待确认 ${pending.length} 条 / 已批准待落盘 ${approved.length} 条）`)
  if (pending.length === 0 && approved.length === 0) {
    lines.push('- （当前无待处理缓冲条目）')
  } else {
    for (const item of pending) {
      lines.push(`- [待确认] \`${item.id}\` (${item.logical_date} · ${item.source_type} -> ${item.target}) ${item.content}`)
    }
    for (const item of approved) {
      lines.push(`- [已批准待落盘] \`${item.id}\` (${item.logical_date} · ${item.source_type} -> ${item.target}) ${item.content}`)
    }
  }

  return lines.join('\n')
}

export function createBriefingApi({
  ctx,
  config,
  store,
  journalApi,
  bufferApi,
  profileApi,
  entityApi,
  lessonApi,
  contextApi,
  clock = { now: () => Date.now() },
}) {
  function currentLogicalDate() {
    return logicalDateOf(clock.now(), {
      timeZone: config.timeZone,
      dayStartHour: config.dayStartHour,
    })
  }

  function getMorningBriefing({ date, scope = 'default' } = {}) {
    const todayDate = date || currentLogicalDate()
    const journalDates = journalApi.listJournalDates(config.home).filter(d => d < todayDate)
    const yesterdayDate = journalDates.at(-1) ?? null

    let yesterday = null
    if (yesterdayDate) {
      const raw = journalApi.readJournal(config.home, yesterdayDate)
      if (raw) {
        yesterday = {
          date: yesterdayDate,
          path: journalApi.journalPath(config.home, yesterdayDate),
          highlights: extractJournalHighlights(raw),
        }
      }
    }

    const active = bufferApi.listItems({ scope, statuses: ['pending', 'approved'] })
    const pending = active.filter(item => item.status === 'pending')
    const approved = active.filter(item => item.status === 'approved')

    const meta = store.getMeta(metaKey(scope))
    const alreadyDelivered = meta?.lastBriefedDate === todayDate
    const hasContent = Boolean((yesterday && yesterday.highlights.hasContent) || pending.length > 0 || approved.length > 0)
    const markdown = formatBriefingMarkdown({ date: todayDate, yesterday, pending, approved })

    return {
      date: todayDate,
      scope,
      hasContent,
      alreadyDelivered,
      yesterday,
      buffer: {
        pending,
        approved,
        totalPending: pending.length,
        totalApproved: approved.length,
      },
      markdown,
    }
  }

  function shouldDeliverToday({ date, scope = 'default' } = {}) {
    if (config.briefing?.enabled === false) return false
    const briefing = getMorningBriefing({ date, scope })
    return briefing.hasContent && !briefing.alreadyDelivered
  }

  function markDelivered({ date, scope = 'default', sessionId } = {}) {
    const todayDate = date || currentLogicalDate()
    const now = clock.now()
    store.setMeta(
      metaKey(scope),
      {
        lastBriefedDate: todayDate,
        deliveredAt: now,
        ...(sessionId ? { sessionId } : {}),
      },
      now,
    )
    return { ok: true, date: todayDate, scope, deliveredAt: now }
  }

  function buildBriefingNotice({ date, scope = 'default', uiMode = 'text' } = {}) {
    const briefing = getMorningBriefing({ date, scope })
    if (!briefing.hasContent) return ''

    const parts = [
      `## 每日晨报与待确认记忆（dsh-memory · ${briefing.date}）`,
      '这是今日首次正常交互汇总，请在自然回应用户的同时（绝不阻塞用户当前任务），简明带出以下晨报要点：',
      briefing.markdown,
    ]

    if (briefing.buffer.totalPending > 0) {
      let confirmHint = '请向用户展示待确认条目编号与内容供其勾选批准（approve）或驳回（reject），随后调用 `memory_briefing`（`action: "confirm"`）批量提交；若用户明确要求立刻写入画像，可传 `settleNow: true`。'
      if (uiMode === 'show_view') {
        confirmHint = '可用 `show_view` 展示昨日亮点与待确认条目勾选卡片（或用 `ask_user` 询问），收到提交后调用 `memory_briefing`（`action: "confirm"`）批量 `approve`/`reject`（可选 `settleNow: true` 立即落盘）。'
      } else if (uiMode === 'ask_user') {
        confirmHint = '可用 `ask_user` 提供批量通过/逐条筛选/暂不处理选项，收到选择后调用 `memory_briefing`（`action: "confirm"`）更新状态（可选 `settleNow: true`）。'
      } else if (uiMode === 'ask_user_question') {
        confirmHint = '可调用 `memory_briefing`（`action: "confirm", interactive: true`）或 `ask_user_question` 弹出低摩擦批量勾选卡片，完成确认与可选立即落盘。'
      }
      parts.push(confirmHint)
    }

    return parts.join('\n\n')
  }

  async function confirmItems({
    approveIds = [],
    rejectIds = [],
    reason,
    settleNow = false,
    scope = 'default',
  } = {}) {
    const rejectList = [...new Set((Array.isArray(rejectIds) ? rejectIds : []).map(id => String(id ?? '').trim()).filter(Boolean))]
    const rejectSet = new Set(rejectList)
    const approveList = [...new Set((Array.isArray(approveIds) ? approveIds : []).map(id => String(id ?? '').trim()).filter(id => id && !rejectSet.has(id)))]

    const existing = bufferApi.listItems({ scope, statuses: ['pending', 'approved'] })
    const itemMap = new Map(existing.map(item => [item.id, item]))

    const approved = approveList.length > 0
      ? await bufferApi.updateStatuses(approveList, 'approved', { by: 'user', reason })
      : []
    const rejected = rejectList.length > 0
      ? await bufferApi.updateStatuses(rejectList, 'rejected', { by: 'user', reason })
      : []

    let settlement = null
    if (settleNow === true) {
      const targetDates = new Set()
      for (const id of approved) {
        const item = itemMap.get(id)
        if (item?.logical_date) targetDates.add(item.logical_date)
      }
      for (const item of existing) {
        if (item.status === 'approved' && !rejectSet.has(item.id)) {
          targetDates.add(item.logical_date)
        }
      }
      settlement = await bufferApi.settleDates({
        dates: [...targetDates],
        scope,
        store,
        profileApi,
        entityApi,
        lessonApi,
        config,
      })
      if (settlement.profile.committed.length > 0) {
        contextApi?.invalidateSnapshots?.()
      }
    }

    return {
      ok: true,
      scope,
      approved,
      rejected,
      settlement,
    }
  }

  async function promptInteractiveConfirm({ agent, signal, scope = 'default', settleNow } = {}) {
    const briefing = getMorningBriefing({ scope })
    const pending = briefing.buffer.pending
    if (pending.length === 0) {
      return {
        ok: true,
        scope,
        pendingCount: 0,
        approved: [],
        rejected: [],
        settlement: null,
        message: 'No pending buffer items to confirm.',
      }
    }

    const userQuestions = typeof ctx?.get === 'function' ? ctx.get('userQuestions') : ctx?.userQuestions
    if (!userQuestions?.ask) {
      return {
        ok: false,
        reason: 'USER_QUESTIONS_UNAVAILABLE',
        briefing,
      }
    }

    const optionToId = new Map()
    const options = pending.map((item) => {
      const label = `[${item.id}] ${clipText(item.content, 60)}`
      optionToId.set(label, item.id)
      return {
        label,
        description: `${item.logical_date} | ${item.source_type} -> ${item.target}`,
      }
    })

    const response = await userQuestions.ask({
      questions: [
        {
          id: 'approve_items',
          header: '待确认记忆',
          question: '请勾选要确认入库的记忆条目（不勾选将按下方策略处理）：',
          options,
          multiSelect: true,
        },
        {
          id: 'unselected_policy',
          header: '未勾选项',
          question: '未勾选的条目如何处理？',
          options: [
            { label: '保持待定 (Recommended)', description: '保留在缓冲区，之后再处理' },
            { label: '批量驳回', description: '将未勾选项全部标记为 rejected' },
          ],
        },
        {
          id: 'settle_policy',
          header: '写入时机',
          question: '已批准的条目何时写入核心画像/实体卡？',
          options: [
            { label: '日结时统一写入 (Recommended)', description: '保住今日 Prompt Prefix Cache，夜间空闲日结落盘' },
            { label: '立即落盘生效', description: '立刻写入 PROFILE.md / entities 并刷新快照' },
          ],
        },
      ],
      ...(agent ? { agent } : {}),
      ...(signal ? { signal } : {}),
    })

    const byId = new Map((response?.answers ?? []).map(ans => [ans.id, ans]))
    const approveAns = byId.get('approve_items')
    const approveIds = []
    for (const selectedLabel of approveAns?.selected ?? []) {
      const mapped = optionToId.get(selectedLabel)
      if (mapped) {
        approveIds.push(mapped)
      } else {
        const m = /^\[([^\]]+)\]/.exec(String(selectedLabel))
        if (m) approveIds.push(m[1])
      }
    }

    const rejectPolicy = byId.get('unselected_policy')?.selected?.[0] ?? ''
    const approveSet = new Set(approveIds)
    const rejectIds = rejectPolicy.includes('批量驳回')
      ? pending.filter(item => !approveSet.has(item.id)).map(item => item.id)
      : []

    const settleChoice = byId.get('settle_policy')?.selected?.[0] ?? ''
    const shouldSettle = settleNow !== undefined ? settleNow : settleChoice.includes('立即落盘')

    const result = await confirmItems({
      approveIds,
      rejectIds,
      settleNow: shouldSettle,
      scope,
      reason: 'morning briefing interactive confirmation',
    })
    markDelivered({ date: briefing.date, scope, sessionId: agent?.id })
    return result
  }

  return {
    extractJournalHighlights,
    getMorningBriefing,
    shouldDeliverToday,
    markDelivered,
    buildBriefingNotice,
    confirmItems,
    promptInteractiveConfirm,
  }
}
