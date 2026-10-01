import { afterEach, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { configureEmbeddedWorkspaceRuntime, ensureEmbeddedWorkspaceRuntime, shutdownEmbeddedWorkspaceRuntimes, syncEmbeddedWorkspaceRuntimes } from "./embedded-workspace-runtime"
import { disposeAgentConfig, saveCommand } from "@claxedo/server-core/agent-config/index"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"

const roots: string[] = []
const previous = process.env.CLAXEDO_DATA_DIR
async function runtime(id: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embedded-config-publication-"))
  roots.push(root)
  process.env.CLAXEDO_DATA_DIR ??= path.join(root, "data")
  configureEmbeddedWorkspaceRuntime({ sessionIdWorkspace: () => undefined })
  return ensureEmbeddedWorkspaceRuntime({ id, directory: root, kind: "local", created_at: 1, updated_at: 1 }, { config: "skip" })
}
afterEach(async () => {
  vi.restoreAllMocks()
  await shutdownEmbeddedWorkspaceRuntimes()
  disposeAgentConfig(); ClaxedoDB.close(); closeAuthorityDatabases()
  if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

test("a mutation during embedded apply waits for a fresh snapshot and its own application", async () => {
  delete process.env.CLAXEDO_DATA_DIR
  const host = await runtime("queued")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const nextEntered = Promise.withResolvers<void>()
  const nextRelease = Promise.withResolvers<void>()
  const seen: unknown[] = []
  vi.spyOn(host.host, "apply").mockImplementation(async (snapshot) => {
    seen.push(snapshot.commands)
    if (seen.length === 1) { entered.resolve(); await release.promise }
    else { nextEntered.resolve(); await nextRelease.promise }
  })
  await saveCommand("review", "old")
  const first = syncEmbeddedWorkspaceRuntimes()
  await entered.promise
  await saveCommand("review", "new")
  let acknowledged = false
  const second = syncEmbeddedWorkspaceRuntimes().then(() => { acknowledged = true })
  release.resolve()
  try {
    await nextEntered.promise
    expect(acknowledged).toBe(false)
  } finally { nextRelease.resolve(); await Promise.all([first, second]) }
  expect(acknowledged).toBe(true)
  expect(seen).toEqual([[{ name: "review", content: "old" }], [{ name: "review", content: "new" }]])
})

test("embedded fan-out settles every runtime and returns all application failures", async () => {
  delete process.env.CLAXEDO_DATA_DIR
  const first = await runtime("fail-one")
  const second = await runtime("slow-success")
  const third = await runtime("fail-two")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const errors = [new Error("one refused"), new Error("two refused")]
  vi.spyOn(first.host, "apply").mockRejectedValue(errors[0])
  vi.spyOn(second.host, "apply").mockImplementation(async () => { entered.resolve(); await release.promise })
  vi.spyOn(third.host, "apply").mockRejectedValue(errors[1])
  let settled = false
  const done = syncEmbeddedWorkspaceRuntimes().then(() => ({ error: undefined }), (error: unknown) => ({ error })).finally(() => { settled = true })
  await entered.promise
  expect(settled).toBe(false)
  release.resolve()
  const result = await done
  expect(result.error).toBeInstanceOf(AggregateError)
  expect((result.error as AggregateError).errors).toEqual(errors)
  vi.mocked(first.host.apply).mockResolvedValue(undefined)
  vi.mocked(third.host.apply).mockResolvedValue(undefined)
  await expect(syncEmbeddedWorkspaceRuntimes()).resolves.toBeUndefined()
})
