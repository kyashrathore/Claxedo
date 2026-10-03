import { beforeEach, expect, test, vi } from "vitest"

const fixtures = vi.hoisted(() => ({ generation: "mount1" as string | undefined, response: undefined as Response | undefined,
  onRead: undefined as (() => void) | undefined }))
vi.mock("@claxedo/server-core/workspace/store/index", () => ({ resolveWorkspace: async () => ({ id: "ws", directory: "/workspace" }) }))
vi.mock("../../deployments/local/embedded-workspace-runtime", () => ({
  embeddedWorkspaceRuntimeGeneration: () => fixtures.generation,
  readMountedEmbeddedWorkspaceRuntime: async () => { fixtures.onRead?.(); return fixtures.response },
}))
import { projectSessionAttention } from "./project-session-attention"

beforeEach(() => { fixtures.generation = "mount1"; fixtures.onRead = undefined; fixtures.response = Response.json({ id: "ses", attention: { sequence: 8 } }) })

test("committed facts are projected only from the same admitted runtime mount", async () => {
  const sync_session_meta = vi.fn(async () => {})
  expect(await projectSessionAttention({ sync_session_meta }, "ws", "ses")).toBe(true)
  expect(sync_session_meta).toHaveBeenCalledWith({ id: "ws", directory: "/workspace" }, { id: "ses", attention: { sequence: 8 } })
})

test("a replacement while the canonical read resolves writes no obsolete projection", async () => {
  const sync_session_meta = vi.fn(async () => {})
  vi.spyOn(fixtures.response!, "json").mockImplementation(async () => { fixtures.generation = "mount2"; return { id: "ses" } })
  await expect(projectSessionAttention({ sync_session_meta }, "ws", "ses")).rejects.toThrow("changed during session read")
  expect(sync_session_meta).not.toHaveBeenCalled()
})

test("a retired mount's 404 cannot publish removal for the replacement", async () => {
  const sync_session_meta = vi.fn(async () => {})
  fixtures.response = new Response(null, { status: 404 })
  fixtures.onRead = () => { fixtures.generation = "mount2" }
  await expect(projectSessionAttention({ sync_session_meta }, "ws", "ses")).rejects.toThrow("changed during session read")
  expect(sync_session_meta).not.toHaveBeenCalled()
})
