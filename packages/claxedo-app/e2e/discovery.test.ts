import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import path from "node:path"
import { subSelectorTags, suiteGrep } from "./suites"

type Spec = { title: string; file: string; line: number; tags: string[] }
type Suite = { specs?: Spec[]; suites?: Suite[] }
const appRoot = path.resolve(import.meta.dir, "..")
const lanes = Object.values(suiteGrep).filter((value): value is RegExp => value !== undefined)
const knownTags = new Set([...lanes.map((lane) => lane.source.replace(/^@/, "")), ...subSelectorTags])

function tagViolations(specs: Spec[]) {
  return specs.flatMap((spec) => {
    const label = `${spec.file}:${spec.line} ${spec.title}`
    const title = spec.tags.map((tag) => `@${tag}`).join(" ")
    return [
      ...(!lanes.some((lane) => lane.test(title)) ? [`${label}: no suite lane`] : []),
      ...spec.tags.filter((tag) => !knownTags.has(tag)).map((tag) => `${label}: unknown @${tag}`),
    ]
  })
}

function specsIn(suite: Suite): Spec[] {
  return [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(specsIn)]
}

describe("Playwright discovery", () => {
  test("does not let a tagged sibling hide an unreachable or misspelled test", () => {
    const spec = { file: "fixture.spec.ts", line: 1, title: "tagged", tags: ["core"] }
    expect(tagViolations([spec, { ...spec, title: "untagged", tags: [] }]))
      .toEqual(["fixture.spec.ts:1 untagged: no suite lane"])
    expect(tagViolations([{ ...spec, tags: ["core", "cores"] }]))
      .toEqual(["fixture.spec.ts:1 tagged: unknown @cores"])
    expect(tagViolations([{ ...spec, tags: ["tier-real"] }]))
      .toEqual(["fixture.spec.ts:1 tagged: no suite lane"])
  })

  test("collects every spec and assigns every individual test to a known lane", async () => {
    // --list loads declarations only: no web server, browser, credential, or
    // test body runs. Playwright supplies inherited describe tags and dynamic
    // test titles, which the former per-file source regex could not verify.
    const child = Bun.spawn([
      "node", "./node_modules/@playwright/test/cli.js", "test",
      "--config", "playwright.config.ts", "--list", "--reporter=json",
    ], {
      cwd: appRoot,
      env: {
        ...process.env,
        CLAXEDO_E2E_SUITE: "all",
        CLAXEDO_E2E_DESKTOP: "1",
        CLAXEDO_TIER_REAL_E2E: "1",
        CLAXEDO_E2E_LIVE: "1",
        PLAYWRIGHT_SKIP_WEBSERVER: "1",
      },
      stdout: "pipe", stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(code, stderr || stdout).toBe(0)
    const report = JSON.parse(stdout) as Suite & { errors: unknown[] }
    expect(report.errors).toEqual([])
    const specs = specsIn(report)
    expect(specs.length).toBeGreaterThan(0)
    const expectedFiles = readdirSync(path.join(appRoot, "e2e"), { recursive: true })
      .filter((file) => typeof file === "string" && file.endsWith(".spec.ts"))
      .map((file) => String(file).replaceAll("\\", "/")).sort()
    expect([...new Set(specs.map((spec) => spec.file.replaceAll("\\", "/")))].sort()).toEqual(expectedFiles)
    expect(tagViolations(specs)).toEqual([])
  }, 30_000)
})
