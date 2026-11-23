import { rmSync, statSync } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { callLlmOneShot, resolveModelSelection } from './digest.js'
import { computeContentHash, detectSecret, normalizeContentForHash } from './guard.js'
import { clipText, estimateTokens, logicalDateOf, slugifyName } from './util.js'

const LOCK_FILENAME = 'dream.lock'
const STALE_LOCK_MS = 30 * 60_000

const DREAM_SYSTEM_PROMPT = `你是一个极度克制、严谨的个人记忆后台整理助手（Dream Consolidator）。
你的任务是对照长期画像（PROFILE.md）、避坑经验卡（lessons/）与近期日报/纠偏记录，仅在存在**明确依据**时提出少量高质量变更提案，写入缓冲区等待人工审核。

必须严格遵守以下原则：
1. **无证据则不动（Absence of evidence != staleness）**：绝不能仅仅因为某条旧记忆最近没被提到就提议淘汰或删除。只有出现近期明确反证、用户直接推翻旧规则、或画像逼近预算上限且存在明显可合并冗余时，才允许提议 \`retire\` 或 \`replace\`。
2. **绝不碰 \`pinned\` 条目**：凡标有 \`pinned\` 的条目绝对禁止作为 \`replace\` 或 \`retire\` 的目标。
3. **冲突保留 \`CONFLICT\` 与权威分层**：无法 100% 裁决的新旧矛盾，绝不能盲目覆盖旧规则；应设置 \`conflict: true\`，在 \`content\` 中以 \`[CONFLICT]\` 显式列出双方观点、日期与来源锚点让用户拍板。低权威推断不得无真实用户证据锚点覆盖 \`manual\` / \`explicit\` 规则。
4. **时间与表述纪律**：将相对时间换算为绝对 ISO 日期（YYYY-MM-DD）；将助手已做出的重要承诺或外部动作视作一等事实；写简洁客观的当前认知陈述句；禁止写入任何密钥/Token/密码具体值。
5. **严格输出 JSON**（不要包在额外解释里）：
{
  "proposals": [
    {
      "target": "profile" | "entity:<名称>" | "lesson:<名称>",
      "op": "add" | "replace" | "retire",
      "targetId": "prof_XX、ent_XX 或 les_XX（replace/retire 时必填）",
      "section": "PROFILE 分节名",
      "content": "拟定更新内容或淘汰/冲突说明",
      "reason": "明确依据与原因",
      "evidenceAnchor": "chat://YYYY-MM-DD#session#seq（如有真实锚点请原样保留，绝不编造）",
      "conflict": false,
      "expires": "YYYY-MM-DD（仅阶段性事实适用，可选）"
    }
  ]
}
如无需任何调整，返回 {"proposals": []}。`

function metaKey(scope) {
  return `dream:${scope}`
}

function sourceAuthorityRank(entry) {
  if (entry.pinned) return 100
  if (entry.source === 'manual' || entry.source === 'onboarding') return 80
  if (typeof entry.source === 'string' && entry.source.startsWith('chat://')) return 60
  if (entry.source === 'explicit') return 50
  if (entry.source === 'correction') return 40
  return 10
}

function isHighAuthorityProfileEntry(entry, store) {
  if (!entry) return false
  if (entry.pinned) return true
  if (entry.source === 'manual' || entry.source === 'onboarding') return true
  if (typeof entry.source === 'string' && entry.source.startsWith('chat://')) {
    const msg = store?.getMessageByAnchor?.(entry.source)
    return Boolean(msg && (msg.role === 'user' || msg.role === 'card'))
  }
  return entry.source === 'explicit'
}

function parseDreamJson(rawText) {
  let cleaned = String(rawText ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned)
  if (fenced) cleaned = fenced[1].trim()
  const parsed = JSON.parse(cleaned)
  if (Array.isArray(parsed)) return parsed
  if (parsed && Array.isArray(parsed.proposals)) return parsed.proposals
  return []
}

export function createDreamApi({
  ctx,
  config,
  store,
  profileApi,
  journalApi,
  bufferApi,
  entityApi,
  lessonApi,
  historyApi,
  clock = { now: () => Date.now() },
  warn = () => {},
}) {
  let inFlight = false

  function currentLogicalDate() {
    return logicalDateOf(clock.now(), {
      timeZone: config.timeZone,
      dayStartHour: config.dayStartHour,
    })
  }

  function listNewJournalsSince(meta, todayDate) {
    const dates = journalApi.listJournalDates(config.home).filter(d => d < todayDate)
    const watermarkDate = meta?.lastProcessedJournalDate
    if (!watermarkDate) return dates
    return dates.filter(d => d > watermarkDate)
  }

  function shouldRunDream({ scope = 'default', isIdle = false } = {}) {
    if (config.dream?.enabled === false) return false
    if (!isIdle) return false
    const todayDate = currentLogicalDate()
    const meta = store.getMeta(metaKey(scope))
    if (meta?.lastSuccessAt != null) {
      const elapsedDays = (clock.now() - meta.lastSuccessAt) / 86_400_000
      if (elapsedDays < config.dream.intervalDays) return false
    }
    const newJournals = listNewJournalsSince(meta, todayDate)
    return newJournals.length >= config.dream.minNewJournals
  }

  async function acquireFileLock() {
    const lockPath = join(config.home, LOCK_FILENAME)
    await mkdir(config.home, { recursive: true })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lockPath, 'wx')
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: clock.now() }), 'utf8')
        return async () => {
          try { await handle.close() } catch {}
          try { rmSync(lockPath, { force: true }) } catch {}
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        let stale = false
        try {
          const st = statSync(lockPath)
          if (Date.now() - st.mtimeMs > STALE_LOCK_MS) stale = true
        } catch {
          stale = true
        }
        if (stale && attempt === 0) {
          try { rmSync(lockPath, { force: true }) } catch {}
          continue
        }
        return null
      }
    }
    return null
  }

  function collectCardDuplicates({ cards, getItems, makeTarget, makeDreamKey, makeContent, makeReason, checkExpires, todayDate, maxTokens }) {
    const candidates = []
    const oversized = []
    for (const card of cards) {
      const items = getItems(card).filter(item => !item?.rawOnly)
      if (items.length > 25 || estimateTokens(card.raw) > maxTokens) {
        oversized.push(card.slug)
      }

      if (checkExpires) {
        for (const item of items) {
          if (item.pinned || !item.id) continue
          if (item.expires && /^\d{4}-\d{2}-\d{2}$/.test(item.expires) && item.expires <= todayDate) {
            candidates.push({
              channel: 'rule',
              target: makeTarget(card),
              op: 'retire',
              targetId: item.id,
              content: `[避坑到期淘汰 ${card.name}/${item.id}] 条目已过有效期 (${item.expires})：${item.content}`,
              reason: `expired in lesson ${card.slug} on ${item.expires}`,
              dreamKey: makeDreamKey(card, item),
              conflict: false,
            })
          }
        }
      }

      const seen = new Map()
      for (const item of items) {
        const hash = normalizeContentForHash(item.content)
        if (!hash) continue
        const existing = seen.get(hash)
        if (!existing) {
          seen.set(hash, item)
          continue
        }
        const toRetire = sourceAuthorityRank(item) <= sourceAuthorityRank(existing) ? item : existing
        const kept = toRetire === item ? existing : item
        seen.set(hash, kept)
        if (!toRetire.pinned && toRetire.id) {
          candidates.push({
            channel: 'rule',
            target: makeTarget(card),
            op: 'retire',
            targetId: toRetire.id,
            content: makeContent(card, toRetire, kept),
            reason: makeReason(card),
            dreamKey: makeDreamKey(card, toRetire),
            conflict: false,
          })
        }
      }
    }
    return { candidates, oversized }
  }

  function collectRuleProposals({ todayDate, profileEntries, entities, lessons, budgetRatio }) {
    const candidates = []

    // 1. Expired phase facts in PROFILE.md (never touch pinned)
    for (const entry of profileEntries) {
      if (entry.pinned) continue
      if (entry.expires && /^\d{4}-\d{2}-\d{2}$/.test(entry.expires) && entry.expires <= todayDate) {
        candidates.push({
          channel: 'rule',
          target: 'profile',
          op: 'retire',
          targetId: entry.id,
          section: entry.section,
          content: `[到期淘汰 ${entry.id}] 条目已过有效期 (${entry.expires})：${entry.content}`,
          reason: `expired on ${entry.expires}`,
          dreamKey: `profile:retire:${entry.id}`,
          conflict: false,
        })
      }
    }

    // 2. Exact normalized duplicates in PROFILE.md (keep highest-authority / earlier entry)
    const seenProfile = new Map()
    for (const entry of profileEntries) {
      const hash = normalizeContentForHash(entry.content)
      if (!hash) continue
      const existing = seenProfile.get(hash)
      if (!existing) {
        seenProfile.set(hash, entry)
        continue
      }
      const existingRank = sourceAuthorityRank(existing)
      const entryRank = sourceAuthorityRank(entry)
      const toRetire = entryRank <= existingRank ? entry : existing
      const kept = toRetire === entry ? existing : entry
      seenProfile.set(hash, kept)

      if (!toRetire.pinned && toRetire.id) {
        candidates.push({
          channel: 'rule',
          target: 'profile',
          op: 'retire',
          targetId: toRetire.id,
          section: toRetire.section,
          content: `[去重淘汰 ${toRetire.id}] 与现有画像条目 ${kept.id || ''} 内容重复：${toRetire.content}`,
          reason: `duplicate of ${kept.id || 'existing entry'}`,
          dreamKey: `profile:retire:${toRetire.id}`,
          conflict: false,
        })
      }
    }

    // 3. Exact duplicate facts within each entity card + diagnostics
    const entityRes = collectCardDuplicates({
      cards: entities,
      getItems: ent => ent.facts ?? [],
      makeTarget: ent => `entity:${ent.name}`,
      makeDreamKey: (ent, item) => `entity:${ent.slug}:retire:${item.id}`,
      makeContent: (ent, toRetire, kept) => `[实体去重 ${ent.name}/${toRetire.id}] 与事实 ${kept.id || ''} 重复：${toRetire.content}`,
      makeReason: ent => `duplicate fact in entity ${ent.slug}`,
      checkExpires: false,
      todayDate,
      maxTokens: config.sections.entities.maxTokens,
    })
    candidates.push(...entityRes.candidates)

    // 4. Expired & exact duplicate entries within each lesson card + diagnostics
    const lessonRes = collectCardDuplicates({
      cards: lessons,
      getItems: lesson => lesson.entries ?? [],
      makeTarget: lesson => `lesson:${lesson.name}`,
      makeDreamKey: (lesson, item) => `lesson:${lesson.slug}:retire:${item.id}`,
      makeContent: (lesson, toRetire, kept) => `[避坑去重 ${lesson.name}/${toRetire.id}] 与条目 ${kept.id || ''} 重复：${toRetire.content}`,
      makeReason: lesson => `duplicate entry in lesson ${lesson.slug}`,
      checkExpires: true,
      todayDate,
      maxTokens: config.sections.lessons?.maxTokens ?? 1500,
    })
    candidates.push(...lessonRes.candidates)

    return {
      candidates,
      diagnostics: {
        budgetPressure: budgetRatio >= 0.85,
        budgetRatio,
        oversizedEntities: entityRes.oversized,
        oversizedLessons: lessonRes.oversized,
      },
    }
  }

  async function runDream({
    scope = 'default',
    dryRun = false,
    useLlm,
    force = false,
    signal,
  } = {}) {
    if (inFlight) {
      return { ok: false, skipped: true, reason: 'DREAM_LOCKED' }
    }
    inFlight = true
    const releaseLock = await acquireFileLock()
    if (!releaseLock) {
      inFlight = false
      return { ok: false, skipped: true, reason: 'DREAM_LOCKED' }
    }

    try {
      const todayDate = currentLogicalDate()
      const meta = store.getMeta(metaKey(scope))

      // Stage 1: Orient
      const profileRaw = profileApi.readProfile(config.home)
      const profileEntries = profileApi.parseProfileEntries(profileRaw)
      const retiredRecords = profileApi.readRetiredRecords(config.home)
      const entities = entityApi ? entityApi.listEntities(config.home) : []
      const lessons = lessonApi ? lessonApi.listLessons(config.home) : []
      const allJournalDates = journalApi.listJournalDates(config.home).filter(d => d < todayDate)
      const newJournals = listNewJournalsSince(meta, todayDate)
      const allBufferItems = bufferApi.listItems({ scope })

      // Stage 2: Gather
      const profileTokens = estimateTokens(profileRaw)
      const maxProfileTokens = config.sections.profile.maxTokens
      const budgetRatio = maxProfileTokens > 0 ? profileTokens / maxProfileTokens : 0
      const recentJournalDates = (newJournals.length > 0 ? newJournals : allJournalDates).slice(-14)
      const recentJournalsText = recentJournalDates
        .map(d => `### ${d}\n${clipText(journalApi.readJournal(config.home, d), 1800)}`)
        .join('\n\n')
      const recentCorrections = allBufferItems.filter(
        item => item.source_type === 'correction' && (item.status === 'pending' || item.status === 'approved' || item.status === 'committed'),
      )

      const builtMonths = new Set((historyApi?.listHistoryMonths?.() ?? []).map(m => m.month))
      const missingHistoryMonths = [...new Set(allJournalDates.map(d => d.slice(0, 7)))]
        .filter(month => !builtMonths.has(month))
        .sort()

      // Stage 3: Consolidate (Rule + optional LLM)
      const { candidates: ruleCandidates, diagnostics } = collectRuleProposals({
        todayDate,
        profileEntries,
        entities,
        lessons,
        budgetRatio,
      })

      let llmStatus = 'skipped'
      let llmError = null
      let degraded = false
      const llmCandidates = []

      const effectiveUseLlm = useLlm !== undefined ? useLlm === true : config.dream?.useLlm === true
      const shouldInvokeLlm = effectiveUseLlm
        && (profileEntries.length > 0 || lessons.length > 0)
        && (newJournals.length > 0 || ((dryRun || force) && allJournalDates.length > 0) || recentCorrections.length > 0 || diagnostics.budgetPressure)

      if (shouldInvokeLlm) {
        const selection = resolveModelSelection(ctx, config)
        if (!selection) {
          llmStatus = 'skipped_no_model'
        } else {
          try {
            const instructionsBlock = config.dream?.instructions
              ? `\n用户定制整理目标（dream.instructions）：\n${config.dream.instructions}\n`
              : ''
            const lessonsPromptSection = lessons.length > 0
              ? ['', '## 当前避坑经验卡（lessons/）', lessons.map(l => clipText(l.raw, 900)).join('\n\n')]
              : []
            const prompt = [
              `当前逻辑日期：${todayDate}`,
              `当前 PROFILE.md 占用：${profileTokens}/${maxProfileTokens} tokens（${Math.round(budgetRatio * 100)}%，预算压力=${diagnostics.budgetPressure}）`,
              `最近已退休条目数：${retiredRecords.length}`,
              instructionsBlock,
              '## 当前核心画像 PROFILE.md',
              profileRaw || '（空）',
              ...lessonsPromptSection,
              '',
              '## 近期不可变日报摘录',
              recentJournalsText || '（无新增日报）',
              '',
              '## 近期纠偏记录',
              recentCorrections.slice(-15).map(c => `- [${c.logical_date}] (${c.status}) ${c.content}${c.anchor ? ` [${c.anchor}]` : ''}`).join('\n') || '（无）',
            ].join('\n')

            const rawLlm = await callLlmOneShot(ctx, {
              ...selection,
              system: DREAM_SYSTEM_PROMPT,
              prompt,
              signal,
            })
            const parsed = parseDreamJson(rawLlm)
            for (const p of parsed) {
              if (!p || typeof p !== 'object') continue
              llmCandidates.push({
                channel: 'llm',
                target: String(p.target ?? 'profile').trim(),
                op: String(p.op ?? 'add').trim(),
                targetId: typeof p.targetId === 'string' ? p.targetId.trim() : undefined,
                section: typeof p.section === 'string' ? p.section.trim() : '其他长期事实',
                content: String(p.content ?? '').trim(),
                reason: typeof p.reason === 'string' ? p.reason.trim() : 'dream semantic consolidation',
                evidenceAnchor: typeof p.evidenceAnchor === 'string' && p.evidenceAnchor.trim() !== '' ? p.evidenceAnchor.trim() : null,
                conflict: p.conflict === true,
                expires: typeof p.expires === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.expires.trim()) ? p.expires.trim() : undefined,
              })
            }
            llmStatus = 'ok'
          } catch (error) {
            llmStatus = 'failed'
            degraded = true
            llmError = error?.message ?? String(error)
            warn('dsh-memory: dream LLM pass failed (watermark held): %s', llmError)
          }
        }
      }

      // Deterministic Post-Verification & Rate/Cooldown Guard
      const skippedReasons = []
      const verified = []
      const seenKeysThisRun = new Set()
      const cooldownMs = (config.dream?.rejectCooldownDays ?? 30) * 86_400_000
      const nowMs = clock.now()

      const openDreamItems = allBufferItems.filter(
        item => item.source_type === 'dream' && (item.status === 'pending' || item.status === 'approved'),
      )
      const rejectedDreamItems = allBufferItems.filter(
        item => item.source_type === 'dream' && item.status === 'rejected',
      )

      const isValidDreamTarget = (t) => (
        t === 'profile'
        || (t.startsWith('entity:') && t.slice('entity:'.length).trim().length > 0)
        || (t.startsWith('lesson:') && t.slice('lesson:'.length).trim().length > 0)
      )

      const blockReasonForEntry = (entry, candidate, { checkAuthority = true } = {}) => {
        if (!entry) return 'TARGET_NOT_FOUND'
        if (entry.pinned) return 'PINNED_PROTECTED'
        if (checkAuthority && candidate.channel === 'llm' && isHighAuthorityProfileEntry(entry, store) && candidate.conflict !== true) {
          const evMsg = candidate.evidenceAnchor ? store.getMessageByAnchor(candidate.evidenceAnchor) : undefined
          const hasVerifiedHumanEvidence = Boolean(evMsg && (evMsg.role === 'user' || evMsg.role === 'card'))
          if (!hasVerifiedHumanEvidence) return 'AUTHORITY_PROTECTED'
        }
        return null
      }

      for (const candidate of [...ruleCandidates, ...llmCandidates]) {
        const { target, op, targetId, content } = candidate
        if (!isValidDreamTarget(target)) {
          skippedReasons.push({ candidate, reason: 'INVALID_TARGET' })
          continue
        }
        if (op !== 'add' && op !== 'replace' && op !== 'retire') {
          skippedReasons.push({ candidate, reason: 'INVALID_OP' })
          continue
        }
        if (!content) {
          skippedReasons.push({ candidate, reason: 'EMPTY_CONTENT' })
          continue
        }
        if (detectSecret(content).detected) {
          skippedReasons.push({ candidate, reason: 'SECRET_DETECTED' })
          continue
        }

        if (target === 'profile' && (op === 'replace' || op === 'retire')) {
          const entry = profileEntries.find(e => e.id === targetId)
          const block = blockReasonForEntry(entry, candidate, { checkAuthority: true })
          if (block) {
            skippedReasons.push({ candidate, reason: block })
            continue
          }
        }

        if (target.startsWith('entity:') && (op === 'replace' || op === 'retire')) {
          const entName = target.slice('entity:'.length).trim()
          const ent = entities.find(e => e.name === entName || e.slug === entName)
          const fact = ent?.facts?.find(f => f.id === targetId)
          const block = blockReasonForEntry(fact, candidate, { checkAuthority: false })
          if (block) {
            skippedReasons.push({ candidate, reason: block })
            continue
          }
        }

        if (target.startsWith('lesson:') && (op === 'replace' || op === 'retire')) {
          const lessonName = target.slice('lesson:'.length).trim()
          const targetSlug = slugifyName(lessonName, 'les')
          const lesson = lessons.find(l => (
            l.name === lessonName
            || l.slug === lessonName
            || l.name.toLowerCase() === lessonName.toLowerCase()
            || l.slug === targetSlug
          ))
          const entry = lesson?.entries?.find(e => !e.rawOnly && e.id === targetId)
          const block = blockReasonForEntry(entry, candidate, { checkAuthority: true })
          if (block) {
            skippedReasons.push({ candidate, reason: block })
            continue
          }
        }

        const dreamKey = candidate.dreamKey
          || (targetId ? `${target}:${op}:${targetId}` : `${target}:${op}:${computeContentHash(content)}`)

        if (seenKeysThisRun.has(dreamKey)) {
          skippedReasons.push({ candidate, reason: 'DUPLICATE_IN_RUN' })
          continue
        }

        const alreadyOpen = openDreamItems.some(
          item => item.dream_key === dreamKey || (targetId && item.target === target && item.supersedes_id === targetId),
        )
        if (alreadyOpen) {
          skippedReasons.push({ candidate, reason: 'ALREADY_OPEN_IN_BUFFER' })
          continue
        }

        const inCooldown = rejectedDreamItems.some((item) => {
          const sameTarget = item.dream_key === dreamKey || (targetId && item.target === target && item.supersedes_id === targetId)
          if (!sameTarget) return false
          const rejectedAt = Date.parse(item.updated_at || item.created_at || '')
          if (!Number.isFinite(rejectedAt)) return false
          return nowMs - rejectedAt < cooldownMs
        })
        if (inCooldown) {
          skippedReasons.push({ candidate, reason: 'REJECT_COOLDOWN' })
          continue
        }

        seenKeysThisRun.add(dreamKey)
        verified.push({ ...candidate, dreamKey })
      }

      // Enforce per-run change ratio limit on profile proposals
      const nonPinnedCount = profileEntries.filter(e => !e.pinned).length
      const maxProfileProposals = nonPinnedCount === 0
        ? 0
        : Math.max(1, Math.floor(nonPinnedCount * (config.dream?.maxChangeRatio ?? 0.2)))

      let profileCount = 0
      const accepted = []
      for (const proposal of verified) {
        if (proposal.target === 'profile') {
          if (profileCount >= maxProfileProposals) {
            skippedReasons.push({ candidate: proposal, reason: 'RATIO_CAP_REACHED' })
            continue
          }
          profileCount += 1
        }
        accepted.push(proposal)
      }

      const writtenProposals = []
      if (!dryRun) {
        for (const p of accepted) {
          const created = await bufferApi.appendCreate({
            logicalDate: todayDate,
            scope,
            sourceType: 'dream',
            target: p.target,
            op: p.op,
            section: p.section || '其他长期事实',
            content: p.content,
            supersedesId: p.targetId ?? null,
            anchor: p.evidenceAnchor ?? null,
            pinned: false,
            ...(p.expires ? { expires: p.expires } : {}),
            dreamKey: p.dreamKey,
            reason: p.reason,
            conflict: p.conflict === true,
            producer: p.channel === 'rule' ? 'dream-rule' : 'dream-llm',
          })
          if (!created.duplicate) {
            writtenProposals.push(created)
          }
        }

        // Stage 4: Prune — best-effort rebuild missing history index months
        if (
          missingHistoryMonths.length > 0
          && historyApi
          && config.sections.historyOverview.enabled
          && resolveModelSelection(ctx, config)
        ) {
          for (const month of missingHistoryMonths) {
            try {
              await historyApi.rebuildMonthHistory(month, { signal })
            } catch (histErr) {
              warn('dsh-memory: dream history rebuild failed for %s: %s', month, histErr?.message ?? histErr)
            }
          }
        }

        // Advance watermark ONLY when LLM channel did not fail
        if (llmStatus !== 'failed') {
          const latestJournal = allJournalDates.at(-1) ?? meta?.lastProcessedJournalDate ?? null
          store.setMeta(
            metaKey(scope),
            {
              lastSuccessAt: clock.now(),
              lastLogicalDate: todayDate,
              lastProcessedJournalDate: latestJournal,
              totalRuns: (meta?.totalRuns ?? 0) + 1,
              lastProposalCount: writtenProposals.length,
            },
            clock.now(),
          )
        }
      }

      return {
        ok: true,
        skipped: false,
        dryRun,
        scope,
        todayDate,
        llmStatus,
        degraded,
        ...(llmError ? { llmError } : {}),
        newJournalsCount: newJournals.length,
        nonPinnedCount,
        maxProfileProposals,
        proposals: accepted,
        writtenProposals,
        skippedReasons,
        diagnostics: {
          ...diagnostics,
          missingHistoryMonths,
        },
      }
    } finally {
      inFlight = false
      await releaseLock()
    }
  }

  return {
    shouldRunDream,
    runDream,
    getWatermark: (scope = 'default') => store.getMeta(metaKey(scope)),
  }
}
