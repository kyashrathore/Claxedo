import { expect, test } from "bun:test"
import { handleCodexServerRequest } from "./server-request"
import type { CodexActiveThread } from "./active-thread"
import type { PendingQuestion, SdkRuntimeDriverHost } from "../shared/sdk-runtime-driver"

for (const dismiss of [false, true]) {
  test(`Codex question ${dismiss ? "dismissal" : "answer"} settles with the native answer contract`, async () => {
    const pendingQuestions = new Map<string, PendingQuestion>()
    const projected: string[] = []
    const active = { sessionId: "session-1", agentSessionId: "thread-1", project: (method: string) => projected.push(method) } as unknown as CodexActiveThread
    const result = handleCodexServerRequest({
      message: { id: 1, method: "item/tool/requestUserInput", params: {
        threadId: "thread-1", questions: [{ id: "environment", question: "Which environment?" }],
      } },
      activeThreads: new Map([["thread-1", active]]),
      host: { pendingQuestions } as unknown as SdkRuntimeDriverHost,
      permissionModeId: () => "workspace-write",
      refreshTokens: async () => { throw new Error("unexpected authentication request") },
    })
    expect(projected).toEqual(["item/tool/requestUserInput"])
    const pending = [...pendingQuestions.values()][0]
    expect(pending.sessionId).toBe("session-1")
    if (dismiss) pending.reject()
    else pending.resolve([["Staging"]])
    expect(await result).toEqual(dismiss ? { answers: {} } : { answers: { environment: { answers: ["Staging"] } } })
  })
}

for (const kind of ["question", "permission"] as const) {
  test(`separate native processes reusing RPC id zero receive distinct canonical ${kind} IDs`, async () => {
    const pendingQuestions = new Map<string, PendingQuestion>()
    const pendingPermissions: SdkRuntimeDriverHost["pendingPermissions"] = new Map()
    const projected: Array<{ sessionId: string; requestId: string; nativeId: unknown }> = []
    const results = ["first", "second"].map((sessionId) => {
      const active = {
        sessionId, agentSessionId: sessionId,
        project: (_method: string, payload: { requestId: string }, frame: { id: unknown }) => {
          projected.push({ sessionId, requestId: payload.requestId, nativeId: frame.id })
        },
      } as unknown as CodexActiveThread
      return handleCodexServerRequest({
        message: { id: 0, method: kind === "question" ? "item/tool/requestUserInput" : "item/commandExecution/requestApproval", params: {
          threadId: sessionId, questions: [{ id: "environment", question: "Which environment?" }],
        } },
        activeThreads: new Map([[sessionId, active]]),
        host: { pendingQuestions, pendingPermissions } as unknown as SdkRuntimeDriverHost,
        permissionModeId: () => "workspace-write",
        refreshTokens: async () => { throw new Error("unexpected authentication request") },
      })
    })
    expect(projected.map((row) => row.nativeId)).toEqual([0, 0])
    expect(projected[0].requestId).not.toBe(projected[1].requestId)
    const requests = kind === "question" ? pendingQuestions : pendingPermissions
    expect(requests.size).toBe(2)
    expect(requests.get(projected[0].requestId)?.sessionId).toBe("first")
    expect(requests.get(projected[1].requestId)?.sessionId).toBe("second")
    if (kind === "question") {
      pendingQuestions.get(projected[0].requestId)!.resolve([["Staging"]])
      pendingQuestions.get(projected[1].requestId)!.reject()
      expect(await Promise.all(results)).toEqual([{ answers: { environment: { answers: ["Staging"] } } }, { answers: {} }])
    } else {
      pendingPermissions.get(projected[0].requestId)!.resolve("allow_once")
      pendingPermissions.get(projected[1].requestId)!.resolve("deny")
      expect(await Promise.all(results)).toEqual([{ decision: "accept" }, { decision: "decline" }])
    }
  })
}
