import { describe, expect, it } from "bun:test"
import { ACPAdapter } from "./acp"

function adapter() {
  const out = Object.create(ACPAdapter.prototype) as ACPAdapter & {
    shared: { proc: { alive: boolean; cachedConfigOptions: unknown[] | null } | null }
  }
  out.shared = { proc: null }
  return out
}

describe("ACPAdapter.probeConfigOptions", () => {
  it("uses the session boot timeout when no probe timeout override is set", async () => {
    const prevNew = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    const prevProbe = process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS
    process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "10"
    delete process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS

    const out = adapter() as ACPAdapter & {
      getOrSpawnProcess: (directory: string) => Promise<{ proc: { cachedConfigOptions: unknown[] | null }; isNew: boolean }>
      dispose: () => void
    }
    out.getOrSpawnProcess = async (directory) => {
      expect(directory).toBe("/work")
      return new Promise(() => {})
    }

    try {
      await expect(out.probeConfigOptions("/work")).resolves.toEqual([])
    } finally {
      if (prevNew === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = prevNew
      if (prevProbe === undefined) delete process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS = prevProbe
    }
  })

  it("returns [] when shared process startup hangs", async () => {
    const prev = process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS
    process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS = "10"

    const out = adapter() as ACPAdapter & {
      getOrSpawnProcess: (directory: string) => Promise<{ proc: { cachedConfigOptions: unknown[] | null }; isNew: boolean }>
      dispose: () => void
    }
    out.getOrSpawnProcess = async (directory) => {
      expect(directory).toBe("/work")
      return new Promise(() => {})
    }

    try {
      await expect(out.probeConfigOptions("/work")).resolves.toEqual([])
    } finally {
      if (prev === undefined) delete process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS = prev
    }
  })

  it("returns cached options from the shared process without booting", async () => {
    const out = adapter() as ACPAdapter & {
      shared: { proc: { alive: boolean; cachedConfigOptions: unknown[] | null } | null }
      getOrSpawnProcess: (directory: string) => Promise<unknown>
    }
    out.shared = {
      proc: {
        alive: true,
        cachedConfigOptions: [{ id: "model" }],
      },
    } as { proc: { alive: boolean; cachedConfigOptions: unknown[] | null } | null }
    out.getOrSpawnProcess = async () => {
      throw new Error("getOrSpawnProcess should not be called when cache exists")
    }

    try {
      await expect(out.probeConfigOptions("/work")).resolves.toEqual([{ id: "model" }])
    } finally {}
  })
})
