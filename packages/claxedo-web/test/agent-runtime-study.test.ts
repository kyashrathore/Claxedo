import { describe, expect, test } from "bun:test"
import study from "../src/content/2026-08-09-runtime-study.json"
import { requireClaim } from "../src/content/claims"
import { routes } from "../src/content/routes"

const page = new URL("../src/pages/how-often-do-coding-agents-need-a-full-machine.astro", import.meta.url)

describe("agent runtime study", () => {
  test("owns one canonical, indexable research route", () => {
    expect(routes.agentRuntimeStudy).toBe("/how-often-do-coding-agents-need-a-full-machine")
    expect(requireClaim("agent-runtime-study").evidence).toContain(
      "packages/claxedo-web/src/content/2026-08-09-runtime-study.json",
    )
  })

  test("publishes the measured turn-level findings without hiding unresolved coverage", () => {
    expect(study.metrics.medianFullMachineReturnIntervalMs).toBe(10_791.5)
    expect(study.metrics.fullMachineReturnIntervalSamples).toBe(92_390)
    expect(study.metrics.turnsRequiringFullMachinePercent).toBeCloseTo(64.01, 2)
    expect(study.metrics.repeatFullMachineTurnPercent).toBeCloseTo(68.92, 2)
    expect(study.metrics.fullMachineExecutionCallPercent).toBeCloseTo(30.8, 2)
    expect(study.metrics.turnCoveragePercent).toBeLessThan(100)
    expect(study.scope.executionCalls).toBe(416_467)
    expect(study.methodology.resolvedPopulation).toContain("exclude")
  })

  test("links the source discussion and the local analyzer", async () => {
    const source = await Bun.file(page).text()
    expect(source).toContain("https://x.com/kyashrathore/status/2082195455107268983")
    expect(source).toContain("npx github:kyashrathore/agent-runtime-stats")
    expect(source).toContain("https://github.com/kyashrathore/agent-runtime-stats")
    expect(source).toContain("data-copy-command")
    expect(source).toContain("https://github.com/vercel-labs/just-bash")
    expect(source).toContain("System binaries outside the lightweight shell")
    expect(source).toContain("Running agent-generated programs crosses the isolation boundary")
    expect(source).not.toContain("noindex")
  })
})
