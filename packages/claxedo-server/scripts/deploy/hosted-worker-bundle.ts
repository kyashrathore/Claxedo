/**
 * The bundle contract every certified hosted Worker config declares: the
 * compatibility posture its entry is built and booted under, and the one
 * module alias that bundle cannot load without.
 *
 * `zod/v4` resolves to `zod` because esbuild emits no lazy-initializer call
 * for an import that reaches a wrapped module only through a re-export barrel
 * it elides. `zod/v4/index.js` is such a barrel and `zod/index.js` is not, so
 * `@modelcontextprotocol/sdk/types.js` — which calls `z.custom` at module
 * scope — reads `ZodCustom` before any initializer assigns it and the isolate
 * dies on load with `TypeError: Class2 is not a constructor`. The two
 * specifiers are the same zod 4 classic export surface.
 *
 * The alias is a TOML table, so this block has to close the config's
 * top-level keys: a bare key emitted after it would belong to `[alias]`.
 */
export const HOSTED_WORKER_BUNDLE_CONTRACT = `compatibility_date = "2025-05-01"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
workers_dev = false
preview_urls = false

[alias]
"zod/v4" = "zod"`
