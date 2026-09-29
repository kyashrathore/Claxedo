import type { Page } from "@playwright/test"
import { installPaintedFrames } from "../harness/painted-frames"
import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, test } from "../harness"

type FenceFrame = { height: number; complete: boolean }
type FenceFramesWindow = Window & { __fenceFrames?: Promise<FenceFrame[]> }

async function recordFenceClose(app: Page): Promise<() => Promise<FenceFrame[]>> {
  await app.evaluate(installPaintedFrames)
  await app.evaluate(() => {
    const paintedFrames = window.__claxedoPaintedFrames
    if (!paintedFrames) throw new Error("installPaintedFrames has not run in this page")
    ;(window as FenceFramesWindow).__fenceFrames = new Promise<FenceFrame[]>((resolve) => {
      const frames: FenceFrame[] = []
      paintedFrames({
        sample: () => {
          const code = document.querySelector<HTMLElement>('[data-session-timeline-root] [data-component="markdown-code"]')
          if (!code) return undefined
          return { height: code.getBoundingClientRect().height, complete: code.closest<HTMLElement>("[data-markdown-block]")?.dataset.markdownComplete === "true" }
        },
        painted: (frame) => {
          if (!frame) return
          frames.push(frame)
          if (frames.filter((seen) => seen.complete).length < 3) return
          resolve(frames)
          return true
        },
      })
    })
  })
  return () => app.evaluate(() => (window as FenceFramesWindow).__fenceFrames!)
}

test("03 a streamed code fence keeps its height on the frame it closes", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("fence")
  await stack.acp.write("fence", {
    steps: [
      { kind: "text", text: "The values:\n\n```pyth" },
      { kind: "hold", name: "fence-info" },
      { kind: "text", text: "on\nfirst = 1\nsecond = 2\n``" },
      { kind: "hold", name: "fence" },
      { kind: "text", text: "`" },
      { kind: "hold", name: "fence-end" },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Fence", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, `Show the values. ${acpScriptToken("fence")}`)
  await expect(app.locator('[data-component="markdown-code"]')).toBeVisible()
  await stack.acp.release("fence-info")
  await expect(app.locator('[data-component="markdown-code"]').getByText("second = 2")).toBeVisible()

  const frames = await recordFenceClose(app)
  await stack.acp.release("fence")
  const heights = (await frames()).map((frame) => frame.height)
  expect(heights).toEqual(heights.map(() => heights[0]))
  await stack.acp.release("fence-end")
})

type BlockWritesWindow = Window & { __blockWrites?: MutationRecord[] }

test("03 while later text streams, an earlier code block of the same answer takes no DOM writes", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("still-block")
  await stack.acp.write("still-block", {
    steps: [
      { kind: "text", text: "Before.\n\n```ts\nconst answer = 42\n```\n\nAfter the code" },
      { kind: "hold", name: "still-block" },
      { kind: "text", text: " keeps streaming in pieces", chunks: 4, delayMs: 40 },
      { kind: "hold", name: "still-block-end" },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Still block", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, `Show it. ${acpScriptToken("still-block")}`)
  const code = app.locator('[data-component="markdown-code"]').filter({ hasText: "const answer = 42" })
  await expect(code.locator("code span[style*='color']").first()).toBeVisible()
  await expect(app.getByText("After the code")).toBeVisible()

  await code.evaluate((element) => {
    const records: MutationRecord[] = []
    ;(window as BlockWritesWindow).__blockWrites = records
    new MutationObserver((batch) => records.push(...batch)).observe(element.closest("[data-markdown-block]")!, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
  })
  await stack.acp.release("still-block")
  await expect(app.getByText("After the code keeps streaming in pieces")).toBeVisible()
  const writes = await app.evaluate(() => ((window as BlockWritesWindow).__blockWrites ?? []).map((record) => `${record.type} ${record.attributeName ?? ""} ${(record.target as Element).tagName ?? "#text"}`))
  expect(writes).toEqual([])
  await stack.acp.release("still-block-end")
})
