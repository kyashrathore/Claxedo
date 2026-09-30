import { describe, expect, test } from "bun:test"
import { PluginManifestError, pluginBackendRouteAllowed, pluginOperationAllowed, pluginRouteAllowed, readPluginManifest } from "./manifest"

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
    backend: {
      entry: "./src/backend.ts",
      objects: ["NotesIndex", "Note"],
      outbound: ["api.example.com"],
      routes: ["GET /notes", "POST /notes", "GET /notes/:id", "DELETE /notes/:id", "GET /notes/:id/files/*"],
    },
  },
}

const { backend: _backend, ...appOnly } = packageJson.claxedo

describe("readPluginManifest", () => {
  test("reads the claxedo block and fills the optional lists", () => {
    const manifest = readPluginManifest({ name: "x", claxedo: { id: "x", name: "X", version: "1.0.0", app: "./app.tsx" } })
    expect(manifest).toEqual({ id: "x", name: "X", version: "1.0.0", app: "./app.tsx", requires: [], server: { routes: [], operations: [] } })
  })

  test("fills a backend's optional lists", () => {
    const manifest = readPluginManifest({ claxedo: { ...appOnly, backend: { entry: "./backend.ts", routes: ["GET /"] } } })
    expect(manifest.backend).toEqual({ entry: "./backend.ts", objects: [], outbound: [], routes: ["GET /"] })
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
    ["a backend entry outside the package", { claxedo: { ...appOnly, backend: { ...packageJson.claxedo.backend, entry: "/src/backend.ts" } } }, "claxedo.backend.entry"],
    ["a backend with no routes", { claxedo: { ...appOnly, backend: { ...packageJson.claxedo.backend, routes: [] } } }, "claxedo.backend.routes"],
    ["a backend route with no method", { claxedo: { ...appOnly, backend: { ...packageJson.claxedo.backend, routes: ["/notes"] } } }, "claxedo.backend.routes.0"],
    ["a backend route with a dot segment", { claxedo: { ...appOnly, backend: { ...packageJson.claxedo.backend, routes: ["GET /notes/../admin"] } } }, "claxedo.backend.routes.0"],
    ["a backend route with a wildcard before its end", { claxedo: { ...appOnly, backend: { ...packageJson.claxedo.backend, routes: ["GET /*/notes"] } } }, "claxedo.backend.routes.0"],
    ["a backend object that is not a class name", { claxedo: { ...appOnly, backend: { ...packageJson.claxedo.backend, objects: ["note"] } } }, "claxedo.backend.objects.0"],
    ["a backend object declared twice", { claxedo: { ...appOnly, backend: { ...packageJson.claxedo.backend, objects: ["Note", "Note"] } } }, "claxedo.backend.objects"],
    ["an outbound host with a scheme", { claxedo: { ...appOnly, backend: { ...packageJson.claxedo.backend, outbound: ["https://api.example.com"] } } }, "claxedo.backend.outbound.0"],
    ["an outbound host with no domain", { claxedo: { ...appOnly, backend: { ...packageJson.claxedo.backend, outbound: ["localhost"] } } }, "claxedo.backend.outbound.0"],
    ["a backend field the manifest does not know", { claxedo: { ...appOnly, backend: { ...packageJson.claxedo.backend, bindings: {} } } }, "claxedo.backend"],
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

describe("backend routes", () => {
  const backend = readPluginManifest(packageJson).backend!

  test("a route matches its method and every literal segment", () => {
    expect(pluginBackendRouteAllowed(backend, "GET", "/notes")).toBe(true)
    expect(pluginBackendRouteAllowed(backend, "POST", "/notes")).toBe(true)
    expect(pluginBackendRouteAllowed(backend, "PUT", "/notes")).toBe(false)
    expect(pluginBackendRouteAllowed(backend, "get", "/notes")).toBe(false)
    expect(pluginBackendRouteAllowed(backend, "GET", "/notesx")).toBe(false)
    expect(pluginBackendRouteAllowed(backend, "GET", "/")).toBe(false)
  })

  test("a parameter matches exactly one segment", () => {
    expect(pluginBackendRouteAllowed(backend, "GET", "/notes/n1")).toBe(true)
    expect(pluginBackendRouteAllowed(backend, "DELETE", "/notes/n1")).toBe(true)
    expect(pluginBackendRouteAllowed(backend, "GET", "/notes/n1/extra")).toBe(false)
    expect(pluginBackendRouteAllowed(backend, "GET", "/notes/")).toBe(false)
  })

  test("a trailing wildcard matches one or more segments", () => {
    expect(pluginBackendRouteAllowed(backend, "GET", "/notes/n1/files/a.txt")).toBe(true)
    expect(pluginBackendRouteAllowed(backend, "GET", "/notes/n1/files/dir/a.txt")).toBe(true)
    expect(pluginBackendRouteAllowed(backend, "GET", "/notes/n1/files")).toBe(false)
  })

  test("a path with an empty or dot segment matches nothing", () => {
    expect(pluginBackendRouteAllowed(backend, "GET", "/notes//n1")).toBe(false)
    expect(pluginBackendRouteAllowed(backend, "GET", "/notes/..")).toBe(false)
    expect(pluginBackendRouteAllowed(backend, "GET", "/notes/n1/files/../../x")).toBe(false)
    expect(pluginBackendRouteAllowed(backend, "GET", "notes")).toBe(false)
  })

  test("the root route and a root wildcard", () => {
    const root = readPluginManifest({ claxedo: { ...appOnly, backend: { entry: "./b.ts", routes: ["GET /", "POST /*"] } } }).backend!
    expect(pluginBackendRouteAllowed(root, "GET", "/")).toBe(true)
    expect(pluginBackendRouteAllowed(root, "GET", "/a")).toBe(false)
    expect(pluginBackendRouteAllowed(root, "POST", "/a/b")).toBe(true)
    expect(pluginBackendRouteAllowed(root, "POST", "/")).toBe(false)
  })
})
