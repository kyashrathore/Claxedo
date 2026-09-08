import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { createRuntimeEventHub } from "../../runtime-event-hub"
import { executeTestTurn, executionBinding } from "../../test-utils/execution-binding"
import { installFakeCodexAppServer } from "../../test-utils/fake-codex-app-server"
import { CodexHarnessAdapter } from "./index"

for (const terminateFails of [false, true]) {
  test(terminateFails ? "Stop reports terminal cleanup failure" : "Stop before start acknowledgement awaits cleanup of only its turn across terminal pages", async () => {
    const fake = await installFakeCodexAppServer({ command: true, terminateFails })
    const adapter = new CodexHarnessAdapter({
      binary: fake.binary,
      store: createMemoryRuntimeStore(),
      eventHub: createRuntimeEventHub(),
      codexHome: path.join(fake.directory, "codex-home"),
    })
    let commandStarted!: () => void
    const started = new Promise<void>((resolve) => { commandStarted = resolve })
    try {
      const session = await adapter.createSession(fake.directory)
      const turn = (async () => {
        for await (const event of executeTestTurn(adapter, session.id, {
          parts: [{ type: "text", text: "Run a command" }],
          userMessageId: "user-1",
          assistantMessageId: "assistant-1",
          agent: "build",
          model: { providerID: "codex", modelID: "default" },
        }, fake.directory)) {
          if (JSON.stringify(event).includes("cmd-current")) commandStarted()
        }
      })()
      await started
      const stopping = adapter.abort(executionBinding(session.id, fake.directory, "native:codex"))
      if (terminateFails) {
        await expect(stopping).rejects.toThrow("terminal cleanup failed")
      } else {
        await expect(stopping).resolves.toEqual({ ok: true, status: "cancelled" })
        expect(await fs.readFile(fake.goalFile + ".terminated", "utf8")).toBe("process-current")
      }
      await turn
      const requests = (await fs.readFile(fake.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      expect(requests.filter((request) => request.method === "thread/backgroundTerminals/terminate"))
        .toEqual([{ method: "thread/backgroundTerminals/terminate", processId: "process-current" }])
    } finally {
      await adapter.dispose()
      await fs.rm(fake.directory, { recursive: true, force: true })
    }
  })
}
