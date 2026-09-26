import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { checkPluginApp, formatPluginDiagnostic } from "./index"
import { parseCompilerOutput } from "./typecheck"

const APP = `import { createSignal } from "solid-js"
import { definePlugin } from "@claxedo/plugin-api"
import { Button } from "@claxedo/app-v2/ui"

function Page() {
  const [count, setCount] = createSignal(0)
  return <section><Button onClick={() => setCount(count() + 1)}>{count()}</Button></section>
}

export default definePlugin({
  activate(api) {
    api.pages.register({ id: "notes", path: "/notes", title: "Notes", render: () => <Page /> })
    api.sidebar.item({ id: "notes", label: "Notes", pageId: "notes" })
  },
})
`

let root: string

async function writePlugin(name: string, app: string, manifest: Record<string, unknown> = {}) {
  const dir = path.join(root, name)
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: `claxedo-plugin-${name}`, version: "0.1.0", claxedo: { id: name, name: "Notes", version: "0.1.0", app: "./src/app.tsx", ...manifest } }),
  )
  await fs.writeFile(path.join(dir, "src", "app.tsx"), app)
  return dir
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-check-test-"))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("checkPluginApp", () => {
  test("a plugin that typechecks against the plugin API and Solid builds", async () => {
    const dir = await writePlugin("notes", APP)
    const checked = await checkPluginApp({ rootDir: dir })
    expect(checked.diagnostics).toEqual([])
    expect(checked.ok).toBe(true)
    expect(checked.manifest?.id).toBe("notes")
    expect(checked.hash).toMatch(/^[0-9a-f]{16}$/)
  })

  test("a type error against the plugin API is reported by file, line and column, and nothing is built", async () => {
    const dir = await writePlugin("typed", APP.replace(`label: "Notes"`, "label: 3").replace(`count()}</Button>`, `count().toUpperCase()}</Button>`))
    const checked = await checkPluginApp({ rootDir: dir })
    expect(checked.ok).toBe(false)
    expect(checked.hash).toBeUndefined()
    expect(checked.diagnostics).toEqual([
      expect.objectContaining({ stage: "typecheck", file: path.join("src", "app.tsx"), line: 7, code: "TS2339", message: expect.stringContaining("toUpperCase") }),
      expect.objectContaining({ stage: "typecheck", file: path.join("src", "app.tsx"), line: 13, column: 37, code: "TS2322" }),
    ])
  })

  test("a syntax error fails the typecheck with its position", async () => {
    const dir = await writePlugin("syntax", "export default definePlugin({ activate( {} })\n")
    const checked = await checkPluginApp({ rootDir: dir })
    expect(checked.ok).toBe(false)
    expect(checked.diagnostics[0]).toMatchObject({ stage: "typecheck", file: path.join("src", "app.tsx"), line: 1 })
  })

  test("an invalid manifest is reported against package.json before anything is compiled", async () => {
    const dir = await writePlugin("manifest", APP, { id: "Bad Id" })
    const checked = await checkPluginApp({ rootDir: dir })
    expect(checked.ok).toBe(false)
    expect(checked.diagnostics).toEqual([expect.objectContaining({ stage: "manifest", file: "package.json", message: expect.stringContaining("claxedo.id") })])
  })

  test("the check writes nothing into the plugin folder", async () => {
    const dir = await writePlugin("clean", APP)
    await checkPluginApp({ rootDir: dir })
    expect((await fs.readdir(dir)).sort()).toEqual(["package.json", "src"])
    expect(await fs.readdir(path.join(dir, "src"))).toEqual(["app.tsx"])
  })
})

describe("parseCompilerOutput", () => {
  test("joins continuation lines, keeps global errors and drops files outside the plugin", () => {
    const output = [
      "src/app.tsx(3,5): error TS2322: Type 'number' is not assignable to type 'string'.",
      "  The expected type comes from property 'label'.",
      "../host/api.ts(1,1): error TS1005: ';' expected.",
      "error TS5058: The specified path does not exist.",
    ].join("\n")
    expect(parseCompilerOutput(output, "/plugin")).toEqual([
      { stage: "typecheck", file: path.join("src", "app.tsx"), line: 3, column: 5, code: "TS2322", message: "Type 'number' is not assignable to type 'string'.\nThe expected type comes from property 'label'." },
      { stage: "typecheck", code: "TS5058", message: "The specified path does not exist." },
    ])
  })

  test("formats a diagnostic the way a compiler prints one", () => {
    expect(formatPluginDiagnostic({ stage: "typecheck", file: "src/app.tsx", line: 3, column: 5, code: "TS2322", message: "Nope" })).toBe("src/app.tsx:3:5: TS2322: Nope")
    expect(formatPluginDiagnostic({ stage: "manifest", file: "package.json", message: "claxedo.id: Invalid" })).toBe("package.json: claxedo.id: Invalid")
  })
})
