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
    const pending = pendingQuestions.get("1")!
    expect(pending.sessionId).toBe("session-1")
    if (dismiss) pending.reject()
    else pending.resolve([["Staging"]])
    expect(await result).toEqual(dismiss ? { answers: {} } : { answers: { environment: { answers: ["Staging"] } } })
  })
}
