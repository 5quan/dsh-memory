import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const plugin = resolve(import.meta.dirname, '..')

const above = (start) => {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'deepseek-harness'))) return join(dir, 'deepseek-harness')
    if (dirname(dir) === dir) return undefined
  }
}

const findHarness = () => {
  if (process.env.DSH_HARNESS) return process.env.DSH_HARNESS
  const localHarness = join(plugin, 'dev', 'harness')
  if (existsSync(join(localHarness, 'node_modules'))) return localHarness
  const siblingDsBotHarness = resolve(plugin, '..', 'dsh-ctrl', 'ds-bot', 'dev', 'harness')
  if (existsSync(join(siblingDsBotHarness, 'node_modules'))) return siblingDsBotHarness
  const near = above(dirname(plugin))
  if (near) return near
  return resolve(plugin, '../deepseek-harness')
}

const harness = findHarness()
process.env.DSH_HARNESS = harness

const base = resolve(harness, 'packages/bundle/base/package.json')
const anchor = pathToFileURL(existsSync(base) ? base : resolve(harness, 'package.json')).href
const workspacePackages = new Map()

if (existsSync(base)) {
  const dirs = [
    ...['apps', 'vendor'].flatMap(group => existsSync(join(harness, group))
      ? readdirSync(join(harness, group), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(harness, group, e.name))
      : []),
    ...(existsSync(join(harness, 'packages'))
      ? readdirSync(join(harness, 'packages'), { withFileTypes: true }).filter(e => e.isDirectory())
        .flatMap(group => readdirSync(join(harness, 'packages', group.name), { withFileTypes: true })
          .filter(e => e.isDirectory()).map(e => join(harness, 'packages', group.name, e.name)))
      : []),
  ]
  for (const dir of dirs) {
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const { name } = JSON.parse(readFileSync(manifest, 'utf8'))
      if (typeof name === 'string') workspacePackages.set(name, pathToFileURL(manifest).href)
    } catch {}
  }
}

const packageNameOf = specifier => specifier.split('/').slice(0, 2).join('/')
const pluginUrl = `${pathToFileURL(plugin).href}/`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(pluginUrl)) {
      const parentURL = workspacePackages.get(packageNameOf(specifier)) ?? anchor
      return nextResolve(specifier, { ...context, parentURL })
    }
    return nextResolve(specifier, context)
  },
})
