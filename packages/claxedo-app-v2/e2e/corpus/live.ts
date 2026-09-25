import type { Page } from "@playwright/test"
import { acpScriptToken, expect, type AppChoice, type ClaxedoApi, type Stack } from "../harness"
import type { CaseTurn } from "./case"

type Target = { readonly directory: string; readonly sessionId: string }

const MARKED_ROWS = "__corpusMarkedRows"

export async function startLiveTurn(stack: Stack, api: ClaxedoApi, target: Target, turn: CaseTurn & { readonly name: string }) {
  await stack.acp.write(turn.name, { steps: [...turn.steps] })
  await api.promptAsync(target.directory, target.sessionId, `${turn.prompt} ${acpScriptToken(turn.name)}`)
}

const QUIET_MS = 700

export function quietDom(app: Page) {
  return app.evaluate(
    (quietMs) =>
      new Promise<void>((resolve) => {
        let timer = setTimeout(done, quietMs)
        const observer = new MutationObserver(() => {
          clearTimeout(timer)
          timer = setTimeout(done, quietMs)
        })
        function done() {
          observer.disconnect()
          resolve()
        }
        observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
      }),
    QUIET_MS,
  )
}

async function sessionIdle(api: ClaxedoApi, target: Target) {
  await expect.poll(async () => (await api.status(target.directory))[target.sessionId]?.type ?? "idle").toBe("idle")
}

export async function releaseHold(input: { stack: Stack; api: ClaxedoApi; target: Target; app: Page }, hold: { hold: string; ready: string; settles?: boolean }) {
  await input.stack.acp.release(hold.hold)
  await expect(input.app.getByText(hold.ready).first()).toBeVisible()
  if (hold.settles) await sessionIdle(input.api, input.target)
  await quietDom(input.app)
}

export async function markRows(app: Page) {
  const marked = await app.locator('[data-component="session-turn"]').evaluateAll((rows, key) => {
    Object.assign(window, { [key]: rows })
    return rows.length
  }, MARKED_ROWS)
  expect(marked).toBeGreaterThan(0)
}

export async function expectRowsKept(app: Page) {
  const rows = await app.evaluate((key) => {
    const marked = ((window as unknown as Record<string, Element[] | undefined>)[key] ?? [])
    return { marked: marked.length, kept: marked.filter((row) => row.isConnected).length }
  }, MARKED_ROWS)
  expect(rows.kept, "every turn row marked before the deltas is the same element after them").toBe(rows.marked)
}

const detachedMarks = new WeakMap<Page, number>()

async function detachedNodes(app: Page) {
  const cdp = await app.context().newCDPSession(app)
  try {
    await cdp.send("HeapProfiler.collectGarbage")
    const { nodes } = (await cdp.send("Memory.getDOMCounters")) as { nodes: number }
    const connected = await app.evaluate(() => {
      const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL)
      let count = 1
      while (walker.nextNode()) count += 1
      return count
    })
    return nodes - connected
  } finally {
    await cdp.detach()
  }
}

export async function markDetachedNodes(app: Page, appChoice: AppChoice) {
  if (appChoice === "v1") return
  detachedMarks.set(app, await detachedNodes(app))
}

export async function expectDetachedGrowthAtMost(app: Page, appChoice: AppChoice, max: number) {
  if (appChoice === "v1") return
  const mark = detachedMarks.get(app)
  if (mark === undefined) throw new Error("detachedGrowth needs a markDetached interaction before it")
  expect((await detachedNodes(app)) - mark, "DOM nodes that outlive the streamed deltas").toBeLessThanOrEqual(max)
}
