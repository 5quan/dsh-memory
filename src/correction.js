import { clipText } from './util.js'

const MIN_CORRECTION_CHARS = 6
const MAX_CORRECTION_CHARS = 500

const CN_FUTURE_DIRECTIVE_RE = /(?:^|[，。；,\s])(?:以后|今后|下次|从现在起)\s*(?:一律|都|统一|千万|直接)?\s*(?:不要|别|必须|一定要|改用|改成|先|用|禁止|严禁)[^，。！？；\n]{2,}/
const CN_REPEAT_NEGATION_RE = /(?:^|[，。；,\s])(?:别再|不要再)[^？?\n]{4,}/
const CN_CORRECTION_PHRASE_RE = /(?:^|[，。；,\s])(?:不对|错了|不是这样|搞错了|别这样|不要这样|我说过|之前说过|提醒过你)(?:(?:了|过|很多次|好几次)?[，,：:；;\s]+.{4,}|(?:不要|别|必须|一定要|只能|不能).{4,})/
const CN_META_CORRECTION_RE = /(?:^|[，。；,\s])(?:纠正一下|更正一下|记牢)(?:[，,：:；;\s]+|.{0,2}).{4,}/
const EN_IMPERATIVE_CORRECTION_RE = /^(?:no[,:\s]+)?(?:don't|do not|never|always)\s+(?:use|do|modify|edit|change|write|run|reply|answer|send|call|skip|forget|truncate|overwrite|delete|put|keep|format|assume)\b.{3,}/i
const EN_CORRECTION_PHRASE_RE = /(?:^|[\s,;])(?:no,\s*(?:don't|do not|never|always)|don't do that|stop doing that|from now on\b|i told you (?:not )?to\b).{4,}/i

const STRONG_QUESTION_DIRECTIVE_RE = /(?:^(?:以后|今后|下次|从现在起)\s*(?:一律|都|统一|千万|直接)?\s*(?:不要|别|必须|一定要|改用|改成|禁止|严禁)|^(?:别再|不要再)|^(?:from now on|no,\s*(?:don't|do not|never|always)))/i

export function detectUserCorrection(rawText) {
  const raw = String(rawText ?? '').trim()
  if (raw.length < MIN_CORRECTION_CHARS || raw.length > MAX_CORRECTION_CHARS) return null
  if (raw.includes('```')) return null

  const clean = raw.replace(/\s+/g, ' ').trim()
  if (clean.length < MIN_CORRECTION_CHARS) return null

  if (/[?？]$/.test(clean) && !STRONG_QUESTION_DIRECTIVE_RE.test(clean)) {
    return null
  }

  let kind = null
  if (CN_FUTURE_DIRECTIVE_RE.test(clean)) {
    kind = 'cn-directive'
  } else if (CN_REPEAT_NEGATION_RE.test(clean) || CN_CORRECTION_PHRASE_RE.test(clean)) {
    kind = 'cn-correction'
  } else if (CN_META_CORRECTION_RE.test(clean)) {
    kind = 'cn-meta-correction'
  } else if (EN_IMPERATIVE_CORRECTION_RE.test(clean) || EN_CORRECTION_PHRASE_RE.test(clean)) {
    kind = 'en-correction'
  }

  if (!kind) return null

  return {
    matched: true,
    kind,
    content: clipText(clean, 300),
  }
}
