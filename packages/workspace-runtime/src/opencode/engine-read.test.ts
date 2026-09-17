import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { AgentHarnessEngineError } from "@claxedo/agent-sdk-runtime/adapters"
import { engineRead } from "./engine-read"
import { WorkspaceScope } from "./scope"

/** `@opencode-ai/sdk`'s promise `ClientError`: `reason` on the instance, the status on `cause`. */
class ClientError extends Error {
  name = "ClientError"
  readonly reason: string
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options)
    this.reason = reason
  }
}

const directory = realpathSync(mkdtempSync(join(tmpdir(), "claxedo-engine-read-")))
const scope = WorkspaceScope.authorize({ workspaceID: "ws_1", directory })

describe("engineRead", () => {
  test("passes a successful read through", async () => {
    expect(await engineRead("permission.request.list", scope, async () => ({ data: [1] }))).toEqual({ data: [1] })
  })

  test("names the call, the workspace and the status when the engine answers an undeclared status", async () => {
    const refused = new ClientError("UnexpectedStatus", { cause: { status: 500 } })
    const error = await engineRead("permission.request.list", scope, async () => { throw refused }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AgentHarnessEngineError)
    const typed = error as AgentHarnessEngineError
    expect(typed).toMatchObject({
      code: "harness_engine_error",
      harness: "opencode",
      operation: "permission.request.list",
      directory,
      status: 500,
      cause: refused,
    })
    expect(typed.message).toBe(`opencode answered permission.request.list for ${directory} with status 500`)
  })

  test("a transport fault has no status and is named by its reason", async () => {
    const error = await engineRead("agent.list", scope, async () => {
      throw new ClientError("Transport", { cause: new TypeError("fetch failed") })
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AgentHarnessEngineError)
    expect((error as AgentHarnessEngineError).status).toBeUndefined()
    expect((error as Error).message).toBe(`opencode answered agent.list for ${directory} with Transport`)
  })

  test("an error that is not the SDK client's propagates untouched", async () => {
    const own = new Error("OpenCode returned an invalid catalog list")
    const error = await engineRead("agent.list", scope, async () => { throw own }).catch((e: unknown) => e)
    expect(error).toBe(own)
  })
})
