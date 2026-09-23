import { describe, expect, test } from "bun:test"
import { PluginManifestError, pluginOperationAllowed, pluginRouteAllowed, readPluginManifest } from "./manifest"

const packageJson = {
  name: "claxedo-plugin-notes",
  version: "0.1.0",
  claxedo: {
    id: "notes",
    name: "Notes",
    version: "0.1.0",
    app: "./src/app.tsx",
    requires: ["documents" as const],
    server: { routes: ["/api/claxedo/tasks"], operations: ["documents.*", "tasks.list"] },
  },
}

describe("readPluginManifest", () => {
  test("reads the claxedo block and fills the optional lists", () => {
    const manifest = readPluginManifest({ name: "x", claxedo: { id: "x", name: "X", version: "1.0.0", app: "./app.tsx" } })
    expect(manifest).toEqual({ id: "x", name: "X", version: "1.0.0", app: "./app.tsx", requires: [], server: { routes: [], operations: [] } })
  })

  test("keeps every declared field", () => {
    expect(readPluginManifest(packageJson)).toEqual(packageJson.claxedo)
  })

  test.each([
    ["no claxedo block", { name: "x" }, "claxedo"],
    ["an id with capitals", { claxedo: { ...packageJson.claxedo, id: "Notes" } }, "claxedo.id"],
    ["an id ending in a dash", { claxedo: { ...packageJson.claxedo, id: "notes-" } }, "claxedo.id"],
    ["an app entry outside the package", { claxedo: { ...packageJson.claxedo, app: "src/app.tsx" } }, "claxedo.app"],
    ["a route outside the Claxedo server", { claxedo: { ...packageJson.claxedo, server: { routes: ["/api/wr/session"] } } }, "claxedo.server.routes.0"],
    ["an unknown capability", { claxedo: { ...packageJson.claxedo, requires: ["network"] } }, "claxedo.requires.0"],
    ["an operation with no namespace", { claxedo: { ...packageJson.claxedo, server: { operations: ["list"] } } }, "claxedo.server.operations.0"],
    ["a field the manifest does not know", { claxedo: { ...packageJson.claxedo, sandbox: true } }, "claxedo"],
  ])("refuses %s", (_label, input, path) => {
    expect(() => readPluginManifest(input)).toThrow(PluginManifestError)
    try {
      readPluginManifest(input)
    } catch (error) {
      expect((error as PluginManifestError).issues.some((issue) => issue.startsWith(`${path}:`))).toBe(true)
    }
  })
})

describe("server allow-lists", () => {
  const manifest = readPluginManifest(packageJson)

  test("a route is allowed by prefix at a path boundary", () => {
    expect(pluginRouteAllowed(manifest, "/api/claxedo/tasks")).toBe(true)
    expect(pluginRouteAllowed(manifest, "/api/claxedo/tasks/42")).toBe(true)
    expect(pluginRouteAllowed(manifest, "/api/claxedo/tasksets")).toBe(false)
    expect(pluginRouteAllowed(manifest, "/api/claxedo/projects")).toBe(false)
  })

  test("an operation is allowed exactly or by a namespace wildcard", () => {
    expect(pluginOperationAllowed(manifest, "documents.list")).toBe(true)
    expect(pluginOperationAllowed(manifest, "tasks.list")).toBe(true)
    expect(pluginOperationAllowed(manifest, "tasks.create")).toBe(false)
    expect(pluginOperationAllowed(manifest, "documentsx.list")).toBe(false)
  })
})
