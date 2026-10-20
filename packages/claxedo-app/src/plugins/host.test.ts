import { describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { PluginManifest } from "@claxedo/plugin-api"
import type { LivePlugin } from "@/server"
import type { Approval } from "./approval"
import { createPluginHost, type PluginHost } from "./host"
import type { LiveRow } from "./live/load"
import { liveOriginOf, type PluginBuild, type PluginOrigin } from "./model"
import type { PluginPreferences } from "./preferences"

await mock.module("./live/load", () => ({ failingBuild: () => undefined }))
const { createLiveReconciler } = await import("./live/controller")

function manifest(id: string): PluginManifest {
  return { id, name: id, version: "1.0.0", app: "./app.ts", requires: [], server: { routes: [], operations: [] } }
}

function build(id: string, origin: PluginOrigin): PluginBuild {
  return { manifest: manifest(id), origin, definition: { activate: () => undefined } }
}

const bundled = build("claxedo-tasks", { kind: "bundled", hash: "b".repeat(16) })
const live = build("fixture", { kind: "live", hash: "a".repeat(16), directory: "/tmp/fixture", builtAt: "2026-10-19T00:00:00.000Z" })

function preferences(safeModeAtStart: boolean) {
  const [off, setOff] = createSignal<readonly string[]>([])
  const [safeMode, setSafeMode] = createSignal(safeModeAtStart)
  const approvals: Record<string, Approval> = {}
  const value: PluginPreferences = {
    switchedOn: (pluginId) => !off().includes(pluginId),
    setSwitchedOn: (pluginId, on) => setOff((current) => (on ? current.filter((id) => id !== pluginId) : [...current, pluginId])),
    approval: (pluginId) => approvals[pluginId],
    approve: (pluginId, approval) => {
      approvals[pluginId] = approval
    },
    forget: () => undefined,
    safeMode,
    leaveSafeMode: () => setSafeMode(false),
  }
  return { value, approvals }
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function hostWith(safeMode = false) {
  const prefs = preferences(safeMode)
  const activated: string[] = []
  const host = createRoot(() =>
    createPluginHost({
      preferences: prefs.value,
      offered: () => true,
      activate: (next) => {
        activated.push(next.manifest.id)
        return Promise.resolve({ build: next.origin.hash, dispose: () => undefined })
      },
      removeLive: () => Promise.resolve(),
    }),
  )
  return { host, approvals: prefs.approvals, activated }
}

function stateOf(host: PluginHost, pluginId: string) {
  return host.plugins().find((plugin) => plugin.id === pluginId)?.state.kind
}

describe("a bundled plugin on its own", () => {
  test("is approved because the host ships it, runs without an approval record, and cannot be approved as a live build", async () => {
    const { host, approvals, activated } = hostWith()
    host.put(bundled)
    await settle()
    expect(host.plugins()[0]?.approval).toEqual({ kind: "approved" })
    expect(stateOf(host, "claxedo-tasks")).toBe("on")
    expect(activated).toEqual(["claxedo-tasks"])
    expect(host.approve("claxedo-tasks", bundled.origin.hash)).toBe(false)
    expect(approvals).toEqual({})
  })

  test("switches off and on like any plugin", async () => {
    const { host } = hostWith()
    host.put(bundled)
    await settle()
    host.switchOff("claxedo-tasks")
    await settle()
    expect(stateOf(host, "claxedo-tasks")).toBe("off")
    host.switchOn("claxedo-tasks")
    await settle()
    expect(stateOf(host, "claxedo-tasks")).toBe("on")
  })
})

describe("an installed plugin", () => {
  const installed = build("counter", { kind: "installed", hash: "c".repeat(64), version: "0.1.0" })

  test("runs on the organization's install and the person's enablement, with no approval record and no switch of its own", async () => {
    const { host, approvals } = hostWith()
    host.put(installed)
    host.switchOff("counter")
    await settle()
    expect(host.plugins()[0]).toMatchObject({ approval: { kind: "approved" }, switchedOn: true })
    expect(stateOf(host, "counter")).toBe("on")
    expect(host.approve("counter", installed.origin.hash)).toBe(false)
    expect(approvals).toEqual({})
  })

  test("is stopped by safe mode, as live plugins are, and starts when the person leaves it", async () => {
    const { host, activated } = hostWith(true)
    host.put(installed)
    await settle()
    expect(stateOf(host, "counter")).toBe("off")
    expect(activated).toEqual([])
    host.leaveSafeMode()
    await settle()
    expect(stateOf(host, "counter")).toBe("on")
    expect(activated).toEqual(["counter"])
  })
})

describe("a bundled plugin beside live plugins", () => {
  test("keeps running in safe mode, which stops only live and installed plugins", async () => {
    const { host } = hostWith(true)
    host.put(bundled)
    host.put(live)
    host.approve("fixture", live.origin.hash)
    await settle()
    expect(stateOf(host, "claxedo-tasks")).toBe("on")
    expect(stateOf(host, "fixture")).toBe("off")
    host.leaveSafeMode()
    await settle()
    expect(stateOf(host, "fixture")).toBe("on")
  })

  test("survives a daemon list that does not name it, while a live plugin the list drops is removed", async () => {
    const { host } = hostWith()
    host.put(bundled)
    host.put(live)
    const reconciler = createLiveReconciler(host, () => Promise.reject(new Error("no load expected")))
    reconciler.reconcile([] satisfies LivePlugin[])
    await settle()
    expect(host.plugins().map((plugin) => plugin.id)).toEqual(["claxedo-tasks"])
  })
})

describe("the live reconciler", () => {
  const hash = "f120b7059bc761c2"
  const buildError = "src/app.tsx:1:1: Expected expression"

  function daemonRow(status: LivePlugin["status"], lastError: string | null): LivePlugin {
    return { id: "fixture", name: "fixture", version: "1.0.0", directory: "/tmp/fixture", status, hash, manifest: manifest("fixture"), builtAt: "2026-10-20T00:00:00.000Z", lastError }
  }

  function loadedBuild(row: LiveRow): PluginBuild {
    return build(row.id, { kind: "live", hash: row.hash, directory: row.directory, ...(row.lastError ? { buildError: row.lastError } : {}) })
  }

  test("a build error the daemon reports while that build's bundle is still loading reaches the loaded plugin", async () => {
    const { host } = hostWith()
    const loads: Array<{ readonly done: Promise<PluginBuild>; readonly finish: () => void }> = []
    const reconciler = createLiveReconciler(host, (row) => {
      let finish: () => void = () => undefined
      const done = new Promise<PluginBuild>((resolve) => {
        finish = () => resolve(loadedBuild(row))
      })
      loads.push({ done, finish })
      return done
    })
    reconciler.reconcile([daemonRow("building", null)])
    reconciler.reconcile([daemonRow("failed", buildError)])
    for (const load of loads) load.finish()
    await Promise.all(loads.map((load) => load.done))
    expect(host.plugins().map((plugin) => liveOriginOf(plugin)?.buildError)).toEqual([buildError])
  })
})
