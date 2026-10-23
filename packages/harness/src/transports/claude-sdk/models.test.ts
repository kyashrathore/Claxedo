import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { DraftLaunch, HarnessServices } from "../../contract"
import { ScriptedProcess } from "../../test-support/scripted-process"
import { ClaudeSdkTransport } from "./index"
import { claudeProbeModel } from "./models"

const draft = (patch: Partial<DraftLaunch> = {}): DraftLaunch => ({
  workspaceId: "w1", directory: "/work", locality: "local", owner: { kind: "person", userId: "member" },
  config: { harness: { id: "claude", access: "native" } }, projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
  credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "lease-1" },
  ...patch,
})

test("a catalog probe for a draft that names its model asks Claude Code with that model, so the list it answers is the one that model runs from", () => {
  expect(claudeProbeModel(draft({ model: { providerID: "claude", modelID: "claude-haiku-4-5-20251001" } }))).toEqual({ model: "claude-haiku-4-5-20251001" })
  expect(claudeProbeModel(draft())).toEqual({})
})

test("disposing the transport retires a model probe still waiting on Claude Code, so no probe outlives its owner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-probe-"))
  const probes: ScriptedProcess<unknown>[] = []
  let spawned = () => {}
  const firstSpawn = new Promise<"spawned">((resolve) => { spawned = () => resolve("spawned") })
  const services = {
    clock: { now: Date.now, setTimeout, clearTimeout }, firstPartyMcp: () => undefined,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    spawn: async () => {
      const silent = new ScriptedProcess<unknown>(() => {})
      probes.push(silent)
      spawned()
      return silent.owned()
    },
  } satisfies Partial<HarnessServices>
  const transport = new ClaudeSdkTransport(services as unknown as HarnessServices, { executable: "claude", configRoot: path.join(root, "homes"),
    userConfigRoot: path.join(root, "owner"), env: {} })
  try {
    const listing = transport.config.options({ draft: draft({ directory: root }) }, "probe").then(() => undefined, (error: unknown) => error)
    const first = await Promise.race([firstSpawn, listing])
    expect(first, `the listing settled before Claude Code was spawned: ${String(first)}`).toBe("spawned")

    await transport.dispose()

    expect(probes).toHaveLength(1)
    expect(probes[0]!.retirements).toBeGreaterThan(0)
    expect(await probes[0]!.exited).toEqual({ code: 0, signal: null })
    expect(await listing).toBeInstanceOf(Error)
    await expect(transport.config.options({ draft: draft({ directory: root }) }, "probe")).rejects.toMatchObject({ code: "session" })
    expect(probes).toHaveLength(1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
