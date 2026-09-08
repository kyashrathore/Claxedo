import { expect, test } from "bun:test"
import { handleCodexServerRequest } from "./server-request"
import type { CodexActiveThread } from "./active-thread"
import type { SdkRuntimeDriverHost } from "../shared/sdk-runtime-driver"

const command = { command: "printf approved > /tmp/result", cwd: "/repo", additionalPermissions: null }

test("a failed durable grant write never returns approval to Codex", async () => {
  const pendingPermissions: SdkRuntimeDriverHost["pendingPermissions"] = new Map()
  const result = handleCodexServerRequest({
    message: { id: 0, method: "item/commandExecution/requestApproval", params: { ...command, threadId: "thread" } },
    activeThreads: new Map([["thread", { sessionId: "session", directory: "/repo", project() {} } as unknown as CodexActiveThread]]),
    host: { pendingPermissions, getSessionConfig: () => ({}), updatePermissionState: () => { throw new Error("storage failed") } } as unknown as SdkRuntimeDriverHost,
    permissionModeId: () => "workspace-write", refreshTokens: async () => { throw new Error("unexpected refresh") },
  })
  pendingPermissions.values().next().value!.resolve("allow_always")
  await expect(result).rejects.toThrow("storage failed")
})

for (const decision of ["allow_always", "allow_once", "deny", "reject_always"] as const) {
  test(`${decision} survives native callback replacement only when explicitly persistent`, async () => {
    const states = new Map<string, Record<string, unknown>>()
    const pendingPermissions: SdkRuntimeDriverHost["pendingPermissions"] = new Map()
    let projected = 0
    const host = {
      pendingPermissions,
      getSessionConfig: (id: string) => ({ permissionState: states.get(id) }),
      updatePermissionState: (id: string, state: Record<string, unknown>) => states.set(id, JSON.parse(JSON.stringify(state))),
    } as unknown as SdkRuntimeDriverHost
    const request = (sessionId: string, threadId: string, params: Record<string, unknown> = command, mode = "workspace-write", directory = "/repo") => handleCodexServerRequest({
      host, permissionModeId: () => mode, refreshTokens: async () => { throw new Error("unexpected refresh") },
      activeThreads: new Map([[threadId, { sessionId, agentSessionId: threadId, directory, project: () => { projected++ } } as unknown as CodexActiveThread]]),
      message: { id: 0, method: "item/commandExecution/requestApproval", params: { ...params, threadId, turnId: threadId, itemId: threadId, startedAtMs: Date.now() } },
    })
    const resolve = (answer: typeof decision) => {
      const [id, pending] = [...pendingPermissions.entries()].at(-1)!
      pendingPermissions.delete(id)
      pending.resolve(answer)
    }
    const first = request("session", "original-process")
    resolve(decision)
    await first
    const before = projected
    const resumed = request("session", "resumed-process")
    expect(projected).toBe(before + (decision === "allow_always" ? 0 : 1))
    if (decision !== "allow_always") resolve("deny")
    expect(await resumed).toEqual({ decision: decision === "allow_always" ? "acceptForSession" : "decline" })

    // Grants never authorize another session, directory, command, or mode.
    for (const [sessionId, params, mode, directory] of [
      ["other", command, "workspace-write", "/repo"],
      ["session", { ...command, command: "rm /tmp/result" }, "workspace-write", "/repo"],
      ["session", { ...command, cwd: "/other" }, "workspace-write", "/repo"],
      ["session", command, "plan", "/repo"],
      ["session", { ...command, futurePermissionContext: "new-authority" }, "workspace-write", "/repo"],
      ["session", command, "workspace-write", "/other"],
      ["session", { ...command, additionalPermissions: { network: { enabled: true } } }, "workspace-write", "/repo"],
    ] as const) {
      const count = projected
      const changed = request(sessionId, "new-process", params, mode, directory)
      expect(projected).toBe(count + 1)
      resolve("deny")
      expect(await changed).toEqual({ decision: "decline" })
    }
  })
}
