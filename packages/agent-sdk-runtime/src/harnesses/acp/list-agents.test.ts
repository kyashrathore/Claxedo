import { describe, expect, it } from "bun:test"
import { AcpHarnessAdapter } from "./index"

function adapter(input?: {
  list?: unknown[]
  cfg?: unknown[]
}) {
  const out = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
    shared: { proc: { alive: boolean; getAgents: () => unknown[] } | null }
    probeConfigOptions: (directory: string) => Promise<unknown[]>
  }
  ;(out as any).sessions = new Map()
  out.shared = { proc: null }
  out.probeConfigOptions = async (directory) => {
    expect(directory).toBe("/work")
    return input?.cfg ?? []
  }
  if (input?.list) {
    ;(out as any).sessions.set("live", {
      directory: "/work",
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
