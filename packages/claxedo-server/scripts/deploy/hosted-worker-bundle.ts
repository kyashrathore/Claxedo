import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import { asRecord, asString } from "@claxedo/helpers/guards"

/**
 * A package's ES module build, as an absolute path: the target its `exports`
 * map names under `condition`, for the copy `importer` resolves.
 *
 * Wrangler resolves an alias target with Node's `require.resolve` from the
 * config's directory, so a bare package name as the target names the package's
 * CommonJS build.
 */
function esModuleEntry(packageName: string, condition: "import" | "module", importer: string = import.meta.url) {
  const entryFile = createRequire(importer).resolve(packageName)
  for (let directory = path.dirname(entryFile); directory !== path.dirname(directory); directory = path.dirname(directory)) {
    const manifestFile = path.join(directory, "package.json")
    if (!fs.existsSync(manifestFile)) continue
    const manifest = asRecord(JSON.parse(fs.readFileSync(manifestFile, "utf8")))
    if (manifest?.name !== packageName) continue
    const entry = asString(asRecord(asRecord(manifest.exports)?.["."])?.[condition])
    if (!entry) throw new Error(`${manifestFile} names no "${condition}" entry`)
    return path.join(directory, entry)
  }
  throw new Error(`${packageName} has no package.json above ${entryFile}`)
}

/** The Better Auth module that imports `@opentelemetry/semantic-conventions`, which the server does not depend on itself. */
const betterAuthCore = () => createRequire(import.meta.url).resolve("@better-auth/core")

/**
 * The one compatibility date every Claxedo Worker deploys at: the newest the
 * workerd in this repository's Miniflare (1.20260730.1) runs, so each Worker's
 * tests boot it under the date it ships with. workspace-relay's wrangler.toml
 * and wrangler-h2.toml and the plugin supervisor's loaded backends repeat it;
 * wrangler-config.test.ts holds them equal and names the sandbox Worker, at a
 * later date its own Wrangler runs, as the one exception.
 */
export const WORKERS_COMPATIBILITY_DATE = "2026-07-30"

/**
 * The bundle contract every certified hosted Worker config declares: the
 * compatibility posture its entry is built and booted under, and the module
 * aliases it is bundled with.
 *
 * `zod/v4` resolves to zod's root entry because esbuild emits no
 * lazy-initializer call for an import that reaches a wrapped module only
 * through a re-export barrel it elides. `zod/v4/index.js` is such a barrel and
 * `zod/index.js` is not, so `@modelcontextprotocol/sdk/types.js` — which calls
 * `z.custom` at module scope — reads `ZodCustom` before any initializer assigns
 * it and the isolate dies on load with `TypeError: Class2 is not a
 * constructor`. The two specifiers are the same zod 4 classic export surface.
 * The target is zod's ES module build: its CommonJS build would put a second
 * copy of zod, with every locale, beside the one the rest of the Worker imports.
 *
 * `@opentelemetry/semantic-conventions` publishes its ES module build only
 * under the `module` condition, which esbuild adds only when no custom
 * conditions are set, and Wrangler sets its own. Unaliased, the four attribute
 * names Better Auth imports bring the package's whole CommonJS build, which
 * cannot be tree-shaken and runs at startup.
 *
 * The aliases are a TOML table, so this block has to close the config's
 * top-level keys: a bare key emitted after it would belong to `[alias]`.
 */
export const HOSTED_WORKER_BUNDLE_CONTRACT = `compatibility_date = "${WORKERS_COMPATIBILITY_DATE}"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]
workers_dev = false
preview_urls = false

[alias]
"zod/v4" = ${JSON.stringify(esModuleEntry("zod", "import"))}
"@opentelemetry/semantic-conventions" = ${JSON.stringify(esModuleEntry("@opentelemetry/semantic-conventions", "module", betterAuthCore()))}`
