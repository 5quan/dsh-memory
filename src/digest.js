import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { formatClock, estimateTokens } from './util.js'

const DIGEST_SYSTEM_PROMPT = `你是一个严谨的个人秘书记忆归档助手。请将给定的当天对话原文整理成结构化的每日日报。
必须严格遵守以下规则：
1. 只能记录原文中确实出现过的事实、决定、纠偏和悬而未决的问题，绝不能猜测或编造。
2. 输出必须严格使用以下 6 个二级标题（不要增删标题，没有内容的段写"- （无）"）：
## 发生了什么
## 做出的决定
## 新建/变更的事项
## 纠正与教训
## 悬而未决的问题
## 提到的实体
3. 重要条目必须保留原文提供的真实锚点，格式为 [chat://YYYY-MM-DD#session#seq]，严禁修改或编造锚点。
4. 在"## 纠正与教训"中重点提取用户指出"不对/别这样/我说过/不要…"等纠偏内容。
5. 直接输出 Markdown 正文，以 "# YYYY-MM-DD 日报" 开头，不要包代码块。`

const CHUNK_MAP_SYSTEM_PROMPT = `请从这一段当天的对话切片中提取结构化要点，供后续合成为完整日报。
规则：
1. 按"发生了什么 / 做出的决定 / 新建变更事项 / 纠正与教训 / 悬而未决 / 提到的实体"分条提取。
2. 每条必须原样保留对应消息前面的 [chat://...] 锚点，严禁编造或改写锚点。
3. 保持简洁准确，不要遗漏用户纠偏。`

export function resolveModelSelection(ctx, config) {
  if (config.llm.provider && config.llm.model) {
    return { provider: config.llm.provider, model: config.llm.model }
  }
  try {
    const defSvc = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : ctx?.agentDefaultModel
    const sel = defSvc?.currentSelection?.()
    if (sel?.provider && sel?.model) {
      return {
        provider: config.llm.provider ?? sel.provider,
        model: config.llm.model ?? sel.model,
        ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}),
      }
    }
  } catch {}
  try {
    const agentsSvc = typeof ctx?.get === 'function' ? ctx.get('agents') : ctx?.agents
    const agents = agentsSvc?.list?.() ?? []
    for (let i = agents.length - 1; i >= 0; i -= 1) {
      const sel = agents[i]?.model?.current?.()
      if (sel?.provider && sel?.model) {
        return {
          provider: config.llm.provider ?? sel.provider,
          model: config.llm.model ?? sel.model,
          ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}),
        }
      }
    }
  } catch {}
  return undefined
}

export async function callLlmOneShot(ctx, { provider, model, reasoningEffort, system, prompt, maxTokens = 16_384, signal }) {
  if (!ctx?.llm?.stream) {
    throw new Error('ctx.llm.stream is unavailable')
  }
  const assembler = new BlockAssembler()
  const request = {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens,
    ...(signal ? { signal } : {}),
  }
  for await (const chunk of ctx.llm.stream(request)) {
    assembler.push(chunk)
  }
  const finish = assembler.finish
  if (finish?.kind === 'error') {
    const code = finish.failure?.code ? ` (${finish.failure.code})` : ''
    throw new Error(`LLM stream error${code}: ${finish.failure?.message ?? 'unknown error'}`)
  }
  if (finish?.kind === 'aborted') {
    throw new Error(`LLM stream aborted: ${finish.failure?.message ?? 'aborted'}`)
  }
  const text = assembler.blocks()
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (text === '') {
    throw new Error('LLM returned an empty digest response')
  }
  return text
}

function formatMessageLine(msg, timeZone) {
  const roleLabel = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'Card'
  const clockStr = formatClock(msg.timestamp, timeZone)
  return `[${msg.anchor}] (${clockStr}) ${roleLabel}: ${msg.text}`
}

export function chunkMessages(messages, maxChunkTokens, timeZone = 'UTC') {
  const chunks = []
  let current = []
  let currentTokens = 0

  for (const msg of messages) {
    const line = formatMessageLine(msg, timeZone)
    const cost = estimateTokens(line) + 4
    if (current.length > 0 && currentTokens + cost > maxChunkTokens) {
      chunks.push(current)
      current = []
      currentTokens = 0
    }
    current.push(line)
    currentTokens += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function buildDigestPrompt({ logicalDate, transcriptText, notes }) {
  const noteBlock = notes.length > 0
    ? `\n\n以下是用户在今天缓冲区补充的待归档备忘（target=note，请一并整合进对应段落）：\n${notes.map(n => `- ${n.anchor ? `[${n.anchor}] ` : ''}${n.content}`).join('\n')}`
    : ''
  return `目标逻辑日期：${logicalDate}\n\n请根据以下对话原文生成 "# ${logicalDate} 日报"：\n\n${transcriptText}${noteBlock}`
}

export function createDigestApi({ ctx, config, store, bufferApi, profileApi, journalApi, clock = { now: () => Date.now() }, warn = () => {} }) {
  async function generateDailyDigest(logicalDate, { scope = 'default', force = false, signal } = {}) {
    const existing = journalApi.readJournal(config.home, logicalDate)
    if (existing !== '' && !force) {
      return { ok: true, skipped: true, reason: 'ALREADY_EXISTS', logicalDate, path: journalApi.journalPath(config.home, logicalDate) }
    }

    const messages = store.getMessagesForDate(logicalDate, scope)
    const notes = bufferApi.listItems({ scope, logicalDate, target: 'note', statuses: ['pending', 'approved'] })

    if (messages.length === 0 && notes.length === 0) {
      return { ok: true, skipped: true, reason: 'NO_MESSAGES', logicalDate }
    }

    const selection = resolveModelSelection(ctx, config)
    if (!selection) {
      throw new Error('No LLM provider/model resolved for daily digest generation')
    }

    const chunks = chunkMessages(messages, config.digest.maxChunkTokens, config.timeZone)
    let rawDigest = ''

    if (chunks.length <= 1) {
      const transcriptText = chunks[0]?.join('\n') ?? '（无对话原文，仅缓冲区备忘）'
      rawDigest = await callLlmOneShot(ctx, {
        ...selection,
        system: DIGEST_SYSTEM_PROMPT,
        prompt: buildDigestPrompt({ logicalDate, transcriptText, notes }),
        signal,
      })
    } else {
      // Intra-day Map-Reduce so long days fit comfortably without cross-day summarization
      const partialSummaries = []
      for (let i = 0; i < chunks.length; i += 1) {
        const partPrompt = `目标逻辑日期：${logicalDate}（分块 ${i + 1}/${chunks.length}）\n\n${chunks[i].join('\n')}`
        const part = await callLlmOneShot(ctx, {
          ...selection,
          system: CHUNK_MAP_SYSTEM_PROMPT,
          prompt: partPrompt,
          signal,
        })
        partialSummaries.push(`### 分块 ${i + 1}\n${part}`)
      }
      rawDigest = await callLlmOneShot(ctx, {
        ...selection,
        system: DIGEST_SYSTEM_PROMPT,
        prompt: buildDigestPrompt({
          logicalDate,
          transcriptText: `以下是同一天分块提取的要点（已保留原始锚点），请合成为一份完整 6 段日报：\n\n${partialSummaries.join('\n\n')}`,
          notes,
        }),
        signal,
      })
    }

    const { markdown, unverifiedAnchors } = journalApi.verifyJournalAnchors(rawDigest, logicalDate, store)
    if (unverifiedAnchors.length > 0) {
      warn('dsh-memory: stripped %d unverified anchor(s) in %s journal: %s', unverifiedAnchors.length, logicalDate, unverifiedAnchors.join(', '))
    }

    await journalApi.writeJournalAtomic(config.home, logicalDate, markdown, { force })
    const closedNotes = notes.length > 0
      ? await bufferApi.closeNotesForDate({ logicalDate, scope })
      : []

    const profileSettlement = await bufferApi.settleProfileForDate({
      logicalDate,
      scope,
      store,
      profileApi,
      config,
      nowIso: new Date(clock.now()).toISOString(),
    })

    for (const warning of profileSettlement.warnings) {
      warn('dsh-memory: buffer item %s was not auto-committed (%s)', warning.id, warning.reason)
    }

    return {
      ok: true,
      skipped: false,
      logicalDate,
      path: journalApi.journalPath(config.home, logicalDate),
      unverifiedAnchors,
      closedNotes,
      profileSettlement,
      chunks: chunks.length,
    }
  }

  return {
    generateDailyDigest,
    resolveModelSelection: () => resolveModelSelection(ctx, config),
  }
}
