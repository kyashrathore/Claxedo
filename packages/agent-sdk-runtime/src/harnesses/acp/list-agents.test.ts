import path from "node:path"
import { describe, expect, it } from "bun:test"
import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import type { WithOverrides } from "../../test-utils/class-internals"
import { AcpHarnessAdapter } from "./index"

type ProbedAgent = { name: string; description: string; mode: string }

/** Builds the live-process and probe views consumed by `listAgents`. */
function adapter(input?: {
  list?: ProbedAgent[]
  cfg?: SessionConfigOption[]
}) {
  const out = Object.create(AcpHarnessAdapter.prototype) as WithOverrides<AcpHarnessAdapter, {
    processes: Map<string, { directory: string; proc: { alive: boolean; getAgents: () => ProbedAgent[] }; init: null }>
    probeConfigOptions: (directory: string) => Promise<{ options: SessionConfigOption[] }>
  }>
  out.processes = new Map()
  out.probeConfigOptions = async (directory) => {
    expect(directory).toBe(path.resolve("/work"))
    return { options: input?.cfg ?? [] }
  }
  if (input?.list) {
    out.processes.set("live", {
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

    expect(await out.listAgents(path.resolve("/work"))).toEqual([
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

    expect(await out.listAgents(path.resolve("/work"))).toEqual([
      { name: "code", description: "Code", mode: "primary" },
      { name: "plan", description: "Plan", mode: "primary" },
    ])
  })

  it("rejects when probing finds no ACP modes", async () => {
    const out = adapter()

    await expect(out.listAgents(path.resolve("/work"))).rejects.toThrow("ACP harness did not return live agent options")
  })
})
