import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
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


/**
 * Every declared test, from Playwright's own `--list`. It loads declarations
 * only: no web server, browser, credential, or test body runs, and Playwright
 * supplies inherited describe tags and dynamic titles that a per-file source
 * regex could not see. Memoized: one collection serves every assertion here.
 */
let collected: Promise<Spec[]> | undefined
function collectedSpecs(): Promise<Spec[]> {
  collected ??= (async () => {
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
    return specsIn(report)
  })()
  return collected
}

const repoRoot = path.resolve(appRoot, "../..")
const tierRealWorkflow = ".github/workflows/test.yml"
const tierRealReplay = "script/cbx-ci-remote.sh"

/** The `--grep` patterns the tier-real CI job loops over, read from the workflow itself. */
function tierRealGatePatterns(): string[] {
  const workflow = readFileSync(path.resolve(repoRoot, tierRealWorkflow), "utf8")
  const loop = /for scenario in\s*\\?\n?((?:\s*"[^"]+"\s*\\?\n?)+);\s*do/.exec(workflow)
  if (!loop) throw new Error(`${tierRealWorkflow} no longer has the tier-real \`for scenario in\` loop`)
  return [...loop[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

/** The same patterns as the crabbox replay lane carries them. */
function tierRealReplayPatterns(): string[] {
  const lane = readFileSync(path.resolve(repoRoot, tierRealReplay), "utf8")
  const list = /TIER_REAL_SCENARIOS=\(((?:\s*"[^"]+")+)\s*\)/.exec(lane)
  if (!list) throw new Error(`${tierRealReplay} no longer declares TIER_REAL_SCENARIOS`)
  return [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
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
    const specs = await collectedSpecs()
    expect(specs.length).toBeGreaterThan(0)
    const expectedFiles = readdirSync(path.join(appRoot, "e2e"), { recursive: true })
      .filter((file) => typeof file === "string" && file.endsWith(".spec.ts"))
      .map((file) => String(file).replaceAll("\\", "/")).sort()
    expect([...new Set(specs.map((spec) => spec.file.replaceAll("\\", "/")))].sort()).toEqual(expectedFiles)
    expect(tagViolations(specs)).toEqual([])
    }, 30_000)

  test("every tier-real CI gate pattern selects at least one real-harness journey", async () => {
    // The workflow greps titles; a title rename that matches nothing makes the
    // job print "No tests found" and the gate goes empty instead of red.
    const titles = (await collectedSpecs())
      .filter((spec) => spec.file.replaceAll("\\", "/").endsWith("playwright/real-harness-local.spec.ts"))
      .map((spec) => spec.title)
    const patterns = tierRealGatePatterns().map((pattern) => new RegExp(pattern))
    expect(patterns.length).toBe(4)
    expect(patterns.filter((pattern) => !titles.some((title) => pattern.test(title))).map(String)).toEqual([])
  }, 30_000)

  test("the crabbox tier-real replay runs the workflow's exact patterns", () => {
    expect(tierRealReplayPatterns()).toEqual(tierRealGatePatterns())
  })
})
