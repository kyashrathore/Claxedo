import type { Page } from "@playwright/test"
import { traceEventsFrom, type TraceEvent } from "../harness/trace-events"
const CATEGORIES = ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink.console"]
const STAMP = "corpus-inserted"

export async function taskInsertingMs(app: Page, selector: string, act: () => Promise<void>): Promise<number> {
  await app.evaluate(({ selector, stamp }) => {
    new MutationObserver((list, observer) => {
      for (const mutation of list) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element) || !(node.matches(selector) || node.querySelector(selector))) continue
          console.timeStamp(stamp)
          observer.disconnect()
          return
        }
      }
    }).observe(document, { subtree: true, childList: true })
  }, { selector, stamp: STAMP })
  const cdp = await app.context().newCDPSession(app)
  try {
    const events: TraceEvent[] = []
    cdp.on("Tracing.dataCollected", (data) => events.push(...traceEventsFrom(data)))
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
    await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: CATEGORIES, recordMode: "recordAsMuchAsPossible" } })
    await act()
    const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve))
    await cdp.send("Tracing.end")
    await complete
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    const stamp = events.find((event) => event.name === "TimeStamp" && event.args?.data?.message === STAMP)
    if (!stamp) throw new Error(`nothing matching ${selector} was inserted while tracing`)
    const task = events.find((event) => event.name === "RunTask" && event.ph === "X" && event.pid === stamp.pid && event.tid === stamp.tid && event.dur !== undefined && event.ts <= stamp.ts && stamp.ts <= event.ts + event.dur)
    return task?.dur === undefined ? 0 : task.dur / 1000
  } finally {
    await cdp.detach()
  }
}
