import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { builtinModules } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build, type Plugin } from "esbuild"
import { Miniflare } from "miniflare"
import { openSqliteDatabase } from "./sqlite/node"
import { RuntimeStore } from "./store"
import { openRuntimeStoreDatabase } from "./store-file"
import { storeCoreScenarios } from "./test-support/store-core-scenarios"

const scenarios = Object.keys(storeCoreScenarios)

void describe("store core scenarios on the Node SQLite driver", () => {
  for (const name of scenarios) {
    void it(name, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-store-core-"))
      const stores: RuntimeStore[] = []
      const side = openSqliteDatabase(path.join(root, "state.db"))
      try {
        storeCoreScenarios[name]!({
          open: () => {
            const store = new RuntimeStore(openRuntimeStoreDatabase(root))
            stores.push(store)
            return store
          },
          exec: (sql) => side.exec(sql),
        })
      } finally {
        for (const store of stores) store.close()
        side.close()
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }
})

const WORKER = `
import { RuntimeStore } from ${JSON.stringify(fileURLToPath(new URL("./store.ts", import.meta.url)))}
import { durableObjectSqliteDatabase } from ${JSON.stringify(fileURLToPath(new URL("./sqlite/durable-object.ts", import.meta.url)))}
import { storeCoreScenarios } from ${JSON.stringify(fileURLToPath(new URL("./test-support/store-core-scenarios.ts", import.meta.url)))}

export class StoreGate {
  constructor(ctx) {
    this.ctx = ctx
  }

  async fetch(request) {
    const name = new URL(request.url).searchParams.get("scenario")
    const storage = this.ctx.storage
    try {
      storeCoreScenarios[name]({
        open: () => new RuntimeStore({ db: durableObjectSqliteDatabase(storage), location: "durable-object:" + name, flush: () => {} }),
        exec: (sql) => storage.sql.exec(sql).toArray(),
      })
      return Response.json({ ok: true })
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) })
    }
  }
}

export default {
  fetch(request, env) {
    const name = new URL(request.url).searchParams.get("scenario")
    return env.STORE_GATE.get(env.STORE_GATE.idFromName(name)).fetch(request)
  },
}
`

/**
 * The Node imports the store's closure still makes, each one reviewed: the
 * harness's subagent admission derives keys with a synchronous SHA-256 and
 * allocates child ids with `randomUUID`, so the worker runs with
 * `nodejs_compat` for these and fails the build on any other.
 */
const ALLOWED_NODE_IMPORTS = [
  { importer: "harness/src/broker/subagents/admission.ts", module: "node:crypto" },
  { importer: "harness/src/broker/subagents/index.ts", module: "node:crypto" },
]

const onlyReviewedNodeImports: Plugin = {
  name: "only-reviewed-node-imports",
  setup(build) {
    build.onResolve({ filter: new RegExp(`^(node:|(${builtinModules.join("|")})(/|$))`) }, (args) => {
      const importer = args.importer.split(path.sep).join("/")
      const reviewed = ALLOWED_NODE_IMPORTS.some((item) => importer.endsWith(item.importer) && args.path === item.module)
      if (reviewed) return { path: args.path, external: true }
      return { errors: [{ text: `${args.path} reached the store's closure from ${importer}` }] }
    })
  },
}

void describe("store core scenarios on Durable Object SQLite under workerd", () => {
  let miniflare: Miniflare

  before(async () => {
    const bundled = await build({
      stdin: { contents: WORKER, loader: "js", resolveDir: import.meta.dirname, sourcefile: "store-gate-worker.js" },
      bundle: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["development"],
      target: "es2022",
      write: false,
      plugins: [onlyReviewedNodeImports],
    })
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-22",
      compatibilityFlags: ["nodejs_compat"],
      modules: [{ type: "ESModule", path: "index.mjs", contents: bundled.outputFiles[0]!.text }],
      durableObjects: { STORE_GATE: { className: "StoreGate", useSQLite: true } },
    })
    await miniflare.ready
  })

  after(async () => {
    await miniflare?.dispose()
  })

  for (const name of scenarios) {
    void it(name, async () => {
      const response = await miniflare.dispatchFetch(`http://store-gate/?scenario=${encodeURIComponent(name)}`)
      const result = await response.json() as { ok: boolean; error?: string }
      assert.equal(result.error, undefined)
      assert.equal(result.ok, true)
    })
  }
})
