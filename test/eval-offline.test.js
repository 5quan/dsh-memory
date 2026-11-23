import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runAblationEval } from '../eval/run-eval.mjs'
import { detectUserCorrection } from '../src/correction.js'
import { detectSecret } from '../src/guard.js'
import * as profileApi from '../src/profile.js'
import { createMemoryStore } from '../src/store.js'

test('offline regression benchmark: correction P/R, secret guard FP/recall, row-window adjacency, and 3-way ablation dry-run', async (t) => {
  // 1. Correction detection Precision / Recall corpus
  const correctionCorpus = [
    { text: '不对，以后汇报先说结论再给细节。', expected: true },
    { text: '错了，不要直接修改 PROFILE.md。', expected: true },
    { text: '别再跳过单测直接提 PR 了。', expected: true },
    { text: '以后一律用 pnpm 运行脚本。', expected: true },
    { text: '纠正一下，测试服端口改成 3086。', expected: true },
    { text: 'From now on, always verify anchors before writing.', expected: true },
    { text: "No, don't overwrite pinned entries automatically.", expected: true },
    { text: '为什么不对吗？', expected: false },
    { text: '记住：我喜欢喝乌龙茶。', expected: false },
    { text: '今天天气不错，帮忙看看这段代码。', expected: false },
    { text: '```js\nconst msg = "不对，别这样"\n```', expected: false },
    { text: '不要用这个过时 API', expected: false },
  ]
  let tp = 0
  let fp = 0
  let fn = 0
  for (const sample of correctionCorpus) {
    const predicted = Boolean(detectUserCorrection(sample.text))
    if (predicted && sample.expected) tp += 1
    if (predicted && !sample.expected) fp += 1
    if (!predicted && sample.expected) fn += 1
  }
  const corrPrecision = tp / Math.max(1, tp + fp)
  const corrRecall = tp / Math.max(1, tp + fn)
  assert.equal(corrPrecision, 1)
  assert.equal(corrRecall, 1)

  // 2. Secret guard Recall & zero false-positive benchmark
  const secretCorpus = [
    { text: 'sk-proj-1234567890abcdef123456', expected: true },
    { text: 'ghp_1234567890abcdef1234567890abcdef12', expected: true },
    { text: 'AKIAIOSFODNN7EXAMPLE', expected: true },
    { text: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload', expected: true },
    { text: '验证码: 938472', expected: true },
    { text: 'Node v24.9.0 and commit 94f314c7bcfa1a37e1eddc736fb6225c2b6a93bc', expected: false },
    { text: '服务监听端口 3085，密钥保存在 OPENAI_API_KEY 环境变量', expected: false },
    { text: 'GitHub 令牌名称是 GITHUB_TOKEN，不要写具体值', expected: false },
  ]
  for (const item of secretCorpus) {
    assert.equal(detectSecret(item.text).detected, item.expected, `Secret mismatch on: ${item.text}`)
  }

  // 3. FTS5 + non-contiguous row-window completeness
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-eval-off-'))
  const store = createMemoryStore(join(dir, 'archive.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  store.insertMessage({ sessionId: 's1', logicalDate: '2026-11-20', seq: 2, role: 'user', text: '前置需求：端口需要隔离。', timestamp: 1000, anchor: 'chat://2026-11-20#s1#2' })
  store.insertMessage({ sessionId: 's1', logicalDate: '2026-11-20', seq: 7, role: 'assistant', text: '决定：测试服务改用 3099 端口。', timestamp: 2000, anchor: 'chat://2026-11-20#s1#7' })
  store.insertMessage({ sessionId: 's1', logicalDate: '2026-11-20', seq: 13, role: 'user', text: '后续确认：3099 不冲突。', timestamp: 3000, anchor: 'chat://2026-11-20#s1#13' })

  const hits = store.searchMessages({ query: '3099 端口' })
  assert.equal(hits.length >= 1, true)
  const ctx = store.getMessageContext({ anchor: 'chat://2026-11-20#s1#7', before: 1, after: 1 })
  assert.deepEqual(ctx.messages.map(m => m.seq), [2, 7, 13])

  // 4. PROFILE forget zero-residue check
  await profileApi.applyProfileBatch(dir, [
    { op: 'add', section: '其他', content: '待擦除 SecretTagA 条目', source: 'chat://2026-11-20#s1#7' },
    { op: 'add', section: '其他', content: '保留手动条目', source: 'manual' },
  ])
  await profileApi.redactProfileForForget(dir, { keyword: 'SecretTagA', force: true })
  assert.equal(profileApi.readProfile(dir).includes('SecretTagA'), false)
  assert.equal(profileApi.readProfile(dir).includes('保留手动条目'), true)

  // 5. 3-way ablation benchmark dry-run verification
  const report = await runAblationEval({ dryRun: true })
  assert.equal(report.caseCount, 8)
  const noMem = report.summary.find(s => s.arm === 'no-memory')
  const dshMem = report.summary.find(s => s.arm === 'dsh-memory')
  const goldMem = report.summary.find(s => s.arm === 'gold-memory')
  assert.equal(noMem.accuracy, 0)
  assert.equal(dshMem.accuracy >= 85, true, `Expected >= 85% offline context recall, got ${dshMem.accuracy}%`)
  assert.equal(goldMem.accuracy, 100)
  assert.equal(dshMem.avgCachedPrefixTokens > 0, true)
})
