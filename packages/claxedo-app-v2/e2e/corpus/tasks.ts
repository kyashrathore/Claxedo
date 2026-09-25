import type { Page } from "@playwright/test"
import type { AppChoice } from "../harness"

const CATEGORIES = ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink.console"]
const STAMP = "corpus-inserted"

type TraceEvent = { name?: string; ph?: string; ts?: number; dur?: number; pid?: number; tid?: number; args?: { name?: string; data?: { message?: string } } }

export async function taskInsertingMs(app: Page, appChoice: AppChoice, selector: string, act: () => Promise<void>): Promise<number | undefined> {
  if (appChoice === "v1") {
    await act()
    return undefined
  }
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
    cdp.on("Tracing.dataCollected", (data) => events.push(...(data.value as TraceEvent[])))
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
    await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: CATEGORIES, recordMode: "recordAsMuchAsPossible" } })
    await act()
    const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve))
    await cdp.send("Tracing.end")
    await complete
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    const stamp = events.find((event) => event.name === "TimeStamp" && event.args?.data?.message === STAMP)
    if (stamp?.ts === undefined) throw new Error(`nothing matching ${selector} was inserted while tracing`)
    const task = events.find((event) => event.name === "RunTask" && event.ph === "X" && event.pid === stamp.pid && event.tid === stamp.tid && event.ts !== undefined && event.dur !== undefined && event.ts <= stamp.ts! && stamp.ts! <= event.ts + event.dur)
    return task?.dur === undefined ? 0 : task.dur / 1000
  } finally {
    await cdp.detach()
  }
}
