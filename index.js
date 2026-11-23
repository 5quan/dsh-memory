import { join } from 'node:path'
import { normalizeConfig } from './src/config.js'
import { createMemoryStore } from './src/store.js'
import * as profileApi from './src/profile.js'
import * as journalApi from './src/journal.js'
import * as entityApi from './src/entities.js'
import * as lessonApi from './src/lessons.js'
import { createBufferApi } from './src/buffer.js'
import { createHistoryApi } from './src/history.js'
import { createDigestApi } from './src/digest.js'
import { createOnboardingApi } from './src/onboarding.js'
import { createBriefingApi } from './src/briefing.js'
import { createRolloverApi } from './src/rollover.js'
import { createDreamApi } from './src/dream.js'
import { createIngestApi } from './src/ingest.js'
import { createContextApi } from './src/context.js'
import { createToolsApi } from './src/tools.js'
import { createPublicService, DAY_ROLLED_OVER_EVENT, SERVICE_NAME } from './src/service.js'

export { DAY_ROLLED_OVER_EVENT, SERVICE_NAME }
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

  const bufferApi = createBufferApi({ home: config.home, profileApi, lessonApi, clock })
  const historyApi = createHistoryApi({
    ctx,
    config,
    store,
    journalApi,
    warn,
  })
  const dreamApi = createDreamApi({
    ctx,
    config,
    store,
    profileApi,
    journalApi,
    bufferApi,
    entityApi,
    lessonApi,
    historyApi,
    clock,
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
    lessonApi,
    historyApi,
    clock,
    warn,
  })

  // contextApi and onboardingApi/briefingApi cross-reference snapshot helpers
  let contextApi
  const snapshotFacade = {
    hasSnapshot: (sessionId, logicalDate) => contextApi?.hasSnapshot?.(sessionId, logicalDate) ?? false,
    invalidateSnapshots: opts => contextApi?.invalidateSnapshots?.(opts),
  }

  const onboardingApi = createOnboardingApi({
    ctx,
    config,
    store,
    profileApi,
    bufferApi,
    entityApi,
    contextApi: snapshotFacade,
    clock,
    warn,
  })
  const briefingApi = createBriefingApi({
    ctx,
    config,
    store,
    journalApi,
    bufferApi,
    profileApi,
    entityApi,
    lessonApi,
    contextApi: snapshotFacade,
    clock,
  })

  contextApi = createContextApi({
    ctx,
    config,
    store,
    profileApi,
    journalApi,
    bufferApi,
    entityApi,
    lessonApi,
    onboardingApi,
    briefingApi,
    clock,
    warn,
  })
  const rolloverApi = createRolloverApi({
    ctx,
    config,
    store,
    digestApi,
    contextApi,
    journalApi,
    bufferApi,
    dreamApi,
    clock,
    onRollover: deps.onRollover,
    warn,
  })
  const ingestApi = createIngestApi({
    ctx,
    config,
    store,
    rolloverApi,
    bufferApi,
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
    lessonApi,
    onboardingApi,
    briefingApi,
    profileApi,
    dreamApi,
    clock,
  })
  const publicService = createPublicService({
    config,
    store,
    bufferApi,
    entityApi,
    lessonApi,
    briefingApi,
    onboardingApi,
    clock,
  })

  if (typeof ctx?.provide === 'function') {
    ctx.provide(SERVICE_NAME, publicService)
  }

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
    lessonApi,
    historyApi,
    bufferApi,
    digestApi,
    dreamApi,
    onboardingApi,
    briefingApi,
    rolloverApi,
    ingestApi,
    contextApi,
    toolsApi,
    service: publicService,
    whenReady: () => readyPromise,
  }
}

export function apply(ctx, config = {}) {
  createMemoryRuntime(ctx, config)
}
