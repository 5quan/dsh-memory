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
