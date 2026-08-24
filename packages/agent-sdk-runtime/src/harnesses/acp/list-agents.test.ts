import { describe, expect, it } from "bun:test"
import path from "node:path"
import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import type { WithOverrides } from "../../test-utils/class-internals"
import { AcpHarnessAdapter } from "./index"

type ProbedAgent = { name: string; description: string; mode: string }

/**
 * `probeConfigOptions` is declared as returning `AgentConfigOptionRow[]`, but it
 * hands back the ACP process cache verbatim (`cachedConfigOptions as
 * AgentConfigOptionRow[]`, index.ts:1464/1494/1514) and `listAgents` reads it back
 * as `SessionConfigOption[]`. The stub therefore has to be ACP-shaped, and has to
 * override the declared signature rather than intersect with it.
 */
function adapter(input?: {
  list?: ProbedAgent[]
  cfg?: SessionConfigOption[]
}) {
  const out = Object.create(AcpHarnessAdapter.prototype) as WithOverrides<AcpHarnessAdapter, {
    sessions: Map<string, { directory: string; proc: { alive: boolean; getAgents: () => ProbedAgent[] }; init: null }>
    shared: { proc: { alive: boolean; getAgents: () => ProbedAgent[] } | null }
    probeConfigOptions: (directory: string) => Promise<SessionConfigOption[]>
  }>
  out.sessions = new Map()
  out.shared = { proc: null }
  out.probeConfigOptions = async (directory) => {
    expect(directory).toBe(path.resolve("/work"))
    return input?.cfg ?? []
  }
  if (input?.list) {
    out.sessions.set("live", {
      directory: path.resolve("/work"),
      proc: {
        alive: true,
        getAgents: () => input.list ?? [],
      },
      init: null,
    })
  }
  return out
}

describe("AcpHarnessAdapter.listAgents", () => {
  it("returns live process agents before probing", async () => {
    const out = adapter({
      list: [{ name: "code", description: "Code", mode: "primary" }],
      cfg: [{
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "plan",
        options: [{ value: "plan", name: "Plan" }],
      }],
    })

    expect(await out.listAgents("/work")).toEqual([
      { name: "code", description: "Code", mode: "primary" },
    ])
  })

  it("lists probed ACP agents before any session exists", async () => {
    const out = adapter({
      cfg: [{
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "code",
        options: [
          { value: "code", name: "Code" },
          { value: "plan", name: "Plan" },
        ],
      }],
    })

    expect(await out.listAgents("/work")).toEqual([
      { name: "code", description: "Code", mode: "primary" },
      { name: "plan", description: "Plan", mode: "primary" },
    ])
  })

  it("rejects when probing finds no ACP modes", async () => {
    const out = adapter()

    await expect(out.listAgents("/work")).rejects.toThrow("ACP harness did not return live agent options")
  })
})
