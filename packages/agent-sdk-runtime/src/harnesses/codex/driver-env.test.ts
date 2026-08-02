import { describe, expect, test } from "bun:test"
import { codexSpawnEnv, observeCodexAppServerProcess } from "./driver"
import type { AgentProcessDescriptor, AgentProcessObserver } from "../../process-observer"

describe("Codex app-server environment", () => {
  test("scrubs the local document installation secret from the child environment", () => {
    expect(codexSpawnEnv({
      PATH: "/bin",
      CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN: "installation-secret",
    })).toEqual({ PATH: "/bin" })
  })

  test("registers the app-server PID and safe MCP identities", () => {
    const sentinel = "codex-observer-sentinel"
    const descriptors: AgentProcessDescriptor[] = []
    const exits: unknown[] = []
    const observer: AgentProcessObserver = {
      register(descriptor) {
        descriptors.push(descriptor)
        return {
          update: () => undefined,
          exit: (event) => exits.push(event),
        }
      },
    }
    const handle = observeCodexAppServerProcess({
      observer,
      binary: "/safe/bin/codex",
      directory: "/safe/workspace",
      pid: 789,
      mcp: {
        local: {
          name: "local",
          source: "user",
          transport: "stdio",
          command: "node",
          args: [sentinel],
          env: { TOKEN: sentinel },
        },
      },
    })

    expect(descriptors).toMatchObject([
      {
        harnessId: "codex",
        role: "harness",
        pid: 789,
        confidence: "direct",
      },
      {
        harnessId: "codex",
        role: "mcp",
        parentOwnerId: descriptors[0]?.ownerId,
        confidence: "inferred",
      },
    ])
    expect(JSON.stringify(descriptors)).not.toContain(sentinel)
    handle.exit({ reason: "disposed" })
    handle.exit({ reason: "disposed" })
    expect(exits).toHaveLength(2)
  })
})
