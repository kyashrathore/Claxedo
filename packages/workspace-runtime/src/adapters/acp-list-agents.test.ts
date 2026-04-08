import { describe, expect, it } from "bun:test"
import { ACPAdapter } from "./acp"

function adapter(input?: {
  list?: unknown[]
  cfg?: unknown[]
}) {
  const out = Object.create(ACPAdapter.prototype) as ACPAdapter & {
    shared: { proc: { alive: boolean; getAgents: () => unknown[] } | null }
    probeConfigOptions: (directory: string) => Promise<unknown[]>
  }
  out.shared = { proc: null }
  out.probeConfigOptions = async (directory) => {
    expect(directory).toBe("/work")
    return input?.cfg ?? []
  }
  if (input?.list) {
    out.shared.proc = {
      alive: true,
      getAgents: () => input.list ?? [],
    }
  }
  return out
}

describe("ACPAdapter.listAgents", () => {
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

  it("falls back to build when probing finds no ACP modes", async () => {
    const out = adapter()

    expect(await out.listAgents("/work")).toEqual([
      { name: "build", description: "Software build and deployment specialist", mode: "primary" },
    ])
  })
})
