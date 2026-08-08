import { expect, test } from "bun:test"
import { renderOgCard, renderReportPage } from "./html"
import type { StoredReport } from "./report"

const report: StoredReport = {
  id: "a".repeat(32),
  createdAt: "2026-08-08T00:00:00.000Z",
  schemaVersion: 1,
  sessionsAnalyzed: 2_178,
  executionCalls: 347_214,
  justBashPercent: 69.16,
  fullVmPercent: 30.84,
  medianTimeBeforeFullMachineMs: 11_500,
  p95TimeBeforeFullMachineMs: 109_200,
}

test("public report exposes X and Open Graph image metadata", () => {
  const html = renderReportPage(report, "https://stats.example", "nonce")
  expect(html).toContain('name="twitter:card" content="summary_large_image"')
  expect(html).toContain(`property="og:image" content="https://stats.example/r/${report.id}/og.png"`)
  expect(html).toContain("https://x.com/intent/post?")
  expect(html).toContain("My%20agent%20needs%20to%20call%20a%20full%20machine%20every%2011.5s%20(median).")
  expect(html).toContain("https://github.com/vercel-labs/just-bash")
  expect(html).toContain("configured network/API access")
  expect(html).not.toContain("CI/E2E")
  expect(html).toContain("347,214")
})

test("OG card uses the main aggregate stats at 1200 by 630", () => {
  const html = renderOgCard(report)
  expect(html).toContain("width:1200px;height:630px")
  expect(html).toContain("347,214")
  expect(html).toContain("69.16%")
  expect(html).not.toContain("workerd")
  expect(html).toContain("109.2s")
  expect(html).toContain("Full machine needed every <em>11.5s</em>")
  expect(html).not.toContain("CI/E2E")
})
