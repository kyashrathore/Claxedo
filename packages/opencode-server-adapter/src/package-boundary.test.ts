import { describe, expect, test } from "bun:test"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")

describe("package boundary", () => {
  test("contains no process, bundled-binary, generated SDK, proxy, or adoption path", async () => {
    const files = [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: root })]
    const production = files.filter((file) => !file.endsWith(".test.ts"))
    const source = (await Promise.all(production.map((file) => Bun.file(path.join(root, file)).text()))).join("\n")

    expect(source).not.toMatch(/child_process|Bun\.spawn|\bspawn\s*\(|bundled|binaryPath/)
    expect(source).not.toMatch(/@opencode-ai\/sdk|createOpencodeClient/)
    expect(source).not.toMatch(/\bproxy\b|fallback|discoverSessions|listSessions|adopt(?:ion)?|migrat(?:e|ion)/i)
    expect(source).not.toContain("opencode-compat")
  })

  test("declares only Claxedo contract/runtime dependencies", async () => {
    const pkg = await Bun.file(path.join(root, "package.json")).json() as { dependencies?: Record<string, string> }
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      "@claxedo/agent-event-runtime",
      "@claxedo/agent-runtime-contract",
      "@claxedo/agent-sdk-runtime",
      "@claxedo/helpers",
    ])
  })

  test("exports only the provider composition boundary", async () => {
    const api = await import("./index")
    expect(Object.keys(api).sort()).toEqual([
      "OPENCODE_SERVER_CONNECTION_PROVIDER_KEY",
      "createOpenCodeServerConnectionProvider",
    ])
  })
})
