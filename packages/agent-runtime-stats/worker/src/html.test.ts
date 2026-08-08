import { expect, test } from "bun:test"
import { renderOgCard, renderReportPage, renderSharePage } from "./html"
import type { StoredReport } from "./report"

const report: StoredReport = {
  id: "a".repeat(32),
  createdAt: "2026-08-08T00:00:00.000Z",
  schemaVersion: 3,
  sessionsAnalyzed: 2_178,
  executionCalls: 347_214,
  sessionsWithoutFullMachinePercent: 18.25,
  turnsAnalyzed: 12_420,
  turnCoveragePercent: 91.6,
  turnsWithoutFullMachinePercent: 37.5,
  repeatFullMachineTurnPercent: 72.4,
  fullMachineReturnIntervalSamples: 89_320,
  medianFullMachineReturnIntervalMs: 10_800,
  p95FullMachineReturnIntervalMs: 98_100,
  medianCallsAfterFirstFullMachine: 6,
  medianObservedSpanAfterFirstFullMachineMs: 45_500,
  p95ObservedSpanAfterFirstFullMachineMs: 301_200,
}

test("public report exposes X and Open Graph image metadata", () => {
  const html = renderReportPage(report, "https://stats.example", "nonce")
  expect(html).toContain('name="twitter:card" content="summary_large_image"')
  expect(html).toContain(`property="og:image" content="https://stats.example/r/${report.id}/og.png"`)
  expect(html).toContain("https://x.com/intent/post?")
  expect(html).toContain("My%20coding%20agent%20needs%20a%20full%20machine%20again%20every%2010.8s%20(median).")
  expect(html).toContain("95%25%20of%20measured%20returns%20happen%20within%2098.1s.")
  expect(html).toContain("https://github.com/vercel-labs/just-bash")
  expect(html).toContain('<meta name="robots" content="noindex, follow">')
  expect(html).toContain("Coding Agent Machine Demand")
  expect(html).toContain("not the complete turn duration")
  expect(html).not.toContain('<details class="metric-details">')
  expect(html).toContain("13 aggregate metrics")
  expect(html).toContain("Measured full-machine return intervals")
  expect(html).toContain("89,320")
  expect(html).toContain("Check yours")
  expect(html).toContain('navigator.clipboard.writeText("npx @claxedo/agent-runtime-stats")')
  expect(html.indexOf("Share on X")).toBeLessThan(html.indexOf("Runtime placement"))
  expect(html).not.toContain("CI/E2E")
  expect(html).toContain("347,214")
})

test("share review keeps secondary metrics collapsed", () => {
  const html = renderSharePage("nonce")
  expect(html).toContain('id="headline-metrics"')
  expect(html).toContain('<details class="metric-details"><summary>More detail <span>10 metrics</span></summary>')
  expect(html).toContain('id="detail-metrics"')
  expect(html).toContain('fetch("/api/agent-runtime-reports"')
  expect(html).toContain('<meta name="robots" content="noindex, follow">')
  expect(html).not.toContain('<details class="metric-details" open>')
})

test("OG card leads with the machine return interval at 1200 by 630", () => {
  const html = renderOgCard(report)
  expect(html).toContain("width:1200px;height:630px")
  expect(html).toContain("347,214")
  expect(html).toContain("Every <em>10.8s</em>")
  expect(html).toContain("98.1s")
  expect(html).toContain("89,320")
  expect(html.match(/class="stat"/g)).toHaveLength(2)
  expect(html).toContain("12,420")
  expect(html).toContain("Median interval before this agent needed a full machine again")
  expect(html).toContain("Coding agent machine demand")
  expect(html).not.toContain("Claxedo / Agent Runtime Report")
  expect(html).not.toContain("CI/E2E")
})
