import { join } from 'node:path'
import { normalizeConfig } from './src/config.js'
import { createMemoryStore } from './src/store.js'
import * as profileApi from './src/profile.js'
import * as journalApi from './src/journal.js'
import * as entityApi from './src/entities.js'
import { createBufferApi } from './src/buffer.js'
import { createHistoryApi } from './src/history.js'
import { createDigestApi } from './src/digest.js'
import { createRolloverApi } from './src/rollover.js'
import { createIngestApi } from './src/ingest.js'
import { createContextApi } from './src/context.js'
import { createToolsApi } from './src/tools.js'

export const name = 'dsh-memory'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessions']

export function createMemoryRuntime(ctx, rawConfig = {}, deps = {}) {
  const config = normalizeConfig(rawConfig)
  const clock = deps.clock ?? { now: () => Date.now() }
  const warn = deps.warn ?? ((...args) => {
    const logger = ctx?.logger
    if (logger?.warn) logger.warn(...args)
  })

  const store = createMemoryStore(join(config.home, 'archive.sqlite'))
  ctx.effect(() => () => store.close(), 'dsh-memory: close archive.sqlite')

  const bufferApi = createBufferApi({ home: config.home, clock })
  const historyApi = createHistoryApi({
    ctx,
    config,
    store,
    journalApi,
    warn,
  })
  const digestApi = createDigestApi({
    ctx,
    config,
    store,
    bufferApi,
    profileApi,
    journalApi,
    entityApi,
    historyApi,
    clock,
    warn,
  })
  const contextApi = createContextApi({
    ctx,
    config,
    store,
    profileApi,
    journalApi,
    bufferApi,
    entityApi,
    clock,
    warn,
  })
  const rolloverApi = createRolloverApi({
    ctx,
    config,
    store,
    digestApi,
    contextApi,
    clock,
    onRollover: deps.onRollover,
    warn,
  })
  const ingestApi = createIngestApi({
    ctx,
    config,
    store,
    rolloverApi,
    clock,
    warn,
  })
  const toolsApi = createToolsApi({
    ctx,
    config,
    store,
    bufferApi,
    journalApi,
    digestApi,
    contextApi,
    historyApi,
    entityApi,
    clock,
  })

  ingestApi.install()
  contextApi.install()
  toolsApi.install()

  if (deps.startTimer !== false) {
    ctx.effect(() => rolloverApi.startTimer(), 'dsh-memory: rollover timer')
  }

  let readyPromise = Promise.resolve()
  if (deps.autoCatchUp !== false) {
    readyPromise = (async () => {
      await ingestApi.catchUpFromSessionQuery()
      await rolloverApi.checkAndRollover({ isStartup: true })
    })().catch(error => {
      warn('dsh-memory: startup catch-up/rollover failed: %s', error?.message ?? error)
    })
  }

  return {
    config,
    clock,
    store,
    profileApi,
    journalApi,
    entityApi,
    historyApi,
    bufferApi,
    digestApi,
    rolloverApi,
    ingestApi,
    contextApi,
    toolsApi,
    whenReady: () => readyPromise,
  }
}

export function apply(ctx, config = {}) {
  return createMemoryRuntime(ctx, config)
}
