/**
 * DeepSeek Harness plugin entry.
 *
 * Cordis loads this module and calls `apply(ctx, config)`. Everything the
 * plugin owns (background listeners, store handle, command registration) is
 * created inside `ctx.effect(...)`, so unloading the plugin disposes it
 * cleanly — the same pattern shipped DSH plugins use.
 *
 * The plugin declares no `inject`: it must load on any profile, including ones
 * without a skills service or a compaction service. Optional services are read
 * lazily through the adapter (`ctx.get(...)`), and absent services degrade to
 * "memory without that source" rather than a failed plugin load.
 *
 * @module dsh-long-memory
 */

import { DEFAULT_CONFIG, normalizeConfig } from './config.js'
import { createRuntime } from './adapter/runtime.js'
import { PLUGIN_VERSION } from './core/constants.js'

export const name = 'long-memory'
export const version = PLUGIN_VERSION
export const inject = []

/**
 * @param {any} ctx cordis context of this plugin fiber
 * @param {object | undefined} config plugin config from cordis.patch.yml
 * @returns {void}
 */
export function apply(ctx, config) {
  const normalized = normalizeConfig(config)
  if (normalized.enabled === false) return
  const runtime = createRuntime({
    ctx,
    config: normalized,
    logger: ctx?.logger,
    version: PLUGIN_VERSION,
  })
  ctx.effect(
    () => {
      runtime.start()
      return () => runtime.dispose()
    },
    'long-memory',
  )
}

export { DEFAULT_CONFIG }
