import { afterAll, afterEach, describe, expect, test } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

// Regression coverage for: a harness session's async auto-title (e.g. an ACP
// harness's post-turn `maybeEmitTitle`, or opencode's own LLM-driven rename)
// is published ONLY as an SSE event — `RuntimeEventHub.publishGlobal`, which
// surfaces as a `session.updated` event on a workspace's `/global/event`
// stream — never as an HTTP `PATCH /session/:id`. Before this fix,
// `services.projectionStore` (the persisted source `/api/control/session-list`
// reads for the sidebar's own rows) had no write path for that event at all,
// so a harness session's title reverted to "Untitled" after a server
// restart. `projectLocalSessionMetaFromEvent` (exported from `./server`) is
// the shared write path now wired to BOTH the legacy single-instance
// `upstreamEvents` bridge and the embedded per-workspace
// `onSessionMetaEvent` tap (see `embedded-workspace-runtime.ts`,
// `embedded-workspace-runtime.test.ts` for the SSE-tap wiring itself). This
// file proves the write path in isolation, against the real SQLite-backed
// projection store, including that it survives a simulated server restart
// (closing and reopening the SQLite connection).

const root = path.join(realpathSync(os.tmpdir()), `session-meta-bridge-test-${randomUUID().slice(0, 8)}`)
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const [
  { projectLocalSessionMetaFromEvent },
  { createSqliteCentralStore },
  { ClaxedoDB },
] = await Promise.all([
  import("../../deployments/local/server"),
  import("../../authority/adapters/sqlite/central-store"),
  import("../../adapters/storage/db"),
])

function centralStore() {
  return createSqliteCentralStore({ mode: () => "workspace_replicated" })
}

afterEach(async () => {
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
})

afterAll(() => {
  process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
})

describe("projectLocalSessionMetaFromEvent (SSE-only auto-title -> projectionStore write path)", () => {
  test("a session.updated event's title reaches the projection store", async () => {
    await fs.mkdir(root, { recursive: true })
    const services = { projectionStore: centralStore().projectionStore }

    await projectLocalSessionMetaFromEvent(services, {
      directory: "/tmp/e2e-harness-session",
      payload: {
        type: "session.updated",
        properties: {
          sessionID: "s_auto_title",
          info: {
            id: "s_auto_title",
            title: "Auto-generated title",
            directory: "/tmp/e2e-harness-session",
          },
        },
      },
    })

    const meta = await services.projectionStore.session_meta("s_auto_title")
    expect(meta?.title).toBe("Auto-generated title")
  })

  test("ignores events with no resolvable session id (best-effort, never throws)", async () => {
    await fs.mkdir(root, { recursive: true })
    const services = { projectionStore: centralStore().projectionStore }

    await expect(
      projectLocalSessionMetaFromEvent(services, {
        directory: "/tmp/e2e-harness-session",
        payload: { type: "session.updated", properties: {} },
      }),
    ).resolves.toBeUndefined()
  })

  test("survives a simulated server restart (fresh SQLite connection re-reads the same file)", async () => {
    await fs.mkdir(root, { recursive: true })
    const firstProcess = { projectionStore: centralStore().projectionStore }

    await projectLocalSessionMetaFromEvent(firstProcess, {
      directory: "/tmp/e2e-harness-session-restart",
      payload: {
        type: "session.updated",
        properties: {
          sessionID: "s_restart",
          info: {
            id: "s_restart",
            title: "Title set before restart",
            directory: "/tmp/e2e-harness-session-restart",
          },
        },
      },
    })

    // Simulate a server restart: close the SQLite connection (the same
    // teardown `shutdownControlPlaneRuntime`/process exit would trigger) and
    // open a brand-new central store against the SAME on-disk database —
    // nothing here is served from an in-memory cache.
    ClaxedoDB.close()
    const secondProcess = { projectionStore: centralStore().projectionStore }

    const meta = await secondProcess.projectionStore.session_meta("s_restart")
    expect(meta?.title).toBe("Title set before restart")
  })
})
