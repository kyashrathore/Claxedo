import { describe, expect, test } from "bun:test"
import type { PluginManifest } from "@claxedo/plugin-api"
import type { AppPluginCatalog, AppPluginInstall, AppPluginListing } from "@/server"
import { appPluginAccess, appPluginEntries, appPluginMainAction, appPluginStatus, appPluginTools, appPluginUpdate } from "./model"

function manifest(id: string, version: string, extra: Partial<PluginManifest> = {}): PluginManifest {
  return { id, name: id.charAt(0).toUpperCase() + id.slice(1), version, app: "./src/app.js", requires: [], server: { routes: [], operations: [] }, ...extra }
}

function listing(id: string, versions: readonly string[], available = true): AppPluginListing {
  return { id, name: manifest(id, versions[0]).name, description: `${id} things`, latest: versions[0], versions, manifest: manifest(id, versions[0]), available }
}

function install(id: string, version: string, state: Partial<Pick<AppPluginInstall, "active" | "enabledForMe" | "orgDefault">> = {}): AppPluginInstall {
  return { id, version, manifest: manifest(id, version), appSha256: "a".repeat(64), active: true, enabledForMe: false, orgDefault: false, ...state }
}

const catalog: AppPluginCatalog = { canManage: true, registry: "listed", plugins: [listing("notes", ["1.0.0"]), listing("counter", ["0.2.0", "0.1.0"]), listing("relay", ["1.0.0"], false)] }

describe("the App plugins directory", () => {
  test("lists the organization's installs first, then what the registry publishes, each by name, with the registry's description", () => {
    const entries = appPluginEntries([install("counter", "0.1.0")], catalog)
    expect(entries.map((entry) => [entry.id, entry.install?.version, entry.description])).toEqual([
      ["counter", "0.1.0", "counter things"],
      ["notes", undefined, "notes things"],
      ["relay", undefined, "relay things"],
    ])
    expect(appPluginEntries([install("gone", "1.0.0")], { ...catalog, registry: "unavailable", plugins: [] }).map((entry) => entry.id)).toEqual(["gone"])
  })

  test("offers an admin the install of an available plugin, a member none, and each member their own switch", () => {
    const [counter, notes, relay] = appPluginEntries([install("counter", "0.1.0")], catalog)
    expect([appPluginMainAction(notes, true), appPluginMainAction(notes, false), appPluginMainAction(relay, true)]).toEqual(["install", undefined, undefined])
    expect(appPluginMainAction(counter, false)).toBe("turnOn")
    const [enabled] = appPluginEntries([install("counter", "0.2.0", { enabledForMe: true })], catalog)
    expect(appPluginMainAction(enabled, false)).toBe("turnOff")
    const [off] = appPluginEntries([install("counter", "0.2.0", { active: false })], catalog)
    expect([appPluginMainAction(off, true), appPluginMainAction(off, false)]).toEqual(["turnOnForOrganization", undefined])
  })
})

describe("an App plugin's agent tools switch", () => {
  const tools = { label: "Notes", names: ["note_list"], on: true }

  test("is offered only for a plugin that declares tools, while the organization has it on and the member turned it on", () => {
    const shown = (state: Partial<Pick<AppPluginInstall, "active" | "enabledForMe">>, declared = true) =>
      appPluginTools(appPluginEntries([{ ...install("notes", "1.0.0", state), ...(declared ? { tools } : {}) }], catalog)[0])
    expect(shown({ enabledForMe: true })).toEqual(tools)
    expect(shown({ enabledForMe: false })).toBeUndefined()
    expect(shown({ enabledForMe: true, active: false })).toBeUndefined()
    expect(shown({ enabledForMe: true }, false)).toBeUndefined()
    expect(appPluginTools(appPluginEntries([], catalog)[0])).toBeUndefined()
  })
})

describe("an App plugin's status and access", () => {
  test("says what state an install is in, and that an update exists only for a version older than the registry's latest", () => {
    const [older] = appPluginEntries([install("counter", "0.1.0", { enabledForMe: true })], catalog)
    expect([appPluginUpdate(older), appPluginStatus(older)?.key]).toEqual(["0.2.0", "marketplace.status.updateAvailable"])
    const [current] = appPluginEntries([install("counter", "0.2.0", { enabledForMe: true })], catalog)
    expect([appPluginUpdate(current), appPluginStatus(current)?.key]).toEqual([undefined, "marketplace.app.status.on"])
    const [off] = appPluginEntries([install("counter", "0.2.0", { active: false })], catalog)
    expect(appPluginStatus(off)?.key).toBe("marketplace.app.status.organizationOff")
    const [, , relay] = appPluginEntries([], catalog)
    expect(appPluginStatus(relay)?.key).toBe("marketplace.app.status.unavailable")
  })

  test("names everything the manifest lets the plugin do: its frame, its backend, each platform permission, and each host, route and operation", () => {
    const access = appPluginAccess(manifest("counter", "0.1.0", {
      server: { routes: ["/api/claxedo/plugins"], operations: ["documents.list"] },
      backend: { entry: "./src/backend.js", objects: [], outbound: ["api.example.com"], routes: ["GET /count"] },
      permissions: ["projects.read", "session-files"],
    }))
    expect(access).toEqual([
      { key: "marketplace.app.access.frame" },
      { key: "marketplace.app.access.backend" },
      { key: "marketplace.app.permission.projectsRead" },
      { key: "marketplace.app.permission.sessionFiles" },
      { key: "marketplace.app.access.outbound", params: { host: "api.example.com" } },
      { key: "marketplace.app.access.route", params: { route: "/api/claxedo/plugins" } },
      { key: "marketplace.app.access.operation", params: { operation: "documents.list" } },
    ])
  })
})
