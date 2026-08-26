import { describe, expect, test } from "bun:test"
import { createRoot, flush } from "solid-js"

import { createWorkspacePanelMotionState } from "./workspace-panel-motion-state"

// Solid 2 stages signal writes, so every synchronous assertion that follows an
// imperative call into the motion state flushes first. Reads after `delay()`
// need no flush: the timer's writes are flushed on the microtask that follows
// their callback, before the awaited continuation runs.
describe("createWorkspacePanelMotionState", () => {
  test("mounts synchronously and disposes only after the close grace", async () => {
    await withMotionDom(async ({ motion }) => {
      expect(motion.shellMounted()).toBe(false)

      motion.setVisualPhase(true)
      flush()
      expect(motion.shellMounted()).toBe(true)

      motion.setVisualPhase(false)
      flush()
      expect(motion.visualOpen()).toBe(false)
      expect(motion.shellMounted()).toBe(true)

      await delay(100)
      expect(motion.shellMounted()).toBe(true)
      await delay(60)
      expect(motion.shellMounted()).toBe(false)
    })
  })

  test("rapid reopen cancels stale shell disposal", async () => {
    await withMotionDom(async ({ motion }) => {
      motion.setVisualPhase(true)
      motion.setVisualPhase(false)
      await delay(80)
      motion.setVisualPhase(true)
      await delay(100)

      expect(motion.visualOpen()).toBe(true)
      expect(motion.shellMounted()).toBe(true)
    })
  })

  test("committed-only transitions own the same shell lifecycle", async () => {
    await withMotionDom(async ({ motion }) => {
      expect(motion.reconcileCommittedOpen(true)).toBe(true)
      flush()
      expect(motion.shellMounted()).toBe(true)

      expect(motion.reconcileCommittedOpen(false)).toBe(true)
      flush()
      expect(motion.shellMounted()).toBe(true)
      await delay(160)
      expect(motion.shellMounted()).toBe(false)
    })
  })

  test("opens immediately while syncing shell and toggle chrome", async () => {
    await withMotionDom(async ({ directToggle, floatingToggle, motion, panel, workbench }) => {
      motion.setVisualPhase(true, directToggle)
      flush()

      expect(motion.visualOpen()).toBe(true)
      expect(motion.visualOpenValue()).toBe(true)
      expect(motion.bridgeChromeVisible()).toBe(true)
      expect(panel.dataset.open).toBe("true")
      expect(panel.style.transform).toBe("translate3d(0, 0, 0)")
      expect(panel.getAttribute("role")).toBe("complementary")
      expect(panel.getAttribute("aria-label")).toBe("Workspace panel")
      expect(directToggle.getAttribute("aria-label")).toBe("Close workspace panel")
      expect(directToggle.getAttribute("aria-pressed")).toBe("true")
      expect(floatingToggle.getAttribute("title")).toBe("Close workspace panel")
      expect(workbench.style.marginRight).toBe("444px")

      await delay(160)
      expect(motion.bridgeChromeVisible()).toBe(false)
    })
  })

  test("keeps an optimistic open phase until committed state catches up", async () => {
    await withMotionDom(async ({ directToggle, motion, panel }) => {
      motion.setVisualPhase(true, directToggle)
      flush()

      expect(motion.reconcileCommittedOpen(false)).toBe(false)
      flush()
      expect(motion.visualOpen()).toBe(true)
      expect(panel.dataset.open).toBe("true")

      expect(motion.reconcileCommittedOpen(true)).toBe(true)
      flush()
      expect(motion.visualOpen()).toBe(true)
    })
  })

  test("rapid close cancels stale bridge cleanup before the next open", async () => {
    await withMotionDom(async ({ directToggle, motion, panel, workbench }) => {
      motion.setVisualPhase(true, directToggle)
      await delay(40)
      workbench.style.marginRight = "12px"
      motion.setVisualPhase(false, directToggle)
      await delay(140)

      expect(motion.bridgeChromeVisible()).toBe(true)
      expect(motion.visualOpen()).toBe(false)
      expect(panel.dataset.open).toBe("false")
      expect(panel.style.transform).toBe("translate3d(100%, 0, 0)")
      expect(panel.classList.contains("pointer-events-none")).toBe(true)
      expect(directToggle.getAttribute("aria-label")).toBe("Open workspace panel")
      expect(workbench.style.marginRight).toBe("0px")

      motion.setVisualPhase(true, directToggle)
      await delay(160)
      expect(motion.bridgeChromeVisible()).toBe(false)
      expect(motion.visualOpen()).toBe(true)
    })
  })
})

async function withMotionDom(
  run: (context: {
    directToggle: HTMLButtonElement
    floatingToggle: HTMLButtonElement
    motion: ReturnType<typeof createWorkspacePanelMotionState>
    panel: HTMLElement
    workbench: HTMLElement
  }) => void | Promise<void>,
) {
  const panel = document.createElement("aside")
  const floating = document.createElement("div")
  const floatingToggle = document.createElement("button")
  const directToggle = document.createElement("button")
  const workbench = document.createElement("div")
  floatingToggle.dataset.testid = "workspace-panel-toggle"
  floating.append(floatingToggle)
  workbench.dataset.testid = "workbench-column"
  document.body.append(panel, floating, directToggle, workbench)
  const root = createRoot((dispose) => ({
    dispose,
    motion: createWorkspacePanelMotionState({
      initialOpen: false,
      workspacePanelWidth: () => 444,
    }),
  }))
  root.motion.registerPanelShell(panel)
  root.motion.registerFloatingChrome(floating)
  root.motion.registerWorkbenchColumn(workbench)

  try {
    await run({
      directToggle,
      floatingToggle,
      motion: root.motion,
      panel,
      workbench,
    })
  } finally {
    root.motion.registerPanelShell(undefined)
    root.motion.registerFloatingChrome(undefined)
    root.motion.registerWorkbenchColumn(undefined)
    root.dispose()
    document.body.replaceChildren()
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
