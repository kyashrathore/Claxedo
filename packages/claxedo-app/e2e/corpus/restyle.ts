import type { CDPSession, Page } from "@playwright/test"
import { traceEventsFrom, type TraceEvent } from "../../perf-harness/src/trace-events"
const CATEGORIES = ["devtools.timeline", "disabled-by-default-devtools.timeline.invalidationTracking"]
const LIST = "[data-timeline-virtual-content]"

async function listNodeId(cdp: CDPSession, app: Page) {
  await app.locator(LIST).waitFor()
  const { result } = (await cdp.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(LIST)})` })) as { result: { objectId: string } }
  const { node } = (await cdp.send("DOM.describeNode", { objectId: result.objectId })) as { node: { backendNodeId: number } }
  return node.backendNodeId
}

export async function wholeListRestyles(app: Page, act: () => Promise<void>): Promise<number> {
  const cdp = await app.context().newCDPSession(app)
  try {
    const list = await listNodeId(cdp, app)
    const events: TraceEvent[] = []
    cdp.on("Tracing.dataCollected", (data) => events.push(...traceEventsFrom(data)))
    await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: CATEGORIES, recordMode: "recordAsMuchAsPossible" } })
    await act()
    const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve))
    await cdp.send("Tracing.end")
    await complete
    return events.filter((event) => event.args?.data?.nodeId === list && /subtree|Related style rule/.test(String(event.args.data.reason ?? ""))).length
  } finally {
    await cdp.detach()
  }
}
