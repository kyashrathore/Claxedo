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
  expect(html).toContain("Main findings")
  expect(html).toContain("Report details")
  expect(html).toContain("At a glance")
  expect(html.match(/class="finding"/g)).toHaveLength(5)
  expect(html.match(/class="detail-row"/g)).toHaveLength(7)
  expect(html.indexOf("Sessions analyzed")).toBeLessThan(html.indexOf("Median return interval"))
  expect(html).toContain("Measured full-machine return intervals")
  expect(html).toContain("89,320")
  expect(html).not.toContain("Check yours")
  expect(html).toContain("Measure your own")
  expect(html).toContain("npx @claxedo/agent-runtime-stats")
  expect(html).toContain('navigator.clipboard.writeText("npx @claxedo/agent-runtime-stats")')
  expect(html.indexOf("Share on X")).toBeLessThan(html.indexOf("Main findings"))
  expect(html).not.toContain("source transcripts")
  expect(html).not.toContain("Public aggregate report")
  expect(html).not.toContain("CI/E2E")
  expect(html).toContain("347,214")
})

test("fragment report renders every metric and saves in place before sharing", () => {
  const html = renderSharePage("nonce")
  expect(html).toContain('id="report-headline"')
  expect(html).toContain('id="report-lede"')
  expect(html).toContain('id="report-findings"')
  expect(html).toContain('id="report-details"')
  expect(html).toContain('id="save-share"')
  expect(html).toContain("Save page and share on X")
  expect(html).toContain('fetch("/api/agent-runtime-reports"')
  expect(html).toContain('history.replaceState(null, "", savedUrl)')
  expect(html).toContain("https://x.com/intent/post")
  expect(html).toContain("p95 observed span after first full-machine need")
  expect(html).toContain('<meta name="robots" content="noindex, follow">')
  expect(html.indexOf("Save page and share on X")).toBeLessThan(html.indexOf("Main findings"))
  expect(html.indexOf("Sessions analyzed")).toBeLessThan(html.indexOf("Median return interval"))
  expect(html).toContain("Measure your own")
  expect(html).toContain("npx @claxedo/agent-runtime-stats")
  expect(html).not.toContain("<details")
  expect(html).not.toContain("Publish")
  expect(html).not.toContain("Cancel")
  expect(html).not.toContain("data stays local")
  expect(html).not.toContain("Not uploaded")
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
