import type { Page } from "@playwright/test"
import { installPaintedFrames } from "../../perf-harness/src/browser/painted-frames"
import { restingPanelWidth } from "../../src/panel/width"
import { expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI, UNTRACED } from "../harness"

test.skip(({ isMobile }) => isMobile, "flow 14 runs at desktop width")
test.use(UNTRACED)

type PaintedFrame = { readonly width: string; readonly available: number }

function paintedWidths(app: Page) {
  return app.getByTestId("workspace-panel-shell").evaluate(
    (aside) =>
      new Promise<PaintedFrame[]>((resolve, reject) => {
        const frames: PaintedFrame[] = []
        const paintedFrames = window.__claxedoPaintedFrames
        if (!paintedFrames) return reject(new Error("installPaintedFrames has not run in this page"))
        paintedFrames({
          sample: () => (aside.style.display === "none" ? undefined : { width: aside.style.width, available: aside.parentElement?.clientWidth ?? 0 }),
          painted: (frame) => {
            if (frame) frames.push(frame)
            if (frames.length < 16) return false
            resolve(frames)
            return true
          },
        })
      }),
  )
}

async function openAndRecord(app: Page) {
  await app.evaluate(installPaintedFrames)
  const frames = paintedWidths(app)
  await app.getByRole("button", { name: UI.openPanel }).click()
  const painted = await frames
  const available = painted.at(-1)?.available ?? 0
  const expected = `${restingPanelWidth({ available, phone: false, fullWidth: false, chosen: null })}px`
  return { painted: painted.map((frame) => frame.width), expected }
}

test("14 the opened panel paints its resting width in its first frame, also after the window was resized while it was closed", async ({ stack, api, app }) => {
  await app.setViewportSize({ width: 1400, height: 800 })
  const workspace = await stack.daemon.makeWorkspace("open-width")
  const session = await api.createSession(workspace.directory, { title: "Width", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  const panel = app.getByRole("complementary", { name: "Workspace panel" })

  const first = await openAndRecord(app)
  expect(first.painted, "the panel width in each frame from the first open's first painted frame").toEqual(first.painted.map(() => first.expected))

  await panel.getByRole("button", { name: "Close workspace panel" }).click()
  await expect(panel).toHaveCount(0)
  await expect(app.getByTestId("workspace-panel-shell")).toBeHidden()
  await app.setViewportSize({ width: 1100, height: 800 })

  const reopened = await openAndRecord(app)
  expect(reopened.expected, "the resting width follows the narrower window").not.toBe(first.expected)
  expect(reopened.painted, "the panel width in each frame from the reopen's first painted frame").toEqual(reopened.painted.map(() => reopened.expected))
})
