import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const scopes = [
  "convex",
  "packages/workgraph",
  "packages/claxedo-server/src/workgraph-host",
  "packages/claxedo-mcp",
  "packages/claxedo-app/src/features/workgraph",
]

describe("WorkGraph vocabulary", () => {
  it("keeps the execution entity vocabulary distinct from retry counters", () => {
    const retired = ["at", "tempt"].join("")
    const result = spawnSync("rg", ["-n", "-w", `${retired}|${retired[0]!.toUpperCase()}${retired.slice(1)}`, ...scopes], {
      cwd: repository,
      encoding: "utf8",
    })
    expect([0, 1]).toContain(result.status)
    expect(result.stderr).toBe("")

    const unexpected = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((line) => !isRetryVocabulary(line))
    expect(unexpected).toEqual([])
  })
})

function isRetryVocabulary(line: string) {
  return [
    /^convex\/workgraphCommands\.ts:/,
    /^convex\/workgraphBackground\.ts:/,
    /^packages\/workgraph\/src\/contracts\/(?:archive|records)\.ts:/,
    /^packages\/workgraph\/src\/adapters\/sqlite\/source-planning-runtime(?:\.test)?\.ts:/,
    /^packages\/workgraph\/src\/adapters\/sqlite\/schema\.ts:/,
    /^packages\/workgraph\/src\/adapters\/sqlite\/store\.ts:/,
    /^packages\/claxedo-server\/src\/workgraph-host\/hosted\.ts:/,
    /^packages\/claxedo-server\/src\/workgraph-host\/convex-store\.test\.ts:/,
    /^packages\/claxedo-server\/src\/workgraph-host\/session-intake\.test\.ts:/,
    /^packages\/claxedo-app\/src\/features\/workgraph\/api\.test\.ts:/,
  ].some((pattern) => pattern.test(line))
}
