import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createSelfHostedApp } from "./app"
import { createControlPlaneServices } from "../../authority/services"
import { createSqliteCentralStore } from "../../authority/adapters/sqlite/central-store"
import {
  __setOpenCodeEmbedLoaderForTests,
  configureOpenCodeEngine,
  opencodeEngineLoaded,
  opencodeRequest,
  drainOpenCodeEngine,
  OPENCODE_INTERNAL_BASE,
} from "@claxedo/server-core/opencode/engine"

/**
 * The just-another-harness guarantee at the composition level: building the
 * self-hosted app and serving non-OpenCode requests never loads the embedded
 * OpenCode engine; the first OpenCode surface use is what boots it. The
 * per-trigger gates (credential auth bridge, MCP config fan-out, composer
 * capability catalog) carry their own focused suites — this test guards the
 * app composition itself against regressing into an eager engine load.
 */

let dataDir: string
let previousDataDir: string | undefined
const loads: number[] = []

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-cold-engine-"))
  previousDataDir = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
  loads.length = 0
  configureOpenCodeEngine({ embedded: true })
  __setOpenCodeEmbedLoaderForTests(async () => {
    loads.push(loads.length + 1)
    return {
      Server: { Default: () => ({ app: { fetch: async () => Response.json({ ok: true }) } }) },
      InstanceRuntime: { disposeAllInstances: async () => {} },
    } as never
  })
})

afterEach(async () => {
  await drainOpenCodeEngine()
  __setOpenCodeEmbedLoaderForTests(undefined)
  configureOpenCodeEngine({ embedded: true })
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function localApp() {
  const centralStore = createSqliteCentralStore({ mode: () => "workspace_replicated" })
  return createSelfHostedApp(
    createControlPlaneServices(
      {
        projectionStore: centralStore.projectionStore,
        durableSessionLog: centralStore.durableSessionLog,
      },
      { localExecution: { enabled: true }, telemetry: { capture: () => {} } },
    ),
  ).app
}

describe("cold embedded engine", () => {
  test("app composition and non-OpenCode requests never load the engine; first engine use does", async () => {
    const app = localApp()
    expect(loads).toEqual([])
    expect(opencodeEngineLoaded()).toBe(false)

    // Non-OpenCode surfaces: a harness-binding provider catalog read and the
    // project listing. Status codes are not this test's concern — engine
    // loads are.
    await app.request("http://localhost/provider?harness=claude-sdk")
    await app.request("http://localhost/project")
    expect(loads).toEqual([])
    expect(opencodeEngineLoaded()).toBe(false)

    // The first actual engine use boots it — exactly once.
    const res = await opencodeRequest(new Request(`${OPENCODE_INTERNAL_BASE}/session`))
    expect(res.status).toBe(200)
    expect(loads).toEqual([1])
    expect(opencodeEngineLoaded()).toBe(true)
  })
})
