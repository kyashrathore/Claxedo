import { describe, expect, it } from "bun:test"
import { AcpHarnessAdapter } from "./index"

function adapter() {
  const out = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
    sessions: Map<string, unknown>
    probe: { proc: { alive: boolean; cachedConfigOptions: unknown[] | null } | null; directory: string; init: null } | null
  }
  out.sessions = new Map()
  out.probe = null
  return out
}

describe("AcpHarnessAdapter.probeConfigOptions", () => {
  it("uses the session boot timeout when no probe timeout override is set", async () => {
    const prevNew = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    const prevProbe = process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS
    process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "10"
    delete process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS

    const out = adapter() as AcpHarnessAdapter & {
      getOrSpawnProbe: (directory: string) => Promise<{ alive: boolean; cachedConfigOptions: unknown[] | null }>
    }
    out.getOrSpawnProbe = async (directory) => {
      expect(directory).toBe("/work")
      return new Promise(() => {})
    }

    try {
      await expect(out.probeConfigOptions("/work")).rejects.toThrow("ACP mode probe timed out")
    } finally {
      if (prevNew === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = prevNew
      if (prevProbe === undefined) delete process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS = prevProbe
    }
  })

  it("rejects when shared process startup hangs", async () => {
    const prev = process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS
    process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS = "10"

    const out = adapter() as AcpHarnessAdapter & {
      getOrSpawnProbe: (directory: string) => Promise<{ alive: boolean; cachedConfigOptions: unknown[] | null }>
    }
    out.getOrSpawnProbe = async (directory) => {
      expect(directory).toBe("/work")
      return new Promise(() => {})
    }

    try {
      await expect(out.probeConfigOptions("/work")).rejects.toThrow("ACP mode probe timed out")
    } finally {
      if (prev === undefined) delete process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS = prev
    }
  })

  it("returns cached options from the shared process without booting", async () => {
    const out = adapter() as AcpHarnessAdapter & {
      probe: { proc: { alive: boolean; cachedConfigOptions: unknown[] | null } | null; directory: string; init: null }
      getOrSpawnProbe: (directory: string) => Promise<unknown>
    }
    out.probe = {
      proc: {
        alive: true,
        cachedConfigOptions: [{ id: "model" }],
      },
      directory: "/work",
      init: null,
    }
    out.getOrSpawnProbe = async () => {
      throw new Error("getOrSpawnProbe should not be called when cache exists")
    }

    try {
      await expect(out.probeConfigOptions("/work")).resolves.toEqual([{ id: "model" }])
    } finally {}
  })
})
