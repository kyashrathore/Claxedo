import { expect, test } from "bun:test"
import { renderOgCard, renderReportPage, renderSharePage } from "./html"
import type { StoredReport } from "./report"

const report: StoredReport = {
  id: "a".repeat(32),
  createdAt: "2026-08-08T00:00:00.000Z",
  schemaVersion: 2,
  sessionsAnalyzed: 2_178,
  executionCalls: 347_214,
  sessionsWithoutFullMachinePercent: 18.25,
  turnsAnalyzed: 12_420,
  turnCoveragePercent: 91.6,
  turnsWithoutFullMachinePercent: 37.5,
  repeatFullMachineTurnPercent: 72.4,
  medianCallsAfterFirstFullMachine: 6,
  medianObservedSpanAfterFirstFullMachineMs: 45_500,
  p95ObservedSpanAfterFirstFullMachineMs: 301_200,
}

test("public report exposes X and Open Graph image metadata", () => {
  const html = renderReportPage(report, "https://stats.example", "nonce")
  expect(html).toContain('name="twitter:card" content="summary_large_image"')
  expect(html).toContain(`property="og:image" content="https://stats.example/r/${report.id}/og.png"`)
  expect(html).toContain("https://x.com/intent/post?")
  expect(html).toContain("My%20agent%20needs%20a%20full%20machine%20in%2062.50%25%20of%20analyzed%20turns.")
  expect(html).toContain("Once%20a%20turn%20reaches%20one%2C%2072.40%25%20need%20it%20again.")
  expect(html).toContain("https://github.com/vercel-labs/just-bash")
  expect(html).toContain("not the complete turn duration")
  expect(html).toContain('<details class="metric-details"><summary>More detail <span>7 metrics</span></summary>')
  expect(html).not.toContain("CI/E2E")
  expect(html).toContain("347,214")
})

test("share review keeps secondary metrics collapsed", () => {
  const html = renderSharePage("nonce")
  expect(html).toContain('id="headline-metrics"')
  expect(html).toContain('<details class="metric-details"><summary>More detail <span>7 metrics</span></summary>')
  expect(html).toContain('id="detail-metrics"')
  expect(html).not.toContain('<details class="metric-details" open>')
})

test("OG card uses the turn placement stats at 1200 by 630", () => {
  const html = renderOgCard(report)
  expect(html).toContain("width:1200px;height:630px")
  expect(html).toContain("347,214")
  expect(html).toContain("62.50%")
  expect(html).toContain("72.40%")
  expect(html).toContain("12,420")
  expect(html).toContain("301.2s")
  expect(html).toContain("of turns need a full machine")
  expect(html).not.toContain("CI/E2E")
})
