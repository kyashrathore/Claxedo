import { createRequire } from "node:module"
import path from "node:path"

import { asRecord, asString } from "@claxedo/helpers/guards"

/**
 * zod's ES module entry, as an absolute path.
 *
 * Wrangler resolves an alias target with Node's `require.resolve` from the
 * config's directory, so a bare `zod` target names zod's CommonJS build: the
 * bundle then carries a second, CommonJS copy of zod with every locale beside
 * the ES module copy the rest of the Worker imports.
 */
function zodEsModuleEntry() {
  const require = createRequire(import.meta.url)
  const manifestFile = require.resolve("zod/package.json")
  const manifest = asRecord(require(manifestFile))
  const entry = asString(asRecord(asRecord(manifest?.exports)?.["."])?.import)
  if (!entry) throw new Error(`${manifestFile} names no ES module entry`)
  return path.join(path.dirname(manifestFile), entry)
}

/**
 * The bundle contract every certified hosted Worker config declares: the
 * compatibility posture its entry is built and booted under, and the one
 * module alias that bundle cannot load without.
 *
 * `zod/v4` resolves to zod's root entry because esbuild emits no
 * lazy-initializer call for an import that reaches a wrapped module only
 * through a re-export barrel it elides. `zod/v4/index.js` is such a barrel and
 * `zod/index.js` is not, so `@modelcontextprotocol/sdk/types.js` — which calls
 * `z.custom` at module scope — reads `ZodCustom` before any initializer assigns
 * it and the isolate dies on load with `TypeError: Class2 is not a
 * constructor`. The two specifiers are the same zod 4 classic export surface.
 *
 * `enable_ctx_exports` gives the plugin-backend supervisor `ctx.exports`, from
 * which it binds a loaded backend's `env.PLATFORM` and outbound gate; at this
 * compatibility date the runtime leaves `ctx.exports` undefined without it.
 *
 * The alias is a TOML table, so this block has to close the config's
 * top-level keys: a bare key emitted after it would belong to `[alias]`.
 */
export const HOSTED_WORKER_BUNDLE_CONTRACT = `compatibility_date = "2025-05-01"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public", "enable_ctx_exports"]
workers_dev = false
preview_urls = false

[alias]
"zod/v4" = ${JSON.stringify(zodEsModuleEntry())}`
