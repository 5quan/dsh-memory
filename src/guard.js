import { createHash } from 'node:crypto'

export class MemoryGuardError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'MemoryGuardError'
    this.code = code
    this.details = details
  }
}

const PLACEHOLDER_VALUE_RE = /^(?:xxx+|placeholder|changeme|example|your[_-].+|none|null|n\/a|\*+|\.{3,}|<[^>]+>|\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*)$/i
const ENV_NAME_ONLY_RE = /^[A-Z][A-Z0-9_]{2,}$/
const FILE_PATH_LIKE_RE = /^(?:[.~\/\\]|[A-Za-z]:[\/\\]).*(?:\.pem|\.key|\.env|id_rsa|id_ed25519)?$/i

const HIGH_CONFIDENCE_PATTERNS = [
  { kind: 'openai_or_api_sk', re: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/ },
  { kind: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { kind: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'slack_token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { kind: 'pem_private_key', re: /-----BEGIN\s+(?:RSA|EC|OPENSSH|DSA|PGP)?\s*PRIVATE KEY-----/i },
  { kind: 'bearer_token', re: /\bBearer\s+(?!<)(?!\{)(?!\$)[A-Za-z0-9\-._~+/]{12,}=*/i },
]

const KEY_VALUE_SECRET_RE = /(?:^|[\s,;'"`])(?:password|passwd|pwd|api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|密码|口令|密钥)\s*[:=：]\s*["']?([^\s"'`,;。；]{6,})["']?/gi
const OTP_SECRET_RE = /(?:验证码|动态码|校验码|otp|verification\s*code)\s*(?:是|为|[:=：])?\s*([0-9]{4,8})(?![0-9.])/i

export function normalizeContentForHash(text) {
  return String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[。．.！!？?；;，,：:\s]+$/g, '')
    .toLowerCase()
}

export function computeContentHash(text) {
  const normalized = normalizeContentForHash(text)
  if (!normalized) return ''
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32)
}

export function detectSecret(text) {
  const input = String(text ?? '')
  if (input.trim() === '') return { detected: false }

  for (const rule of HIGH_CONFIDENCE_PATTERNS) {
    if (rule.re.test(input)) {
      return {
        detected: true,
        code: 'SECRET_DETECTED',
        kind: rule.kind,
        message: `Refused to store potential secret (${rule.kind}). Record only the credential or environment variable name (e.g. OPENAI_API_KEY / GITHUB_TOKEN), never its value.`,
      }
    }
  }

  KEY_VALUE_SECRET_RE.lastIndex = 0
  let match
  while ((match = KEY_VALUE_SECRET_RE.exec(input)) !== null) {
    const val = match[1].trim()
    if (!val) continue
    if (PLACEHOLDER_VALUE_RE.test(val)) continue
    if (ENV_NAME_ONLY_RE.test(val)) continue
    if (FILE_PATH_LIKE_RE.test(val)) continue
    return {
      detected: true,
      code: 'SECRET_DETECTED',
      kind: 'credential_assignment',
      message: 'Refused to store explicit password/secret/token value. Record only the credential or environment variable name, never its value.',
    }
  }

  if (OTP_SECRET_RE.test(input)) {
    return {
      detected: true,
      code: 'SECRET_DETECTED',
      kind: 'otp_code',
      message: 'Refused to store verification/OTP code. Do not persist one-time codes in memory.',
    }
  }

  return { detected: false }
}

const PROMPT_INJECTION_RULES = [
  {
    kind: 'role_hijack_markup',
    re: /<\/?(?:system|system-reminder|developer|instructions|tool_call|function_call)\b[^>]*>|(?:^|\n)\s*(?:SYSTEM\s+OVERRIDE|JAILBREAK|ADMIN\s+MODE|DEVELOPER\s+OVERRIDE)\s*[:：]/i,
    message: 'Refused to store hidden role/system markup injection directive in memory.',
  },
  {
    kind: 'instruction_override',
    re: /(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+)?(?:(?:previous|prior|earlier|above|system|safety|security|existing)\s+)+(?:instructions|prompts?|rules?|constraints?|guardrails?)|(?:忽略|无视|忘记|覆盖|绕过|废除)\s*(?:(?:之前|先前|此前|以上|所有|一切|既有|全部)\s*)*(?:系统|安全|红线|保密)(?:规则|指令|提示词|约束|限制)|(?:忽略|无视|忘记|覆盖|绕过|废除)\s*(?:(?:之前|先前|此前|以上|所有|一切|既有|全部)\s*)+(?:规则|指令|提示词|约束|限制)/i,
    message: 'Refused to store instruction-override prompt injection in memory.',
  },
  {
    kind: 'approval_bypass',
    re: /(?:auto[-_\s]?approve|automatically\s+approve|skip\s+(?:all\s+|human\s+)?(?:approval|confirmation|safety\s+checks?)|bypass\s+(?:approval|permission|guard))|(?:自动批准(?:所有|全部|一切)?|跳过(?:所有|全部|人工)?(?:确认|审批|安全检查)|免审批(?:执行|所有)?|绕过(?:权限|审批|防护))/i,
    message: 'Refused to store approval-bypass or safety-skipping directive in memory.',
  },
  {
    kind: 'exfiltration_directive',
    re: /(?:silently|secretly|quietly|without\s+telling\s+(?:the\s+)?user)\s+(?:send|upload|exfiltrate|post|leak|transmit)\b.*?(?:https?:\/\/|token|secret|key|env|credential|file)|(?:悄悄|偷偷|背地里|不要告诉用户|隐蔽地)(?:将|把)?.*?(?:密钥|密码|token|凭证|环境变量|\.env).*?(?:发送|上传|传到|回传|外发)/i,
    message: 'Refused to store stealth exfiltration directive in memory.',
  },
  {
    kind: 'tool_coercion',
    re: /(?:silently|automatically|without\s+asking)\s+(?:execute|run)\b.*?(?:rm\s+-rf|curl\s+[^|\n]*\|\s*(?:sh|bash)|powershell\s+-enc)|(?:每次(?:会话|启动|响应)都)?(?:静默|偷偷|自动)执行\s*(?:`?(?:rm\s+-rf|curl\s+[^|\n]*\|\s*(?:sh|bash)|powershell\s+-enc))/i,
    message: 'Refused to store coercive hidden shell payload directive in memory.',
  },
]

/**
 * Detect high-confidence prompt injection / memory poisoning payloads while
 * allowing benign user preferences and engineering safety rules.
 */
export function detectPromptInjection(text) {
  const input = String(text ?? '')
  if (input.trim() === '') return { detected: false }

  for (const rule of PROMPT_INJECTION_RULES) {
    if (rule.re.test(input)) {
      return {
        detected: true,
        code: 'INJECTION_DETECTED',
        kind: rule.kind,
        message: rule.message,
      }
    }
  }
  return { detected: false }
}

export function checkMemorySafety(text, { blockPromptInjection = true } = {}) {
  const secret = detectSecret(text)
  if (secret.detected) return secret
  if (blockPromptInjection !== false) {
    const inj = detectPromptInjection(text)
    if (inj.detected) return inj
  }
  return { detected: false }
}

export function checkDuplicateContent({
  content,
  scope = 'default',
  target = 'profile',
  section = '其他长期事实',
  op = 'add',
  bufferItems = [],
  profileEntries = [],
  lessonEntries = [],
} = {}) {
  const contentHash = computeContentHash(content)
  if ((op ?? 'add') !== 'add' || !contentHash) {
    return { duplicate: false, contentHash }
  }

  for (const item of bufferItems) {
    if (item.status !== 'pending' && item.status !== 'approved') continue
    if (item.scope !== scope || item.target !== target) continue
    if (target === 'profile' && (item.section || '其他长期事实') !== (section || '其他长期事实')) continue
    if ((item.op ?? 'add') !== 'add') continue
    const itemHash = item.content_hash || computeContentHash(item.content)
    if (itemHash === contentHash) {
      return {
        duplicate: true,
        duplicateIn: 'buffer',
        existingId: item.id,
        existingItem: item,
        contentHash,
      }
    }
  }

  if (target === 'profile') {
    for (const entry of profileEntries) {
      if ((entry.section || '其他长期事实') !== (section || '其他长期事实')) continue
      if (computeContentHash(entry.content) === contentHash) {
        return {
          duplicate: true,
          duplicateIn: 'profile',
          existingId: entry.id,
          existingEntry: entry,
          contentHash,
        }
      }
    }
  }

  if (typeof target === 'string' && target.startsWith('lesson:')) {
    for (const entry of lessonEntries) {
      if (entry.rawOnly) continue
      if (computeContentHash(entry.content) === contentHash) {
        return {
          duplicate: true,
          duplicateIn: 'lesson',
          existingId: entry.id,
          existingEntry: entry,
          contentHash,
        }
      }
    }
  }

  return { duplicate: false, contentHash }
}
