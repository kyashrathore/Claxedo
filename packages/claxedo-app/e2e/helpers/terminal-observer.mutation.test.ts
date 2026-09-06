import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "@playwright/test"
import { installAgentBrowserObserver } from "../../perf-harness/src/agent-browser-observer"

let browser: Browser
let page: Page
beforeAll(async () => { browser = await chromium.launch({ headless: true }) })
afterAll(async () => { await browser?.close() })
beforeEach(async () => {
  page = await browser.newPage()
  await installAgentBrowserObserver(page)
  await page.route("http://localhost/observer", (route) => route.fulfill({ contentType: "text/html", body: "<textarea autofocus></textarea>" }))
  await page.goto("http://localhost/observer")
})
afterEach(async () => { await page?.close() })

describe("terminal benchmark observer with controlled parser receipts", () => {
  test.each([
    { distance: 100, missed: false },
    { distance: 65_536 - 4, missed: false },
    { distance: 65_536 - 4 + 1, missed: true },
    { distance: 65_536 + 5_000, missed: true },
  ])("observes ECHO $distance bytes from the batch end", async ({ distance, missed }) => {
    await page.evaluate(() => {
      const observer = window.__CLAXEDO_AGENT_APP_BENCHMARK__!
      observer.beginTerminal({ terminalId: "pty", instanceId: "instance", startSentinel: "START", rawEndSentinel: "END", modelEndSentinel: "END", expectedEchoes: ["ECHO"], bytes: 0 })
      observer.armTerminalInput("ECHO")
    })
    await page.keyboard.press("a")
    const batchBytes = await page.evaluate((distance) => {
      const observer = window.__CLAXEDO_AGENT_APP_BENCHMARK__!
      const data = "STARTECHO" + "y".repeat(distance)
      observer.terminalWriteAccepted({ terminalId: "pty", instanceId: "instance", data, acceptedAtMs: performance.now() })
      observer.terminalWriteParsed({ parsedAtMs: performance.now(), terminalId: "pty", instanceId: "instance", data, serialize: () => "ECHO", dimensions: () => ({ cols: 80, rows: 24 }) })
      return data.length
    }, distance)
    await page.waitForFunction(() => window.__CLAXEDO_AGENT_APP_BENCHMARK__!.terminalInputObserved("ECHO"))

    await page.evaluate(() => {
      const observer = window.__CLAXEDO_AGENT_APP_BENCHMARK__!
      observer.terminalWriteAccepted({ terminalId: "pty", instanceId: "instance", data: "END", acceptedAtMs: performance.now() })
      observer.terminalWriteParsed({ parsedAtMs: performance.now(), terminalId: "pty", instanceId: "instance", data: "END", serialize: () => "ECHO END", dimensions: () => ({ cols: 80, rows: 24 }) })
    })
    await page.waitForFunction(() => window.__CLAXEDO_AGENT_APP_BENCHMARK__!.terminalObservationComplete())
    const evidence = await page.evaluate(() => window.__CLAXEDO_AGENT_APP_BENCHMARK__!.finishTerminal())
    expect(evidence).not.toHaveProperty("state", "invalid")
    expect(evidence).toMatchObject({
      echoTailMisses: missed ? [{ echo: "ECHO", batchBytes, bytesFromEnd: distance }] : [],
      inputDurationsMs: [expect.any(Number)],
    })
  })

  test("does not serialize unrelated output or record an echo absent from the actual model", async () => {
    await page.evaluate(() => {
      const observer = window.__CLAXEDO_AGENT_APP_BENCHMARK__!
      observer.beginTerminal({ terminalId: "pty", instanceId: "instance", startSentinel: "START", rawEndSentinel: "END", modelEndSentinel: "END", expectedEchoes: ["ECHO"], bytes: 0 })
      observer.armTerminalInput("ECHO")
    })
    await page.keyboard.press("a")
    const reads = await page.evaluate(() => {
      const observer = window.__CLAXEDO_AGENT_APP_BENCHMARK__!
      let calls = 0
      const receipt = { terminalId: "pty", instanceId: "instance", serialize: () => { calls++; return "no rendered echo" }, dimensions: () => ({ cols: 80, rows: 24 }) }
      observer.terminalWriteParsed({ parsedAtMs: performance.now(), ...receipt, data: "unrelated" })
      const unrelated = calls
      observer.terminalWriteParsed({ parsedAtMs: performance.now(), ...receipt, data: "ECHO" })
      return { unrelated, candidate: calls }
    })
    expect(reads).toEqual({ unrelated: 0, candidate: 1 })
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(await page.evaluate(() => window.__CLAXEDO_AGENT_APP_BENCHMARK__!.terminalInputObserved("ECHO"))).toBe(false)
  })
})
