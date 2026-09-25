import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { PluginDefinition } from "@claxedo/plugin-api"
import { PLUGIN_RUNTIME_GLOBAL } from "@claxedo/plugin-api/runtime"
import { buildPluginApp, PluginBuildError } from "./index"

const APP = `import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { definePlugin } from "@claxedo/plugin-api"
import { Button } from "@claxedo/app-v2/ui"

function Page() {
  const [count, setCount] = createSignal(0)
  const [state] = createStore({ title: "Notes" })
  return <div class="notes"><h1>{state.title}</h1><Button onClick={() => setCount(count() + 1)}>{count()}</Button></div>
}

export default definePlugin({
  activate(api) {
    const disposers = [
      api.pages.register({ id: "notes", path: "/notes", title: "Notes", render: () => <Page /> }),
      api.sidebar.item({ id: "notes", label: "Notes", pageId: "notes" }),
    ]
    return () => disposers.forEach((dispose) => dispose())
  },
})
`

let root: string

async function writePlugin(dir: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  }
  return dir
}

const packageJson = (app = "./src/app.tsx") =>
  JSON.stringify({ name: "claxedo-plugin-notes", version: "0.1.0", claxedo: { id: "notes", name: "Notes", version: "0.1.0", app } })

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-build-"))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("buildPluginApp", () => {
  test("bundles the app entry with host modules resolved from the runtime global", async () => {
    const dir = await writePlugin(path.join(root, "notes"), { "package.json": packageJson(), "src/app.tsx": APP })
    const built = await buildPluginApp({ rootDir: dir })
    expect(built.manifest.id).toBe("notes")
    expect(built.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(built.code).toContain(`globalThis.${PLUGIN_RUNTIME_GLOBAL}`)
    for (const specifier of ["solid-js", "solid-js/web", "solid-js/store", "@claxedo/plugin-api", "@claxedo/app-v2/ui"]) {
      expect(built.code).toContain(`runtime[${JSON.stringify(specifier)}]`)
      expect(built.code).not.toMatch(new RegExp(`from\\s+"${specifier.replace(/[/@.-]/g, "\\$&")}"`))
    }
    expect(built.code).toMatch(/export\s*\{[^}]*as default/)
    expect(built.code).not.toContain("<Button")
    expect(built.code).toContain("createComponent")
    expect((await buildPluginApp({ rootDir: dir })).hash).toBe(built.hash)
  })

  test("a manifest change alone is a new build", async () => {
    const dir = await writePlugin(path.join(root, "access"), { "package.json": packageJson(), "src/app.tsx": APP })
    const before = await buildPluginApp({ rootDir: dir })
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as { claxedo: { server?: unknown } }
    manifest.claxedo.server = { routes: ["/api/claxedo/projects"] }
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(manifest))
    const after = await buildPluginApp({ rootDir: dir })
    expect(after.code).toBe(before.code)
    expect(after.hash).not.toBe(before.hash)
  })

  test("the bundle activates against a runtime the host installs", async () => {
    const dir = await writePlugin(path.join(root, "runs"), { "package.json": packageJson(), "src/app.tsx": APP })
    const built = await buildPluginApp({ rootDir: dir })
    const bundle = path.join(root, `runs-${built.hash}.mjs`)
    await fs.writeFile(bundle, built.code)
    const registered: string[] = []
    const web = {
      template: () => () => ({ firstChild: {} }),
      insert: () => undefined,
      createComponent: () => undefined,
      delegateEvents: () => undefined,
    }
    Object.assign(globalThis, {
      [PLUGIN_RUNTIME_GLOBAL]: {
        "solid-js": await import("solid-js"),
        "solid-js/web": web,
        "solid-js/store": await import("solid-js/store"),
        "@claxedo/plugin-api": await import("@claxedo/plugin-api"),
        "@claxedo/app-v2/ui": { Button: () => undefined },
      },
    })
    try {
      const definition = (await import(pathToFileURL(bundle).href)).default as PluginDefinition
      const api = {
        pages: { register: (page: { id: string }) => { registered.push(`page:${page.id}`); return () => registered.push("disposed:page") } },
        sidebar: { item: (item: { id: string }) => { registered.push(`sidebar:${item.id}`); return () => registered.push("disposed:sidebar") } },
      }
      const dispose = await definition.activate(api as never)
      expect(registered).toEqual(["page:notes", "sidebar:notes"])
      if (typeof dispose === "function") dispose()
      expect(registered.slice(2)).toEqual(["disposed:page", "disposed:sidebar"])
    } finally {
      delete (globalThis as Record<string, unknown>)[PLUGIN_RUNTIME_GLOBAL]
    }
  })

  test("a syntax error names the file and keeps no output", async () => {
    const dir = await writePlugin(path.join(root, "broken"), { "package.json": packageJson(), "src/app.tsx": "export default definePlugin({" })
    const failure = await buildPluginApp({ rootDir: dir }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PluginBuildError)
    expect((failure as PluginBuildError).failure).toBe("bundle")
    expect((failure as PluginBuildError).messages.join("\n")).toContain("app.tsx")
  })

  test("a missing entry and a bad manifest are refused before bundling", async () => {
    const missing = await writePlugin(path.join(root, "missing"), { "package.json": packageJson("./src/nope.tsx") })
    const noEntry = await buildPluginApp({ rootDir: missing }).catch((error: unknown) => error)
    expect(noEntry).toBeInstanceOf(PluginBuildError)
    expect((noEntry as PluginBuildError).failure).toBe("entry")

    const invalid = await writePlugin(path.join(root, "invalid"), { "package.json": JSON.stringify({ name: "x", claxedo: { id: "Bad Id" } }) })
    const noManifest = await buildPluginApp({ rootDir: invalid }).catch((error: unknown) => error)
    expect(noManifest).toBeInstanceOf(PluginBuildError)
    expect((noManifest as PluginBuildError).failure).toBe("manifest")
    expect((noManifest as PluginBuildError).messages.some((message) => message.includes("claxedo.id"))).toBe(true)
  })
})
