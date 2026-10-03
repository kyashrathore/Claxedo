import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { AgentHarnessEngineError } from "@claxedo/harness/contract"
import type { OpenCodeHost } from "./host"
import { createInteractionPort } from "./interaction-port"
import { WorkspaceScope } from "./scope"

const directory = realpathSync(mkdtempSync(join(tmpdir(), "claxedo-interaction-port-")))

function host(lifecycle: "cold" | "migrating" | "ready", rows: { permissions?: unknown[]; forms?: unknown[] } = {}) {
  const client = {
    sessions: { get: mock(async () => ({ location: { directory } })) },
    permission: { list: mock(async () => rows.permissions ?? []) },
    form: { list: mock(async () => rows.forms ?? []) },
  }
  const boot = mock(async () => client)
  const value = {
    client: boot,
    status: () => ({ lifecycle, events: "healthy" as const }),
    setEventHealth() {},
    close: async () => {},
  } as unknown as OpenCodeHost
  return { value, boot, client }
}

const scope = WorkspaceScope.authorize({ workspaceID: "ws_1", directory })

describe("createInteractionPort", () => {
  test("a host that is not serving has no pending interactions and is not booted by the read", async () => {
    for (const lifecycle of ["cold", "migrating"] as const) {
      const fake = host(lifecycle)
      const port = createInteractionPort(fake.value)
      expect(await port.permissions(scope, "ses_1")).toEqual([])
      expect(await port.forms(scope, "ses_1")).toEqual([])
      expect(fake.boot).not.toHaveBeenCalled()
    }
  })

  test("a serving host lists one session's pending requests through the SDK", async () => {
    const fake = host("ready", {
      permissions: [{ id: "req_1", sessionID: "ses_1", type: "bash", title: "Run tests", time: { created: 5 } }],
      forms: [{ id: "form_1", sessionID: "ses_1", title: "Pick one", fields: [{ key: "a" }], time: { created: 6 } }],
    })
    const port = createInteractionPort(fake.value)
    expect(await port.permissions(scope, "ses_1")).toEqual([{ id: "req_1", sessionID: "ses_1", type: "bash", title: "Run tests", createdAt: 5 }])
    expect(await port.forms(scope, "ses_1")).toEqual([{ id: "form_1", sessionID: "ses_1", title: "Pick one", fields: [{ key: "a" }], createdAt: 6 }])
    expect(fake.client.permission.list).toHaveBeenCalledWith({ sessionID: "ses_1" })
    expect(fake.client.form.list).toHaveBeenCalledWith({ sessionID: "ses_1" })
  })

  test("an engine that refuses the list is reported as that engine's refusal of that call", async () => {
    const fake = host("ready")
    const refused = Object.assign(new Error("UnexpectedStatus"), { name: "ClientError", reason: "UnexpectedStatus", cause: { status: 500 } })
    fake.client.permission.list.mockImplementation(async () => { throw refused })
    const port = createInteractionPort(fake.value)
    const error = await port.permissions(scope, "ses_1").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AgentHarnessEngineError)
    expect(error).toMatchObject({ harness: "opencode", operation: "permission.list", directory, status: 500 })
    expect(await port.forms(scope, "ses_1")).toEqual([])
  })
})
