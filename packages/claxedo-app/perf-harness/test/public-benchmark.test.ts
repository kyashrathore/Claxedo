import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolvePublicBenchmark } from "../src/public-benchmark"

const entrypoint = path.join(import.meta.dir, "../src/public-benchmark.ts")
const harnessRoot = path.join(import.meta.dir, "..")

describe("public benchmark entrypoint", () => {
  test("locates the CLI of the pinned installed framework", async () => {
    const { pin, cliPath } = await resolvePublicBenchmark()
    expect(pin.pinnedCommit.startsWith(pin.installedCommit)).toBe(true)
    expect(cliPath.endsWith(path.join("agent-app-benchmark", "bin", "agent-app-benchmark.mjs"))).toBe(true)
  })

  test("refuses a drifted framework tree before reaching its CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-public-benchmark-"))
    try {
      await writeFile(path.join(root, ".bun-tag"), "kyashrathore-agent-app-benchmark-3e2c78d")
      await expect(
        resolvePublicBenchmark({ manifestPath: path.join(harnessRoot, "package.json"), frameworkRoot: root }),
      ).rejects.toThrow("run bun install --frozen-lockfile")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("forwards arguments to the framework CLI and returns its exit status", async () => {
    const registered = Bun.spawnSync(["bun", entrypoint, "validate"], { cwd: harnessRoot })
    expect(registered.exitCode).toBe(0)
    const listed = registered.stdout.toString()
    expect(listed).toContain("app\tclaxedo")
    expect(listed).toContain("scenario\tworkspace-panel-v1")

    const rejected = Bun.spawnSync(["bun", entrypoint, "result", "validate", "--input", "/nonexistent/result.json"], {
      cwd: harnessRoot,
    })
    expect(rejected.exitCode).toBe(1)
  })
})
