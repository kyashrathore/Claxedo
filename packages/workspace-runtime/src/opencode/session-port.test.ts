import { expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { OpenCodeHost } from "./host"
import { WorkspaceScope } from "./scope"
import { createSessionPort } from "./session-port"

const scope = WorkspaceScope.authorize({
  workspaceID: "ws_port",
  directory: fs.mkdtempSync(path.join(os.tmpdir(), "opencode-session-port-")),
})
const location = { directory: scope.directory }

function portOver(client: Record<string, unknown>) {
  return createSessionPort({ client: async () => client } as unknown as OpenCodeHost)
}

function sessionsAnswering(row: unknown) {
  return {
    sessions: {
      get: async () => row,
      create: async () => row,
      list: async () => ({ data: [row], cursor: {} }),
      prompt: async () => ({ id: "msg_1", sessionID: "ses_1", payload: { text: "hi" } }),
    },
    message: { list: async () => ({ data: [{ id: "msg_1", type: "user", text: "hi" }], cursor: {} }) },
  }
}

const untimedSessions = [
  ["no time", {}],
  ["no creation time", { time: { updated: 2 } }],
  ["no update time", { time: { created: 1 } }],
] as const

for (const [label, stamp] of untimedSessions) {
  test(`a session the engine answers with ${label} is refused, never dated 0`, async () => {
    const port = portOver(sessionsAnswering({ id: "ses_1", location, ...stamp }))

    await expect(port.get(scope, "ses_1")).rejects.toThrow(/OpenCode returned a session with no time\./)
    await expect(port.create(scope)).rejects.toThrow(/OpenCode returned a session with no time\./)
    await expect(port.list(scope)).rejects.toThrow(/OpenCode returned a session with no time\./)
  })
}

test("a message or prompt admission the engine answers without its creation time is refused, never dated 0", async () => {
  const port = portOver(sessionsAnswering({ id: "ses_1", location, time: { created: 1, updated: 2 } }))

  await expect(port.messages(scope, "ses_1")).rejects.toThrow("OpenCode returned a message with no time.created")
  await expect(port.prompt(scope, "ses_1", { text: "hi" })).rejects.toThrow("OpenCode returned a prompt admission with no timeCreated")
})

test("a session the engine stamps keeps the engine's times", async () => {
  const port = portOver(sessionsAnswering({ id: "ses_1", location, time: { created: 1, updated: 2 } }))

  expect(await port.get(scope, "ses_1")).toMatchObject({ id: "ses_1", createdAt: 1, updatedAt: 2 })
})
