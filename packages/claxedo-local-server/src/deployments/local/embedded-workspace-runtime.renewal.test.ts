import { afterEach, expect, test, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { configureAgentConfig, disposeAgentConfig } from "@claxedo/server-core/agent-config/index"
import type { ProviderProjection } from "@claxedo/agent-sdk-runtime"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import {
  ensureEmbeddedWorkspaceRuntime,
  renewEmbeddedWorkspaceRuntimeConfigs,
  shutdownEmbeddedWorkspaceRuntimes,
  startEmbeddedWorkspaceRuntimeConfigRenewal,
  RENEWAL_CHECK_INTERVAL_MS,
} from "./embedded-workspace-runtime"

/**
 * Renewal is what stands between a one-hour placeholder and a turn that fails
 * authentication an hour into a session, so what decides it has to be the
 * placeholder's own expiry rather than a timer someone sized once.
 */
const previousDataDir = process.env.CLAXEDO_DATA_DIR
const HOUR = 60 * 60 * 1000
let roots: string[] = []

afterEach(async () => {
  await shutdownEmbeddedWorkspaceRuntimes()
  disposeAgentConfig()
  ClaxedoDB.close()
  closeAuthorityDatabases()
  vi.useRealTimers()
  for (const root of roots) await fs.rm(root, { recursive: true, force: true })
  roots = []
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
})

/**
 * A runtime over a real workspace whose authority hands out a placeholder with
 * the lifetime this test names, and a count of how often it was asked.
 */
async function runtimeProjecting(input: { lifetimeMs: number; fail?: () => boolean }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embedded-renewal-"))
  roots.push(root)
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
  const projections: number[] = []
  configureAgentConfig({
    projectAuth: async (): Promise<Record<string, ProviderProjection>> => {
      if (input.fail?.()) throw new Error("authority unavailable")
      projections.push(Date.now())
      return {
        "claude-sdk": {
          baseUrl: "http://127.0.0.1:2595/bindings/b1",
          placeholder: `placeholder-${projections.length}`,
          authMode: "bearer",
          expiresAt: Date.now() + input.lifetimeMs,
        },
      }
    },
  })
  const workspace: Workspace = { id: "ws_renewal", directory: project, kind: "local", created_at: 1, updated_at: 1 }
  await ensureEmbeddedWorkspaceRuntime(workspace, { config: "sync" })
  return { projections }
}

test("a placeholder is replaced halfway through its own lifetime, not before", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-13T00:00:00.000Z") })
  const { projections } = await runtimeProjecting({ lifetimeMs: HOUR })
  expect(projections).toHaveLength(1)

  vi.setSystemTime(Date.parse("2026-09-13T00:29:00.000Z"))
  await renewEmbeddedWorkspaceRuntimeConfigs({ at: Date.now() })
  expect(projections).toHaveLength(1)

  vi.setSystemTime(Date.parse("2026-09-13T00:31:00.000Z"))
  await renewEmbeddedWorkspaceRuntimeConfigs({ at: Date.now() })
  expect(projections).toHaveLength(2)
})

test("a shorter lifetime is renewed sooner, without anyone re-sizing a timer", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-13T00:00:00.000Z") })
  const { projections } = await runtimeProjecting({ lifetimeMs: 10 * 60 * 1000 })

  vi.setSystemTime(Date.parse("2026-09-13T00:06:00.000Z"))
  await renewEmbeddedWorkspaceRuntimeConfigs({ at: Date.now() })

  expect(projections).toHaveLength(2)
})

test("a process that slept re-pushes every runtime on the next check", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-13T00:00:00.000Z") })
  const { projections } = await runtimeProjecting({ lifetimeMs: HOUR })
  const stop = startEmbeddedWorkspaceRuntimeConfigRenewal()
  try {
    await vi.advanceTimersByTimeAsync(RENEWAL_CHECK_INTERVAL_MS)
    // Nothing is due yet, and an ordinary tick must not re-push.
    expect(projections).toHaveLength(1)

    // The laptop was closed: the next tick arrives long after it was scheduled,
    // and every placeholder is older than any tick the timer saw.
    vi.setSystemTime(Date.now() + 6 * RENEWAL_CHECK_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(RENEWAL_CHECK_INTERVAL_MS)
    // The tick's own work is not awaited by the timer, and the renewal pass
    // asks the OpenCode engine first, so the re-push lands a few microtasks in.
    for (let flush = 0; flush < 50 && projections.length < 2; flush++) await Promise.resolve()

    expect(projections).toHaveLength(2)
  } finally {
    stop()
  }
})

test("a failed renewal is retried with backoff instead of being settled away", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-09-13T00:00:00.000Z") })
  let broken = false
  const { projections } = await runtimeProjecting({ lifetimeMs: HOUR, fail: () => broken })
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    broken = true
    vi.setSystemTime(Date.parse("2026-09-13T00:31:00.000Z"))
    const failedAt = Date.now()
    await renewEmbeddedWorkspaceRuntimeConfigs({ at: failedAt })
    expect(projections).toHaveLength(1)
    expect(warn).toHaveBeenCalled()

    // Retried, not abandoned — and not hammered either.
    await renewEmbeddedWorkspaceRuntimeConfigs({ at: failedAt + 1_000 })
    expect(projections).toHaveLength(1)

    broken = false
    vi.setSystemTime(failedAt + 6_000)
    await renewEmbeddedWorkspaceRuntimeConfigs({ at: Date.now() })
    expect(projections).toHaveLength(2)
  } finally {
    warn.mockRestore()
  }
})
