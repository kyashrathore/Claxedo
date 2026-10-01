import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildPluginBackend, PluginBuildError } from "./index"

const BACKEND = `import { DurableObject } from "cloudflare:workers"
import { label } from "./label"

export class Counter extends DurableObject {}

export default {
  fetch() {
    return new Response(label)
  },
}
`

let root: string

async function writePlugin(name: string, backend: string, declared: Record<string, unknown> = {}) {
  const dir = path.join(root, name)
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  const manifest = { id: name, name, version: "0.1.0", app: "./src/app.ts", backend: { entry: "./src/backend.ts", objects: ["Counter"], routes: ["GET /"], ...declared } }
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ claxedo: manifest }))
  await fs.writeFile(path.join(dir, "src", "app.ts"), "export default {}\n")
  await fs.writeFile(path.join(dir, "src", "label.ts"), `export const label = "counter"\n`)
  await fs.writeFile(path.join(dir, "src", "backend.ts"), backend)
  return dir
}

async function buildFailure(dir: string) {
  const failure = await buildPluginBackend({ rootDir: dir }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(PluginBuildError)
  return failure as PluginBuildError
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-backend-test-"))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("buildPluginBackend", () => {
  test("bundles the entry into one module that imports only the runtime", async () => {
    const built = await buildPluginBackend({ rootDir: await writePlugin("counter", BACKEND) })
    expect(built.manifest.backend.objects).toEqual(["Counter"])
    expect(built.code).toContain(`from "cloudflare:workers"`)
    expect(built.code).toContain(`"counter"`)
    expect(built.code).not.toContain("./label")
    expect(built.code).toMatch(/export\s*\{[^}]*Counter[^}]*\}/)
  })

  test("refuses an entry with no default export", async () => {
    const failure = await buildFailure(await writePlugin("headless", BACKEND.replace("export default {", "const handler = {")))
    expect(failure.diagnostics).toEqual([{ stage: "bundle", file: "./src/backend.ts", message: "the backend entry has no default export" }])
  })

  test("refuses a node builtin, which the loaded Worker cannot import", async () => {
    const failure = await buildFailure(await writePlugin("node", `import { readFileSync } from "node:fs"\nexport const read = readFileSync\n${BACKEND}`))
    expect(failure.failure).toBe("bundle")
    expect(failure.diagnostics[0]).toMatchObject({ stage: "bundle", file: "src/backend.ts", line: 1, message: expect.stringContaining("node:fs") })
  })

  test("refuses a package without a backend", async () => {
    const dir = await writePlugin("plain", BACKEND)
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ claxedo: { id: "plain", name: "Plain", version: "0.1.0", app: "./src/app.ts" } }))
    const failure = await buildFailure(dir)
    expect(failure.diagnostics).toEqual([{ stage: "entry", file: "package.json", message: "claxedo.backend is not declared" }])
  })
})
